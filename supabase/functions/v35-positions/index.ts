import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

function normalizeWalletAddress(address: string | null | undefined): string | null {
  if (!address) return null;
  const trimmed = address.trim();
  if (!trimmed) return null;
  return trimmed.toLowerCase();
}

interface PolymarketPosition {
  asset: string;
  conditionId: string;
  market: string;
  outcome: string;
  outcomeIndex: number;
  size: number;
  avgPrice: number;
  initialValue: number;
  currentValue: number;
  curPrice: number;
  eventSlug?: string;
}

interface MarketPosition {
  market_slug: string;
  asset: string;
  // Polymarket data (ground truth)
  polymarket_up_qty: number;
  polymarket_up_avg: number;
  polymarket_down_qty: number;
  polymarket_down_avg: number;
  // Current live prices from Polymarket
  live_up_price: number;
  live_down_price: number;
  // Derived metrics (from Polymarket only)
  paired: number;
  unpaired: number;
  combined_cost: number;
  locked_profit: number;
  total_cost: number;
  current_value: number;
  unrealized_pnl: number;
}

async function fetchPolymarketPositions(walletAddress: string): Promise<PolymarketPosition[]> {
  const positions: PolymarketPosition[] = [];
  let cursor: string | null = null;
  let pageCount = 0;
  const maxPages = 10;

  console.log(`📊 Fetching Polymarket positions for ${walletAddress.slice(0, 10)}...`);

  while (pageCount < maxPages) {
    pageCount++;
    let url = `https://data-api.polymarket.com/positions?user=${walletAddress}&sizeThreshold=0&limit=500`;
    if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`;

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
      });

      if (!response.ok) {
        console.error(`❌ Positions API error: HTTP ${response.status}`);
        break;
      }

      const data = await response.json();
      
      let items: any[];
      let nextCursor: string | null = null;

      if (Array.isArray(data)) {
        items = data;
      } else if (data.positions && Array.isArray(data.positions)) {
        items = data.positions;
        nextCursor = data.next_cursor || data.nextCursor || null;
      } else {
        break;
      }

      for (const p of items) {
        if (p.size > 0) {
          positions.push({
            asset: p.asset || '',
            conditionId: p.conditionId || '',
            market: p.title || p.market || '',
            outcome: p.outcome || (p.outcomeIndex === 0 ? 'Yes' : 'No'),
            outcomeIndex: p.outcomeIndex || 0,
            size: parseFloat(p.size) || 0,
            avgPrice: parseFloat(p.avgPrice) || 0,
            initialValue: parseFloat(p.initialValue) || 0,
            currentValue: parseFloat(p.currentValue) || 0,
            curPrice: parseFloat(p.curPrice) || 0,
            eventSlug: p.eventSlug || p.slug || undefined,
          });
        }
      }

      console.log(`   Page ${pageCount}: ${items.length} items, ${positions.length} total`);

      if (!nextCursor || nextCursor === cursor || items.length === 0) break;
      cursor = nextCursor;
    } catch (e) {
      console.error(`❌ Error fetching positions:`, e);
      break;
    }
  }

  console.log(`   ✅ Fetched ${positions.length} total positions`);
  return positions;
}

async function getBotWalletAddress(supabase: any): Promise<string | null> {
  // Single-row table in this project; still fetch latest to be robust.
  const { data, error } = await supabase
    .from('bot_config')
    .select('polymarket_address, updated_at, created_at')
    .order('updated_at', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error('❌ Error reading bot_config.polymarket_address:', error);
    return null;
  }

  return normalizeWalletAddress(data?.polymarket_address);
}

function is15mCryptoMarket(position: PolymarketPosition): boolean {
  const market = position.market.toLowerCase();
  const slug = (position.eventSlug || '').toLowerCase();
  
  // Check for 15m market patterns
  const has15m = market.includes('15m') || 
                 market.includes('15 min') ||
                 market.includes(':00am-') ||
                 market.includes(':15am-') ||
                 market.includes(':30am-') ||
                 market.includes(':45am-') ||
                 market.includes(':00pm-') ||
                 market.includes(':15pm-') ||
                 market.includes(':30pm-') ||
                 market.includes(':45pm-');
  
  // Check for crypto assets
  const hasCrypto = market.includes('btc') || 
                    market.includes('bitcoin') ||
                    market.includes('eth') || 
                    market.includes('ethereum') ||
                    market.includes('sol') || 
                    market.includes('solana') ||
                    market.includes('xrp') ||
                    slug.includes('btc') ||
                    slug.includes('eth') ||
                    slug.includes('sol') ||
                    slug.includes('xrp');
  
  return has15m && hasCrypto;
}

/**
 * Parse epoch timestamp from market slug like "btc-updown-15m-1769517000"
 */
function getMarketEpochFromSlug(slug: string): number | null {
  const match = slug.match(/(\d{10})$/);
  if (!match) return null;
  return parseInt(match[1]) * 1000; // convert to ms
}

/**
 * Check if market is currently LIVE (not yet expired).
 * Each 15-minute market starts fresh - expired markets do NOT carry over.
 */
function isMarketLive(position: PolymarketPosition): boolean {
  const slug = position.eventSlug || '';
  const epoch = getMarketEpochFromSlug(slug);
  if (!epoch) {
    // If we can't parse the epoch, exclude it (safety)
    console.log(`   ⚠️ Cannot parse epoch from slug: ${slug}, excluding`);
    return false;
  }
  const expiryMs = epoch + 15 * 60 * 1000; // end of 15m window
  const now = Date.now();
  const isLive = expiryMs > now;
  if (!isLive) {
    console.log(`   🔴 EXPIRED market excluded: ${slug} (expired ${Math.round((now - expiryMs) / 1000)}s ago)`);
  }
  return isLive;
}

function extractMarketSlug(position: PolymarketPosition): string {
  // Use eventSlug if available, otherwise derive from market title
  if (position.eventSlug) return position.eventSlug;
  
  // Fallback: create a slug from the market title
  return position.market.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 80);
}

function extractAsset(position: PolymarketPosition): string {
  const market = position.market.toLowerCase();
  if (market.includes('btc') || market.includes('bitcoin')) return 'BTC';
  if (market.includes('eth') || market.includes('ethereum')) return 'ETH';
  if (market.includes('sol') || market.includes('solana')) return 'SOL';
  if (market.includes('xrp')) return 'XRP';
  return 'UNKNOWN';
}

function isUpOutcome(position: PolymarketPosition): boolean {
  const outcome = position.outcome.toLowerCase();
  return outcome === 'yes' || outcome === 'up' || position.outcomeIndex === 0;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const walletAddress = await getBotWalletAddress(supabase);
    if (!walletAddress) {
      return new Response(JSON.stringify({
        success: false,
        error: 'No polymarket_address configured in bot_config',
      }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // 1. Fetch real positions from Polymarket - ONLY LIVE MARKETS
    // Each 15-minute market starts fresh at 0 - expired markets don't carry over
    const allPositions = await fetchPolymarketPositions(walletAddress);
    const positions15m = allPositions
      .filter(is15mCryptoMarket)
      .filter(isMarketLive);  // Only show LIVE markets, not expired ones
    
    console.log(`📈 Found ${positions15m.length} LIVE 15-min crypto positions (filtered from ${allPositions.length} total)`);

    // 2. Group Polymarket positions by market slug
    const polymarketByMarket = new Map<string, { 
      upQty: number; upCost: number; upAvg: number;
      downQty: number; downCost: number; downAvg: number;
      upCurPrice: number; downCurPrice: number;
      upCurrentValue: number; downCurrentValue: number;
      asset: string;
    }>();

    for (const pos of positions15m) {
      const slug = extractMarketSlug(pos);
      const asset = extractAsset(pos);
      const isUp = isUpOutcome(pos);
      
      if (!polymarketByMarket.has(slug)) {
        polymarketByMarket.set(slug, {
          upQty: 0, upCost: 0, upAvg: 0,
          downQty: 0, downCost: 0, downAvg: 0,
          upCurPrice: 0, downCurPrice: 0,
          upCurrentValue: 0, downCurrentValue: 0,
          asset,
        });
      }
      
      const m = polymarketByMarket.get(slug)!;
      if (isUp) {
        m.upQty += pos.size;
        m.upCost += pos.size * pos.avgPrice;
        m.upCurPrice = pos.curPrice; // Current market price
        m.upCurrentValue += pos.currentValue;
      } else {
        m.downQty += pos.size;
        m.downCost += pos.size * pos.avgPrice;
        m.downCurPrice = pos.curPrice; // Current market price
        m.downCurrentValue += pos.currentValue;
      }
    }

    // Calculate averages
    for (const m of polymarketByMarket.values()) {
      m.upAvg = m.upQty > 0 ? m.upCost / m.upQty : 0;
      m.downAvg = m.downQty > 0 ? m.downCost / m.downQty : 0;
    }

    // 3. Build result from Polymarket data (ground truth)
    // NOTE: We no longer use v35_fills as they may contain fills from other traders
    // Polymarket API is the authoritative source for current positions
    const result: MarketPosition[] = [];

    for (const [slug, pm] of polymarketByMarket.entries()) {
      const polymarket_up_qty = pm.upQty || 0;
      const polymarket_down_qty = pm.downQty || 0;

      const paired = Math.min(polymarket_up_qty, polymarket_down_qty);
      const unpaired = Math.abs(polymarket_up_qty - polymarket_down_qty);
      
      const upAvg = pm.upAvg || 0;
      const downAvg = pm.downAvg || 0;
      const combined_cost = upAvg + downAvg;
      const locked_profit = combined_cost < 1 && paired > 0 ? paired * (1 - combined_cost) : 0;

      // Calculate costs and values
      const upCost = polymarket_up_qty * pm.upAvg;
      const downCost = polymarket_down_qty * pm.downAvg;
      const total_cost = upCost + downCost;
      
      // Current value based on live prices
      const upCurrentValue = pm.upCurrentValue || (polymarket_up_qty * pm.upCurPrice);
      const downCurrentValue = pm.downCurrentValue || (polymarket_down_qty * pm.downCurPrice);
      const current_value = upCurrentValue + downCurrentValue;
      
      // Unrealized P&L
      const unrealized_pnl = current_value - total_cost;

      result.push({
        market_slug: slug,
        asset: pm.asset || 'UNKNOWN',
        polymarket_up_qty,
        polymarket_up_avg: pm.upAvg,
        polymarket_down_qty,
        polymarket_down_avg: pm.downAvg,
        live_up_price: pm.upCurPrice,
        live_down_price: pm.downCurPrice,
        paired,
        unpaired,
        combined_cost,
        locked_profit,
        total_cost,
        current_value,
        unrealized_pnl,
      });
    }

    // Sort by most recent (based on market slug pattern if contains time)
    result.sort((a, b) => b.market_slug.localeCompare(a.market_slug));

    console.log(`✅ Built ${result.length} market positions (Polymarket only, no fills DB)`);

    return new Response(JSON.stringify({
      success: true,
      wallet_used: walletAddress,
      positions: result,
      summary: {
        total_markets: result.length,
        total_paired: result.reduce((s, p) => s + p.paired, 0),
        total_unpaired: result.reduce((s, p) => s + p.unpaired, 0),
        total_locked_profit: result.reduce((s, p) => s + p.locked_profit, 0),
        total_cost: result.reduce((s, p) => s + p.total_cost, 0),
        total_current_value: result.reduce((s, p) => s + p.current_value, 0),
        total_unrealized_pnl: result.reduce((s, p) => s + p.unrealized_pnl, 0),
      },
      polymarket_raw: positions15m.length,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('Error:', error);
    return new Response(JSON.stringify({ success: false, error: String(error) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
