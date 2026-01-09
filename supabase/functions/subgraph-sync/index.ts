import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

/**
 * Polymarket Subgraph Sync Service
 * 
 * Fetches canonical fills and positions from Goldsky subgraphs:
 * - Activity: executed trades
 * - Positions: current position state
 * 
 * Stores in subgraph_* tables for 100% truthful PnL tracking.
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Subgraph endpoints (Goldsky)
const ACTIVITY_SUBGRAPH = 'https://api.goldsky.com/api/public/project_cl6mb8i9h0003e201j6li0diw/subgraphs/activity-subgraph/0.0.4/gn';
const POSITIONS_SUBGRAPH = 'https://api.goldsky.com/api/public/project_cl6mb8i9h0003e201j6li0diw/subgraphs/positions-subgraph/0.0.7/gn';

// Config
const PAGE_SIZE = 500;
const OVERLAP_SEC = 900; // 15 min overlap for late indexing

interface SubgraphFill {
  id: string;
  user: string;
  timestamp: string;
  blockNumber?: string;
  transactionHash?: string;
  logIndex?: string;
  conditionId?: string;
  tokenId?: string;
  outcome?: string;
  side: string;
  price: string;
  size: string;
  feeAmount?: string;
  type?: string; // MAKER/TAKER
}

interface SubgraphPosition {
  id: string;
  user: string;
  conditionId?: string;
  tokenId: string;
  outcome?: string;
  balance: string;
}

// deno-lint-ignore no-explicit-any
type SupabaseClient = any;

/**
 * Execute GraphQL query against subgraph
 */
async function querySubgraph(endpoint: string, query: string, variables: Record<string, unknown> = {}): Promise<unknown> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    throw new Error(`Subgraph error: ${response.status}`);
  }

  const result = await response.json();
  if (result.errors) {
    console.error('[subgraph-sync] GraphQL errors:', result.errors);
    throw new Error(`GraphQL error: ${result.errors[0]?.message}`);
  }

  return result.data;
}

/**
 * Fetch all fills for a wallet from Activity subgraph
 */
async function fetchFills(wallet: string, sinceTimestamp?: number): Promise<SubgraphFill[]> {
  const allFills: SubgraphFill[] = [];
  let lastId = '';
  let hasMore = true;

  const sinceTs = sinceTimestamp ? String(sinceTimestamp) : '0';

  while (hasMore) {
    const query = `
      query GetFills($user: String!, $since: String!, $lastId: String!, $first: Int!) {
        trades(
          where: { 
            user: $user, 
            timestamp_gte: $since,
            id_gt: $lastId
          }
          orderBy: id
          orderDirection: asc
          first: $first
        ) {
          id
          user
          timestamp
          blockNumber
          transactionHash
          logIndex
          conditionId
          tokenId
          outcome
          side
          price
          size
          feeAmount
          type
        }
      }
    `;

    const data = await querySubgraph(ACTIVITY_SUBGRAPH, query, {
      user: wallet.toLowerCase(),
      since: sinceTs,
      lastId,
      first: PAGE_SIZE,
    }) as { trades: SubgraphFill[] };

    const fills = data.trades || [];
    allFills.push(...fills);

    if (fills.length < PAGE_SIZE) {
      hasMore = false;
    } else {
      lastId = fills[fills.length - 1].id;
    }

    console.log(`[subgraph-sync] Fetched ${fills.length} fills (total: ${allFills.length})`);
  }

  return allFills;
}

/**
 * Fetch current positions for a wallet from Positions subgraph
 */
