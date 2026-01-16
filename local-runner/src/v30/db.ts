/**
 * V30 Database Operations
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { DEFAULT_V30_CONFIG } from './config.js';
import type { V30Config, V30Tick, V30Position, Asset } from './types.js';

let db: SupabaseClient | null = null;

export function initDb(): SupabaseClient {
  const url = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const key = process.env.VITE_SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  
  if (!url || !key) {
    throw new Error('Missing Supabase credentials');
  }
  
  db = createClient(url, key);
  return db;
}

export function getDb(): SupabaseClient {
  if (!db) {
    return initDb();
  }
  return db;
}

/**
 * Load V30 config from database
 */
export async function loadV30Config(): Promise<V30Config> {
  const supabase = getDb();
  
  const { data, error } = await supabase
    .from('v30_config')
    .select('*')
    .eq('id', 'default')
    .single();
  
  if (error || !data) {
    console.log('[V30] Using default config');
    return DEFAULT_V30_CONFIG;
  }
  
  return {
    enabled: data.enabled ?? DEFAULT_V30_CONFIG.enabled,
    assets: (data.assets as Asset[]) ?? DEFAULT_V30_CONFIG.assets,
    fair_value_model: data.fair_value_model ?? DEFAULT_V30_CONFIG.fair_value_model,
    base_theta: Number(data.base_theta) || DEFAULT_V30_CONFIG.base_theta,
    theta_time_decay_factor: Number(data.theta_time_decay_factor) || DEFAULT_V30_CONFIG.theta_time_decay_factor,
    theta_inventory_factor: Number(data.theta_inventory_factor) || DEFAULT_V30_CONFIG.theta_inventory_factor,
    i_max_base: Number(data.i_max_base) || DEFAULT_V30_CONFIG.i_max_base,
    bet_size_base: Number(data.bet_size_base) || DEFAULT_V30_CONFIG.bet_size_base,
    bet_size_vol_factor: Number(data.bet_size_vol_factor) || DEFAULT_V30_CONFIG.bet_size_vol_factor,
    force_counter_at_pct: Number(data.force_counter_at_pct) || DEFAULT_V30_CONFIG.force_counter_at_pct,
    aggressive_exit_sec: Number(data.aggressive_exit_sec) || DEFAULT_V30_CONFIG.aggressive_exit_sec,
    min_share_price: Number(data.min_share_price) || DEFAULT_V30_CONFIG.min_share_price,
    max_share_price: Number(data.max_share_price) || DEFAULT_V30_CONFIG.max_share_price,
    min_time_remaining_sec: Number(data.min_time_remaining_sec) || DEFAULT_V30_CONFIG.min_time_remaining_sec,
  };
}

/**
 * Save V30 config to database
 */
export async function saveV30Config(config: Partial<V30Config>): Promise<boolean> {
  const supabase = getDb();
  
  const { error } = await supabase
    .from('v30_config')
    .upsert({
      id: 'default',
      ...config,
      updated_at: new Date().toISOString(),
    });
  
  if (error) {
    console.error('[V30] Failed to save config:', error.message);
    return false;
  }
  
  return true;
}

/**
 * Log a tick
 */
export async function logTick(tick: V30Tick): Promise<void> {
  const supabase = getDb();
  
  const { error } = await supabase.from('v30_ticks').insert({
    ts: tick.ts,
    run_id: tick.run_id,
    asset: tick.asset,
    market_slug: tick.market_slug,
    c_price: tick.c_price,
    z_price: tick.z_price,
    strike_price: tick.strike_price,
    seconds_remaining: tick.seconds_remaining,
    delta_to_strike: tick.delta_to_strike,
    up_best_ask: tick.up_best_ask,
    up_best_bid: tick.up_best_bid,
    down_best_ask: tick.down_best_ask,
    down_best_bid: tick.down_best_bid,
    fair_p_up: tick.fair_p_up,
    edge_up: tick.edge_up,
    edge_down: tick.edge_down,
    theta_current: tick.theta_current,
    inventory_up: tick.inventory_up,
    inventory_down: tick.inventory_down,
    inventory_net: tick.inventory_net,
    action_taken: tick.action_taken,
  });
  
  if (error) {
    console.error('[V30] Failed to log tick:', error.message);
  }
}

// Batch tick queue
let tickQueue: V30Tick[] = [];
const TICK_BATCH_SIZE = 50;
const TICK_FLUSH_INTERVAL = 5000;

export function queueTick(tick: V30Tick): void {
  tickQueue.push(tick);
  if (tickQueue.length >= TICK_BATCH_SIZE) {
    flushTicks();
  }
}

export async function flushTicks(): Promise<void> {
  if (tickQueue.length === 0) return;
  
  const batch = tickQueue.splice(0, TICK_BATCH_SIZE);
  const supabase = getDb();
  
  const { error } = await supabase.from('v30_ticks').insert(batch);
  
  if (error) {
    console.error('[V30] Failed to flush ticks:', error.message);
    // Re-queue failed ticks
    tickQueue.unshift(...batch);
  }
}

// Start flush interval
setInterval(flushTicks, TICK_FLUSH_INTERVAL);

// ============================================
// LOG BATCHING
// ============================================

interface LogEntry {
  ts: number;
  run_id: string;
  level: string;
  category: string;
  asset: string | null;
  message: string;
  data: Record<string, unknown> | null;
}

let logQueue: LogEntry[] = [];
const LOG_BATCH_SIZE = 30;
const LOG_FLUSH_INTERVAL = 3000;

