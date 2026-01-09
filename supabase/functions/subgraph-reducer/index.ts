import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

/**
 * CANONICAL ACCOUNTING REDUCER v2
 * 
 * COMPLETE HISTORICAL INGESTION - No time limits, no pagination truncation
 * 
 * Pipeline: Subgraph Events → Normalized Cashflows → Position Reducer → Database State
 * 
 * This is the ONLY place where PnL is computed. The dashboard reads from database only.
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const DATA_API_BASE = 'https://data-api.polymarket.com';
const PAGE_SIZE = 500;
// NO MAX_PAGES LIMIT - fetch until genesis
// NO MAX_AGE_DAYS - fetch complete history

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
  blockNumber?: number;
  logIndex?: number;
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

interface DailyAggregate {
  date: string;
  realized_pnl: number;
  volume_traded: number;
  buy_count: number;
  sell_count: number;
  redeem_count: number;
  markets: Set<string>;
}

// REST helper with batch support
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

// Batch insert helper for large datasets
async function batchUpsert(table: string, records: unknown[], onConflict: string, batchSize = 100): Promise<void> {
  for (let i = 0; i < records.length; i += batchSize) {
    const batch = records.slice(i, i + batchSize);
    await executeRest(table, 'upsert', batch, { onConflict });
  }
}

/**
 * Fetch COMPLETE activity history from Polymarket - NO LIMITS
 * Continues until no more events exist
 */