async function fetchPositions(wallet: string): Promise<SubgraphPosition[]> {
  const allPositions: SubgraphPosition[] = [];
  let lastId = '';
  let hasMore = true;

  while (hasMore) {
    const query = `
      query GetPositions($user: String!, $lastId: String!, $first: Int!) {
        userBalances(
          where: { 
            user: $user,
            balance_gt: "0",
            id_gt: $lastId
          }
          orderBy: id
          orderDirection: asc
          first: $first
        ) {
          id
          user
          conditionId
          tokenId
          outcome
          balance
        }
      }
    `;

    const data = await querySubgraph(POSITIONS_SUBGRAPH, query, {
      user: wallet.toLowerCase(),
      lastId,
      first: PAGE_SIZE,
    }) as { userBalances: SubgraphPosition[] };

    const positions = data.userBalances || [];
    allPositions.push(...positions);

    if (positions.length < PAGE_SIZE) {
      hasMore = false;
    } else {
      lastId = positions[positions.length - 1].id;
    }

    console.log(`[subgraph-sync] Fetched ${positions.length} positions (total: ${allPositions.length})`);
  }

  return allPositions;
}

/**
 * Map outcome string to UP/DOWN
 */
function mapOutcome(outcome: string | undefined): string | null {
  if (!outcome) return null;
  const lower = outcome.toLowerCase();
  if (lower.includes('up') || lower === 'yes') return 'UP';
  if (lower.includes('down') || lower === 'no') return 'DOWN';
  return null;
}

/**
 * Execute raw SQL via RPC (workaround for new tables not in types)
 */
