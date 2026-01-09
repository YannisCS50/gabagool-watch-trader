import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

/**
 * CANONICAL ACCOUNTING REDUCER v3
 * 
 * BATCHED PROCESSING - Resumable, resource-efficient
 * 
 * - Fetches max 10 pages per invocation to avoid timeout
 * - Stores cursor for resumable ingestion
 * - Multiple invocations complete full history
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const DATA_API_BASE = 'https://data-api.polymarket.com';
const PAGE_SIZE = 500;
const MAX_PAGES_PER_RUN = 10; // Limit per invocation to avoid resource exhaustion

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

  console.log(`[reducer] Starting batch ingestion from offset ${offset}`);
  
  let totalIngested = 0;
  let isComplete = false;
  
  // Fetch up to MAX_PAGES_PER_RUN pages
  for (let page = 0; page < MAX_PAGES_PER_RUN; page++) {
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
    
    console.log(`[reducer] Page ${page + 1}: +${activities.length} events (total this run: ${totalIngested})`);
    
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

// REDUCER - runs after ingestion is complete
async function runReducer(wallet: string): Promise<{
  marketsProcessed: number;
  realizedPnl: number;
  claimedMarkets: number;
  lostMarkets: number;
  daysWithActivity: number;
}> {
  const walletLower = wallet.toLowerCase();
  
  // Fetch all raw events from database
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  
  const eventsResp = await fetch(
    `${supabaseUrl}/rest/v1/raw_subgraph_events?wallet=eq.${walletLower}&order=timestamp.asc&limit=10000`,
    {
      headers: {
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
      },
    }
  );
  
  const events = await eventsResp.json() as {
    id: string;
    market_id: string;
    outcome: string;
    event_type: string;
    shares: number;
    price: number;
    amount_usd: number;
    fee_usd: number | null;
    timestamp: string;
    raw_json: Activity;
  }[];

  if (!events?.length) {
    return { marketsProcessed: 0, realizedPnl: 0, claimedMarkets: 0, lostMarkets: 0, daysWithActivity: 0 };
  }

  console.log(`[reducer] Processing ${events.length} events from database`);

  // Group by market
  const byMarket = new Map<string, typeof events>();
  for (const e of events) {
    if (!e.market_id) continue;
    if (!byMarket.has(e.market_id)) byMarket.set(e.market_id, []);
    byMarket.get(e.market_id)!.push(e);
  }

  // Fetch current positions from API
  let currentPosMap = new Map<string, number>();
  try {
    const posResp = await fetch(`${DATA_API_BASE}/positions?user=${wallet}`);
    if (posResp.ok) {
      const positions = await posResp.json() as { conditionId: string; outcomeIndex: number; size: number }[];
      for (const p of positions) {
        currentPosMap.set(`${p.conditionId}:${p.outcomeIndex}`, p.size);
      }
    }
  } catch { /* ignore */ }

  const positionRecords: unknown[] = [];
  const marketRecords: unknown[] = [];
  const dailyPnlMap = new Map<string, { realized: number; volume: number; buys: number; sells: number; redeems: number; markets: Set<string> }>();
  
  let totalRealizedPnl = 0;
  let claimedCount = 0;
  let lostCount = 0;

  for (const [marketId, marketEvents] of byMarket) {
    let upShares = 0, downShares = 0;
    let upCost = 0, downCost = 0;
    let upRealized = 0, downRealized = 0;
    let hasBuy = false, hasSell = false, hasRedeem = false;
    let isClaimed = false, isLost = false;
    let marketSlug: string | null = null;
    let redeemOutcome: 'UP' | 'DOWN' | null = null;
    let redeemPayout = 0;

    for (const e of marketEvents) {
      const type = e.event_type as 'BUY' | 'SELL' | 'REDEEM';
      const outcome = e.outcome as 'UP' | 'DOWN';
      const shares = e.shares || 0;
      const price = e.price || 0;
      const cost = shares * price;
      const date = e.timestamp.split('T')[0];

      if (!marketSlug && e.raw_json?.slug) marketSlug = e.raw_json.slug;

      // Initialize daily record
      if (!dailyPnlMap.has(date)) {
        dailyPnlMap.set(date, { realized: 0, volume: 0, buys: 0, sells: 0, redeems: 0, markets: new Set() });
      }
      const day = dailyPnlMap.get(date)!;
      day.markets.add(marketId);

      if (type === 'BUY') {
        hasBuy = true;
        day.buys++;
        day.volume += e.amount_usd;
        if (outcome === 'UP') {
          upCost += cost;
          upShares += shares;
        } else {
          downCost += cost;
          downShares += shares;
        }
      } else if (type === 'SELL') {
        hasSell = true;
        day.sells++;
        day.volume += e.amount_usd;
        if (outcome === 'UP' && upShares > 0) {
          const avgCost = upCost / upShares;
          const soldShares = Math.min(shares, upShares);
          const costBasis = soldShares * avgCost;
          const proceeds = soldShares * price;
          const pnl = proceeds - costBasis;
          upRealized += pnl;
          upShares -= soldShares;
          upCost = upShares > 0 ? upShares * avgCost : 0;
          day.realized += pnl;
        } else if (outcome === 'DOWN' && downShares > 0) {
          const avgCost = downCost / downShares;
          const soldShares = Math.min(shares, downShares);
          const costBasis = soldShares * avgCost;
          const proceeds = soldShares * price;
          const pnl = proceeds - costBasis;
          downRealized += pnl;
          downShares -= soldShares;
          downCost = downShares > 0 ? downShares * avgCost : 0;
          day.realized += pnl;
        }
      } else if (type === 'REDEEM') {
        hasRedeem = true;
        day.redeems++;
        redeemOutcome = outcome;
        const payout = e.amount_usd > 0 ? e.amount_usd : shares;
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
        day.realized += pnl;
      }
    }

    const currentUp = currentPosMap.get(`${marketId}:0`) || 0;
    const currentDown = currentPosMap.get(`${marketId}:1`) || 0;
    const hasOpenPosition = currentUp > 0 || currentDown > 0;

    let marketState: 'OPEN' | 'SETTLED' = 'OPEN';
    let resolvedOutcome: 'UP' | 'DOWN' | null = null;

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
      upRealized -= upCost;
      downRealized -= downCost;
      lostCount++;
    }

    const totalRealized = upRealized + downRealized;
    totalRealizedPnl += totalRealized;

    if (upShares > 0 || upCost > 0 || upRealized !== 0) {
      positionRecords.push({
        id: `${walletLower}:${marketId}:UP`,
        wallet: walletLower,
        market_id: marketId,
        outcome: 'UP',
        shares_held: Math.max(0, currentUp || upShares),
        total_cost_usd: upCost,
        realized_pnl: upRealized,
        state: isClaimed ? 'CLAIMED' : (isLost ? 'LOST' : (hasSell && upShares === 0 ? 'SOLD' : 'OPEN')),
        updated_at: new Date().toISOString(),
      });
    }

    if (downShares > 0 || downCost > 0 || downRealized !== 0) {
      positionRecords.push({
        id: `${walletLower}:${marketId}:DOWN`,
        wallet: walletLower,
        market_id: marketId,
        outcome: 'DOWN',
        shares_held: Math.max(0, currentDown || downShares),
        total_cost_usd: downCost,
        realized_pnl: downRealized,
        state: isClaimed ? 'CLAIMED' : (isLost ? 'LOST' : (hasSell && downShares === 0 ? 'SOLD' : 'OPEN')),
        updated_at: new Date().toISOString(),
      });
    }

    marketRecords.push({
      id: `${walletLower}:${marketId}`,
      wallet: walletLower,
      market_id: marketId,
      market_slug: marketSlug,
      state: marketState,
      resolved_outcome: resolvedOutcome,
      total_cost: upCost + downCost,
      total_payout: redeemPayout,
      realized_pnl: totalRealized,
      has_buy: hasBuy,
      has_sell: hasSell,
      has_redeem: hasRedeem,
      is_claimed: isClaimed,
      is_lost: isLost,
      updated_at: new Date().toISOString(),
    });
  }

  // Store positions and markets
  if (positionRecords.length > 0) {
    await batchUpsert('canonical_positions', positionRecords, 'id');
    console.log(`[reducer] Stored ${positionRecords.length} positions`);
  }

  if (marketRecords.length > 0) {
    await batchUpsert('market_lifecycle', marketRecords, 'id');
    console.log(`[reducer] Stored ${marketRecords.length} market states`);
  }

  // Store daily PnL
  const dailyRecords = Array.from(dailyPnlMap.entries()).map(([date, day]) => ({
    date,
    wallet: walletLower,
    realized_pnl: day.realized,
    unrealized_pnl: 0,
    total_pnl: day.realized,
    volume_traded: day.volume,
    markets_active: day.markets.size,
    buy_count: day.buys,
    sell_count: day.sells,
    redeem_count: day.redeems,
    updated_at: new Date().toISOString(),
  }));

  if (dailyRecords.length > 0) {
    await batchUpsert('daily_pnl', dailyRecords, 'wallet,date');
    console.log(`[reducer] Stored ${dailyRecords.length} daily PnL records`);
  }

  // Get date range
  const dates = events.map(e => e.timestamp);
  const oldestEvent = dates[0];
  const newestEvent = dates[dates.length - 1];

  // Update account summary
  const totalVolume = Array.from(dailyPnlMap.values()).reduce((s, d) => s + d.volume, 0);
  await executeRest('account_pnl_summary', 'upsert', [{
    wallet: walletLower,
    total_realized_pnl: totalRealizedPnl,
    total_unrealized_pnl: 0,
    total_pnl: totalRealizedPnl,
    first_trade_ts: oldestEvent,
    last_trade_ts: newestEvent,
    total_trades: events.length,
    total_markets: marketRecords.length,
    total_volume: totalVolume,
    claimed_markets: claimedCount,
    lost_markets: lostCount,
    open_markets: marketRecords.filter((m: any) => m.state === 'OPEN').length,
    updated_at: new Date().toISOString(),
  }], { onConflict: 'wallet' });

  console.log(`[reducer] Updated account summary: PnL=$${totalRealizedPnl.toFixed(2)}`);

  return {
    marketsProcessed: marketRecords.length,
    realizedPnl: totalRealizedPnl,
    claimedMarkets: claimedCount,
    lostMarkets: lostCount,
    daysWithActivity: dailyPnlMap.size,
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
