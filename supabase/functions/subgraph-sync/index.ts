import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

/**
 * Polymarket Data Sync Service
 * 
 * Fetches canonical fills and positions from Polymarket Data API:
 * - Activity: executed trades  
 * - Positions: current position state
 * 
 * Stores in subgraph_* tables for 100% truthful PnL tracking.
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Polymarket Data API endpoints
const DATA_API_BASE = 'https://data-api.polymarket.com';

// Config
const PAGE_SIZE = 500;
const MAX_PAGES = 10; // Limit to prevent CPU timeout (10 * 500 = 5000 max records)
const MAX_AGE_DAYS = 30; // Only fetch last 30 days

interface PolymarketActivity {
  proxyWallet: string;
  timestamp: number;
  conditionId: string;
  type: string; // TRADE, REDEEM, etc.
  size: number;
  usdcSize: number;
  transactionHash: string;
  price: number;
  asset: string;
  side: string; // BUY, SELL
  outcomeIndex: number;
  title: string;
  slug: string;
  outcome: string; // Yes, No
}

interface PolymarketPosition {
  conditionId: string;
  outcomeIndex: number;
  size: number;
  avgPrice: number;
  currentPrice: number;
  pnl: number;
  pnlPercent: number;
  title: string;
  slug: string;
  outcome: string;
}

// deno-lint-ignore no-explicit-any
type SupabaseClient = any;

/**
 * Fetch user activity from Polymarket Data API
 */
async function fetchActivity(wallet: string): Promise<PolymarketActivity[]> {
  const allActivity: PolymarketActivity[] = [];
  let offset = 0;
  let pagesLoaded = 0;
  const cutoffTime = Math.floor(Date.now() / 1000) - (MAX_AGE_DAYS * 24 * 60 * 60);

  console.log(`[subgraph-sync] Fetching recent activity (last ${MAX_AGE_DAYS} days, max ${MAX_PAGES} pages)...`);

  while (pagesLoaded < MAX_PAGES) {
    const url = `${DATA_API_BASE}/activity?user=${wallet}&limit=${PAGE_SIZE}&offset=${offset}`;
    
    const response = await fetch(url);
    if (!response.ok) {
      console.error(`[subgraph-sync] Activity API error: ${response.status}`);
      break;
    }

    const data = await response.json() as PolymarketActivity[];
    
    if (!data || data.length === 0) {
      break;
    }
    
    // Filter to TRADE activities within time window
    const recentTrades = data.filter(a => a.type === 'TRADE' && a.timestamp >= cutoffTime);
    allActivity.push(...recentTrades);
    
    pagesLoaded++;
    
    // Stop if we've gone past our time window or no more data
    const oldestInBatch = Math.min(...data.map(a => a.timestamp));
    if (oldestInBatch < cutoffTime || data.length < PAGE_SIZE) {
      console.log(`[subgraph-sync] Reached cutoff or end of data`);
      break;
    }
    
    offset += PAGE_SIZE;
    console.log(`[subgraph-sync] Page ${pagesLoaded}/${MAX_PAGES}: ${recentTrades.length} trades (total: ${allActivity.length})`);
  }

  console.log(`[subgraph-sync] Fetched ${allActivity.length} trades in ${pagesLoaded} pages`);
  return allActivity;
}

/**
 * Fetch user positions from Polymarket Data API (via profile endpoint)
 */
async function fetchPositions(wallet: string): Promise<PolymarketPosition[]> {
  console.log(`[subgraph-sync] Fetching positions for wallet ${wallet.slice(0, 10)}...`);

  try {
    // Use the profile positions endpoint
    const url = `${DATA_API_BASE}/positions?user=${wallet}`;
    
    const response = await fetch(url);
    if (!response.ok) {
      console.error(`[subgraph-sync] Positions API error: ${response.status}`);
      return [];
    }

    const data = await response.json();
    
    if (!data || !Array.isArray(data)) {
      console.log(`[subgraph-sync] No positions data or unexpected format`);
      return [];
    }

    console.log(`[subgraph-sync] Fetched ${data.length} positions`);
    return data as PolymarketPosition[];
  } catch (error) {
    console.error(`[subgraph-sync] Error fetching positions:`, error);
    return [];
  }
}

