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

interface V35Fill {
  id: string;
  market_slug: string;
  side: string;
  price: number;
  size: number;
  order_id: string;
  created_at: string;
}

interface MarketPosition {
  market_slug: string;
  asset: string;
  // Polymarket data (ground truth)
  polymarket_up_qty: number;
  polymarket_up_avg: number;
  polymarket_down_qty: number;
  polymarket_down_avg: number;
  // v35_fills data (what we recorded)
  fills_up_qty: number;
  fills_up_avg: number;
  fills_down_qty: number;
  fills_down_avg: number;
  // Discrepancy flags
  up_qty_match: boolean;
  down_qty_match: boolean;
  // Derived metrics
  paired: number;
  unpaired: number;
  combined_cost: number;
  locked_profit: number;
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
 * Filter positions within given time window (LIVE + lookbackMs)
 */
function isWithinTimeWindow(position: PolymarketPosition, lookbackMs: number): boolean {
  const slug = position.eventSlug || '';
  const epoch = getMarketEpochFromSlug(slug);
  if (!epoch) {
    // If we can't parse the epoch, include it to be safe
    return true;
  }
  const expiryMs = epoch + 15 * 60 * 1000; // end of 15m window
  const now = Date.now();
  const cutoff = now - lookbackMs;
  // Include if: not expired yet OR expired within lookback
  return expiryMs > cutoff;
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

    // 1. Fetch real positions from Polymarket
    const LOOKBACK_MS = 2 * 60 * 60 * 1000; // 2 hours
    const allPositions = await fetchPolymarketPositions(walletAddress);
    const positions15m = allPositions
      .filter(is15mCryptoMarket)
      .filter((p) => isWithinTimeWindow(p, LOOKBACK_MS));
    
    console.log(`📈 Found ${positions15m.length} 15-min crypto positions within 2h window`);

    // 2. Group Polymarket positions by market slug
    const polymarketByMarket = new Map<string, { 
      upQty: number; upCost: number; upAvg: number;
      downQty: number; downCost: number; downAvg: number;
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
          asset,
        });
      }
      
      const m = polymarketByMarket.get(slug)!;
      if (isUp) {
        m.upQty += pos.size;
        m.upCost += pos.size * pos.avgPrice;
      } else {
        m.downQty += pos.size;
        m.downCost += pos.size * pos.avgPrice;
      }
    }

    // Calculate averages
    for (const m of polymarketByMarket.values()) {
      m.upAvg = m.upQty > 0 ? m.upCost / m.upQty : 0;
      m.downAvg = m.downQty > 0 ? m.downCost / m.downQty : 0;
    }

    // Compute earliest relevant epoch for fills (now - 2h)
    const earliestEpochMs = Date.now() - LOOKBACK_MS;
    const earliestCreatedAt = new Date(earliestEpochMs).toISOString();

    // 3. Fetch v35_fills from database (deduplicated by order_id), only recent ones
    const { data: fills, error: fillsError } = await supabase
      .from('v35_fills')
      .select('*')
      .gte('created_at', earliestCreatedAt)
      .order('created_at', { ascending: false })
      .limit(5000);

    if (fillsError) {
      console.error('Error fetching fills:', fillsError);
    }

    // Deduplicate fills by order_id
    const seenOrders = new Set<string>();
    const uniqueFills: V35Fill[] = [];
    for (const fill of (fills || [])) {
      const key = `${fill.order_id}-${fill.side}-${fill.price}-${fill.size}`;
      if (!seenOrders.has(key)) {
        seenOrders.add(key);
        uniqueFills.push(fill as V35Fill);
      }
    }

    console.log(`📝 Found ${fills?.length || 0} fills, ${uniqueFills.length} unique`);

    // 4. Group fills by market slug
    const fillsByMarket = new Map<string, {
      upQty: number; upCost: number; upAvg: number;
      downQty: number; downCost: number; downAvg: number;
    }>();

    for (const fill of uniqueFills) {
      const slug = fill.market_slug;
      if (!fillsByMarket.has(slug)) {
        fillsByMarket.set(slug, {
          upQty: 0, upCost: 0, upAvg: 0,
          downQty: 0, downCost: 0, downAvg: 0,
        });
      }
      
      const m = fillsByMarket.get(slug)!;
      const side = fill.side?.toUpperCase();
      if (side === 'UP' || side === 'YES') {
        m.upQty += fill.size;
        m.upCost += fill.size * fill.price;
      } else {
        m.downQty += fill.size;
        m.downCost += fill.size * fill.price;
      }
    }

    // Calculate averages for fills
    for (const m of fillsByMarket.values()) {
      m.upAvg = m.upQty > 0 ? m.upCost / m.upQty : 0;
      m.downAvg = m.downQty > 0 ? m.downCost / m.downQty : 0;
    }

    // 5. Build combined result
    const allSlugs = new Set([...polymarketByMarket.keys(), ...fillsByMarket.keys()]);
    const result: MarketPosition[] = [];

    for (const slug of allSlugs) {
      const pm = polymarketByMarket.get(slug);
      const fl = fillsByMarket.get(slug);

      const polymarket_up_qty = pm?.upQty || 0;
      const polymarket_down_qty = pm?.downQty || 0;
      const fills_up_qty = fl?.upQty || 0;
      const fills_down_qty = fl?.downQty || 0;

      const paired = Math.min(polymarket_up_qty, polymarket_down_qty);
      const unpaired = Math.abs(polymarket_up_qty - polymarket_down_qty);
      
      const upAvg = pm?.upAvg || fl?.upAvg || 0;
      const downAvg = pm?.downAvg || fl?.downAvg || 0;
      const combined_cost = upAvg + downAvg;
      const locked_profit = combined_cost < 1 && paired > 0 ? paired * (1 - combined_cost) : 0;

      result.push({
        market_slug: slug,
        asset: pm?.asset || 'UNKNOWN',
        polymarket_up_qty,
        polymarket_up_avg: pm?.upAvg || 0,
        polymarket_down_qty,
        polymarket_down_avg: pm?.downAvg || 0,
        fills_up_qty,
        fills_up_avg: fl?.upAvg || 0,
        fills_down_qty,
        fills_down_avg: fl?.downAvg || 0,
        up_qty_match: Math.abs(polymarket_up_qty - fills_up_qty) < 1,
        down_qty_match: Math.abs(polymarket_down_qty - fills_down_qty) < 1,
        paired,
        unpaired,
        combined_cost,
        locked_profit,
      });
    }

    // Sort by most recent (based on market slug pattern if contains time)
    result.sort((a, b) => b.market_slug.localeCompare(a.market_slug));

    console.log(`✅ Built ${result.length} market positions`);

    return new Response(JSON.stringify({
      success: true,
      wallet_used: walletAddress,
      positions: result,
      summary: {
        total_markets: result.length,
        total_paired: result.reduce((s, p) => s + p.paired, 0),
        total_unpaired: result.reduce((s, p) => s + p.unpaired, 0),
        total_locked_profit: result.reduce((s, p) => s + p.locked_profit, 0),
        mismatched_markets: result.filter(p => !p.up_qty_match || !p.down_qty_match).length,
      },
      polymarket_raw: positions15m.length,
      fills_raw: uniqueFills.length,
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
