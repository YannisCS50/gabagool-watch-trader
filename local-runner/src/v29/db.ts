/**
 * V29 Database Functions
 * 
 * Simple Supabase operations for signals, positions, and logging
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { Signal, AggregatePosition } from './types.js';
import type { Asset } from './config.js';

let supabase: SupabaseClient | null = null;

function log(msg: string): void {
  console.log(`[V29:DB] ${msg}`);
}

export function initDb(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;
  
  if (!url || !key) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
  }
  
  supabase = createClient(url, key);
  log('Initialized');
  return supabase;
}

export function getDb(): SupabaseClient {
  if (!supabase) {
    return initDb();
  }
  return supabase;
}

/**
 * Save or update a signal to v29_signals table
 */
export async function saveSignal(signal: Signal): Promise<string | null> {
  const db = getDb();
  
  try {
    if (signal.id) {
      // Update existing
      const { error } = await db
        .from('v29_signals')
        .update({
          status: signal.status,
          entry_price: signal.entry_price,
          exit_price: signal.exit_price,
          shares: signal.shares,
          fill_ts: signal.fill_ts,
          sell_ts: signal.close_ts,
          exit_reason: signal.exit_type,
          net_pnl: signal.net_pnl,
        })
        .eq('id', signal.id);
      
      if (error) throw error;
      return signal.id;
    } else {
      // Insert new
      const { data, error } = await db
        .from('v29_signals')
        .insert({
          run_id: signal.run_id,
          asset: signal.asset,
          direction: signal.direction,
          binance_price: signal.binance_price,
          delta_usd: signal.binance_delta,
          share_price: signal.share_price,
          market_slug: signal.market_slug,
          strike_price: signal.strike_price,
          status: signal.status,
          signal_ts: signal.signal_ts,
        })
        .select('id')
        .single();
      
      if (error) throw error;
      return data?.id ?? null;
    }
  } catch (err) {
    log(`❌ Save failed: ${err}`);
    return null;
  }
}

/**
 * Load V29 config from database - SIMPLE STRATEGY
 */
export async function loadV29Config(): Promise<{
  enabled: boolean;
  tick_delta_usd: number;
  delta_threshold: number;
  min_share_price: number;
  max_share_price: number;
  shares_per_trade: number;
  take_profit_cents: number;
  timeout_seconds: number;
  max_sell_retries: number;
  price_buffer_cents: number;
  assets: string[];
  binance_poll_ms: number;
  orderbook_poll_ms: number;
  order_cooldown_ms: number;
} | null> {
  const db = getDb();
  
  try {
    const { data, error } = await db
      .from('v29_config')
      .select('*')
      .eq('id', 'default')
      .single();
    
    if (error || !data) {
      log('No V29 config found, using defaults');
      return null;
    }
    
    return {
      enabled: data.enabled ?? true,
      tick_delta_usd: Number(data.tick_delta_usd ?? data.min_delta_usd ?? 6),
      delta_threshold: Number(data.delta_threshold ?? 75),
      min_share_price: Number(data.min_share_price ?? 0.30),
      max_share_price: Number(data.max_share_price ?? 0.75),
      shares_per_trade: Number(data.shares_per_trade ?? 5),
      take_profit_cents: Number(data.take_profit_cents ?? 4),
      timeout_seconds: Number(data.timeout_seconds ?? 10),
      max_sell_retries: Number(data.max_sell_retries ?? 5),
      price_buffer_cents: Number(data.price_buffer_cents ?? 1),
      assets: data.assets ?? ['BTC'],
      binance_poll_ms: Number(data.binance_poll_ms ?? 100),
      orderbook_poll_ms: Number(data.orderbook_poll_ms ?? 2000),
      order_cooldown_ms: Number(data.order_cooldown_ms ?? 3000),
    };
  } catch (err) {
    log(`Config load error: ${err}`);
    return null;
  }
}

// ============================================
// AGGREGATE POSITIONS (Accumulation & Hedge)
// ============================================

/**
 * Get aggregate position for an asset/side in a market
 */
export async function getAggregatePosition(
  asset: Asset,
  side: 'UP' | 'DOWN',
  marketSlug: string
): Promise<AggregatePosition | null> {
  const db = getDb();
  
  try {
    const { data, error } = await db
      .from('v29_positions')
      .select('*')
      .eq('asset', asset)
      .eq('side', side)
      .eq('market_slug', marketSlug)
      .single();
    
    if (error || !data) return null;
    
    return {
      id: data.id,
      runId: data.run_id,
      asset: data.asset as Asset,
      side: data.side as 'UP' | 'DOWN',
      marketSlug: data.market_slug,
      tokenId: data.token_id || '',
      totalShares: Number(data.total_shares),
      totalCost: Number(data.total_cost),
      avgEntryPrice: data.total_shares > 0 ? Number(data.total_cost) / Number(data.total_shares) : 0,
      hedgeShares: Number(data.hedge_shares),
      hedgeCost: Number(data.hedge_cost),
      isFullyHedged: data.is_fully_hedged,
      createdAt: new Date(data.created_at),
      updatedAt: new Date(data.updated_at),
    };
  } catch {
    return null;
  }
}

