/**
 * V29 Order & Bet Tracker
 * 
 * Tracks individual orders with P&L and aggregates per 15-min bet window.
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';

let supabase: SupabaseClient | null = null;

function getDb(): SupabaseClient {
  if (!supabase) {
    // Use same env vars as db.ts - SUPABASE_URL (not VITE_SUPABASE_URL)
    const supabaseUrl = process.env.SUPABASE_URL || '';
    const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || '';
    if (!supabaseUrl || !supabaseKey) {
      console.error('[OrderTracker] Missing env vars. Available:', Object.keys(process.env).filter(k => k.includes('SUPABASE')));
      throw new Error('Supabase URL and key are required for order tracker');
    }
    supabase = createClient(supabaseUrl, supabaseKey);
    console.log('[OrderTracker] Initialized Supabase client');
  }
  return supabase;
}

export interface OrderRecord {
  id?: string;
  run_id?: string;
  asset: string;
  market_id: string;
  token_id?: string;
  side: 'BUY' | 'SELL';
  direction: 'UP' | 'DOWN';
  shares: number;
  price: number;
  cost?: number;
  status: 'pending' | 'filled' | 'partial' | 'cancelled' | 'failed';
  fill_price?: number;
  fill_shares?: number;
  fill_cost?: number;
  pnl?: number;
  order_id?: string;
  signal_id?: string;
  filled_at?: string;
  notes?: string;
}

export interface BetRecord {
  id?: string;
  run_id?: string;
  asset: string;
  market_id: string;
  market_slug?: string;
  strike_price?: number;
  window_start: string;
  window_end: string;
  up_shares?: number;
  up_avg_price?: number;
  up_cost?: number;
  down_shares?: number;
  down_avg_price?: number;
  down_cost?: number;
  buy_count?: number;
  sell_count?: number;
  total_cost?: number;
  total_revenue?: number;
  realized_pnl?: number;
  unrealized_pnl?: number;
  status: 'active' | 'closed' | 'settled';
  result?: 'win' | 'loss' | 'breakeven' | 'pending';
  settled_outcome?: 'UP' | 'DOWN';
  payout?: number;
}

// In-memory cache of active bets by market_id
const activeBets: Map<string, BetRecord> = new Map();

// Track cost basis for P&L calculation
interface CostBasis {
  upShares: number;
  upAvgCost: number;
  downShares: number;
  downAvgCost: number;
}
const costBasis: Map<string, CostBasis> = new Map();

let runId: string | undefined;

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] [V29:Tracker] ${msg}`);
}

/**
 * Initialize the tracker with current run ID
 */
export function initTracker(currentRunId: string): void {
  runId = currentRunId;
  activeBets.clear();
  costBasis.clear();
  log(`Initialized with run_id: ${runId}`);
}

/**
 * Get or create a bet record for a market window
 */
export async function getOrCreateBet(
  asset: string,
  marketId: string,
  marketSlug: string,
  strikePrice: number,
  windowStart: Date,
  windowEnd: Date
): Promise<BetRecord> {
  // Check cache first
  const cached = activeBets.get(marketId);
  if (cached) {
    return cached;
  }

  // Check database
  const { data: existing } = await getDb()
    .from('v29_bets')
    .select('*')
    .eq('market_id', marketId)
    .eq('status', 'active')
    .single();

  if (existing) {
    activeBets.set(marketId, existing as BetRecord);
    return existing as BetRecord;
  }

  // Create new bet
  const newBet: BetRecord = {
    run_id: runId,
    asset,
    market_id: marketId,
    market_slug: marketSlug,
    strike_price: strikePrice,
    window_start: windowStart.toISOString(),
    window_end: windowEnd.toISOString(),
    up_shares: 0,
    up_avg_price: 0,
    up_cost: 0,
    down_shares: 0,
    down_avg_price: 0,
    down_cost: 0,
    buy_count: 0,
    sell_count: 0,
    total_cost: 0,
    total_revenue: 0,
    realized_pnl: 0,
    unrealized_pnl: 0,
    status: 'active',
    result: 'pending',
  };

  const { data: inserted, error } = await getDb()
    .from('v29_bets')
    .insert(newBet)
    .select()
    .single();

  if (error) {
    log(`❌ Failed to create bet: ${error.message}`);
    return newBet;
  }

  const bet = inserted as BetRecord;
  activeBets.set(marketId, bet);
  log(`📊 Created bet: ${asset} ${marketSlug}`);
  
  return bet;
}

