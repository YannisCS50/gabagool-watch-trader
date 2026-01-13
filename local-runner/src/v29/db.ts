/**
 * V29 Database Functions
 * 
 * Simple Supabase operations for signals and logging
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { Signal } from './types.js';

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
 * Load V29 config from database
 */
export async function loadV29Config(): Promise<{
  enabled: boolean;
  min_delta_usd: number;
  max_share_price: number;
  trade_size_usd: number;
  max_shares: number;
  price_buffer_cents: number;
  assets: string[];
  tp_enabled: boolean;
  tp_cents: number;
  sl_enabled: boolean;
  sl_cents: number;
  timeout_ms: number;
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
      enabled: data.enabled,
      min_delta_usd: Number(data.min_delta_usd),
      max_share_price: Number(data.max_share_price),
      trade_size_usd: Number(data.trade_size_usd),
      max_shares: Number(data.max_shares),
      price_buffer_cents: Number(data.price_buffer_cents),
      assets: data.assets,
      tp_enabled: data.tp_enabled,
      tp_cents: Number(data.tp_cents),
      sl_enabled: data.sl_enabled,
      sl_cents: Number(data.sl_cents),
      timeout_ms: Number(data.timeout_ms),
      binance_poll_ms: Number(data.binance_poll_ms),
      orderbook_poll_ms: Number(data.orderbook_poll_ms),
      order_cooldown_ms: Number(data.order_cooldown_ms),
    };
  } catch (err) {
    log(`Config load error: ${err}`);
    return null;
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
  runId: string,
  status: string,
  balance: number,
  positionCount: number,
  tradesCount: number
): Promise<void> {
  const db = getDb();
  
  try {
    await db.from('runner_heartbeats').upsert({
      id: runId,
      runner_type: 'v29-live',
      status,
      last_heartbeat: new Date().toISOString(),
      balance,
      position_count: positionCount,
      trade_count: tradesCount,
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
