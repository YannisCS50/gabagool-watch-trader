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
 * Save or update a signal
 */
export async function saveSignal(signal: Signal): Promise<string | null> {
  const db = getDb();
  
  try {
    if (signal.id) {
      // Update existing
      const { error } = await db
        .from('paper_signals')
        .update({
          status: signal.status,
          entry_price: signal.entry_price,
          exit_price: signal.exit_price,
          shares: signal.shares,
          order_id: signal.order_id,
          fill_ts: signal.fill_ts,
          close_ts: signal.close_ts,
          exit_type: signal.exit_type,
          gross_pnl: signal.gross_pnl,
          net_pnl: signal.net_pnl,
          fees: signal.fees,
          notes: signal.notes,
        })
        .eq('id', signal.id);
      
      if (error) throw error;
      return signal.id;
    } else {
      // Insert new
      const { data, error } = await db
        .from('paper_signals')
        .insert({
          run_id: signal.run_id,
          asset: signal.asset,
          direction: signal.direction,
          binance_price: signal.binance_price,
          binance_delta: signal.binance_delta,
          share_price: signal.share_price,
          market_slug: signal.market_slug,
          strike_price: signal.strike_price,
          status: signal.status,
          signal_ts: signal.signal_ts,
          notes: signal.notes,
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
 * Load config overrides from database
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
      // Try v28 config as fallback
      const { data: v28Data } = await db
        .from('v27_config')
        .select('*')
        .eq('id', 'v28-live')
        .single();
      
      return v28Data ?? null;
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