/**
 * Record a new order (buy or sell)
 */
export async function recordOrder(order: Omit<OrderRecord, 'id'>): Promise<string | null> {
  const record = {
    ...order,
    run_id: runId,
    cost: order.side === 'BUY' ? order.shares * order.price : undefined,
  };

  const { data, error } = await getDb()
    .from('v29_orders')
    .insert(record)
    .select('id')
    .single();

  if (error) {
    log(`❌ Failed to record order: ${error.message}`);
    return null;
  }

  log(`📝 Order: ${order.side} ${order.asset} ${order.direction} ${order.shares} @ ${(order.price * 100).toFixed(1)}¢`);
  return data.id;
}

/**
 * Update order with fill information
 */
export async function updateOrderFill(
  orderId: string,
  fillPrice: number,
  fillShares: number,
  polymarketOrderId?: string
): Promise<void> {
  const fillCost = fillShares * fillPrice;

  const { error } = await getDb()
    .from('v29_orders')
    .update({
      status: 'filled',
      fill_price: fillPrice,
      fill_shares: fillShares,
      fill_cost: fillCost,
      order_id: polymarketOrderId,
      filled_at: new Date().toISOString(),
    })
    .eq('id', orderId);

  if (error) {
    log(`❌ Failed to update order fill: ${error.message}`);
  }
}

/**
 * Record a buy fill and update the bet
 */
export async function recordBuyFill(
  asset: string,
  marketId: string,
  direction: 'UP' | 'DOWN',
  shares: number,
  price: number,
  orderId?: string
): Promise<void> {
  const cost = shares * price;
  
  // Update cost basis
  let basis = costBasis.get(marketId);
  if (!basis) {
    basis = { upShares: 0, upAvgCost: 0, downShares: 0, downAvgCost: 0 };
    costBasis.set(marketId, basis);
  }

  if (direction === 'UP') {
    const totalCost = basis.upShares * basis.upAvgCost + cost;
    basis.upShares += shares;
    basis.upAvgCost = basis.upShares > 0 ? totalCost / basis.upShares : 0;
  } else {
    const totalCost = basis.downShares * basis.downAvgCost + cost;
    basis.downShares += shares;
    basis.downAvgCost = basis.downShares > 0 ? totalCost / basis.downShares : 0;
  }

  // Update bet record
  const bet = activeBets.get(marketId);
  if (bet) {
    if (direction === 'UP') {
      bet.up_shares = basis.upShares;
      bet.up_avg_price = basis.upAvgCost;
      bet.up_cost = basis.upShares * basis.upAvgCost;
    } else {
      bet.down_shares = basis.downShares;
      bet.down_avg_price = basis.downAvgCost;
      bet.down_cost = basis.downShares * basis.downAvgCost;
    }
    bet.buy_count = (bet.buy_count || 0) + 1;
    bet.total_cost = (bet.total_cost || 0) + cost;

    // Persist to database
    await getDb()
      .from('v29_bets')
      .update({
        up_shares: bet.up_shares,
        up_avg_price: bet.up_avg_price,
        up_cost: bet.up_cost,
        down_shares: bet.down_shares,
        down_avg_price: bet.down_avg_price,
        down_cost: bet.down_cost,
        buy_count: bet.buy_count,
        total_cost: bet.total_cost,
      })
      .eq('id', bet.id);
  }

  log(`💰 Buy: ${asset} ${direction} ${shares} @ ${(price * 100).toFixed(1)}¢ = $${cost.toFixed(2)}`);
}

/**
 * Record a sell fill with P&L calculation
 */
