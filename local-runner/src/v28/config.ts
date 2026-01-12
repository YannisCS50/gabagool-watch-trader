/**
 * V28 Configuration
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';

export type Asset = 'BTC' | 'ETH' | 'SOL' | 'XRP';

export interface V28Config {
  id: string;
  enabled: boolean;
  is_live: boolean;
  
  // Trade sizing
  trade_size_usd: number;
  
  // Signal detection
  min_delta_usd: number;       // Minimum Binance price move to trigger
  delta_window_ms: number;     // Rolling window for delta accumulation
  
  // Share price bounds
  min_share_price: number;     // Min acceptable share price (e.g. 0.35 = 35¢)
  max_share_price: number;     // Max acceptable share price (e.g. 0.65 = 65¢)
  
  // TP/SL settings
  tp_cents: number;            // Take profit in cents
  tp_enabled: boolean;
  sl_cents: number;            // Stop loss in cents
  sl_enabled: boolean;
  timeout_ms: number;          // Max hold time before forced exit
  
  // Assets to trade
  assets: Asset[];
}

export const DEFAULT_V28_CONFIG: V28Config = {
  id: 'default',
  enabled: true,
  is_live: false,
  trade_size_usd: 5,
  min_delta_usd: 10,
  delta_window_ms: 300,
  min_share_price: 0.35,
  max_share_price: 0.65,
  tp_cents: 3,
  tp_enabled: true,
  sl_cents: 3,
  sl_enabled: true,
  timeout_ms: 15000,
  assets: ['BTC', 'ETH', 'SOL', 'XRP'],
};

export async function loadV28Config(supabase: SupabaseClient): Promise<V28Config> {
  try {
    const { data, error } = await supabase
      .from('paper_trading_config')
      .select('*')
      .limit(1)
      .single();
    
    if (error || !data) {
      console.log('[V28] No config found, using defaults');
      return DEFAULT_V28_CONFIG;
    }
    
    return {
      id: data.id,
      enabled: data.enabled ?? true,
      is_live: data.is_live ?? false,
      trade_size_usd: data.trade_size_usd ?? 5,
      min_delta_usd: data.min_delta_usd ?? 10,
      delta_window_ms: data.delta_window_ms ?? 300,
      min_share_price: data.min_share_price ?? 0.35,
      max_share_price: data.max_share_price ?? 0.65,
      tp_cents: data.tp_cents ?? 3,
      tp_enabled: data.tp_enabled ?? true,
      sl_cents: data.sl_cents ?? 3,
      sl_enabled: data.sl_enabled ?? true,
      timeout_ms: data.timeout_ms ?? 15000,
      assets: data.assets ?? ['BTC', 'ETH', 'SOL', 'XRP'],
    };
  } catch (err) {
    console.error('[V28] Failed to load config:', err);
    return DEFAULT_V28_CONFIG;
  }
}

export function initSupabase(): SupabaseClient {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  
  if (!url || !key) {
    throw new Error('[V28] Missing SUPABASE_URL or key');
  }
  
  return createClient(url, key);
}