async function executeRaw(supabase: SupabaseClient, table: string, operation: 'upsert' | 'insert' | 'delete', data: unknown, options?: { onConflict?: string }): Promise<void> {
  // Use REST API directly for tables not in generated types
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
 * Ingest fills into database (idempotent)
 */
async function ingestFills(supabase: SupabaseClient, wallet: string, fills: SubgraphFill[]): Promise<number> {
  if (fills.length === 0) return 0;

  let ingested = 0;

  // Process in batches
  const batchSize = 100;
  for (let i = 0; i < fills.length; i += batchSize) {
    const batch = fills.slice(i, i + batchSize);
    
    const records = batch.map(f => ({
      id: f.id,
      wallet: wallet.toLowerCase(),
      block_number: f.blockNumber ? parseInt(f.blockNumber) : null,
      tx_hash: f.transactionHash || null,
      log_index: f.logIndex ? parseInt(f.logIndex) : null,
      timestamp: new Date(parseInt(f.timestamp) * 1000).toISOString(),
      market_id: f.conditionId || null,
      token_id: f.tokenId || null,
      outcome_side: mapOutcome(f.outcome),
      side: f.side?.toUpperCase() || 'BUY',
      price: parseFloat(f.price) || 0,
      size: parseFloat(f.size) || 0,
      notional: (parseFloat(f.price) || 0) * (parseFloat(f.size) || 0),
      liquidity: f.type?.toUpperCase() || null,
      fee_usd: f.feeAmount ? parseFloat(f.feeAmount) : null,
      fee_known: f.feeAmount !== undefined && f.feeAmount !== null,
      raw_json: f,
      ingested_at: new Date().toISOString(),
    }));

    await executeRaw(supabase, 'subgraph_fills', 'upsert', records, { onConflict: 'id' });
    ingested += batch.length;
  }

  return ingested;
}

/**
 * Ingest positions into database (replace all)
 */
async function ingestPositions(supabase: SupabaseClient, wallet: string, positions: SubgraphPosition[]): Promise<number> {
  const walletLower = wallet.toLowerCase();
  
  // Delete old positions for this wallet via REST
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  
  await fetch(`${supabaseUrl}/rest/v1/subgraph_positions?wallet=eq.${walletLower}`, {
    method: 'DELETE',
    headers: {
      'apikey': supabaseKey,
      'Authorization': `Bearer ${supabaseKey}`,
    },
  });

  if (positions.length === 0) return 0;

  const records = positions.map(p => ({
    id: `${walletLower}:${p.tokenId}`,
    wallet: walletLower,
    timestamp: new Date().toISOString(),
    market_id: p.conditionId || null,
    token_id: p.tokenId,
    outcome_side: mapOutcome(p.outcome),
    shares: parseFloat(p.balance) || 0,
    raw_json: p,
    updated_at: new Date().toISOString(),
  }));

  await executeRaw(supabase, 'subgraph_positions', 'insert', records);
  return positions.length;
}

/**
 * Update sync state
 */
async function updateSyncState(
  supabase: SupabaseClient, 
  type: string, 
  wallet: string, 
  recordsCount: number,
  error?: string
) {
  await executeRaw(supabase, 'subgraph_sync_state', 'upsert', {
    id: `${type}:${wallet.toLowerCase()}`,
    wallet: wallet.toLowerCase(),
    last_sync_at: new Date().toISOString(),
    records_synced: recordsCount,
    last_error: error || null,
    errors_count: error ? 1 : 0,
    updated_at: new Date().toISOString(),
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
  if (!fills || fills.length === 0) return;

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

    const record = {
      id: `${walletLower}:${marketId}`,
      wallet: walletLower,
      market_id: marketId,
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

    await fetch(`${supabaseUrl}/rest/v1/subgraph_pnl_markets?on_conflict=id`, {
      method: 'POST',
      headers: {
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify(record),
    });
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
      first_trade_at: fills[0]?.timestamp,
      last_trade_at: fills[fills.length - 1]?.timestamp,
      updated_at: new Date().toISOString(),
    };

    await fetch(`${supabaseUrl}/rest/v1/subgraph_pnl_summary?on_conflict=wallet`, {
      method: 'POST',
      headers: {
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify(summaryRecord),
    });
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
    const { data: config } = await supabase
      .from('bot_config')
      .select('polymarket_address')
      .single();

    const wallet = config?.polymarket_address;
    if (!wallet) {
      return new Response(
        JSON.stringify({ error: 'No wallet configured' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`[subgraph-sync] Starting sync for wallet: ${wallet.slice(0, 10)}...`);

    // Get last sync timestamp for incremental sync
    const syncStateRes = await fetch(
      `${supabaseUrl}/rest/v1/subgraph_sync_state?id=eq.activity:${wallet.toLowerCase()}`,
      {
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
        },
      }
    );

    const syncStateData = await syncStateRes.json();
    const syncState = syncStateData?.[0];

    const sinceTimestamp = syncState?.last_timestamp 
      ? Math.floor(new Date(syncState.last_timestamp).getTime() / 1000) - OVERLAP_SEC
      : undefined;

    // Fetch and ingest fills
    let fillsCount = 0;
    let positionsCount = 0;
    let error: string | undefined;

    try {
      console.log('[subgraph-sync] Fetching fills from Activity subgraph...');
      const fills = await fetchFills(wallet, sinceTimestamp);
      fillsCount = await ingestFills(supabase, wallet, fills);
      await updateSyncState(supabase, 'activity', wallet, fillsCount);
      console.log(`[subgraph-sync] Ingested ${fillsCount} fills`);
    } catch (e) {
      error = String(e);
      console.error('[subgraph-sync] Error fetching fills:', e);
      await updateSyncState(supabase, 'activity', wallet, 0, error);
    }

    try {
      console.log('[subgraph-sync] Fetching positions from Positions subgraph...');
      const positions = await fetchPositions(wallet);
      positionsCount = await ingestPositions(supabase, wallet, positions);
      await updateSyncState(supabase, 'positions', wallet, positionsCount);
      console.log(`[subgraph-sync] Ingested ${positionsCount} positions`);
    } catch (e) {
      error = String(e);
      console.error('[subgraph-sync] Error fetching positions:', e);
      await updateSyncState(supabase, 'positions', wallet, 0, error);
    }

    // Compute PnL
    console.log('[subgraph-sync] Computing market PnL...');
    await computeMarketPnl(wallet);

    console.log('[subgraph-sync] Sync complete');

    return new Response(
      JSON.stringify({
        success: true,
        wallet,
        fills_synced: fillsCount,
        positions_synced: positionsCount,
        error,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('[subgraph-sync] Unexpected error:', error);
    return new Response(
      JSON.stringify({ error: String(error) }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
