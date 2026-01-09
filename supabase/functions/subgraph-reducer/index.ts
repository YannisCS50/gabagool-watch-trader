import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

/**
 * CANONICAL ACCOUNTING REDUCER
 * 
 * Pipeline: Subgraph Events → Normalized Cashflows → Position Reducer → Database State
 * 
 * This is the ONLY place where PnL is computed. The dashboard reads from database only.
 * 
 * Reducer Rules:
 * - BUY: increase shares_held, increase total_cost_usd
 * - SELL: decrease shares_held, realize PnL on sold shares
 * - REDEEM (win): payout = shares × 1.0, realize payout - cost, state = CLAIMED
 * - REDEEM (loss): realize -cost, state = LOST
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const DATA_API_BASE = 'https://data-api.polymarket.com';
const PAGE_SIZE = 500;
const MAX_PAGES = 10;
const MAX_AGE_DAYS = 90;

interface Activity {
  proxyWallet: string;
  timestamp: number;
  conditionId: string;
  type: string;
  size: number;
  usdcSize: number;
  transactionHash: string;
  price: number;
  asset: string;
  side: string;
  outcomeIndex: number;
  title: string;
  slug: string;
  outcome: string;
  feesPaid?: number;
}

interface Position {
  wallet: string;
  market_id: string;
  outcome: 'UP' | 'DOWN';
  shares_held: number;
  total_cost_usd: number;
  realized_pnl: number;
  state: 'OPEN' | 'CLAIMED' | 'LOST' | 'SOLD';
}

interface MarketState {
  wallet: string;
  market_id: string;
  market_slug: string | null;
  state: 'OPEN' | 'SETTLED';
  resolved_outcome: 'UP' | 'DOWN' | 'SPLIT' | null;
  total_cost: number;
  total_payout: number;
  realized_pnl: number;
  has_buy: boolean;
  has_sell: boolean;
  has_redeem: boolean;
  is_claimed: boolean;
  is_lost: boolean;
}

// REST helper
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
    if (options?.filter) url += `?${options.filter}`;
  }

  const response = await fetch(url, {
    method,
    headers,
    body: operation !== 'delete' ? JSON.stringify(data) : undefined,
  });

  if (!response.ok) {
    const text = await response.text();
    console.error(`[reducer] REST error for ${table}:`, text);
  }
}

// Fetch ALL activity from Polymarket
async function fetchActivity(wallet: string): Promise<Activity[]> {
  const all: Activity[] = [];
  let offset = 0;
  let pages = 0;
  const cutoff = Math.floor(Date.now() / 1000) - (MAX_AGE_DAYS * 24 * 60 * 60);

  console.log(`[reducer] Fetching activity for ${wallet.slice(0, 10)}...`);

  while (pages < MAX_PAGES) {
    const url = `${DATA_API_BASE}/activity?user=${wallet}&limit=${PAGE_SIZE}&offset=${offset}`;
    const resp = await fetch(url);
    if (!resp.ok) break;

    const data = await resp.json() as Activity[];
    if (!data?.length) break;

    const recent = data.filter(a => a.timestamp >= cutoff);
    all.push(...recent);
    pages++;

    if (data.length < PAGE_SIZE || Math.min(...data.map(a => a.timestamp)) < cutoff) break;
    offset += PAGE_SIZE;
  }

  console.log(`[reducer] Fetched ${all.length} activities`);
  return all;
}

// Fetch current positions
async function fetchPositions(wallet: string): Promise<{ conditionId: string; outcomeIndex: number; size: number; avgPrice: number }[]> {
  try {
    const resp = await fetch(`${DATA_API_BASE}/positions?user=${wallet}`);
    if (!resp.ok) return [];
    return await resp.json() || [];
  } catch {
    return [];
  }
}

// Map activity to event type
function mapEventType(a: Activity): 'BUY' | 'SELL' | 'REDEEM' | 'TRANSFER' | 'MERGE' | 'SPLIT' {
  const t = a.type?.toUpperCase() || '';
  if (t === 'TRADE') return a.side?.toUpperCase() === 'SELL' ? 'SELL' : 'BUY';
  if (t === 'REDEEM' || t === 'REDEMPTION') return 'REDEEM';
  if (t === 'MERGE') return 'MERGE';
  if (t === 'SPLIT') return 'SPLIT';
  return 'TRANSFER';
}

// MAIN REDUCER
async function runReducer(wallet: string): Promise<{
  eventsIngested: number;
  marketsProcessed: number;
  realizedPnl: number;
  settledMarkets: number;
  claimedMarkets: number;
  lostMarkets: number;
}> {
  const walletLower = wallet.toLowerCase();

  // 1. Fetch all activity
  const activities = await fetchActivity(wallet);
  if (!activities.length) {
    return { eventsIngested: 0, marketsProcessed: 0, realizedPnl: 0, settledMarkets: 0, claimedMarkets: 0, lostMarkets: 0 };
  }

  // 2. Store raw events
  const rawEvents = activities.map(a => ({
    id: `${a.transactionHash}:${a.conditionId}:${a.outcomeIndex}:${a.timestamp}`,
    tx_hash: a.transactionHash,
    event_type: mapEventType(a),
    market_id: a.conditionId,
    outcome: a.outcomeIndex === 0 ? 'UP' : 'DOWN',
    shares: a.size || 0,
    price: a.price || 0,
    amount_usd: a.usdcSize || (a.price * a.size) || 0,
    fee_usd: a.feesPaid,
    wallet: walletLower,
    timestamp: new Date(a.timestamp * 1000).toISOString(),
    raw_json: a,
  }));

  await executeRest('raw_subgraph_events', 'upsert', rawEvents, { onConflict: 'id' });
  console.log(`[reducer] Stored ${rawEvents.length} raw events`);

  // 3. Create normalized cashflows
  const cashflows = activities.map(a => {
    const type = mapEventType(a);
    const shares = a.size || 0;
    const price = a.price || 0;
    const usdcSize = a.usdcSize || (price * shares);
    const fee = a.feesPaid || 0;

    let direction: 'IN' | 'OUT';
    let category: 'BUY' | 'SELL' | 'REDEEM' | 'FEE' | 'LOSS' | 'TRANSFER';
    let amount: number;

    switch (type) {
      case 'BUY':
        direction = 'OUT';
        category = 'BUY';
        amount = usdcSize + fee;
        break;
      case 'SELL':
        direction = 'IN';
        category = 'SELL';
        amount = usdcSize - fee;
        break;
      case 'REDEEM':
        direction = 'IN';
        category = 'REDEEM';
        // Infer payout from shares if usdcSize is 0 (binary: 1.0 per share)
        amount = usdcSize > 0 ? usdcSize : shares;
        break;
      default:
        direction = 'IN';
        category = 'TRANSFER';
        amount = usdcSize;
    }

    return {
      id: `${a.transactionHash}:${a.conditionId}:${a.outcomeIndex}:${a.timestamp}:${type}`,
      market_id: a.conditionId,
      outcome: a.outcomeIndex === 0 ? 'UP' : 'DOWN',
      direction,
      category,
      amount_usd: amount,
      shares_delta: type === 'BUY' ? shares : (type === 'SELL' || type === 'REDEEM' ? -shares : 0),
      wallet: walletLower,
      timestamp: new Date(a.timestamp * 1000).toISOString(),
      source_event_id: `${a.transactionHash}:${a.conditionId}:${a.outcomeIndex}:${a.timestamp}`,
    };
  });

  await executeRest('cashflow_ledger', 'upsert', cashflows, { onConflict: 'id' });
  console.log(`[reducer] Stored ${cashflows.length} cashflows`);

  // 4. Group by market and REDUCE to positions + market state
  const byMarket = new Map<string, Activity[]>();
  for (const a of activities) {
    if (!a.conditionId) continue;
    if (!byMarket.has(a.conditionId)) byMarket.set(a.conditionId, []);
    byMarket.get(a.conditionId)!.push(a);
  }

  // Fetch current positions from API
  const currentPositions = await fetchPositions(wallet);
  const currentPosMap = new Map<string, number>();
  for (const p of currentPositions) {
    currentPosMap.set(`${p.conditionId}:${p.outcomeIndex}`, p.size);
  }

  const positions: Position[] = [];
  const marketStates: MarketState[] = [];
  let totalRealizedPnl = 0;
  let settledCount = 0;
  let claimedCount = 0;
  let lostCount = 0;

  for (const [marketId, events] of byMarket) {
    // Sort by timestamp
    events.sort((a, b) => a.timestamp - b.timestamp);

    // Track state
    let upShares = 0, downShares = 0;
    let upCost = 0, downCost = 0;
    let upRealized = 0, downRealized = 0;
    let hasBuy = false, hasSell = false, hasRedeem = false;
    let isClaimed = false, isLost = false;
    let marketSlug: string | null = null;
    let redeemOutcome: 'UP' | 'DOWN' | null = null;
    let redeemPayout = 0;

    for (const e of events) {
      const type = mapEventType(e);
      const outcome = e.outcomeIndex === 0 ? 'UP' : 'DOWN';
      const shares = e.size || 0;
      const price = e.price || 0;
      const cost = shares * price;

      if (!marketSlug && e.slug) marketSlug = e.slug;

      if (type === 'BUY') {
        hasBuy = true;
        if (outcome === 'UP') {
          upCost += cost;
          upShares += shares;
        } else {
          downCost += cost;
          downShares += shares;
        }
      } else if (type === 'SELL') {
        hasSell = true;
        // Realize PnL on sold shares
        if (outcome === 'UP' && upShares > 0) {
          const avgCost = upCost / upShares;
          const soldShares = Math.min(shares, upShares);
          const costBasis = soldShares * avgCost;
          const proceeds = soldShares * price;
          upRealized += proceeds - costBasis;
          upShares -= soldShares;
          upCost = upShares > 0 ? upShares * avgCost : 0;
        } else if (outcome === 'DOWN' && downShares > 0) {
          const avgCost = downCost / downShares;
          const soldShares = Math.min(shares, downShares);
          const costBasis = soldShares * avgCost;
          const proceeds = soldShares * price;
          downRealized += proceeds - costBasis;
          downShares -= soldShares;
          downCost = downShares > 0 ? downShares * avgCost : 0;
        }
      } else if (type === 'REDEEM') {
        hasRedeem = true;
        redeemOutcome = outcome;
        // Payout: use usdcSize if available, else infer from shares × 1.0
        const payout = e.usdcSize > 0 ? e.usdcSize : shares;
        redeemPayout += payout;

        // Realize based on which side was redeemed
        if (outcome === 'UP') {
          const costBasis = upCost;
          upRealized += payout - costBasis;
          upShares = 0;
          upCost = 0;
        } else {
          const costBasis = downCost;
          downRealized += payout - costBasis;
          downShares = 0;
          downCost = 0;
        }
      }
    }

    // Check current positions from API
    const currentUp = currentPosMap.get(`${marketId}:0`) || 0;
    const currentDown = currentPosMap.get(`${marketId}:1`) || 0;
    const hasOpenPosition = currentUp > 0 || currentDown > 0;

    // Determine lifecycle state
    let marketState: 'OPEN' | 'SETTLED' = 'OPEN';
    let resolvedOutcome: 'UP' | 'DOWN' | 'SPLIT' | null = null;

    if (hasRedeem) {
      // CLAIMED: We have redemption
      isClaimed = true;
      marketState = 'SETTLED';
      resolvedOutcome = redeemOutcome;
      claimedCount++;
    } else if (hasSell && !hasOpenPosition && upShares === 0 && downShares === 0) {
      // SOLD: Closed via selling
      marketState = 'SETTLED';
    } else if (!hasOpenPosition && !hasRedeem && (upCost > 0 || downCost > 0)) {
      // Position closed but no REDEEM - check if LOST
      // We can only determine LOST if we have resolution data
      // For now, mark as potentially lost
      isLost = true;
      marketState = 'SETTLED';
      // Realize the loss: -remaining cost basis
      upRealized -= upCost;
      downRealized -= downCost;
      lostCount++;
    }

    if (marketState === 'SETTLED') settledCount++;

    const totalCost = upCost + downCost;
    const totalRealized = upRealized + downRealized;
    totalRealizedPnl += totalRealized;

    // Store positions
    if (upShares > 0 || upCost > 0 || upRealized !== 0) {
      positions.push({
        wallet: walletLower,
        market_id: marketId,
        outcome: 'UP',
        shares_held: Math.max(0, currentUp || upShares),
        total_cost_usd: upCost,
        realized_pnl: upRealized,
        state: isClaimed ? 'CLAIMED' : (isLost ? 'LOST' : (hasSell && upShares === 0 ? 'SOLD' : 'OPEN')),
      });
    }

    if (downShares > 0 || downCost > 0 || downRealized !== 0) {
      positions.push({
        wallet: walletLower,
        market_id: marketId,
        outcome: 'DOWN',
        shares_held: Math.max(0, currentDown || downShares),
        total_cost_usd: downCost,
        realized_pnl: downRealized,
        state: isClaimed ? 'CLAIMED' : (isLost ? 'LOST' : (hasSell && downShares === 0 ? 'SOLD' : 'OPEN')),
      });
    }

    // Store market lifecycle
    marketStates.push({
      wallet: walletLower,
      market_id: marketId,
      market_slug: marketSlug,
      state: marketState,
      resolved_outcome: resolvedOutcome,
      total_cost: totalCost,
      total_payout: redeemPayout,
      realized_pnl: totalRealized,
      has_buy: hasBuy,
      has_sell: hasSell,
      has_redeem: hasRedeem,
      is_claimed: isClaimed,
      is_lost: isLost,
    });
  }

  // 5. Store canonical positions
  const positionRecords = positions.map(p => ({
    id: `${p.wallet}:${p.market_id}:${p.outcome}`,
    wallet: p.wallet,
    market_id: p.market_id,
    outcome: p.outcome,
    shares_held: p.shares_held,
    total_cost_usd: p.total_cost_usd,
    realized_pnl: p.realized_pnl,
    state: p.state,
    updated_at: new Date().toISOString(),
  }));

  if (positionRecords.length > 0) {
    await executeRest('canonical_positions', 'upsert', positionRecords, { onConflict: 'id' });
    console.log(`[reducer] Stored ${positionRecords.length} positions`);
  }

  // 6. Store market lifecycle
  const marketRecords = marketStates.map(m => ({
    id: `${m.wallet}:${m.market_id}`,
    wallet: m.wallet,
    market_id: m.market_id,
    market_slug: m.market_slug,
    state: m.state,
    resolved_outcome: m.resolved_outcome,
    total_cost: m.total_cost,
    total_payout: m.total_payout,
    realized_pnl: m.realized_pnl,
    has_buy: m.has_buy,
    has_sell: m.has_sell,
    has_redeem: m.has_redeem,
    is_claimed: m.is_claimed,
    is_lost: m.is_lost,
    updated_at: new Date().toISOString(),
  }));

  if (marketRecords.length > 0) {
    await executeRest('market_lifecycle', 'upsert', marketRecords, { onConflict: 'id' });
    console.log(`[reducer] Stored ${marketRecords.length} market states`);
  }

  // 7. Store PnL snapshot
  const snapshot = {
    id: `${walletLower}:${Date.now()}`,
    wallet: walletLower,
    ts: new Date().toISOString(),
    realized_pnl: totalRealizedPnl,
    unrealized_pnl: 0,
    total_pnl: totalRealizedPnl,
    total_markets: marketStates.length,
    settled_markets: settledCount,
    open_markets: marketStates.length - settledCount,
    claimed_markets: claimedCount,
    lost_markets: lostCount,
    total_cost: marketStates.reduce((s, m) => s + m.total_cost, 0),
    total_fees: 0,
  };

  await executeRest('pnl_snapshots', 'insert', [snapshot]);
  console.log(`[reducer] Created PnL snapshot: realized=$${totalRealizedPnl.toFixed(2)}`);

  return {
    eventsIngested: activities.length,
    marketsProcessed: marketStates.length,
    realizedPnl: totalRealizedPnl,
    settledMarkets: settledCount,
    claimedMarkets: claimedCount,
    lostMarkets: lostCount,
  };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    // Get wallet from bot_config
    const configRes = await fetch(`${supabaseUrl}/rest/v1/bot_config?select=polymarket_address&limit=1`, {
      headers: {
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
      },
    });

    const configs = await configRes.json();
    const wallet = configs?.[0]?.polymarket_address;

    if (!wallet) {
      return new Response(
        JSON.stringify({ error: 'No wallet configured' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 }
      );
    }

    console.log(`[reducer] Starting canonical accounting sync for ${wallet.slice(0, 10)}...`);

    const result = await runReducer(wallet);

    console.log(`[reducer] Complete:`, JSON.stringify(result));

    return new Response(JSON.stringify({ success: true, ...result }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('[reducer] Fatal error:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 }
    );
  }
});