async function fetchCompleteActivity(wallet: string): Promise<Activity[]> {
  const all: Activity[] = [];
  let offset = 0;
  let page = 0;

  console.log(`[reducer] Fetching COMPLETE history for ${wallet.slice(0, 10)}...`);

  while (true) {
    const url = `${DATA_API_BASE}/activity?user=${wallet}&limit=${PAGE_SIZE}&offset=${offset}`;
    
    try {
      const resp = await fetch(url);
      if (!resp.ok) {
        console.error(`[reducer] API error at offset ${offset}: ${resp.status}`);
        break;
      }

      const data = await resp.json() as Activity[];
      if (!data?.length) {
        console.log(`[reducer] No more events at offset ${offset}`);
        break;
      }

      all.push(...data);
      page++;
      
      console.log(`[reducer] Page ${page}: +${data.length} events (total: ${all.length})`);

      if (data.length < PAGE_SIZE) {
        console.log(`[reducer] Reached end of history at page ${page}`);
        break;
      }

      offset += PAGE_SIZE;
      
      // Small delay to avoid rate limiting
      if (page % 5 === 0) {
        await new Promise(r => setTimeout(r, 100));
      }
    } catch (err) {
      console.error(`[reducer] Fetch error at offset ${offset}:`, err);
      break;
    }
  }

  // Sort by timestamp ascending (oldest first)
  all.sort((a, b) => a.timestamp - b.timestamp);
  
  console.log(`[reducer] Complete history: ${all.length} events`);
  if (all.length > 0) {
    const oldest = new Date(all[0].timestamp * 1000).toISOString();
    const newest = new Date(all[all.length - 1].timestamp * 1000).toISOString();
    console.log(`[reducer] Range: ${oldest} to ${newest}`);
  }
  
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

// Get UTC date string from timestamp
function toUTCDate(ts: number): string {
  return new Date(ts * 1000).toISOString().split('T')[0];
}

// Create unique event ID
function createEventId(a: Activity): string {
  // Use tx_hash + logIndex if available, otherwise use timestamp-based
  const logIdx = a.logIndex ?? a.timestamp;
  return `${a.transactionHash}:${a.conditionId}:${a.outcomeIndex}:${logIdx}`;
}

// MAIN REDUCER
async function runReducer(wallet: string): Promise<{
  eventsIngested: number;
  marketsProcessed: number;
  realizedPnl: number;
  settledMarkets: number;
  claimedMarkets: number;
  lostMarkets: number;
  oldestEvent: string | null;
  newestEvent: string | null;
  daysWithActivity: number;
}> {
  const walletLower = wallet.toLowerCase();

  // 1. Fetch COMPLETE history - no limits
  const activities = await fetchCompleteActivity(wallet);
  if (!activities.length) {
    return { 
      eventsIngested: 0, marketsProcessed: 0, realizedPnl: 0, 
      settledMarkets: 0, claimedMarkets: 0, lostMarkets: 0,
      oldestEvent: null, newestEvent: null, daysWithActivity: 0
    };
  }

  const oldestTs = activities[0].timestamp;
  const newestTs = activities[activities.length - 1].timestamp;
  const oldestEvent = new Date(oldestTs * 1000).toISOString();
  const newestEvent = new Date(newestTs * 1000).toISOString();

  // 2. Store raw events
  const rawEvents = activities.map(a => ({
    id: createEventId(a),
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

  await batchUpsert('raw_subgraph_events', rawEvents, 'id');
  console.log(`[reducer] Stored ${rawEvents.length} raw events`);

  // 3. Create normalized cashflows AND timeseries
  const cashflows: unknown[] = [];
  const timeseriesRecords: unknown[] = [];
  const dailyMap = new Map<string, DailyAggregate>();

  for (const a of activities) {
    const type = mapEventType(a);
    const shares = a.size || 0;
    const price = a.price || 0;
    const usdcSize = a.usdcSize || (price * shares);
    const fee = a.feesPaid || 0;
    const eventId = createEventId(a);
    const ts = new Date(a.timestamp * 1000).toISOString();
    const date = toUTCDate(a.timestamp);

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
        amount = usdcSize > 0 ? usdcSize : shares;
        break;
      default:
        direction = 'IN';
        category = 'TRANSFER';
        amount = usdcSize;
    }

    // Cashflow ledger entry
    cashflows.push({
      id: `${eventId}:${type}`,
      market_id: a.conditionId,
      outcome: a.outcomeIndex === 0 ? 'UP' : 'DOWN',
      direction,
      category,
      amount_usd: amount,
      shares_delta: type === 'BUY' ? shares : (type === 'SELL' || type === 'REDEEM' ? -shares : 0),
      wallet: walletLower,
      timestamp: ts,
      source_event_id: eventId,
    });

    // Timeseries entry
    timeseriesRecords.push({
      ts,
      date,
      market_id: a.conditionId,
      outcome: a.outcomeIndex === 0 ? 'UP' : 'DOWN',
      category,
      amount_usd: direction === 'OUT' ? -amount : amount,
      shares_delta: type === 'BUY' ? shares : (type === 'SELL' || type === 'REDEEM' ? -shares : 0),
      wallet: walletLower,
      source_event_id: eventId,
    });

    // Aggregate daily stats
    if (!dailyMap.has(date)) {
      dailyMap.set(date, {
        date,
        realized_pnl: 0,
        volume_traded: 0,
        buy_count: 0,
        sell_count: 0,
        redeem_count: 0,
        markets: new Set(),
      });
    }
    const day = dailyMap.get(date)!;
    day.markets.add(a.conditionId);
    if (type === 'BUY') {
      day.buy_count++;
      day.volume_traded += amount;
    } else if (type === 'SELL') {
      day.sell_count++;
      day.volume_traded += amount;
    } else if (type === 'REDEEM') {
      day.redeem_count++;
    }
  }

  await batchUpsert('cashflow_ledger', cashflows, 'id');
  console.log(`[reducer] Stored ${cashflows.length} cashflows`);

  await batchUpsert('account_cashflow_timeseries', timeseriesRecords, 'wallet,source_event_id');
  console.log(`[reducer] Stored ${timeseriesRecords.length} timeseries entries`);

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

  // Track PnL per day per market for daily aggregation
  const dailyPnlMap = new Map<string, number>();

  for (const [marketId, events] of byMarket) {
    events.sort((a, b) => a.timestamp - b.timestamp);

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
      const date = toUTCDate(e.timestamp);

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
        if (outcome === 'UP' && upShares > 0) {
          const avgCost = upCost / upShares;
          const soldShares = Math.min(shares, upShares);
          const costBasis = soldShares * avgCost;
          const proceeds = soldShares * price;
          const pnl = proceeds - costBasis;
          upRealized += pnl;
          upShares -= soldShares;
          upCost = upShares > 0 ? upShares * avgCost : 0;
          // Track daily PnL
          dailyPnlMap.set(date, (dailyPnlMap.get(date) || 0) + pnl);
        } else if (outcome === 'DOWN' && downShares > 0) {
          const avgCost = downCost / downShares;
          const soldShares = Math.min(shares, downShares);
          const costBasis = soldShares * avgCost;
          const proceeds = soldShares * price;
          const pnl = proceeds - costBasis;
          downRealized += pnl;
          downShares -= soldShares;
          downCost = downShares > 0 ? downShares * avgCost : 0;
          dailyPnlMap.set(date, (dailyPnlMap.get(date) || 0) + pnl);
        }
      } else if (type === 'REDEEM') {
        hasRedeem = true;
        redeemOutcome = outcome;
        const payout = e.usdcSize > 0 ? e.usdcSize : shares;
        redeemPayout += payout;

        let pnl = 0;
        if (outcome === 'UP') {
          pnl = payout - upCost;
          upRealized += pnl;
          upShares = 0;
          upCost = 0;
        } else {
          pnl = payout - downCost;
          downRealized += pnl;
          downShares = 0;
          downCost = 0;
        }
        dailyPnlMap.set(date, (dailyPnlMap.get(date) || 0) + pnl);
      }
    }

    const currentUp = currentPosMap.get(`${marketId}:0`) || 0;
    const currentDown = currentPosMap.get(`${marketId}:1`) || 0;
    const hasOpenPosition = currentUp > 0 || currentDown > 0;

    let marketState: 'OPEN' | 'SETTLED' = 'OPEN';
    let resolvedOutcome: 'UP' | 'DOWN' | 'SPLIT' | null = null;

    if (hasRedeem) {
      isClaimed = true;
      marketState = 'SETTLED';
      resolvedOutcome = redeemOutcome;
      claimedCount++;
    } else if (hasSell && !hasOpenPosition && upShares === 0 && downShares === 0) {
      marketState = 'SETTLED';
    } else if (!hasOpenPosition && !hasRedeem && (upCost > 0 || downCost > 0)) {
      isLost = true;
      marketState = 'SETTLED';
      const lostPnl = -(upCost + downCost);
      upRealized -= upCost;
      downRealized -= downCost;
      lostCount++;
      // Track as loss on last event date
      const lastEvent = events[events.length - 1];
      const lastDate = toUTCDate(lastEvent.timestamp);
      dailyPnlMap.set(lastDate, (dailyPnlMap.get(lastDate) || 0) + lostPnl);
    }

    if (marketState === 'SETTLED') settledCount++;

    const totalCost = upCost + downCost;
    const totalRealized = upRealized + downRealized;
    totalRealizedPnl += totalRealized;

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
    await batchUpsert('canonical_positions', positionRecords, 'id');
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
    await batchUpsert('market_lifecycle', marketRecords, 'id');
    console.log(`[reducer] Stored ${marketRecords.length} market states`);
  }

  // 7. Update daily PnL table
  const dailyPnlRecords = Array.from(dailyMap.entries()).map(([date, day]) => ({
    date,
    wallet: walletLower,
    realized_pnl: dailyPnlMap.get(date) || 0,
    unrealized_pnl: 0,
    total_pnl: dailyPnlMap.get(date) || 0,
    volume_traded: day.volume_traded,
    markets_active: day.markets.size,
    buy_count: day.buy_count,
    sell_count: day.sell_count,
    redeem_count: day.redeem_count,
    updated_at: new Date().toISOString(),
  }));

  if (dailyPnlRecords.length > 0) {
    await batchUpsert('daily_pnl', dailyPnlRecords, 'wallet,date');
    console.log(`[reducer] Stored ${dailyPnlRecords.length} daily PnL records`);
  }

  // 8. Update account PnL summary
  const totalVolume = Array.from(dailyMap.values()).reduce((s, d) => s + d.volume_traded, 0);
  const accountSummary = {
    wallet: walletLower,
    total_realized_pnl: totalRealizedPnl,
    total_unrealized_pnl: 0,
    total_pnl: totalRealizedPnl,
    first_trade_ts: oldestEvent,
    last_trade_ts: newestEvent,
    total_trades: activities.length,
    total_markets: marketStates.length,
    total_volume: totalVolume,
    claimed_markets: claimedCount,
    lost_markets: lostCount,
    open_markets: marketStates.filter(m => m.state === 'OPEN').length,
    updated_at: new Date().toISOString(),
  };

  await executeRest('account_pnl_summary', 'upsert', [accountSummary], { onConflict: 'wallet' });
  console.log(`[reducer] Updated account summary: PnL=$${totalRealizedPnl.toFixed(2)}`);

  // 9. Update ingest state
  const ingestState = {
    wallet: walletLower,
    oldest_event_ts: oldestEvent,
    newest_event_ts: newestEvent,
    total_events_ingested: activities.length,
    last_sync_at: new Date().toISOString(),
    is_complete: true,
    updated_at: new Date().toISOString(),
  };

  await executeRest('subgraph_ingest_state', 'upsert', [ingestState], { onConflict: 'wallet' });

  // 10. Store PnL snapshot
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
  console.log(`[reducer] Created PnL snapshot`);

  return {
    eventsIngested: activities.length,
    marketsProcessed: marketStates.length,
    realizedPnl: totalRealizedPnl,
    settledMarkets: settledCount,
    claimedMarkets: claimedCount,
    lostMarkets: lostCount,
    oldestEvent,
    newestEvent,
    daysWithActivity: dailyMap.size,
  };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Get wallet from bot_config
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    const configResp = await fetch(`${supabaseUrl}/rest/v1/bot_config?select=polymarket_address&limit=1`, {
      headers: {
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
      },
    });

    const configs = await configResp.json();
    const wallet = configs?.[0]?.polymarket_address;

    if (!wallet) {
      return new Response(
        JSON.stringify({ error: 'No wallet configured in bot_config' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`[reducer] Starting COMPLETE historical ingestion for ${wallet}`);
    const result = await runReducer(wallet);

    return new Response(
      JSON.stringify({ 
        success: true, 
        ...result,
        message: `Ingested ${result.eventsIngested} events across ${result.daysWithActivity} days. Realized PnL: $${result.realizedPnl.toFixed(2)}`
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('[reducer] Error:', error);
    return new Response(
      JSON.stringify({ error: String(error) }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
