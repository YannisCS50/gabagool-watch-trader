import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

/**
 * Polymarket Data Sync Service - Accrued vs Cash PnL
 * 
 * KEY INSIGHT: REDEEM events in Polymarket activity mark winning positions.
 * Even if amount_usd is 0, we can derive:
 * - Which outcome won (the one that was redeemed)
 * - Accrued payout = shares × 1.0 (binary market payout)
 * 
 * PnL is split into:
 * 1. ACCRUED PnL: Economic PnL once market resolves (payout - cost)
 * 2. CASH PnL: Actual cash received via claim/redeem
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const DATA_API_BASE = 'https://data-api.polymarket.com';
const GAMMA_API_BASE = 'https://gamma-api.polymarket.com';

const PAGE_SIZE = 500;
const MAX_PAGES = 10;
const MAX_AGE_DAYS = 90;

interface PolymarketActivity {
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

interface MarketResolution {
  conditionId: string;
  isResolved: boolean;
  winningOutcome: string | null;
  payoutNumerators?: number[];
  derivedFromRedeem?: boolean;
}

/**
 * Fetch ALL user activity from Polymarket Data API
 */
async function fetchAllActivity(wallet: string): Promise<PolymarketActivity[]> {
  const allActivity: PolymarketActivity[] = [];
  let offset = 0;
  let pagesLoaded = 0;
  const cutoffTime = Math.floor(Date.now() / 1000) - (MAX_AGE_DAYS * 24 * 60 * 60);

  console.log(`[subgraph-sync] Fetching ALL activity (last ${MAX_AGE_DAYS} days)...`);

  while (pagesLoaded < MAX_PAGES) {
    const url = `${DATA_API_BASE}/activity?user=${wallet}&limit=${PAGE_SIZE}&offset=${offset}`;
    
    const response = await fetch(url);
    if (!response.ok) {
      console.error(`[subgraph-sync] Activity API error: ${response.status}`);
      break;
    }

    const data = await response.json() as PolymarketActivity[];
    if (!data || data.length === 0) break;
    
    const recentActivity = data.filter(a => a.timestamp >= cutoffTime);
    allActivity.push(...recentActivity);
    
    pagesLoaded++;
    
    const oldestInBatch = Math.min(...data.map(a => a.timestamp));
    if (oldestInBatch < cutoffTime || data.length < PAGE_SIZE) break;
    
    offset += PAGE_SIZE;
    console.log(`[subgraph-sync] Page ${pagesLoaded}: ${recentActivity.length} activities (total: ${allActivity.length})`);
  }

  const typeBreakdown = allActivity.reduce((acc, a) => {
    acc[a.type] = (acc[a.type] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  console.log(`[subgraph-sync] Activity breakdown:`, JSON.stringify(typeBreakdown));

  return allActivity;
}

/**
 * Fetch user positions from Polymarket Data API
 */
async function fetchPositions(wallet: string): Promise<PolymarketPosition[]> {
  console.log(`[subgraph-sync] Fetching positions...`);

  try {
    const url = `${DATA_API_BASE}/positions?user=${wallet}`;
    const response = await fetch(url);
    if (!response.ok) {
      console.error(`[subgraph-sync] Positions API error: ${response.status}`);
      return [];
    }

    const data = await response.json();
    if (!data || !Array.isArray(data)) return [];

    console.log(`[subgraph-sync] Fetched ${data.length} positions`);
    return data as PolymarketPosition[];
  } catch (error) {
    console.error(`[subgraph-sync] Error fetching positions:`, error);
    return [];
  }
}

/**
 * Derive market resolution from REDEEM events
 * KEY INSIGHT: If a user has a REDEEM event, that outcome WON
 */
function deriveResolutionsFromActivity(activities: PolymarketActivity[]): Map<string, MarketResolution> {
  const resolutions = new Map<string, MarketResolution>();
  
  // Group REDEEM events by market
  const redeemsByMarket = new Map<string, PolymarketActivity[]>();
  for (const a of activities) {
    if (a.type === 'REDEEM' || a.type === 'Redemption') {
      const marketId = a.conditionId;
      if (!marketId) continue;
      if (!redeemsByMarket.has(marketId)) {
        redeemsByMarket.set(marketId, []);
      }
      redeemsByMarket.get(marketId)!.push(a);
    }
  }
  
  // For each market with REDEEM, derive winning outcome
  for (const [marketId, redeems] of redeemsByMarket) {
    // The outcome that was redeemed is the winning outcome
    const outcomeIndexes = new Set(redeems.map(r => r.outcomeIndex));
    let winningOutcome: string | null = null;
    
    if (outcomeIndexes.has(0) && !outcomeIndexes.has(1)) {
      winningOutcome = 'UP';
    } else if (outcomeIndexes.has(1) && !outcomeIndexes.has(0)) {
      winningOutcome = 'DOWN';
    } else if (outcomeIndexes.has(0) && outcomeIndexes.has(1)) {
      // Both outcomes redeemed - could be a merge or split
      winningOutcome = 'SPLIT';
    }
    
    if (winningOutcome) {
      resolutions.set(marketId, {
        conditionId: marketId,
        isResolved: true,
        winningOutcome,
        derivedFromRedeem: true,
      });
    }
  }
  
  console.log(`[subgraph-sync] Derived ${resolutions.size} resolutions from REDEEM events`);
  return resolutions;
}

/**
 * Fetch market resolution from Gamma API (fallback)
 */
async function fetchMarketResolutions(conditionIds: string[]): Promise<Map<string, MarketResolution>> {
  const resolutions = new Map<string, MarketResolution>();
  
  if (conditionIds.length === 0) return resolutions;
  
  console.log(`[subgraph-sync] Fetching resolution for ${conditionIds.length} markets from Gamma API...`);
  
  const batchSize = 20;
  for (let i = 0; i < conditionIds.length; i += batchSize) {
    const batch = conditionIds.slice(i, i + batchSize);
    
    await Promise.all(batch.map(async (conditionId) => {
      try {
        const url = `${GAMMA_API_BASE}/markets?condition_id=${conditionId}`;
        const response = await fetch(url);
        
        if (response.ok) {
          const markets = await response.json();
          if (Array.isArray(markets) && markets.length > 0) {
            const market = markets[0];
            const isResolved = market.closed === true || market.resolved === true;
            let winningOutcome: string | null = null;
            let payoutNumerators: number[] = [];
            
            if (isResolved && market.payoutNumerators && Array.isArray(market.payoutNumerators)) {
              payoutNumerators = market.payoutNumerators.map(Number);
              if (payoutNumerators[0] === 1 && payoutNumerators[1] === 0) {
                winningOutcome = 'UP';
              } else if (payoutNumerators[1] === 1 && payoutNumerators[0] === 0) {
                winningOutcome = 'DOWN';
              } else if (payoutNumerators[0] > 0 && payoutNumerators[1] > 0) {
                winningOutcome = 'SPLIT';
              }
            }
            
            // Only store if we have useful resolution info
            if (isResolved) {
              resolutions.set(conditionId, {
                conditionId,
                isResolved,
                winningOutcome,
                payoutNumerators,
              });
            }
          }
        }
      } catch (error) {
        console.error(`[subgraph-sync] Error fetching resolution for ${conditionId}:`, error);
      }
    }));
    
    if (i + batchSize < conditionIds.length) {
      await new Promise(r => setTimeout(r, 100));
    }
  }
  
  console.log(`[subgraph-sync] Fetched ${resolutions.size} resolutions from Gamma API`);
  return resolutions;
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
    if (options?.filter) url += `?${options.filter}`;
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
 * Map activity type to cashflow type
 */
function mapActivityToCashflowType(activity: PolymarketActivity): string {
  const typeUpper = activity.type?.toUpperCase() || '';
  const side = activity.side?.toUpperCase() || '';

  if (typeUpper === 'TRADE') {
    return side === 'SELL' ? 'FILL_SELL' : 'FILL_BUY';
  }
  if (typeUpper === 'REDEEM' || typeUpper === 'REDEMPTION') return 'REDEEM';
  if (typeUpper === 'CLAIM') return 'CLAIM';
  if (typeUpper === 'MERGE') return 'MERGE';
  if (typeUpper === 'SPLIT') return 'SPLIT';
  if (typeUpper === 'TRANSFER') return 'TRANSFER';
  
  return 'TRANSFER';
}

/**
 * Compute cashflow amount (signed: outflow negative, inflow positive)
 * For REDEEM: if amount_usd is 0 but we have shares, infer payout from shares × 1.0
 */
function computeCashflowAmount(activity: PolymarketActivity, type: string): { amount: number; inferred: boolean } {
  const price = Number(activity.price) || 0;
  const size = Number(activity.size) || 0;
  const usdcSize = Number(activity.usdcSize) || (price * size);
  const fee = Number(activity.feesPaid) || 0;

  switch (type) {
    case 'FILL_BUY':
      return { amount: -(usdcSize + fee), inferred: false };
    case 'FILL_SELL':
      return { amount: usdcSize - fee, inferred: false };
    case 'REDEEM':
    case 'CLAIM':
    case 'SETTLEMENT_PAYOUT':
      // If usdcSize is 0 but we have size, infer payout as size × 1.0 (binary market)
      if (usdcSize === 0 && size > 0) {
        return { amount: size, inferred: true };
      }
      return { amount: usdcSize, inferred: false };
    case 'MERGE':
      return { amount: usdcSize, inferred: false };
    case 'SPLIT':
      return { amount: -usdcSize, inferred: false };
    default:
      return { amount: 0, inferred: false };
  }
}

/**
 * Ingest activity as cashflows + fills
 */
async function ingestActivityAsCashflows(
  wallet: string, 
  activities: PolymarketActivity[]
): Promise<{ fillsIngested: number; payoutsIngested: number; cashflowsIngested: number; inferredPayouts: number }> {
  if (activities.length === 0) return { fillsIngested: 0, payoutsIngested: 0, cashflowsIngested: 0, inferredPayouts: 0 };

  const walletLower = wallet.toLowerCase();
  let fillsIngested = 0;
  let payoutsIngested = 0;
  let cashflowsIngested = 0;
  let inferredPayouts = 0;
  const batchSize = 100;

  const trades = activities.filter(a => a.type === 'TRADE');
  const payouts = activities.filter(a => ['REDEEM', 'REDEMPTION', 'CLAIM', 'MERGE', 'SPLIT'].includes(a.type?.toUpperCase() || ''));

  // Ingest trades as fills
  for (let i = 0; i < trades.length; i += batchSize) {
    const batch = trades.slice(i, i + batchSize);
    
    const records = batch.map(a => ({
      id: `${a.transactionHash}:${a.conditionId}:${a.outcomeIndex}:${a.timestamp}`,
      wallet: walletLower,
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
      fee_usd: a.feesPaid || null,
      fee_known: a.feesPaid !== undefined,
      raw_json: a,
      ingested_at: new Date().toISOString(),
    }));

    await executeRest('subgraph_fills', 'upsert', records, { onConflict: 'id' });
    fillsIngested += batch.length;
  }

  // Ingest ALL activities as cashflows
  for (let i = 0; i < activities.length; i += batchSize) {
    const batch = activities.slice(i, i + batchSize);
    
    const cashflowRecords = batch.map(a => {
      const type = mapActivityToCashflowType(a);
      const { amount: amountUsd, inferred } = computeCashflowAmount(a, type);
      
      if (inferred) inferredPayouts++;
      
      return {
        id: `${a.transactionHash}:${a.conditionId}:${a.outcomeIndex}:${a.timestamp}:${a.type}`,
        wallet: walletLower,
        ts: new Date(a.timestamp * 1000).toISOString(),
        type: type,
        market_id: a.conditionId || null,
        condition_id: a.conditionId || null,
        token_id: null,
        outcome_side: a.outcomeIndex === 0 ? 'UP' : 'DOWN',
        amount_usd: amountUsd,
        shares: a.size || null,
        price: a.price || null,
        fee_usd: a.feesPaid || null,
        fee_known: a.feesPaid !== undefined,
        source: 'DATA_API',
        raw_json: a,
        ingested_at: new Date().toISOString(),
      };
    });

    await executeRest('polymarket_cashflows', 'upsert', cashflowRecords, { onConflict: 'id' });
    cashflowsIngested += batch.length;
  }

  payoutsIngested = payouts.length;
  
  console.log(`[subgraph-sync] Ingested: ${fillsIngested} fills, ${payoutsIngested} payouts (${inferredPayouts} inferred), ${cashflowsIngested} cashflows`);
  return { fillsIngested, payoutsIngested, cashflowsIngested, inferredPayouts };
}

/**
 * Ingest positions into database
 */
async function ingestPositions(wallet: string, positions: PolymarketPosition[]): Promise<number> {
  const walletLower = wallet.toLowerCase();
  
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
 * Store market resolution data
 */
async function storeMarketResolutions(resolutions: Map<string, MarketResolution>): Promise<void> {
  if (resolutions.size === 0) return;
  
  const records = Array.from(resolutions.values()).map(r => ({
    id: r.conditionId,
    condition_id: r.conditionId,
    is_resolved: r.isResolved,
    winning_outcome: r.winningOutcome,
    payout_per_share_up: r.winningOutcome === 'UP' ? 1 : (r.winningOutcome === 'SPLIT' ? 0.5 : 0),
    payout_per_share_down: r.winningOutcome === 'DOWN' ? 1 : (r.winningOutcome === 'SPLIT' ? 0.5 : 0),
    resolution_source: r.derivedFromRedeem ? 'DERIVED_FROM_REDEEM' : 'GAMMA_API',
    raw_json: r,
    updated_at: new Date().toISOString(),
  }));
  
  await executeRest('polymarket_market_resolution', 'upsert', records, { onConflict: 'id' });
  console.log(`[subgraph-sync] Stored ${records.length} market resolutions`);
}

/**
 * Update sync state
 */
async function updateSyncState(
  type: string, 
  wallet: string, 
  recordsCount: number,
  error?: string,
  payoutCount?: number
) {
  const record: Record<string, unknown> = {
    id: `${type}:${wallet.toLowerCase()}`,
    wallet: wallet.toLowerCase(),
    last_sync_at: new Date().toISOString(),
    records_synced: recordsCount,
    last_error: error || null,
    errors_count: error ? 1 : 0,
    updated_at: new Date().toISOString(),
  };
  
  if (payoutCount !== undefined) {
    record.payout_records_synced = payoutCount;
    record.payout_sync_at = new Date().toISOString();
  }
  
  await executeRest('subgraph_sync_state', 'upsert', record, { onConflict: 'id' });
}

/**
 * MAIN PnL COMPUTATION: Accrued vs Cash
 * 
 * For each market:
 * 1. Accrued PnL = (winning shares × 1.0) - total cost basis
 * 2. Cash PnL = sum of REDEEM/CLAIM amounts actually received
 * 
 * Lifecycle states:
 * - BOUGHT: has FILL_BUY
 * - SOLD: has FILL_SELL (closed via selling)
 * - CLAIMED: has REDEEM/CLAIM (won and redeemed)
 * - LOST: market resolved, held losing side, no payout
 */
async function computeAccruedCashPnl(
  wallet: string, 
  derivedResolutions: Map<string, MarketResolution>,
  gammaResolutions: Map<string, MarketResolution>
): Promise<{ syntheticClosures: number; marketsProcessed: number }> {
  const walletLower = wallet.toLowerCase();
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  let syntheticClosures = 0;
  let marketsProcessed = 0;

  // Merge resolutions: prefer derived from REDEEM (more reliable)
  const resolutions = new Map<string, MarketResolution>();
  for (const [k, v] of gammaResolutions) resolutions.set(k, v);
  for (const [k, v] of derivedResolutions) resolutions.set(k, v); // Override with derived

  // Get all cashflows for wallet
  const cashflowsRes = await fetch(
    `${supabaseUrl}/rest/v1/polymarket_cashflows?wallet=eq.${walletLower}&order=ts.asc`,
    {
      headers: {
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
      },
    }
  );

  const cashflows = await cashflowsRes.json();
  if (!cashflows || cashflows.length === 0) {
    console.log(`[subgraph-sync] No cashflows to compute PnL`);
    return { syntheticClosures: 0, marketsProcessed: 0 };
  }

  console.log(`[subgraph-sync] Computing ACCRUED vs CASH PnL for ${cashflows.length} cashflows...`);

  // Get current positions
  const positionsRes = await fetch(
    `${supabaseUrl}/rest/v1/subgraph_positions?wallet=eq.${walletLower}`,
    {
      headers: {
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
      },
    }
  );
  const positions = await positionsRes.json() || [];
  const positionsByMarket = new Map<string, typeof positions[0][]>();
  for (const pos of positions) {
    const marketId = pos.market_id || 'unknown';
    if (!positionsByMarket.has(marketId)) {
      positionsByMarket.set(marketId, []);
    }
    positionsByMarket.get(marketId)!.push(pos);
  }

  // Group cashflows by market
  const marketCashflows = new Map<string, typeof cashflows>();
  for (const cf of cashflows) {
    const marketId = cf.market_id || 'unknown';
    if (!marketCashflows.has(marketId)) {
      marketCashflows.set(marketId, []);
    }
    marketCashflows.get(marketId)!.push(cf);
  }

  // Compute PnL per market
  for (const [marketId, mCashflows] of marketCashflows) {
    if (marketId === 'unknown') continue;
    marketsProcessed++;
    
    // Track position state
    let upShares = 0;
    let downShares = 0;
    let upCost = 0;
    let downCost = 0;
    let feesKnown = 0;
    let feesUnknownCount = 0;
    let marketSlug: string | null = null;
    
    // Lifecycle flags
    let hasBuy = false;
    let hasSell = false;
    let hasRedeem = false;
    
    // Cash received
    let cashReceived = 0;
    let redeemShares = 0;
    let redeemOutcome: string | null = null;
    let redeemTs: string | null = null;
    let redeemTxHash: string | null = null;
    
    // Sell proceeds (for markets closed via SELL)
    let sellProceeds = 0;
    let sellCostBasis = 0;

    for (const cf of mCashflows) {
      const type = cf.type;
      const amount = Number(cf.amount_usd) || 0;
      const shares = Number(cf.shares) || 0;
      const price = Number(cf.price) || 0;
      const fee = Number(cf.fee_usd) || 0;
      const side = cf.outcome_side;
      
      if (!marketSlug && cf.raw_json?.slug) {
        marketSlug = cf.raw_json.slug;
      }

      if (cf.fee_known) {
        feesKnown += fee;
      } else if (type === 'FILL_BUY' || type === 'FILL_SELL') {
        feesUnknownCount++;
      }

      if (type === 'FILL_BUY') {
        hasBuy = true;
        const cost = shares * price;
        if (side === 'UP') {
          upCost += cost;
          upShares += shares;
        } else {
          downCost += cost;
          downShares += shares;
        }
      } else if (type === 'FILL_SELL') {
        hasSell = true;
        const proceeds = shares * price;
        let costBasis = 0;
        
        if (side === 'UP' && upShares > 0) {
          const avgCost = upCost / upShares;
          const soldShares = Math.min(shares, upShares);
          costBasis = soldShares * avgCost;
          upShares -= soldShares;
          upCost = upShares > 0 ? upShares * avgCost : 0;
        } else if (side === 'DOWN' && downShares > 0) {
          const avgCost = downCost / downShares;
          const soldShares = Math.min(shares, downShares);
          costBasis = soldShares * avgCost;
          downShares -= soldShares;
          downCost = downShares > 0 ? downShares * avgCost : 0;
        }
        
        sellProceeds += proceeds;
        sellCostBasis += costBasis;
      } else if (type === 'REDEEM' || type === 'CLAIM') {
        hasRedeem = true;
        cashReceived += amount;
        redeemShares += shares;
        redeemOutcome = side;
        redeemTs = cf.ts;
        redeemTxHash = cf.raw_json?.transactionHash;
      } else if (type === 'MERGE') {
        hasRedeem = true;
        cashReceived += amount;
      }
    }

    // Get resolution
    const resolution = resolutions.get(marketId);
    const winningOutcome = resolution?.winningOutcome ?? null;
    const isResolved = resolution?.isResolved ?? false;
    
    // Check current positions
    const currentPositions = positionsByMarket.get(marketId) || [];
    const hasOpenPosition = currentPositions.some(p => (Number(p.shares) || 0) > 0);
    
    // Total cost basis
    const totalCost = upCost + downCost;
    const historicalUpCost = mCashflows
      .filter((cf: {type: string; outcome_side: string}) => cf.type === 'FILL_BUY' && cf.outcome_side === 'UP')
      .reduce((sum: number, cf: {shares: number; price: number}) => sum + (Number(cf.shares) || 0) * (Number(cf.price) || 0), 0);
    const historicalDownCost = mCashflows
      .filter((cf: {type: string; outcome_side: string}) => cf.type === 'FILL_BUY' && cf.outcome_side === 'DOWN')
      .reduce((sum: number, cf: {shares: number; price: number}) => sum + (Number(cf.shares) || 0) * (Number(cf.price) || 0), 0);
    const historicalTotalCost = historicalUpCost + historicalDownCost;

    // Compute ACCRUED PnL
    let accruedPnl: number | null = null;
    let accruedConfidence: 'HIGH' | 'MEDIUM' | 'LOW' = 'LOW';
    let isSettled = false;
    let lifecycleState: string = 'BOUGHT';
    let isLost = false;
    let isClaimed = false;
    let missingPayoutReason: string | null = null;
    let syntheticClosureCreated = false;
    let syntheticClosureReason: string | null = null;

    if (hasRedeem) {
      // CLAIMED: We have redemption events
      isClaimed = true;
      isSettled = true;
      lifecycleState = 'CLAIMED';
      
      // Accrued PnL = cash received - historical cost
      accruedPnl = cashReceived - historicalTotalCost - feesKnown;
      accruedConfidence = feesUnknownCount > 0 ? 'MEDIUM' : 'HIGH';
      
    } else if (hasSell && !hasOpenPosition && upShares === 0 && downShares === 0) {
      // SOLD: Position closed via selling
      isSettled = true;
      lifecycleState = 'SOLD';
      
      // Accrued PnL = sell proceeds - cost basis sold
      accruedPnl = sellProceeds - sellCostBasis - feesKnown;
      accruedConfidence = feesUnknownCount > 0 ? 'MEDIUM' : 'HIGH';
      
    } else if (isResolved && winningOutcome && !hasOpenPosition) {
      // Market resolved and position closed without REDEEM
      // Check if we were on the losing side
      const heldUp = historicalUpCost > 0;
      const heldDown = historicalDownCost > 0;
      const wonUp = winningOutcome === 'UP';
      const wonDown = winningOutcome === 'DOWN';
      
      const lostOnUp = heldUp && wonDown;
      const lostOnDown = heldDown && wonUp;
      
      if (lostOnUp || lostOnDown) {
        // LOST: We held the losing side
        isLost = true;
        isSettled = true;
        lifecycleState = 'LOST';
        
        // Accrued PnL = -total cost (payout = 0)
        accruedPnl = -historicalTotalCost - feesKnown;
        accruedConfidence = 'HIGH';
        
        // Create synthetic closure
        syntheticClosureCreated = true;
        syntheticClosureReason = `lost_${winningOutcome?.toLowerCase()}_won`;
        syntheticClosures++;
        
        const syntheticId = `synthetic_loss:${walletLower}:${marketId}`;
        const syntheticCashflow = {
          id: syntheticId,
          wallet: walletLower,
          ts: new Date().toISOString(),
          type: 'SETTLEMENT_LOSS',
          market_id: marketId,
          condition_id: marketId,
          token_id: null,
          outcome_side: lostOnUp ? 'UP' : 'DOWN',
          amount_usd: 0,
          shares: 0,
          price: 0,
          fee_usd: 0,
          fee_known: true,
          source: 'SYNTHETIC',
          raw_json: { 
            reason: 'synthetic_loss_closure',
            winning_outcome: winningOutcome,
            lost_cost: historicalTotalCost,
          },
          ingested_at: new Date().toISOString(),
        };
        
        await executeRest('polymarket_cashflows', 'upsert', [syntheticCashflow], { onConflict: 'id' });
        console.log(`[subgraph-sync] Created LOST closure for ${marketSlug || marketId}: -$${historicalTotalCost.toFixed(2)}`);
        
      } else if ((heldUp && wonUp) || (heldDown && wonDown)) {
        // We held winning side but no REDEEM - maybe not claimed yet?
        isSettled = true;
        lifecycleState = 'CLAIMED'; // Assume won
        
        // Accrued PnL = winning shares × 1.0 - cost
        const winningShares = wonUp ? 
          mCashflows.filter((cf: {type: string; outcome_side: string}) => cf.type === 'FILL_BUY' && cf.outcome_side === 'UP').reduce((sum: number, cf: {shares: number}) => sum + (Number(cf.shares) || 0), 0) :
          mCashflows.filter((cf: {type: string; outcome_side: string}) => cf.type === 'FILL_BUY' && cf.outcome_side === 'DOWN').reduce((sum: number, cf: {shares: number}) => sum + (Number(cf.shares) || 0), 0);
        
        accruedPnl = winningShares - historicalTotalCost - feesKnown;
        accruedConfidence = 'MEDIUM';
        missingPayoutReason = 'Won but no REDEEM event (may not be claimed yet or event missing)';
      }
    } else if (!hasOpenPosition && historicalTotalCost > 0 && !hasSell && !hasRedeem) {
      // Position closed but we don't know how - mark incomplete
      lifecycleState = 'UNKNOWN';
      accruedPnl = null;
      accruedConfidence = 'LOW';
      missingPayoutReason = 'Position closed but no SELL/REDEEM events found';
    } else if (hasOpenPosition) {
      // Still open - compute unrealized
      lifecycleState = 'BOUGHT';
    }

    // Compute UNREALIZED PnL for open positions
    let unrealizedPnl: number | null = null;
    let unrealizedConfidence: 'HIGH' | 'MEDIUM' | 'LOW' = 'LOW';
    let markPriceUp: number | null = null;
    let markPriceDown: number | null = null;

    if (currentPositions.length > 0) {
      for (const pos of currentPositions) {
        const posShares = Number(pos.shares) || 0;
        const avgCost = Number(pos.avg_cost) || 0;
        const currentPrice = pos.raw_json?.currentPrice;
        
        if (posShares > 0 && currentPrice !== undefined && currentPrice !== null) {
          const markValue = posShares * Number(currentPrice);
          const costBasis = posShares * avgCost;
          unrealizedPnl = (unrealizedPnl || 0) + (markValue - costBasis);
          unrealizedConfidence = 'MEDIUM';
          
          if (pos.outcome_side === 'UP') markPriceUp = Number(currentPrice);
          else markPriceDown = Number(currentPrice);
        }
      }
    }

    // Overall confidence
    let overallConfidence: 'HIGH' | 'MEDIUM' | 'LOW' = 'HIGH';
    if (missingPayoutReason) overallConfidence = 'LOW';
    else if (feesUnknownCount > 0 || accruedConfidence === 'MEDIUM') overallConfidence = 'MEDIUM';

    // Compute historical share counts
    const historicalUpShares = mCashflows
      .filter((cf: {type: string; outcome_side: string}) => cf.type === 'FILL_BUY' && cf.outcome_side === 'UP')
      .reduce((sum: number, cf: {shares: number}) => sum + (Number(cf.shares) || 0), 0);
    const historicalDownShares = mCashflows
      .filter((cf: {type: string; outcome_side: string}) => cf.type === 'FILL_BUY' && cf.outcome_side === 'DOWN')
      .reduce((sum: number, cf: {shares: number}) => sum + (Number(cf.shares) || 0), 0);

    // Build market record
    const record = {
      id: `${walletLower}:${marketId}`,
      wallet: walletLower,
      market_id: marketId,
      market_slug: marketSlug,
      up_shares: historicalUpShares,
      down_shares: historicalDownShares,
      avg_up_cost: historicalUpShares > 0 ? historicalUpCost / historicalUpShares : null,
      avg_down_cost: historicalDownShares > 0 ? historicalDownCost / historicalDownShares : null,
      total_cost: historicalTotalCost,
      realized_pnl_usd: accruedPnl,
      unrealized_pnl_usd: unrealizedPnl,
      realized_confidence: accruedConfidence,
      unrealized_confidence: unrealizedConfidence,
      confidence: overallConfidence,
      fees_known_usd: feesKnown,
      fees_unknown_count: feesUnknownCount,
      is_settled: isSettled,
      settlement_outcome: isLost ? 'LOSS' : (isClaimed ? 'WIN' : (hasSell ? 'SOLD' : null)),
      settlement_payout: cashReceived > 0 ? cashReceived : null,
      payout_ingested: hasRedeem,
      payout_amount_usd: cashReceived > 0 ? cashReceived : null,
      payout_source: hasRedeem ? 'DATA_API' : null,
      payout_tx_hash: redeemTxHash,
      payout_ts: redeemTs,
      missing_payout_reason: missingPayoutReason,
      mark_price_up: markPriceUp,
      mark_price_down: markPriceDown,
      mark_source: markPriceUp || markPriceDown ? 'DATA_API' : null,
      mark_timestamp: new Date().toISOString(),
      lifecycle_bought: hasBuy,
      lifecycle_sold: hasSell,
      lifecycle_claimed: isClaimed,
      lifecycle_lost: isLost,
      lifecycle_state: lifecycleState,
      resolution_winning_outcome: winningOutcome,
      resolution_fetched_at: resolution ? new Date().toISOString() : null,
      synthetic_closure_created: syntheticClosureCreated,
      synthetic_closure_reason: syntheticClosureReason,
      updated_at: new Date().toISOString(),
    };

    await executeRest('subgraph_pnl_markets', 'upsert', record, { onConflict: 'id' });
  }

  // Build summary
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
    let totalUnrealized = 0;
    let totalFeesKnown = 0;
    let totalFeesUnknownCount = 0;
    let settledCount = 0;
    let openCount = 0;
    let payoutsIngestedCount = 0;
    let missingPayoutsCount = 0;
    let marketsBought = 0;
    let marketsSold = 0;
    let marketsClaimed = 0;
    let marketsLost = 0;

    for (const m of marketPnls) {
      totalRealized += Number(m.realized_pnl_usd) || 0;
      totalUnrealized += Number(m.unrealized_pnl_usd) || 0;
      totalFeesKnown += Number(m.fees_known_usd) || 0;
      totalFeesUnknownCount += m.fees_unknown_count || 0;
      if (m.is_settled) settledCount++;
      else openCount++;
      if (m.payout_ingested) payoutsIngestedCount++;
      if (m.missing_payout_reason) missingPayoutsCount++;
      if (m.lifecycle_bought) marketsBought++;
      if (m.lifecycle_sold) marketsSold++;
      if (m.lifecycle_claimed) marketsClaimed++;
      if (m.lifecycle_lost) marketsLost++;
    }

    let overallConfidence: 'HIGH' | 'MEDIUM' | 'LOW' = 'HIGH';
    if (missingPayoutsCount > 0) overallConfidence = 'LOW';
    else if (totalFeesUnknownCount > 0) overallConfidence = 'MEDIUM';

    const summaryRecord = {
      wallet: walletLower,
      total_realized_pnl: totalRealized,
      total_unrealized_pnl: totalUnrealized,
      total_pnl: totalRealized + totalUnrealized,
      total_fees_known: totalFeesKnown,
      total_fees_unknown_count: totalFeesUnknownCount,
      total_fills: cashflows.filter((cf: { type: string }) => cf.type.startsWith('FILL_')).length,
      total_payouts: cashflows.filter((cf: { type: string }) => ['REDEEM', 'CLAIM', 'SETTLEMENT_PAYOUT', 'MERGE', 'SETTLEMENT_LOSS'].includes(cf.type)).length,
      total_markets: marketPnls.length,
      settled_markets: settledCount,
      open_markets: openCount,
      payouts_ingested_count: payoutsIngestedCount,
      missing_payouts_count: missingPayoutsCount,
      markets_bought: marketsBought,
      markets_sold: marketsSold,
      markets_claimed: marketsClaimed,
      markets_lost: marketsLost,
      synthetic_closures_count: syntheticClosures,
      resolution_fetch_count: resolutions.size,
      realized_confidence: missingPayoutsCount > 0 ? 'LOW' : (totalFeesUnknownCount > 0 ? 'MEDIUM' : 'HIGH'),
      unrealized_confidence: openCount > 0 ? 'MEDIUM' : 'HIGH',
      overall_confidence: overallConfidence,
      pnl_complete: missingPayoutsCount === 0,
      updated_at: new Date().toISOString(),
    };

    await executeRest('subgraph_pnl_summary', 'upsert', summaryRecord, { onConflict: 'wallet' });
    console.log(`[subgraph-sync] PnL Summary: realized=$${totalRealized.toFixed(2)}, unrealized=$${(totalUnrealized || 0).toFixed(2)}, markets=${marketPnls.length}, settled=${settledCount}, claimed=${marketsClaimed}, lost=${marketsLost}`);
  }

  return { syntheticClosures, marketsProcessed };
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
    console.log(`[subgraph-sync] Starting ACCRUED vs CASH PnL sync for wallet: ${wallet.slice(0, 10)}...`);

    let fillsIngested = 0;
    let payoutsIngested = 0;
    let cashflowsIngested = 0;
    let inferredPayouts = 0;
    let positionsIngested = 0;
    let syntheticClosures = 0;
    let marketsProcessed = 0;
    let resolutionsFetched = 0;
    let fillsError: string | undefined;
    let positionsError: string | undefined;

    // Fetch ALL activity (trades + payouts)
    let activities: PolymarketActivity[] = [];
    try {
      activities = await fetchAllActivity(wallet);
      const result = await ingestActivityAsCashflows(wallet, activities);
      fillsIngested = result.fillsIngested;
      payoutsIngested = result.payoutsIngested;
      cashflowsIngested = result.cashflowsIngested;
      inferredPayouts = result.inferredPayouts;
      await updateSyncState('fills', wallet, fillsIngested, undefined, payoutsIngested);
    } catch (error) {
      fillsError = error instanceof Error ? error.message : String(error);
      console.error('[subgraph-sync] Activity sync error:', fillsError);
      await updateSyncState('fills', wallet, 0, fillsError);
    }

    // Fetch positions
    try {
      const positions = await fetchPositions(wallet);
      positionsIngested = await ingestPositions(wallet, positions);
      await updateSyncState('positions', wallet, positionsIngested);
    } catch (error) {
      positionsError = error instanceof Error ? error.message : String(error);
      console.error('[subgraph-sync] Positions sync error:', positionsError);
      await updateSyncState('positions', wallet, 0, positionsError);
    }

    // DERIVE resolutions from REDEEM events (most reliable)
    const derivedResolutions = deriveResolutionsFromActivity(activities);
    
    // FETCH resolutions from Gamma API (fallback for markets without REDEEM)
    const marketIds = [...new Set(activities.map(a => a.conditionId).filter(Boolean))];
    const marketsNeedingGamma = marketIds.filter(id => !derivedResolutions.has(id));
    let gammaResolutions = new Map<string, MarketResolution>();
    try {
      if (marketsNeedingGamma.length > 0) {
        gammaResolutions = await fetchMarketResolutions(marketsNeedingGamma);
      }
      resolutionsFetched = derivedResolutions.size + gammaResolutions.size;
      
      // Store all resolutions
      const allResolutions = new Map([...gammaResolutions, ...derivedResolutions]);
      await storeMarketResolutions(allResolutions);
    } catch (error) {
      console.error('[subgraph-sync] Resolution fetch error:', error);
    }

    // Compute PnL with ACCRUED vs CASH model
    try {
      const result = await computeAccruedCashPnl(wallet, derivedResolutions, gammaResolutions);
      syntheticClosures = result.syntheticClosures;
      marketsProcessed = result.marketsProcessed;
    } catch (error) {
      console.error('[subgraph-sync] PnL computation error:', error);
    }

    const response = {
      success: true,
      wallet: wallet.slice(0, 10) + '...',
      fillsIngested,
      payoutsIngested,
      inferredPayouts,
      cashflowsIngested,
      positionsIngested,
      resolutionsFetched,
      derivedFromRedeem: derivedResolutions.size,
      syntheticClosures,
      marketsProcessed,
      errors: {
        fills: fillsError,
        positions: positionsError,
      },
    };

    console.log(`[subgraph-sync] Sync complete:`, JSON.stringify(response));

    return new Response(JSON.stringify(response), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('[subgraph-sync] Fatal error:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 }
    );
  }
});