export async function recordSellFill(
  asset: string,
  marketId: string,
  direction: 'UP' | 'DOWN',
  shares: number,
  price: number,
  orderId?: string
): Promise<number> {
  const revenue = shares * price;
  
  // Calculate P&L based on cost basis
  const basis = costBasis.get(marketId);
  let pnl = 0;
  let costBasisPrice = 0;

  if (basis) {
    if (direction === 'UP' && basis.upShares > 0) {
      costBasisPrice = basis.upAvgCost;
      pnl = (price - costBasisPrice) * shares;
      basis.upShares = Math.max(0, basis.upShares - shares);
    } else if (direction === 'DOWN' && basis.downShares > 0) {
      costBasisPrice = basis.downAvgCost;
      pnl = (price - costBasisPrice) * shares;
      basis.downShares = Math.max(0, basis.downShares - shares);
    }
  }

  // Update bet record
  const bet = activeBets.get(marketId);
  if (bet) {
    if (direction === 'UP') {
      bet.up_shares = basis?.upShares || 0;
    } else {
      bet.down_shares = basis?.downShares || 0;
    }
    bet.sell_count = (bet.sell_count || 0) + 1;
    bet.total_revenue = (bet.total_revenue || 0) + revenue;
    bet.realized_pnl = (bet.realized_pnl || 0) + pnl;

    // Persist to database
    await getDb()
      .from('v29_bets')
      .update({
        up_shares: bet.up_shares,
        down_shares: bet.down_shares,
        sell_count: bet.sell_count,
        total_revenue: bet.total_revenue,
        realized_pnl: bet.realized_pnl,
      })
      .eq('id', bet.id);
  }

  const pnlStr = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;
  log(`💵 Sell: ${asset} ${direction} ${shares} @ ${(price * 100).toFixed(1)}¢ = $${revenue.toFixed(2)} (P&L: ${pnlStr})`);

  // Update order with P&L
  if (orderId) {
    await getDb()
      .from('v29_orders')
      .update({ pnl })
      .eq('order_id', orderId);
  }

  return pnl;
}

/**
 * Update unrealized P&L based on current prices
 */
export async function updateUnrealizedPnL(
  marketId: string,
  upBid: number,
  downBid: number
): Promise<void> {
  const basis = costBasis.get(marketId);
  const bet = activeBets.get(marketId);
  
  if (!basis || !bet) return;

  // Calculate unrealized P&L
  const upUnrealized = basis.upShares > 0 ? (upBid - basis.upAvgCost) * basis.upShares : 0;
  const downUnrealized = basis.downShares > 0 ? (downBid - basis.downAvgCost) * basis.downShares : 0;
  const totalUnrealized = upUnrealized + downUnrealized;

  bet.unrealized_pnl = totalUnrealized;

  // Persist (throttled - only update every few seconds)
  await getDb()
    .from('v29_bets')
    .update({ unrealized_pnl: totalUnrealized })
    .eq('id', bet.id);
}

/**
 * Close a bet when the window ends
 */
export async function closeBet(
  marketId: string,
  settledOutcome?: 'UP' | 'DOWN'
): Promise<void> {
  const bet = activeBets.get(marketId);
  if (!bet) return;

  // Calculate final P&L
  let payout = 0;
  const basis = costBasis.get(marketId);
  
  if (settledOutcome && basis) {
    // Winning shares pay out at $1.00 each
    if (settledOutcome === 'UP') {
      payout = basis.upShares * 1.0;
    } else {
      payout = basis.downShares * 1.0;
    }
  }

  const totalCost = bet.total_cost || 0;
  const totalRevenue = (bet.total_revenue || 0) + payout;
  const finalPnL = totalRevenue - totalCost;

  let result: 'win' | 'loss' | 'breakeven' = 'breakeven';
  if (finalPnL > 0.01) result = 'win';
  else if (finalPnL < -0.01) result = 'loss';

  // Update bet
  await getDb()
    .from('v29_bets')
    .update({
      status: 'settled',
      settled_outcome: settledOutcome,
      payout,
      total_revenue: totalRevenue,
      realized_pnl: finalPnL,
      unrealized_pnl: 0,
      result,
    })
    .eq('id', bet.id);

  // Clean up cache
  activeBets.delete(marketId);
  costBasis.delete(marketId);

  const pnlStr = finalPnL >= 0 ? `+$${finalPnL.toFixed(2)}` : `-$${Math.abs(finalPnL).toFixed(2)}`;
  log(`🏁 Bet closed: ${bet.asset} ${bet.market_slug} → ${result.toUpperCase()} (${pnlStr})`);
}

/**
 * Get summary of all active bets
 */
export function getActiveBetsSummary(): { totalCost: number; totalPnL: number; count: number } {
  let totalCost = 0;
  let totalPnL = 0;
  let count = 0;

  for (const bet of activeBets.values()) {
    totalCost += bet.total_cost || 0;
    totalPnL += (bet.realized_pnl || 0) + (bet.unrealized_pnl || 0);
    count++;
  }

  return { totalCost, totalPnL, count };
}

/**
 * Get bet by market ID
 */
export function getBet(marketId: string): BetRecord | undefined {
  return activeBets.get(marketId);
}

/**
 * Get cost basis for a market
 */
export function getCostBasis(marketId: string): CostBasis | undefined {
  return costBasis.get(marketId);
}