/**
 * Get all aggregate positions for a market
 */
export async function getAllPositionsForMarket(marketSlug: string): Promise<AggregatePosition[]> {
  const db = getDb();
  
  try {
    const { data, error } = await db
      .from('v29_positions')
      .select('*')
      .eq('market_slug', marketSlug);
    
    if (error || !data) return [];
    
    return data.map(d => ({
      id: d.id,
      runId: d.run_id,
      asset: d.asset as Asset,
      side: d.side as 'UP' | 'DOWN',
      marketSlug: d.market_slug,
      tokenId: d.token_id || '',
      totalShares: Number(d.total_shares),
      totalCost: Number(d.total_cost),
      avgEntryPrice: d.total_shares > 0 ? Number(d.total_cost) / Number(d.total_shares) : 0,
      hedgeShares: Number(d.hedge_shares),
      hedgeCost: Number(d.hedge_cost),
      isFullyHedged: d.is_fully_hedged,
      createdAt: new Date(d.created_at),
      updatedAt: new Date(d.updated_at),
    }));
  } catch {
    return [];
  }
}

/**
 * Upsert aggregate position (add shares to existing or create new)
 */
export async function upsertAggregatePosition(
  runId: string,
  asset: Asset,
  side: 'UP' | 'DOWN',
  marketSlug: string,
  tokenId: string,
  addShares: number,
  addCost: number
): Promise<AggregatePosition | null> {
  const db = getDb();
  
  try {
    // First try to get existing
    const existing = await getAggregatePosition(asset, side, marketSlug);
    
    if (existing) {
      // Update existing
      const newShares = existing.totalShares + addShares;
      const newCost = existing.totalCost + addCost;
      
      const { data, error } = await db
        .from('v29_positions')
        .update({
          total_shares: newShares,
          total_cost: newCost,
          run_id: runId,
          updated_at: new Date().toISOString(),
        })
        .eq('id', existing.id)
        .select()
        .single();
      
      if (error) throw error;
      
      return {
        ...existing,
        runId,
        totalShares: newShares,
        totalCost: newCost,
        avgEntryPrice: newShares > 0 ? newCost / newShares : 0,
        updatedAt: new Date(),
      };
    } else {
      // Create new
      const { data, error } = await db
        .from('v29_positions')
        .insert({
          run_id: runId,
          asset,
          side,
          market_slug: marketSlug,
          token_id: tokenId,
          total_shares: addShares,
          total_cost: addCost,
          hedge_shares: 0,
          hedge_cost: 0,
          is_fully_hedged: false,
        })
        .select()
        .single();
      
      if (error) throw error;
      
      return {
        id: data.id,
        runId,
        asset,
        side,
        marketSlug,
        tokenId,
        totalShares: addShares,
        totalCost: addCost,
        avgEntryPrice: addShares > 0 ? addCost / addShares : 0,
        hedgeShares: 0,
        hedgeCost: 0,
        isFullyHedged: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    }
  } catch (err) {
    log(`❌ Failed to upsert position: ${err}`);
    return null;
  }
}

/**
 * Add hedge shares to a position
 */
export async function addHedgeToPosition(
  positionId: string,
  hedgeShares: number,
  hedgeCost: number,
  isFullyHedged: boolean
): Promise<boolean> {
  const db = getDb();
  
  try {
    const { error } = await db
      .from('v29_positions')
      .update({
        hedge_shares: hedgeShares,
        hedge_cost: hedgeCost,
        is_fully_hedged: isFullyHedged,
        updated_at: new Date().toISOString(),
      })
      .eq('id', positionId);
    
    return !error;
  } catch {
    return false;
  }
}

/**
 * Clear all positions for a market (on settlement/expiry)
 */
export async function clearPositionsForMarket(marketSlug: string): Promise<void> {
  const db = getDb();
  
  try {
    await db
      .from('v29_positions')
      .delete()
      .eq('market_slug', marketSlug);
  } catch (err) {
    log(`Failed to clear positions: ${err}`);
  }
}

/**
 * Legacy: Load config overrides from v27_config (fallback)
 */
export async function loadConfigFromDb(): Promise<Record<string, unknown> | null> {
  const db = getDb();
  
  try {
    const { data, error } = await db
      .from('v27_config')
      .select('*')
      .eq('id', 'v29-live')
      .single();
    
    if (error || !data) {
      return null;
    }
    
    return data;
  } catch {
    return null;
  }
}

/**
 * Send heartbeat
 */
export async function sendHeartbeat(
  heartbeatId: string,
  runnerId: string,
  status: string,
  balance: number,
  positionCount: number,
  tradesCount: number
): Promise<void> {
  const db = getDb();

  try {
    await db.from('runner_heartbeats').upsert({
      id: heartbeatId,
      runner_id: runnerId,
      runner_type: 'v29-live',
      status,
      last_heartbeat: new Date().toISOString(),
      balance,
      positions_count: positionCount,
      trades_count: tradesCount,
      markets_count: 4,
      version: 'v29.0.1',
    });
  } catch (err) {
    log(`⚠️ Heartbeat failed: ${err}`);
  }
}

/**
 * Log an event to v29_logs table
 */
export async function logEvent(
  runId: string,
  level: 'info' | 'warn' | 'error' | 'debug',
  category: string,
  message: string,
  asset?: string,
  data?: Record<string, unknown>
): Promise<void> {
  const db = getDb();
  
  try {
    await db.from('v29_logs').insert({
      ts: Date.now(),
      run_id: runId,
      level,
      category,
      asset: asset || null,
      message,
      data: data || null,
    });
  } catch {
    // Silent fail - don't spam console
  }
}

/**
 * Batch log multiple events (more efficient)
 */
let logBuffer: Array<{
  ts: number;
  run_id: string;
  level: string;
  category: string;
  asset: string | null;
  message: string;
  data: Record<string, unknown> | null;
}> = [];
let flushTimeout: NodeJS.Timeout | null = null;

export function queueLog(
  runId: string,
  level: 'info' | 'warn' | 'error' | 'debug',
  category: string,
  message: string,
  asset?: string,
  data?: Record<string, unknown>
): void {
  logBuffer.push({
    ts: Date.now(),
    run_id: runId,
    level,
    category,
    asset: asset || null,
    message,
    data: data || null,
  });
  
  // Flush every 2 seconds or when buffer reaches 50 items
  if (logBuffer.length >= 50) {
    void flushLogs();
  } else if (!flushTimeout) {
    flushTimeout = setTimeout(() => void flushLogs(), 2000);
  }
}

async function flushLogs(): Promise<void> {
  if (flushTimeout) {
    clearTimeout(flushTimeout);
    flushTimeout = null;
  }
  
  if (logBuffer.length === 0) return;
  
  const batch = logBuffer;
  logBuffer = [];
  
  const db = getDb();
  
  try {
    await db.from('v29_logs').insert(batch);
  } catch {
    // Silent fail
  }
}

// ============================================
// FILL LOGGING - Track individual burst fills
// ============================================

export interface FillRecord {
  signalId?: string;
  runId: string;
  asset: string;
  direction: 'UP' | 'DOWN';
  marketSlug: string;
  orderId?: string;
  price: number;
  shares: number;
  costUsd: number;
  fillTs: number;
}

/**
 * Log individual fills from burst orders
 */
export async function logFill(fill: FillRecord): Promise<void> {
  const db = getDb();
  
  try {
    await db.from('v29_fills').insert({
      signal_id: fill.signalId || null,
      run_id: fill.runId,
      asset: fill.asset,
      direction: fill.direction,
      market_slug: fill.marketSlug,
      order_id: fill.orderId || null,
      price: fill.price,
      shares: fill.shares,
      cost_usd: fill.costUsd,
      fill_ts: fill.fillTs,
    });
  } catch (err) {
    log(`⚠️ Failed to log fill: ${err}`);
  }
}

/**
 * Log multiple fills at once (more efficient)
 */
export async function logFillsBatch(fills: FillRecord[]): Promise<void> {
  if (fills.length === 0) return;
  
  const db = getDb();
  
  try {
    await db.from('v29_fills').insert(
      fills.map(f => ({
        signal_id: f.signalId || null,
        run_id: f.runId,
        asset: f.asset,
        direction: f.direction,
        market_slug: f.marketSlug,
        order_id: f.orderId || null,
        price: f.price,
        shares: f.shares,
        cost_usd: f.costUsd,
        fill_ts: f.fillTs,
      }))
    );
  } catch (err) {
    log(`⚠️ Failed to log ${fills.length} fills: ${err}`);
  }
}

// ============================================
// TICK LOGGING - Tick-by-tick price and signal data
// ============================================

export interface TickRecord {
  runId: string;
  asset: string;
  binancePrice?: number;
  chainlinkPrice?: number;
  binanceDelta?: number;
  upBestAsk?: number;
  upBestBid?: number;
  downBestAsk?: number;
  downBestBid?: number;
  alertTriggered?: boolean;
  signalDirection?: 'UP' | 'DOWN';
  orderPlaced?: boolean;
  orderId?: string;
  fillPrice?: number;
  fillSize?: number;
  marketSlug?: string;
  strikePrice?: number;
  // Latency tracking
  orderLatencyMs?: number;    // Time to place order
  fillLatencyMs?: number;     // Time from order post to fill
  signalToFillMs?: number;    // Total time from signal to fill
  signLatencyMs?: number;     // Time to sign order (0 if cached)
  postLatencyMs?: number;     // Time to post to exchange
  usedCache?: boolean;        // Whether pre-signed cache was used
}

// Buffer for tick data (batch inserts for efficiency)
let tickBuffer: TickRecord[] = [];
let tickFlushTimeout: NodeJS.Timeout | null = null;

/**
 * Queue a tick record for batch insert
 */
export function queueTick(tick: TickRecord): void {
  tickBuffer.push(tick);
  
  // Flush every 1 second or when buffer reaches 20 items
  if (tickBuffer.length >= 20) {
    void flushTicks();
  } else if (!tickFlushTimeout) {
    tickFlushTimeout = setTimeout(() => void flushTicks(), 1000);
  }
}

/**
 * Flush all queued ticks to database
 */
async function flushTicks(): Promise<void> {
  if (tickFlushTimeout) {
    clearTimeout(tickFlushTimeout);
    tickFlushTimeout = null;
  }
  
  if (tickBuffer.length === 0) return;
  
  const batch = tickBuffer;
  tickBuffer = [];
  
  const db = getDb();
  const ts = Date.now();
  
  try {
    await db.from('v29_ticks').insert(
      batch.map(t => ({
        ts,
        run_id: t.runId,
        asset: t.asset,
        binance_price: t.binancePrice ?? null,
        chainlink_price: t.chainlinkPrice ?? null,
        binance_delta: t.binanceDelta ?? null,
        up_best_ask: t.upBestAsk ?? null,
        up_best_bid: t.upBestBid ?? null,
        down_best_ask: t.downBestAsk ?? null,
        down_best_bid: t.downBestBid ?? null,
        alert_triggered: t.alertTriggered ?? false,
        signal_direction: t.signalDirection ?? null,
        order_placed: t.orderPlaced ?? false,
        order_id: t.orderId ?? null,
        fill_price: t.fillPrice ?? null,
        fill_size: t.fillSize ?? null,
        market_slug: t.marketSlug ?? null,
        strike_price: t.strikePrice ?? null,
      }))
    );
  } catch (err) {
    log(`⚠️ Failed to log ${batch.length} ticks: ${err}`);
  }
}

/**
 * Log a single tick immediately (for alerts/orders)
 */
export async function logTick(tick: TickRecord): Promise<void> {
  const db = getDb();
  
  try {
    await db.from('v29_ticks').insert({
      ts: Date.now(),
      run_id: tick.runId,
      asset: tick.asset,
      binance_price: tick.binancePrice ?? null,
      chainlink_price: tick.chainlinkPrice ?? null,
      binance_delta: tick.binanceDelta ?? null,
      up_best_ask: tick.upBestAsk ?? null,
      up_best_bid: tick.upBestBid ?? null,
      down_best_ask: tick.downBestAsk ?? null,
      down_best_bid: tick.downBestBid ?? null,
      alert_triggered: tick.alertTriggered ?? false,
      signal_direction: tick.signalDirection ?? null,
      order_placed: tick.orderPlaced ?? false,
      order_id: tick.orderId ?? null,
      fill_price: tick.fillPrice ?? null,
      fill_size: tick.fillSize ?? null,
      market_slug: tick.marketSlug ?? null,
      strike_price: tick.strikePrice ?? null,
      // Latency fields
      order_latency_ms: tick.orderLatencyMs ?? null,
      fill_latency_ms: tick.fillLatencyMs ?? null,
      signal_to_fill_ms: tick.signalToFillMs ?? null,
      sign_latency_ms: tick.signLatencyMs ?? null,
      post_latency_ms: tick.postLatencyMs ?? null,
      used_cache: tick.usedCache ?? false,
    });
  } catch (err) {
    log(`⚠️ Failed to log tick: ${err}`);
  }
}
