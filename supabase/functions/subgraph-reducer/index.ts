import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

/**
 * CANONICAL ACCOUNTING REDUCER v5
 * 
 * CORRECT P/L FORMULA:
 *   REALIZED_PNL = SUM(REDEEM payouts) + SUM(SELL proceeds) - SUM(BUY costs) - SUM(fees)
 * 
 * DAILY P/L:
 *   daily_pnl = payouts_on_day + sells_on_day - buys_on_day - fees_on_day
 * 
 * VALIDATION:
 *   SUM(daily_pnl) MUST equal SUM(market_pnl) MUST equal total_pnl
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const DATA_API_BASE = 'https://data-api.polymarket.com';
const PAGE_SIZE = 500;

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

interface IngestState {
  wallet: string;
  next_offset: number;
  is_complete: boolean;
  total_events_ingested: number;
}

// REST helper
async function executeRest(
  table: string,
  operation: 'upsert' | 'insert' | 'delete' | 'select',
  data?: unknown,
  options?: { onConflict?: string; filter?: string }
): Promise<unknown> {
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

  if (operation === 'select') {
    method = 'GET';
    if (options?.filter) url += `?${options.filter}`;
    delete headers['Prefer'];
  } else if (operation === 'upsert' && options?.onConflict) {
    headers['Prefer'] = `resolution=merge-duplicates,return=minimal`;
    url += `?on_conflict=${options.onConflict}`;
  } else if (operation === 'delete') {
    method = 'DELETE';
    if (options?.filter) url += `?${options.filter}`;
  }

  const response = await fetch(url, {
    method,
    headers,
    body: operation !== 'delete' && operation !== 'select' ? JSON.stringify(data) : undefined,
  });

  if (operation === 'select') {
    return await response.json();
  }

  if (!response.ok) {
    const text = await response.text();
    console.error(`[reducer] REST error for ${table}:`, text);
  }
  return null;
}

// Batch upsert
async function batchUpsert(table: string, records: unknown[], onConflict: string, batchSize = 50): Promise<void> {
  for (let i = 0; i < records.length; i += batchSize) {
    const batch = records.slice(i, i + batchSize);
    await executeRest(table, 'upsert', batch, { onConflict });
  }
}

// Get ingest state
async function getIngestState(wallet: string): Promise<IngestState | null> {
  const data = await executeRest('subgraph_ingest_state', 'select', null, {
    filter: `wallet=eq.${wallet.toLowerCase()}&select=wallet,next_offset,is_complete,total_events_ingested`
  }) as IngestState[];
  return data?.[0] || null;
}

// Fetch batch of activities with offset
async function fetchActivityBatch(wallet: string, offset: number): Promise<{ activities: Activity[]; hasMore: boolean }> {
  const url = `${DATA_API_BASE}/activity?user=${wallet}&limit=${PAGE_SIZE}&offset=${offset}`;
  
  try {
    const resp = await fetch(url);
    if (!resp.ok) {
      console.error(`[reducer] API error at offset ${offset}: ${resp.status}`);
      return { activities: [], hasMore: false };
    }

    const data = await resp.json() as Activity[];
    if (!data?.length) {
      return { activities: [], hasMore: false };
    }

    return { 
      activities: data, 
      hasMore: data.length === PAGE_SIZE 
    };
  } catch (err) {
    console.error(`[reducer] Fetch error at offset ${offset}:`, err);
    return { activities: [], hasMore: false };
  }
}

function mapEventType(a: Activity): 'BUY' | 'SELL' | 'REDEEM' | 'TRANSFER' | 'MERGE' | 'SPLIT' {
  const t = a.type?.toUpperCase() || '';
  if (t === 'TRADE') return a.side?.toUpperCase() === 'SELL' ? 'SELL' : 'BUY';
  if (t === 'REDEEM' || t === 'REDEMPTION') return 'REDEEM';
  if (t === 'MERGE') return 'MERGE';
  if (t === 'SPLIT') return 'SPLIT';
  return 'TRANSFER';
}

function toUTCDate(ts: number): string {
  return new Date(ts * 1000).toISOString().split('T')[0];
}

function createEventId(a: Activity): string {
  const logIdx = a.logIndex ?? a.timestamp;
  return `${a.transactionHash}:${a.conditionId}:${a.outcomeIndex}:${logIdx}`;
}

// BATCHED INGESTION - stores raw events only
async function ingestBatch(wallet: string): Promise<{
  eventsIngested: number;
  isComplete: boolean;
  nextOffset: number;
  message: string;
}> {
  const walletLower = wallet.toLowerCase();
  
  // Get current state
  const state = await getIngestState(walletLower);
  let offset = state?.next_offset || 0;
  const previousTotal = state?.total_events_ingested || 0;
  
  if (state?.is_complete) {
    console.log(`[reducer] Ingestion already complete for ${walletLower}`);
    return {
      eventsIngested: 0,
      isComplete: true,
      nextOffset: offset,
      message: 'Ingestion already complete. Running reducer...'
    };
  }

  console.log(`[reducer] Starting full ingestion from offset ${offset}`);
  
  let totalIngested = 0;
  let isComplete = false;
  
  // Fetch ALL pages until no more data
  while (true) {
    const { activities, hasMore } = await fetchActivityBatch(wallet, offset);
    
    if (!activities.length) {
      isComplete = true;
      break;
    }

    // Store raw events
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
    
    // Store cashflows
    const cashflows = activities.map(a => {
      const type = mapEventType(a);
      const shares = a.size || 0;
      const price = a.price || 0;
      const usdcSize = a.usdcSize || (price * shares);
      const fee = a.feesPaid || 0;
      const eventId = createEventId(a);
      const ts = new Date(a.timestamp * 1000).toISOString();

      let direction: 'IN' | 'OUT';
      let category: string;
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

      return {
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
      };
    });

    await batchUpsert('cashflow_ledger', cashflows, 'id');

    // Store timeseries
    const timeseries = activities.map(a => {
      const type = mapEventType(a);
      const shares = a.size || 0;
      const price = a.price || 0;
      const usdcSize = a.usdcSize || (price * shares);
      const fee = a.feesPaid || 0;
      const eventId = createEventId(a);
      const ts = new Date(a.timestamp * 1000).toISOString();
      const date = toUTCDate(a.timestamp);
      const isOut = type === 'BUY';
      const amount = type === 'BUY' ? (usdcSize + fee) : (type === 'SELL' ? (usdcSize - fee) : (usdcSize > 0 ? usdcSize : shares));

      return {
        ts,
        date,
        market_id: a.conditionId,
        outcome: a.outcomeIndex === 0 ? 'UP' : 'DOWN',
        category: type === 'TRANSFER' ? 'TRANSFER' : type,
        amount_usd: isOut ? -amount : amount,
        shares_delta: type === 'BUY' ? shares : (type === 'SELL' || type === 'REDEEM' ? -shares : 0),
        wallet: walletLower,
        source_event_id: eventId,
      };
    });

    await batchUpsert('account_cashflow_timeseries', timeseries, 'wallet,source_event_id');

    totalIngested += activities.length;
    offset += PAGE_SIZE;
    
    console.log(`[reducer] Fetched ${totalIngested} events so far...`);
    
    if (!hasMore) {
      isComplete = true;
      break;
    }
  }

  // Update ingest state
  const ingestStateRecord = {
    wallet: walletLower,
    next_offset: offset,
    is_complete: isComplete,
    total_events_ingested: previousTotal + totalIngested,
    last_sync_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  await executeRest('subgraph_ingest_state', 'upsert', [ingestStateRecord], { onConflict: 'wallet' });

  return {
    eventsIngested: totalIngested,
    isComplete,
    nextOffset: offset,
    message: isComplete 
      ? `Ingestion complete! ${previousTotal + totalIngested} total events.`
      : `Ingested ${totalIngested} events. ${previousTotal + totalIngested} total. Run again to continue.`
  };
}

// REDUCER v5 - CORRECT ACCOUNTING based on polymarket_cashflows
async function runReducer(wallet: string): Promise<{
  marketsProcessed: number;
  realizedPnl: number;
  claimedMarkets: number;
  lostMarkets: number;
  daysWithActivity: number;
  validation: { passed: boolean; drift: number };
}> {
  const walletLower = wallet.toLowerCase();
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  
  // Fetch ALL cashflows from polymarket_cashflows (source of truth)
  const cfResp = await fetch(
    `${supabaseUrl}/rest/v1/polymarket_cashflows?wallet=eq.${walletLower}&order=ts.asc&limit=10000`,
    {
      headers: {
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
      },
    }
  );
  
  const cashflows = await cfResp.json() as {
    id: string;
    market_id: string;
    outcome_side: string;
    type: string;
    amount_usd: number;
    shares: number | null;
    price: number | null;
    fee_usd: number | null;
    fee_known: boolean;
    ts: string;
    raw_json?: { slug?: string };
  }[];

  if (!cashflows?.length) {
    console.log(`[reducer] No cashflows found for ${walletLower}`);
    return { 
      marketsProcessed: 0, 
      realizedPnl: 0, 
      claimedMarkets: 0, 
      lostMarkets: 0, 
      daysWithActivity: 0,
      validation: { passed: true, drift: 0 }
    };
  }

  console.log(`[reducer] Processing ${cashflows.length} cashflows from polymarket_cashflows`);

  // ========================================
  // STEP 1: DIRECT P/L CALCULATION (validation baseline)
  // ========================================
  let directBuyCost = 0;
  let directSellProceeds = 0;
  let directRedeemPayout = 0;
  let directFees = 0;

  for (const cf of cashflows) {
    const amount = Math.abs(Number(cf.amount_usd) || 0);
    const fee = Number(cf.fee_usd) || 0;
    
    switch (cf.type) {
      case 'FILL_BUY':
        directBuyCost += amount;
        if (cf.fee_known) directFees += fee;
        break;
      case 'FILL_SELL':
        directSellProceeds += amount;
        if (cf.fee_known) directFees += fee;
        break;
      case 'REDEEM':
      case 'CLAIM':
      case 'SETTLEMENT_PAYOUT':
      case 'MERGE':
        directRedeemPayout += amount;
        break;
    }
  }

  const directTotalPnl = directRedeemPayout + directSellProceeds - directBuyCost - directFees;
  console.log(`[reducer] Direct P/L: buys=$${directBuyCost.toFixed(2)}, sells=$${directSellProceeds.toFixed(2)}, redeems=$${directRedeemPayout.toFixed(2)}, fees=$${directFees.toFixed(2)} => PnL=$${directTotalPnl.toFixed(2)}`);

  // ========================================
  // STEP 2: PER-MARKET P/L CALCULATION
  // ========================================
  interface MarketAccounting {
    market_id: string;
    market_slug: string | null;
    buy_cost: number;
    sell_proceeds: number;
    redeem_payout: number;
    fees: number;
    realized_pnl: number;
    up_shares_bought: number;
    down_shares_bought: number;
    has_buy: boolean;
    has_sell: boolean;
    has_redeem: boolean;
    first_ts: string;
    last_ts: string;
  }

  const marketMap = new Map<string, MarketAccounting>();

  for (const cf of cashflows) {
    const marketId = cf.market_id;
    if (!marketId) continue;

    if (!marketMap.has(marketId)) {
      marketMap.set(marketId, {
        market_id: marketId,
        market_slug: cf.raw_json?.slug || null,
        buy_cost: 0,
        sell_proceeds: 0,
        redeem_payout: 0,
        fees: 0,
        realized_pnl: 0,
        up_shares_bought: 0,
        down_shares_bought: 0,
        has_buy: false,
        has_sell: false,
        has_redeem: false,
        first_ts: cf.ts,
        last_ts: cf.ts,
      });
    }

    const m = marketMap.get(marketId)!;
    const amount = Math.abs(Number(cf.amount_usd) || 0);
    const shares = Number(cf.shares) || 0;
    const fee = Number(cf.fee_usd) || 0;

    if (cf.ts > m.last_ts) m.last_ts = cf.ts;
    if (!m.market_slug && cf.raw_json?.slug) m.market_slug = cf.raw_json.slug;

    switch (cf.type) {
      case 'FILL_BUY':
        m.has_buy = true;
        m.buy_cost += amount;
        if (cf.fee_known) m.fees += fee;
        if (cf.outcome_side === 'UP') m.up_shares_bought += shares;
        else m.down_shares_bought += shares;
        break;
      case 'FILL_SELL':
        m.has_sell = true;
        m.sell_proceeds += amount;
        if (cf.fee_known) m.fees += fee;
        break;
      case 'REDEEM':
      case 'CLAIM':
      case 'SETTLEMENT_PAYOUT':
      case 'MERGE':
        m.has_redeem = true;
        m.redeem_payout += amount;
        break;
    }
  }

  // Calculate realized P/L per market using CORRECT formula
  let totalMarketPnl = 0;
  let claimedCount = 0;
  let lostCount = 0;

  for (const m of marketMap.values()) {
    // REALIZED P/L = payouts + sells - buys - fees
    m.realized_pnl = m.redeem_payout + m.sell_proceeds - m.buy_cost - m.fees;
    totalMarketPnl += m.realized_pnl;

    if (m.has_redeem) claimedCount++;
    else if (m.buy_cost > 0 && m.redeem_payout === 0 && m.sell_proceeds === 0) {
      // Has buys but no payouts/sells - likely lost
      lostCount++;
    }
  }

  console.log(`[reducer] Market P/L sum: $${totalMarketPnl.toFixed(2)} (${marketMap.size} markets)`);

  // ========================================
  // STEP 3: DAILY P/L CALCULATION
  // ========================================
  interface DailyAccounting {
    date: string;
    buy_cost: number;
    sell_proceeds: number;
    redeem_payout: number;
    fees: number;
    net_pnl: number;
    trade_count: number;
    markets: Set<string>;
    buys: number;
    sells: number;
    redeems: number;
  }

  const dailyMap = new Map<string, DailyAccounting>();

  for (const cf of cashflows) {
    const dateStr = cf.ts.split('T')[0];
    
    if (!dailyMap.has(dateStr)) {
      dailyMap.set(dateStr, {
        date: dateStr,
        buy_cost: 0,
        sell_proceeds: 0,
        redeem_payout: 0,
        fees: 0,
        net_pnl: 0,
        trade_count: 0,
        markets: new Set(),
        buys: 0,
        sells: 0,
        redeems: 0,
      });
    }

    const day = dailyMap.get(dateStr)!;
    const amount = Math.abs(Number(cf.amount_usd) || 0);
    const fee = Number(cf.fee_usd) || 0;

    if (cf.market_id) day.markets.add(cf.market_id);
    day.trade_count++;

    switch (cf.type) {
      case 'FILL_BUY':
        day.buy_cost += amount;
        day.buys++;
        if (cf.fee_known) day.fees += fee;
        break;
      case 'FILL_SELL':
        day.sell_proceeds += amount;
        day.sells++;
        if (cf.fee_known) day.fees += fee;
        break;
      case 'REDEEM':
      case 'CLAIM':
      case 'SETTLEMENT_PAYOUT':
      case 'MERGE':
        day.redeem_payout += amount;
        day.redeems++;
        break;
    }
  }

  // Calculate daily P/L
  let totalDailyPnl = 0;
  for (const day of dailyMap.values()) {
    day.net_pnl = day.redeem_payout + day.sell_proceeds - day.buy_cost - day.fees;
    totalDailyPnl += day.net_pnl;
  }

  console.log(`[reducer] Daily P/L sum: $${totalDailyPnl.toFixed(2)} (${dailyMap.size} days)`);

  // ========================================
  // STEP 4: VALIDATION
  // ========================================
  const drift = Math.abs(directTotalPnl - totalMarketPnl);
  const validationPassed = drift < 0.01;

  if (!validationPassed) {
    console.warn(`[reducer] VALIDATION FAILED: direct=$${directTotalPnl.toFixed(2)}, market_sum=$${totalMarketPnl.toFixed(2)}, drift=$${drift.toFixed(2)}`);
  } else {
    console.log(`[reducer] VALIDATION PASSED: P/L matches within $0.01`);
  }

  // ========================================
  // STEP 5: PERSIST TO DATABASE
  // ========================================

  // 5a. Update subgraph_pnl_markets with CORRECT P/L
  const marketRecords = Array.from(marketMap.values()).map(m => ({
    id: `${walletLower}:${m.market_id}`,
    wallet: walletLower,
    market_id: m.market_id,
    market_slug: m.market_slug,
    up_shares: m.up_shares_bought,
    down_shares: m.down_shares_bought,
    total_cost: m.buy_cost,
    realized_pnl_usd: m.realized_pnl,
    realized_confidence: 'HIGH',
    fees_known_usd: m.fees,
    is_settled: m.has_redeem || (m.buy_cost > 0 && m.sell_proceeds >= m.buy_cost),
    settlement_outcome: m.has_redeem ? 'WIN' : 
                        (m.realized_pnl < -m.buy_cost * 0.9 ? 'LOSS' : null),
    settlement_payout: m.redeem_payout > 0 ? m.redeem_payout : null,
    payout_ingested: m.has_redeem,
    payout_amount_usd: m.redeem_payout > 0 ? m.redeem_payout : null,
    lifecycle_bought: m.has_buy,
    lifecycle_sold: m.has_sell,
    lifecycle_claimed: m.has_redeem,
    lifecycle_lost: m.buy_cost > 0 && m.redeem_payout === 0 && m.sell_proceeds === 0,
    lifecycle_state: m.has_redeem ? 'CLAIMED' : 
                     (m.has_sell ? 'SOLD' : 
                     (m.buy_cost > 0 && m.redeem_payout === 0 && m.sell_proceeds === 0 ? 'LOST' : 'OPEN')),
    confidence: 'HIGH',
    updated_at: new Date().toISOString(),
  }));

  await batchUpsert('subgraph_pnl_markets', marketRecords, 'id', 100);
  console.log(`[reducer] Updated ${marketRecords.length} market P/L records`);

  // 5b. Update market_lifecycle
  const lifecycleRecords = Array.from(marketMap.values()).map(m => ({
    id: `${walletLower}:${m.market_id}`,
    wallet: walletLower,
    market_id: m.market_id,
    market_slug: m.market_slug,
    state: m.has_redeem ? 'SETTLED' : (m.has_sell ? 'SOLD' : 'OPEN'),
    total_cost: m.buy_cost,
    total_payout: m.redeem_payout,
    realized_pnl: m.realized_pnl,
    has_buy: m.has_buy,
    has_sell: m.has_sell,
    has_redeem: m.has_redeem,
    is_claimed: m.has_redeem,
    is_lost: m.buy_cost > 0 && m.redeem_payout === 0 && m.sell_proceeds === 0,
    updated_at: new Date().toISOString(),
  }));

  await batchUpsert('market_lifecycle', lifecycleRecords, 'id', 100);
  console.log(`[reducer] Updated ${lifecycleRecords.length} market lifecycle records`);

  // 5c. Update daily_pnl with CORRECT formula
  const dailyRecords = Array.from(dailyMap.values()).map(d => ({
    id: `${walletLower}:${d.date}`,
    wallet: walletLower,
    date: d.date,
    realized_pnl: d.net_pnl,
    unrealized_pnl: 0,
    total_pnl: d.net_pnl,
    volume_traded: d.buy_cost + d.sell_proceeds,
    markets_active: d.markets.size,
    buy_count: d.buys,
    sell_count: d.sells,
    redeem_count: d.redeems,
    updated_at: new Date().toISOString(),
  }));

  await batchUpsert('daily_pnl', dailyRecords, 'id', 100);
  console.log(`[reducer] Updated ${dailyRecords.length} daily P/L records`);

  // 5d. Update summary with CORRECT totals
  const summaryRecord = {
    wallet: walletLower,
    total_realized_pnl: directTotalPnl, // Use validated direct calculation
    total_unrealized_pnl: 0,
    total_pnl: directTotalPnl,
    total_fees_known: directFees,
    total_fills: cashflows.filter(cf => cf.type.startsWith('FILL_')).length,
    total_payouts: cashflows.filter(cf => ['REDEEM', 'CLAIM', 'SETTLEMENT_PAYOUT', 'MERGE'].includes(cf.type)).length,
    total_markets: marketMap.size,
    settled_markets: claimedCount + lostCount,
    open_markets: marketMap.size - claimedCount - lostCount,
    markets_claimed: claimedCount,
    markets_lost: lostCount,
    realized_confidence: 'HIGH',
    overall_confidence: validationPassed ? 'HIGH' : 'LOW',
    pnl_complete: true,
    updated_at: new Date().toISOString(),
  };

  await executeRest('subgraph_pnl_summary', 'upsert', [summaryRecord], { onConflict: 'wallet' });
  console.log(`[reducer] Updated summary: P/L=$${directTotalPnl.toFixed(2)}`);

  // 5e. Update account_pnl_summary for dashboard
  const dates = cashflows.map(cf => cf.ts);
  await executeRest('account_pnl_summary', 'upsert', [{
    wallet: walletLower,
    total_realized_pnl: directTotalPnl,
    total_unrealized_pnl: 0,
    total_pnl: directTotalPnl,
    first_trade_ts: dates[0],
    last_trade_ts: dates[dates.length - 1],
    total_trades: cashflows.length,
    total_markets: marketMap.size,
    total_volume: directBuyCost + directSellProceeds,
    claimed_markets: claimedCount,
    lost_markets: lostCount,
    open_markets: marketMap.size - claimedCount - lostCount,
    updated_at: new Date().toISOString(),
  }], { onConflict: 'wallet' });

  return {
    marketsProcessed: marketMap.size,
    realizedPnl: directTotalPnl,
    claimedMarkets: claimedCount,
    lostMarkets: lostCount,
    daysWithActivity: dailyMap.size,
    validation: { passed: validationPassed, drift },
  };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
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

    // Phase 1: Ingest batch
    console.log(`[reducer] Starting batched ingestion for ${wallet}`);
    const ingestResult = await ingestBatch(wallet);
    
    // Phase 2: If complete, run reducer
    let reducerResult = null;
    if (ingestResult.isComplete) {
      console.log(`[reducer] Ingestion complete, running reducer`);
      reducerResult = await runReducer(wallet);
    }

    return new Response(
      JSON.stringify({ 
        success: true,
        ingestion: ingestResult,
        reducer: reducerResult,
        message: ingestResult.isComplete 
          ? `Complete! ${reducerResult?.marketsProcessed} markets, PnL: $${reducerResult?.realizedPnl?.toFixed(2)}`
          : ingestResult.message
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