export function queueLog(
  runId: string,
  level: 'debug' | 'info' | 'warn' | 'error',
  category: string,
  message: string,
  asset?: string,
  data?: Record<string, unknown>
): void {
  logQueue.push({
    ts: Date.now(),
    run_id: runId,
    level,
    category,
    asset: asset ?? null,
    message,
    data: data ?? null,
  });
  
  if (logQueue.length >= LOG_BATCH_SIZE) {
    flushLogs();
  }
}

export async function flushLogs(): Promise<void> {
  if (logQueue.length === 0) return;
  
  const batch = logQueue.splice(0, LOG_BATCH_SIZE);
  const supabase = getDb();
  
  const { error } = await supabase.from('v30_logs').insert(batch);
  
  if (error) {
    // Log to console only if DB fails
    console.error('[V30] Failed to flush logs:', error.message);
  }
}

// Periodic log flush
setInterval(flushLogs, LOG_FLUSH_INTERVAL);

/**
 * Load positions for a run
 */
export async function loadPositions(runId: string): Promise<V30Position[]> {
  const supabase = getDb();
  
  const { data, error } = await supabase
    .from('v30_positions')
    .select('*')
    .eq('run_id', runId);
  
  if (error) {
    console.error('[V30] Failed to load positions:', error.message);
    return [];
  }
  
  return (data || []).map(row => ({
    id: row.id,
    run_id: row.run_id,
    asset: row.asset as Asset,
    market_slug: row.market_slug,
    direction: row.direction as 'UP' | 'DOWN',
    shares: Number(row.shares),
    avg_entry_price: Number(row.avg_entry_price),
    total_cost: Number(row.total_cost),
  }));
}

/**
 * Upsert position
 */
export async function upsertPosition(position: V30Position): Promise<void> {
  const supabase = getDb();
  
  const { error } = await supabase.from('v30_positions').upsert({
    run_id: position.run_id,
    asset: position.asset,
    market_slug: position.market_slug,
    direction: position.direction,
    shares: position.shares,
    avg_entry_price: position.avg_entry_price,
    total_cost: position.total_cost,
    updated_at: new Date().toISOString(),
  }, {
    onConflict: 'run_id,asset,market_slug,direction',
  });
  
  if (error) {
    console.error('[V30] Failed to upsert position:', error.message);
  }
}

/**
 * Delete positions for a market
 */
export async function clearMarketPositions(runId: string, marketSlug: string): Promise<void> {
  const supabase = getDb();
  
  const { error } = await supabase
    .from('v30_positions')
    .delete()
    .eq('run_id', runId)
    .eq('market_slug', marketSlug);
  
  if (error) {
    console.error('[V30] Failed to clear positions:', error.message);
  }
}

/**
 * Send heartbeat
 */
export async function sendHeartbeat(
  runId: string,
  status: string,
  marketsActive: number,
  positionsCount: number,
  balance: number | null
): Promise<void> {
  const supabase = getDb();
  
  // Use a consistent UUID for this runner type (v30-market-maker)
  // This allows upsert to work correctly
  const V30_HEARTBEAT_UUID = '00000000-0000-0000-0000-000000000030';
  
  const { error } = await supabase.from('runner_heartbeats').upsert({
    id: V30_HEARTBEAT_UUID,
    runner_id: runId,
    runner_type: 'v30-market-maker',
    last_heartbeat: new Date().toISOString(),
    status,
    markets_active: marketsActive,
    positions_count: positionsCount,
    balance,
    version: 'v30.0.1',
  });
  
  if (error) {
    console.error('[V30] Heartbeat failed:', error.message);
  }
}

/**
 * Load historical data for fair value calibration
 */
export async function loadHistoricalData(limit: number = 10000): Promise<Array<{
  asset: Asset;
  deltaToStrike: number;
  secRemaining: number;
  upWon: boolean;
  ts: number;
}>> {
  const supabase = getDb();
  
  // First get market history for outcomes and end times
  const { data: markets, error: marketsError } = await supabase
    .from('market_history')
    .select('slug, result, event_end_time')
    .not('result', 'is', null);
  
  if (marketsError || !markets) {
    console.error('[V30] Failed to load market history:', marketsError?.message);
    return [];
  }
  
  const marketMap = new Map<string, { result: string; endTime: number }>();
  for (const m of markets) {
    marketMap.set(m.slug, {
      result: m.result,
      endTime: new Date(m.event_end_time).getTime(),
    });
  }
  
  // Get v29_ticks
  const { data, error } = await supabase
    .from('v29_ticks')
    .select(`
      asset,
      binance_price,
      strike_price,
      ts,
      market_slug
    `)
    .not('strike_price', 'is', null)
    .not('binance_price', 'is', null)
    .not('market_slug', 'is', null)
    .order('ts', { ascending: false })
    .limit(limit);
  
  if (error || !data) {
    console.error('[V30] Failed to load historical ticks:', error?.message);
    return [];
  }
  
  // Transform data
  return data
    .filter(d => d.market_slug && marketMap.has(d.market_slug))
    .map(d => {
      const market = marketMap.get(d.market_slug!)!;
      return {
        asset: d.asset as Asset,
        deltaToStrike: Number(d.binance_price) - Number(d.strike_price),
        secRemaining: Math.max(0, (market.endTime - d.ts) / 1000),
        upWon: market.result === 'UP',
        ts: d.ts,
      };
    });
}
