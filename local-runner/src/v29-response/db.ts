/**
 * V29 Response-Based Strategy - Database Functions
 * 
 * Async logging to avoid blocking the hot path.
 * All DB writes are fire-and-forget with batching.
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
import type { SignalLog, TickLog } from './types.js';
import type { Asset, Direction } from './config.js';

let supabase: SupabaseClient | null = null;

// Batching for ticks (high frequency)
let tickQueue: TickLog[] = [];
let tickFlushTimeout: NodeJS.Timeout | null = null;
const TICK_FLUSH_INTERVAL_MS = 2000;
const TICK_BATCH_SIZE = 100;

// Batching for logs (lower frequency)
let logQueue: Array<{
  run_id: string;
  level: string;
  category: string;
  message: string;
  asset?: string;
  data?: Record<string, unknown>;
}> = [];
let logFlushTimeout: NodeJS.Timeout | null = null;

// ============================================
// INITIALIZATION
// ============================================

export function initDb(): SupabaseClient {
  if (supabase) return supabase;
  
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  
  if (!url || !key) {
    throw new Error('Missing Supabase credentials');
  }
  
  supabase = createClient(url, key);
  return supabase;
}

export function getDb(): SupabaseClient {
  if (!supabase) return initDb();
  return supabase;
}

// ============================================
// CONFIG LOADING
// ============================================

export async function loadConfig(): Promise<Record<string, unknown> | null> {
  try {
    const db = getDb();
    const { data, error } = await db
      .from('v29_config_response')
      .select('*')
      .eq('id', 'v29-response')
      .maybeSingle();
    
    if (error) {
      console.log('[V29:DB] Config load error:', error.message);
      return null;
    }
    
    if (!data) return null;
    
    // Merge config_json into the base data (config_json takes priority)
    // This allows hedge_mode settings stored in config_json to override base columns
    const configJson = data.config_json as Record<string, unknown> | null;
    if (configJson && typeof configJson === 'object') {
      const { config_json: _, ...baseData } = data;
      return { ...baseData, ...configJson };
    }
    
    return data;
  } catch (err) {
    console.log('[V29:DB] Config load failed:', err);
    return null;
  }
}

// ============================================
// SIGNAL LOGGING
// ============================================

export async function saveSignal(signal: SignalLog): Promise<void> {
  try {
    const db = getDb();
    
    const record = {
      id: signal.id,
      run_id: signal.run_id,
      asset: signal.asset,
      direction: signal.direction,
      
      binance_price: signal.binance_price,
      binance_delta: signal.binance_delta,
      binance_ts: signal.binance_ts,
      
      share_price_t0: signal.share_price_t0,
      spread_t0: signal.spread_t0,
      best_bid_t0: signal.best_bid_t0,
      best_ask_t0: signal.best_ask_t0,
      
      market_slug: signal.market_slug,
      strike_price: signal.strike_price,
      
      status: signal.status,
      skip_reason: signal.skip_reason,
      entry_price: signal.entry_price,
      exit_price: signal.exit_price,
      shares: signal.shares,
      
      signal_ts: signal.signal_ts,
      decision_ts: signal.decision_ts,
      fill_ts: signal.fill_ts,
      exit_ts: signal.exit_ts,
      
      exit_type: signal.exit_type,
      exit_reason: signal.exit_reason,
      
      gross_pnl: signal.gross_pnl,
      fees: signal.fees,
      net_pnl: signal.net_pnl,
      
      price_at_1s: signal.price_at_1s,
      price_at_2s: signal.price_at_2s,
      price_at_3s: signal.price_at_3s,
      price_at_5s: signal.price_at_5s,
      
      decision_latency_ms: signal.decision_latency_ms,
      order_latency_ms: signal.order_latency_ms,
      fill_latency_ms: signal.fill_latency_ms,
      exit_latency_ms: signal.exit_latency_ms,
      
      created_at: new Date().toISOString(),
    };
    
    const { error } = await db
      .from('v29_signals_response')
      .upsert(record, { onConflict: 'id' });
    
    if (error) {
      console.log('[V29:DB] Signal save error:', error.message);
    }
  } catch (err) {
    console.log('[V29:DB] Signal save failed:', err);
  }
}

// ============================================
// TICK LOGGING (BATCHED)
// ============================================

export function queueTick(tick: TickLog): void {
  tickQueue.push(tick);
  
  // Flush if batch is full
  if (tickQueue.length >= TICK_BATCH_SIZE) {
    flushTicks();
  } else if (!tickFlushTimeout) {
    // Schedule flush
    tickFlushTimeout = setTimeout(flushTicks, TICK_FLUSH_INTERVAL_MS);
  }
}

async function flushTicks(): Promise<void> {
  if (tickFlushTimeout) {
    clearTimeout(tickFlushTimeout);
    tickFlushTimeout = null;
  }
  
  if (tickQueue.length === 0) return;
  
  const batch = tickQueue.splice(0, TICK_BATCH_SIZE);
  
  try {
    const db = getDb();
    
    const records = batch.map(t => ({
      run_id: t.run_id,
      asset: t.asset,
      ts: t.ts,
      binance_price: t.binance_price,
      binance_delta: t.binance_delta,
      up_best_bid: t.up_best_bid,
      up_best_ask: t.up_best_ask,
      down_best_bid: t.down_best_bid,
      down_best_ask: t.down_best_ask,
      market_slug: t.market_slug,
      strike_price: t.strike_price,
      signal_triggered: t.signal_triggered,
      signal_direction: t.signal_direction,
      signal_id: t.signal_id,
      created_at: new Date().toISOString(),
    }));
    
    const { error } = await db
      .from('v29_ticks_response')
      .insert(records);
    
    if (error) {
      console.log('[V29:DB] Tick flush error:', error.message);
    }
  } catch (err) {
    console.log('[V29:DB] Tick flush failed:', err);
  }
  
  // Continue flushing if more in queue
  if (tickQueue.length > 0) {
    tickFlushTimeout = setTimeout(flushTicks, TICK_FLUSH_INTERVAL_MS);
  }
}

// ============================================
// GENERAL LOG (BATCHED)
// ============================================

export function queueLog(
  runId: string,
  level: string,
  category: string,
  message: string,
  asset?: string,
  data?: Record<string, unknown>
): void {
  logQueue.push({ run_id: runId, level, category, message, asset, data });
  
  if (!logFlushTimeout) {
    logFlushTimeout = setTimeout(flushLogs, 5000);
  }
}

async function flushLogs(): Promise<void> {
  if (logFlushTimeout) {
    clearTimeout(logFlushTimeout);
    logFlushTimeout = null;
  }
  
  if (logQueue.length === 0) return;
  
  const batch = logQueue.splice(0, 50);
  
  try {
    const db = getDb();
    
    const records = batch.map(l => ({
      run_id: l.run_id,
      level: l.level,
      category: l.category,
      message: l.message,
      asset: l.asset,
      data: l.data ? JSON.stringify(l.data) : null,
      created_at: new Date().toISOString(),
    }));
    
    await db.from('v29_logs_response').insert(records);
  } catch (err) {
    // Silent fail for logs
  }
  
  if (logQueue.length > 0) {
    logFlushTimeout = setTimeout(flushLogs, 5000);
  }
}

// ============================================
// HEARTBEAT
// ============================================

export async function sendHeartbeat(
  runId: string,
  status: string,
  data: Record<string, unknown>
): Promise<void> {
  try {
    const db = getDb();

    const marketsCount = Number((data.markets ?? data.markets_active) ?? 0);
    const positionsCount = Number((data.activePositions ?? data.positions_active) ?? 0);
    const tradesCount = Number((data.trades ?? data.trades_count) ?? 0);
    const balance = typeof data.balance === 'number' ? data.balance : null;
    const version = typeof data.version === 'string' ? data.version : 'v29r';

    // Schema uses (runner_id TEXT, id UUID). We try to upsert on runner_id.
    const payload = {
      runner_id: runId,
      runner_type: 'v29-response',
      status,
      last_heartbeat: new Date().toISOString(),
      markets_count: marketsCount,
      markets_active: marketsCount,
      positions_count: positionsCount,
      trades_count: tradesCount,
      balance,
      version,
    };

    const upsertRes = await db
      .from('runner_heartbeats')
      .upsert(payload, { onConflict: 'runner_id' });

    // If runner_id isn't unique in the DB schema, Postgres will reject upsert.
    // Fall back to inserting a new row so we still get operational visibility.
    if (upsertRes.error) {
      await db.from('runner_heartbeats').insert({
        id: randomUUID(),
        ...payload,
      });
    }
  } catch {
    // Silent fail
  }
}

// ============================================
// FLUSH ALL (for shutdown)
// ============================================

export async function flushAll(): Promise<void> {
  await flushTicks();
  await flushLogs();
}