/**
 * Map outcome string to UP/DOWN based on asset context
 */
function mapOutcome(outcome: string | undefined, asset?: string): string | null {
  if (!outcome) return null;
  const lower = outcome.toLowerCase();
  
  // For crypto price markets, Yes = Up, No = Down
  if (lower === 'yes' || lower.includes('up')) return 'UP';
  if (lower === 'no' || lower.includes('down')) return 'DOWN';
  
  // Fallback: outcomeIndex 0 = Yes/Up, 1 = No/Down
  return null;
}

/**
 * Execute REST API operation
 */
async function executeRest(
  table: string, 
  operation: 'upsert' | 'insert' | 'delete', 
  data?: unknown, 
  options?: { onConflict?: string; filter?: string }
): Promise<void> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  
  let url = `${supabaseUrl}/rest/v1/${table}`;
  let method = 'POST';
  const headers: Record<string, string> = {
    'apikey': supabaseKey,
    'Authorization': `Bearer ${supabaseKey}`,
    'Content-Type': 'application/json',
    'Prefer': 'return=minimal',
  };

  if (operation === 'upsert' && options?.onConflict) {
    headers['Prefer'] = `resolution=merge-duplicates,return=minimal`;
    url += `?on_conflict=${options.onConflict}`;
  }

  if (operation === 'delete') {
    method = 'DELETE';
    if (options?.filter) {
      url += `?${options.filter}`;
    }
  }

  const response = await fetch(url, {
    method,
    headers,
    body: operation !== 'delete' ? JSON.stringify(data) : undefined,
  });

  if (!response.ok) {
    const text = await response.text();
    console.error(`[subgraph-sync] REST error for ${table}:`, text);
  }
}

/**
 * Ingest activity as fills into database (idempotent)
 */
async function ingestFills(wallet: string, activities: PolymarketActivity[]): Promise<number> {
  if (activities.length === 0) return 0;

  let ingested = 0;
  const batchSize = 100;

  for (let i = 0; i < activities.length; i += batchSize) {
    const batch = activities.slice(i, i + batchSize);
    
    const records = batch.map(a => ({
      id: `${a.transactionHash}:${a.conditionId}:${a.outcomeIndex}:${a.timestamp}`,
      wallet: wallet.toLowerCase(),
      block_number: null,
      tx_hash: a.transactionHash || null,
      log_index: null,
      timestamp: new Date(a.timestamp * 1000).toISOString(),
      market_id: a.conditionId || null,
      token_id: null,
      outcome_side: a.outcomeIndex === 0 ? 'UP' : 'DOWN',
      side: a.side?.toUpperCase() || 'BUY',
      price: a.price || 0,
      size: a.size || 0,
      notional: a.usdcSize || (a.price * a.size) || 0,
      liquidity: null,
      fee_usd: null,
      fee_known: false,
      raw_json: a,
      ingested_at: new Date().toISOString(),
    }));

    await executeRest('subgraph_fills', 'upsert', records, { onConflict: 'id' });
    ingested += batch.length;
  }

  console.log(`[subgraph-sync] Ingested ${ingested} fills`);
  return ingested;
}

/**
 * Ingest positions into database (replace all)
 */
async function ingestPositions(wallet: string, positions: PolymarketPosition[]): Promise<number> {
  const walletLower = wallet.toLowerCase();
  
  // Delete old positions for this wallet
  await executeRest('subgraph_positions', 'delete', undefined, { filter: `wallet=eq.${walletLower}` });

  if (positions.length === 0) return 0;

  const records = positions.map(p => ({
    id: `${walletLower}:${p.conditionId}:${p.outcomeIndex}`,
    wallet: walletLower,
    timestamp: new Date().toISOString(),
    market_id: p.conditionId || null,
    token_id: null,
    outcome_side: p.outcomeIndex === 0 ? 'UP' : 'DOWN',
    shares: p.size || 0,
    avg_cost: p.avgPrice || null,
    raw_json: p,
  }));

  await executeRest('subgraph_positions', 'insert', records);
  console.log(`[subgraph-sync] Ingested ${positions.length} positions`);
  return positions.length;
}

/**
 * Update sync state
 */
