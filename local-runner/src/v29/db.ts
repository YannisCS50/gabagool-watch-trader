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
 * Load V29 config from database
 */
export async function loadV29Config(): Promise<{
  enabled: boolean;
  tick_delta_usd: number;
  delta_threshold: number;
  min_share_price: number;
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
  // Accumulation & hedge config
  accumulation_enabled: boolean;
  max_total_cost_usd: number;
  max_total_shares: number;
  auto_hedge_enabled: boolean;
  hedge_trigger_cents: number;
  hedge_min_profit_cents: number;
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
      tick_delta_usd: Number(data.tick_delta_usd ?? data.min_delta_usd ?? 6),
      delta_threshold: Number(data.delta_threshold ?? 70),
      min_share_price: Number(data.min_share_price ?? 0.30),
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
      // Accumulation & hedge
      accumulation_enabled: data.accumulation_enabled ?? true,
      max_total_cost_usd: Number(data.max_total_cost_usd ?? 75),
      max_total_shares: Number(data.max_total_shares ?? 300),
      auto_hedge_enabled: data.auto_hedge_enabled ?? true,
      hedge_trigger_cents: Number(data.hedge_trigger_cents ?? 15),
      hedge_min_profit_cents: Number(data.hedge_min_profit_cents ?? 10),
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
