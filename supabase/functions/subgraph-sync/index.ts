import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

/**
 * Polymarket Data Sync Service - Cashflow-Based PnL with Lifecycle States
 * 
 * Fetches canonical data from Polymarket Data API:
 * - Activity: trades (BUY/SELL), redemptions, claims, merges, splits
 * - Positions: current position state
 * - Market Resolution: winning outcome for resolved markets (to derive "Lost")
 * 
 * Creates cashflow records for accurate PnL tracking:
 * - FILL_BUY: cost outflow
 * - FILL_SELL: proceeds inflow
 * - REDEEM/CLAIM: settlement payout inflow
 * - SETTLEMENT_LOSS: synthetic closure for losing positions (payout = 0)
 * 
 * Lifecycle states: Bought, Sold, Claimed, Lost
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const DATA_API_BASE = 'https://data-api.polymarket.com';
const GAMMA_API_BASE = 'https://gamma-api.polymarket.com';

// Config
const PAGE_SIZE = 500;
const MAX_PAGES = 10;
const MAX_AGE_DAYS = 60;

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
}

/**
 * Fetch ALL user activity from Polymarket Data API (not just trades)
 */
async function fetchAllActivity(wallet: string): Promise<PolymarketActivity[]> {
  const allActivity: PolymarketActivity[] = [];
  let offset = 0;
  let pagesLoaded = 0;
  const cutoffTime = Math.floor(Date.now() / 1000) - (MAX_AGE_DAYS * 24 * 60 * 60);

  console.log(`[subgraph-sync] Fetching ALL activity (last ${MAX_AGE_DAYS} days, max ${MAX_PAGES} pages)...`);

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
    console.log(`[subgraph-sync] Page ${pagesLoaded}/${MAX_PAGES}: ${recentActivity.length} activities (total: ${allActivity.length})`);
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
  console.log(`[subgraph-sync] Fetching positions for wallet ${wallet.slice(0, 10)}...`);

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
 * Fetch market resolution status from Gamma API
 */
async function fetchMarketResolution(conditionIds: string[]): Promise<Map<string, MarketResolution>> {
  const resolutions = new Map<string, MarketResolution>();
  
  if (conditionIds.length === 0) return resolutions;
  
  console.log(`[subgraph-sync] Fetching resolution for ${conditionIds.length} markets...`);
  
  // Fetch in batches
  const batchSize = 20;
  for (let i = 0; i < conditionIds.length; i += batchSize) {
    const batch = conditionIds.slice(i, i + batchSize);
    
    await Promise.all(batch.map(async (conditionId) => {
      try {
        // Try Gamma API for market info
        const url = `${GAMMA_API_BASE}/markets?condition_id=${conditionId}`;
        const response = await fetch(url);
        
        if (response.ok) {
          const markets = await response.json();
          if (Array.isArray(markets) && markets.length > 0) {
            const market = markets[0];
            const isResolved = market.closed === true || market.resolved === true;
            let winningOutcome: string | null = null;
            let payoutNumerators: number[] = [];
            
            if (isResolved && market.payoutNumerators) {
              payoutNumerators = market.payoutNumerators.map(Number);
              // Determine winning outcome: index with payout > 0
              if (payoutNumerators[0] > 0 && payoutNumerators[1] === 0) {
                winningOutcome = 'UP';
              } else if (payoutNumerators[1] > 0 && payoutNumerators[0] === 0) {
                winningOutcome = 'DOWN';
              } else if (payoutNumerators[0] > 0 && payoutNumerators[1] > 0) {
                winningOutcome = 'SPLIT'; // Both outcomes paid (rare)
              }
            }
            
            resolutions.set(conditionId, {
              conditionId,
              isResolved,
              winningOutcome,
              payoutNumerators,
            });
          }
        }
      } catch (error) {
        console.error(`[subgraph-sync] Error fetching resolution for ${conditionId}:`, error);
      }
    }));
    
    // Small delay between batches
    if (i + batchSize < conditionIds.length) {
      await new Promise(r => setTimeout(r, 100));
    }
  }
  
  console.log(`[subgraph-sync] Fetched resolution for ${resolutions.size} markets`);
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
 */
function computeCashflowAmount(activity: PolymarketActivity, type: string): number {
  const price = Number(activity.price) || 0;
  const size = Number(activity.size) || 0;
  const usdcSize = Number(activity.usdcSize) || (price * size);
  const fee = Number(activity.feesPaid) || 0;

  switch (type) {
    case 'FILL_BUY':
      return -(usdcSize + fee);
    case 'FILL_SELL':
      return usdcSize - fee;
    case 'REDEEM':
    case 'CLAIM':
    case 'SETTLEMENT_PAYOUT':
      return usdcSize;
    case 'MERGE':
      return usdcSize;
    case 'SPLIT':
      return -usdcSize;
    default:
      return 0;
  }
}

/**
 * Ingest activity as cashflows + fills
 */
async function ingestActivityAsCashflows(
  wallet: string, 
  activities: PolymarketActivity[]
): Promise<{ fillsIngested: number; payoutsIngested: number; cashflowsIngested: number }> {
  if (activities.length === 0) return { fillsIngested: 0, payoutsIngested: 0, cashflowsIngested: 0 };

  const walletLower = wallet.toLowerCase();
  let fillsIngested = 0;
  let payoutsIngested = 0;
  let cashflowsIngested = 0;
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
      const amountUsd = computeCashflowAmount(a, type);
      
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
  
  console.log(`[subgraph-sync] Ingested: ${fillsIngested} fills, ${payoutsIngested} payouts, ${cashflowsIngested} cashflows`);
  return { fillsIngested, payoutsIngested, cashflowsIngested };
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
    payout_per_share_up: r.payoutNumerators?.[0] ?? 0,
    payout_per_share_down: r.payoutNumerators?.[1] ?? 0,
    resolution_source: 'DATA_API',
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
 * Compute PnL using CASHFLOW-BASED method with LIFECYCLE STATES
 * 
 * Lifecycle states:
 * - Bought: has any FILL_BUY
 * - Sold: has any FILL_SELL
 * - Claimed: has REDEEM/CLAIM/PAYOUT event (payout > 0)
 * - Lost: market resolved, held losing side, position is 0, no payout event (payout = 0)
 */
async function computeCashflowPnl(
  wallet: string, 
  resolutions: Map<string, MarketResolution>
): Promise<{ syntheticClosures: number }> {
  const walletLower = wallet.toLowerCase();
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  let syntheticClosures = 0;

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
    return { syntheticClosures: 0 };
  }

  console.log(`[subgraph-sync] Computing cashflow-based PnL for ${cashflows.length} cashflows...`);

  // Get current positions for mark-to-market
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
    // Lifecycle detection
    let hasBuy = false;
    let hasSell = false;
    let hasClaim = false;
    
    // PnL computation
    let realizedPnl = 0;
    let upShares = 0;
    let downShares = 0;
    let upCost = 0;
    let downCost = 0;
    let feesKnown = 0;
    let feesUnknownCount = 0;
    let hasPayouts = false;
    let payoutAmount = 0;
    let payoutTxHash: string | null = null;
    let payoutTs: string | null = null;
    let marketSlug: string | null = null;
    let heldOutcomeSide: string | null = null;

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

      // Track position for cost basis
      if (type === 'FILL_BUY') {
        hasBuy = true;
        if (side === 'UP') {
          upCost += shares * price;
          upShares += shares;
          heldOutcomeSide = 'UP';
        } else {
          downCost += shares * price;
          downShares += shares;
          heldOutcomeSide = 'DOWN';
        }
      } else if (type === 'FILL_SELL') {
        hasSell = true;
        if (side === 'UP' && upShares > 0) {
          const avgCost = upCost / upShares;
          const sellShares = Math.min(shares, upShares);
          const costBasis = sellShares * avgCost;
          realizedPnl += (sellShares * price) - costBasis - fee;
          upShares -= sellShares;
          upCost = upShares > 0 ? (upCost - costBasis) : 0;
        } else if (side === 'DOWN' && downShares > 0) {
          const avgCost = downCost / downShares;
          const sellShares = Math.min(shares, downShares);
          const costBasis = sellShares * avgCost;
          realizedPnl += (sellShares * price) - costBasis - fee;
          downShares -= sellShares;
          downCost = downShares > 0 ? (downCost - costBasis) : 0;
        }
      } else if (type === 'REDEEM' || type === 'CLAIM' || type === 'SETTLEMENT_PAYOUT') {
        hasClaim = true;
        hasPayouts = true;
        payoutAmount += amount;
        payoutTxHash = cf.raw_json?.transactionHash || payoutTxHash;
        payoutTs = cf.ts || payoutTs;
        
        if (side === 'UP' && upShares > 0) {
          realizedPnl += amount;
          upShares = 0;
          upCost = 0;
        } else if (side === 'DOWN' && downShares > 0) {
          realizedPnl += amount;
          downShares = 0;
          downCost = 0;
        } else {
          realizedPnl += amount;
        }
      } else if (type === 'MERGE') {
        hasClaim = true;
        hasPayouts = true;
        realizedPnl += amount;
        upShares = 0;
        downShares = 0;
        upCost = 0;
        downCost = 0;
      } else if (type === 'SETTLEMENT_LOSS') {
        // Synthetic closure - already realized loss
        hasPayouts = true;
        realizedPnl += amount; // amount is 0 or negative
      }
    }

    // Check if market has open position from positions table
    const marketPositions = positionsByMarket.get(marketId) || [];
    let isSettled = hasPayouts && marketPositions.length === 0;
    let unrealizedPnl: number | null = null;
    let unrealizedConfidence: 'HIGH' | 'MEDIUM' | 'LOW' = 'LOW';
    let markPriceUp: number | null = null;
    let markPriceDown: number | null = null;

    // Compute unrealized PnL if position exists
    if (marketPositions.length > 0) {
      isSettled = false;
      for (const pos of marketPositions) {
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

    // Determine confidence and lifecycle
    let realizedConfidence: 'HIGH' | 'MEDIUM' | 'LOW' = 'HIGH';
    let overallConfidence: 'HIGH' | 'MEDIUM' | 'LOW' = 'HIGH';
    let missingPayoutReason: string | null = null;
    let isLost = false;
    let syntheticClosureCreated = false;
    let syntheticClosureReason: string | null = null;
    let resolutionWinningOutcome: string | null = null;

    if (feesUnknownCount > 0) {
      realizedConfidence = 'MEDIUM';
      overallConfidence = 'MEDIUM';
    }

    // Check resolution to derive "Lost" state
    const resolution = resolutions.get(marketId);
    if (resolution) {
      resolutionWinningOutcome = resolution.winningOutcome;
      
      // If market is resolved, no payout events, position is 0, and we held the losing side
      if (resolution.isResolved && !hasPayouts && marketPositions.length === 0 && (upCost > 0 || downCost > 0)) {
        // Determine if we held the losing side
        const heldUp = upCost > 0;
        const heldDown = downCost > 0;
        const wonUp = resolution.winningOutcome === 'UP';
        const wonDown = resolution.winningOutcome === 'DOWN';
        
        const lostOnUp = heldUp && wonDown;
        const lostOnDown = heldDown && wonUp;
        
        if (lostOnUp || lostOnDown) {
          // This is a LOSS - create synthetic closure
          isLost = true;
          syntheticClosureCreated = true;
          syntheticClosureReason = `resolved_${resolution.winningOutcome?.toLowerCase()}_won`;
          
          // Realize the loss: cost basis is gone
          const lostCost = lostOnUp ? upCost : downCost;
          realizedPnl -= lostCost;
          hasPayouts = true; // Mark as having closure
          isSettled = true;
          
          // Create synthetic cashflow for the loss
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
            amount_usd: 0, // Payout is 0 for losses
            shares: lostOnUp ? upShares : downShares,
            price: 0,
            fee_usd: 0,
            fee_known: true,
            source: 'DATA_API',
            raw_json: { 
              reason: 'synthetic_loss_closure',
              winning_outcome: resolution.winningOutcome,
              lost_cost: lostCost,
            },
            ingested_at: new Date().toISOString(),
          };
          
          await executeRest('polymarket_cashflows', 'upsert', [syntheticCashflow], { onConflict: 'id' });
          syntheticClosures++;
          
          console.log(`[subgraph-sync] Created synthetic LOSS closure for ${marketSlug || marketId}: -$${lostCost.toFixed(2)}`);
        } else if ((heldUp && wonUp) || (heldDown && wonDown)) {
          // We held the winning side but no payout event - mark as incomplete
          realizedConfidence = 'LOW';
          overallConfidence = 'LOW';
          missingPayoutReason = `Won but no payout event: held ${heldUp ? 'UP' : 'DOWN'}, won ${resolution.winningOutcome}`;
        }
      }
    } else if (!hasPayouts && marketPositions.length === 0 && (upCost > 0 || downCost > 0)) {
      // No resolution data and no payout - mark as incomplete
      realizedConfidence = 'LOW';
      overallConfidence = 'LOW';
      missingPayoutReason = 'No payout events and no resolution data for closed position';
    }

    // Determine primary lifecycle state
    let lifecycleState: string;
    if (isLost) {
      lifecycleState = 'LOST';
    } else if (hasClaim) {
      lifecycleState = 'CLAIMED';
    } else if (hasSell && marketPositions.length === 0) {
      lifecycleState = 'SOLD';
    } else if (hasBuy) {
      lifecycleState = 'BOUGHT';
    } else {
      lifecycleState = 'UNKNOWN';
    }

    const avgUp = upShares > 0 ? upCost / upShares : null;
    const avgDown = downShares > 0 ? downCost / downShares : null;
    const totalCost = upCost + downCost;

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
      unrealized_pnl_usd: unrealizedPnl,
      realized_confidence: realizedConfidence,
      unrealized_confidence: unrealizedConfidence,
      confidence: overallConfidence,
      fees_known_usd: feesKnown,
      fees_unknown_count: feesUnknownCount,
      is_settled: isSettled,
      settlement_outcome: isLost ? 'LOSS' : (hasPayouts && payoutAmount > 0 ? 'WIN' : null),
      settlement_payout: hasPayouts ? payoutAmount : null,
      payout_ingested: hasPayouts,
      payout_amount_usd: hasPayouts ? payoutAmount : null,
      payout_source: hasPayouts ? 'DATA_API' : null,
      payout_tx_hash: payoutTxHash,
      payout_ts: payoutTs,
      missing_payout_reason: missingPayoutReason,
      mark_price_up: markPriceUp,
      mark_price_down: markPriceDown,
      mark_source: markPriceUp || markPriceDown ? 'DATA_API' : null,
      mark_timestamp: new Date().toISOString(),
      // Lifecycle states
      lifecycle_bought: hasBuy,
      lifecycle_sold: hasSell,
      lifecycle_claimed: hasClaim,
      lifecycle_lost: isLost,
      lifecycle_state: lifecycleState,
      resolution_winning_outcome: resolutionWinningOutcome,
      resolution_fetched_at: resolution ? new Date().toISOString() : null,
      synthetic_closure_created: syntheticClosureCreated,
      synthetic_closure_reason: syntheticClosureReason,
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
    console.log(`[subgraph-sync] PnL Summary: realized=$${totalRealized.toFixed(2)}, unrealized=$${(totalUnrealized || 0).toFixed(2)}, markets=${marketPnls.length}, claimed=${marketsClaimed}, lost=${marketsLost}, syntheticClosures=${syntheticClosures}`);
  }

  return { syntheticClosures };
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
    console.log(`[subgraph-sync] Starting CASHFLOW-BASED sync with LIFECYCLE for wallet: ${wallet.slice(0, 10)}...`);

    let fillsIngested = 0;
    let payoutsIngested = 0;
    let cashflowsIngested = 0;
    let positionsIngested = 0;
    let syntheticClosures = 0;
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

    // Fetch market resolutions for markets that might need "Lost" derivation
    const marketIds = [...new Set(activities.map(a => a.conditionId).filter(Boolean))];
    let resolutions = new Map<string, MarketResolution>();
    try {
      resolutions = await fetchMarketResolution(marketIds);
      resolutionsFetched = resolutions.size;
      await storeMarketResolutions(resolutions);
    } catch (error) {
      console.error('[subgraph-sync] Resolution fetch error:', error);
    }

    // Compute cashflow-based PnL with lifecycle states
    try {
      const result = await computeCashflowPnl(wallet, resolutions);
      syntheticClosures = result.syntheticClosures;
    } catch (error) {
      console.error('[subgraph-sync] PnL computation error:', error);
    }

    const response = {
      success: true,
      wallet: wallet.slice(0, 10) + '...',
      fills: fillsIngested,
      payouts: payoutsIngested,
      cashflows: cashflowsIngested,
      positions: positionsIngested,
      resolutions: resolutionsFetched,
      syntheticClosures,
      errors: {
        fills: fillsError,
        positions: positionsError,
      },
      syncedAt: new Date().toISOString(),
    };

    console.log('[subgraph-sync] Sync complete:', response);

    return new Response(
      JSON.stringify(response),
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