async function updateSyncState(
  type: string, 
  wallet: string, 
  recordsCount: number,
  error?: string
) {
  await executeRest('subgraph_sync_state', 'upsert', {
    id: `${type}:${wallet.toLowerCase()}`,
    wallet: wallet.toLowerCase(),
    last_sync_at: new Date().toISOString(),
    records_synced: recordsCount,
    last_error: error || null,
    errors_count: error ? 1 : 0,
  }, { onConflict: 'id' });
}

/**
 * Compute PnL for markets based on fills
 */
async function computeMarketPnl(wallet: string): Promise<void> {
  const walletLower = wallet.toLowerCase();
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

  // Get all fills for wallet
  const fillsRes = await fetch(
    `${supabaseUrl}/rest/v1/subgraph_fills?wallet=eq.${walletLower}&order=timestamp.asc`,
    {
      headers: {
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
      },
    }
  );

  const fills = await fillsRes.json();
  if (!fills || fills.length === 0) {
    console.log(`[subgraph-sync] No fills to compute PnL`);
    return;
  }

  console.log(`[subgraph-sync] Computing PnL for ${fills.length} fills...`);

  // Group fills by market
  const marketFills = new Map<string, typeof fills>();
  for (const fill of fills) {
    const marketId = fill.market_id || 'unknown';
    if (!marketFills.has(marketId)) {
      marketFills.set(marketId, []);
    }
    marketFills.get(marketId)!.push(fill);
  }

  // Compute PnL per market using average cost method
  for (const [marketId, mFills] of marketFills) {
    let upShares = 0;
    let downShares = 0;
    let upCost = 0;
    let downCost = 0;
    let realizedPnl = 0;
    let feesKnown = 0;
    let feesUnknownCount = 0;

    for (const fill of mFills) {
      const side = fill.outcome_side;
      const tradeSize = Number(fill.size) || 0;
      const tradePrice = Number(fill.price) || 0;
      const tradeCost = tradeSize * tradePrice;
      const fee = Number(fill.fee_usd) || 0;
      
      if (fill.fee_known) {
        feesKnown += fee;
      } else {
        feesUnknownCount++;
      }

      if (fill.side === 'BUY') {
        if (side === 'UP') {
          upCost += tradeCost;
          upShares += tradeSize;
        } else if (side === 'DOWN') {
          downCost += tradeCost;
          downShares += tradeSize;
        }
      } else if (fill.side === 'SELL') {
        // Realize PnL on sells
        if (side === 'UP' && upShares > 0) {
          const avgCost = upCost / upShares;
          const sellShares = Math.min(tradeSize, upShares);
          const proceeds = sellShares * tradePrice;
          const costBasis = sellShares * avgCost;
          realizedPnl += proceeds - costBasis - fee;
          upShares -= sellShares;
          upCost = upShares > 0 ? (upCost - costBasis) : 0;
        } else if (side === 'DOWN' && downShares > 0) {
          const avgCost = downCost / downShares;
          const sellShares = Math.min(tradeSize, downShares);
          const proceeds = sellShares * tradePrice;
          const costBasis = sellShares * avgCost;
          realizedPnl += proceeds - costBasis - fee;
          downShares -= sellShares;
          downCost = downShares > 0 ? (downCost - costBasis) : 0;
        }
      }
    }

    const avgUp = upShares > 0 ? upCost / upShares : null;
    const avgDown = downShares > 0 ? downCost / downShares : null;
    const totalCost = upCost + downCost;

    // Determine confidence
    let confidence: 'HIGH' | 'MEDIUM' | 'LOW' = 'HIGH';
    let realizedConfidence: 'HIGH' | 'MEDIUM' | 'LOW' = 'HIGH';
    
    if (feesUnknownCount > 0) {
      realizedConfidence = 'MEDIUM';
      confidence = 'MEDIUM';
    }

    // Get market slug from raw_json
    const marketSlug = mFills[0]?.raw_json?.slug || null;

    const record = {
      id: `${walletLower}:${marketId}`,
      wallet: walletLower,
      market_id: marketId,
      market_slug: marketSlug,
      up_shares: upShares,
      down_shares: downShares,
      avg_up_cost: avgUp,
      avg_down_cost: avgDown,
      total_cost: totalCost,
      realized_pnl_usd: realizedPnl,
      realized_confidence: realizedConfidence,
      unrealized_confidence: 'LOW',
      fees_known_usd: feesKnown,
      fees_unknown_count: feesUnknownCount,
      confidence,
      updated_at: new Date().toISOString(),
    };

    await executeRest('subgraph_pnl_markets', 'upsert', record, { onConflict: 'id' });
  }

  // Update wallet summary
  const marketPnlRes = await fetch(
    `${supabaseUrl}/rest/v1/subgraph_pnl_markets?wallet=eq.${walletLower}`,
    {
      headers: {
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
      },
    }
  );

  const marketPnls = await marketPnlRes.json();
  if (marketPnls && marketPnls.length > 0) {
    let totalRealized = 0;
    let totalFeesKnown = 0;
    let totalFeesUnknownCount = 0;
    let settledCount = 0;
    let openCount = 0;

    for (const m of marketPnls) {
      totalRealized += Number(m.realized_pnl_usd) || 0;
      totalFeesKnown += Number(m.fees_known_usd) || 0;
      totalFeesUnknownCount += m.fees_unknown_count || 0;
      if (m.is_settled) settledCount++;
      else openCount++;
    }

    const summaryRecord = {
      wallet: walletLower,
      total_realized_pnl: totalRealized,
      total_fees_known: totalFeesKnown,
      total_fees_unknown_count: totalFeesUnknownCount,
      total_fills: fills.length,
      total_markets: marketPnls.length,
      settled_markets: settledCount,
      open_markets: openCount,
      realized_confidence: totalFeesUnknownCount > 0 ? 'MEDIUM' : 'HIGH',
      unrealized_confidence: 'LOW',
      overall_confidence: totalFeesUnknownCount > 0 ? 'MEDIUM' : 'HIGH',
      updated_at: new Date().toISOString(),
    };

    await executeRest('subgraph_pnl_summary', 'upsert', summaryRecord, { onConflict: 'wallet' });
    console.log(`[subgraph-sync] Updated PnL summary: ${totalRealized.toFixed(2)} realized across ${marketPnls.length} markets`);
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Get wallet from bot_config
    const { data: config, error: configError } = await supabase
      .from('bot_config')
      .select('polymarket_address')
      .single();

    if (configError || !config?.polymarket_address) {
      console.error('[subgraph-sync] No wallet configured:', configError);
      return new Response(
        JSON.stringify({ error: 'No wallet configured in bot_config' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 }
      );
    }

    const wallet = config.polymarket_address;
    console.log(`[subgraph-sync] Starting sync for wallet: ${wallet.slice(0, 10)}...`);

    // Fetch from Polymarket Data API
    console.log('[subgraph-sync] Fetching activity from Polymarket Data API...');
    let fillsIngested = 0;
    let positionsIngested = 0;
    let fillsError: string | undefined;
    let positionsError: string | undefined;

    try {
      const activities = await fetchActivity(wallet);
      fillsIngested = await ingestFills(wallet, activities);
      await updateSyncState('fills', wallet, fillsIngested);
    } catch (error) {
      fillsError = error instanceof Error ? error.message : String(error);
      console.error('[subgraph-sync] Error fetching/ingesting fills:', fillsError);
      await updateSyncState('fills', wallet, 0, fillsError);
    }

    console.log('[subgraph-sync] Fetching positions from Polymarket Data API...');
    try {
      const positions = await fetchPositions(wallet);
      positionsIngested = await ingestPositions(wallet, positions);
      await updateSyncState('positions', wallet, positionsIngested);
    } catch (error) {
      positionsError = error instanceof Error ? error.message : String(error);
      console.error('[subgraph-sync] Error fetching/ingesting positions:', positionsError);
      await updateSyncState('positions', wallet, 0, positionsError);
    }

    // Compute market PnL
    console.log('[subgraph-sync] Computing market PnL...');
    await computeMarketPnl(wallet);

    console.log('[subgraph-sync] Sync complete');

    return new Response(
      JSON.stringify({
        success: true,
        wallet,
        fills_ingested: fillsIngested,
        positions_ingested: positionsIngested,
        fills_error: fillsError || null,
        positions_error: positionsError || null,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('[subgraph-sync] Fatal error:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 }
    );
  }
});
