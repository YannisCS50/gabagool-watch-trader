import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface PaperSignal {
  id: string;
  created_at: string;
  run_id: string | null;
  asset: string;
  direction: string;
  signal_ts: number;
  binance_price: number;
  binance_delta: number;
  chainlink_price: number | null;
  share_price: number;
  market_slug: string | null;
  strike_price: number | null;
  status: string;
  entry_price: number | null;
  exit_price: number | null;
  fill_ts: number | null;
  sell_ts: number | null;
  order_type: string | null;
  entry_fee: number | null;
  exit_fee: number | null;
  total_fees: number | null;
  gross_pnl: number | null;
  net_pnl: number | null;
  tp_price: number | null;
  tp_status: string | null;
  sl_price: number | null;
  sl_status: string | null;
  exit_type: string | null;
  trade_size_usd: number | null;
  shares: number | null;
  notes: string | null;
  is_live: boolean | null;
}

export interface PaperTpSlEvent {
  id: string;
  created_at: string;
  signal_id: string;
  ts: number;
  current_bid: number;
  tp_price: number | null;
  sl_price: number | null;
  tp_distance_cents: number | null;
  sl_distance_cents: number | null;
  triggered: string | null;
}

export interface PaperTradingConfig {
  id: string;
  enabled: boolean;
  is_live: boolean;
  trade_size_usd: number;
  min_delta_usd: number;
  min_share_price: number;
  max_share_price: number;
  tp_cents: number;
  tp_pct?: number; // Take-profit as percentage (e.g., 0.04 = 4%), optional for backward compatibility
  tp_enabled: boolean;
  sl_cents: number;
  sl_enabled: boolean;
  timeout_ms: number;
  assets: string[];
}

export function usePaperSignals(limit = 100) {
  return useQuery({
    queryKey: ['paper-signals', limit],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('paper_signals')
        .select('*')
        .order('signal_ts', { ascending: false })
        .limit(limit);
      
      if (error) throw error;
      return data as PaperSignal[];
    },
    refetchInterval: 2000,
  });
}

export function usePaperTpSlEvents(signalId: string | null) {
  return useQuery({
    queryKey: ['paper-tp-sl-events', signalId],
    queryFn: async () => {
      if (!signalId) return [];
      
      const { data, error } = await supabase
        .from('paper_tp_sl_events')
        .select('*')
        .eq('signal_id', signalId)
        .order('ts', { ascending: true });
      
      if (error) throw error;
      return data as PaperTpSlEvent[];
    },
    enabled: !!signalId,
    refetchInterval: 1000,
  });
}

export function usePaperTradingConfig() {
  return useQuery({
    queryKey: ['paper-trading-config'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('paper_trading_config')
        .select('*')
        .limit(1)
        .single();
      
      if (error) throw error;
      return data as PaperTradingConfig;
    },
    refetchInterval: 5000,
  });
}

export function usePaperTraderStats() {
  return useQuery({
    queryKey: ['paper-trader-stats'],
    queryFn: async () => {
      // Get all completed trades
      const { data: signals, error } = await supabase
        .from('paper_signals')
        .select('*')
        .eq('status', 'sold');
      
      if (error) throw error;
      
      const stats = {
        totalTrades: signals?.length ?? 0,
        totalPnl: 0,
        tpHits: 0,
        slHits: 0,
        timeouts: 0,
        winRate: 0,
        avgPnl: 0,
        bestTrade: 0,
        worstTrade: 0,
      };
      
      if (signals && signals.length > 0) {
        for (const s of signals) {
          const pnl = s.net_pnl ?? 0;
          stats.totalPnl += pnl;
          
          if (s.exit_type === 'tp') stats.tpHits++;
          else if (s.exit_type === 'sl') stats.slHits++;
          else stats.timeouts++;
          
          if (pnl > stats.bestTrade) stats.bestTrade = pnl;
          if (pnl < stats.worstTrade) stats.worstTrade = pnl;
        }
        
        stats.avgPnl = stats.totalPnl / signals.length;
        stats.winRate = signals.filter(s => (s.net_pnl ?? 0) > 0).length / signals.length * 100;
      }
      
      return stats;
    },
    refetchInterval: 5000,
  });
}

export async function updatePaperTradingConfig(updates: Partial<PaperTradingConfig>) {
  const { data: existing } = await supabase
    .from('paper_trading_config')
    .select('id')
    .limit(1)
    .single();
  
  if (!existing) {
    const { error } = await supabase
      .from('paper_trading_config')
      .insert({ ...updates, updated_at: new Date().toISOString() } as never);
    return !error;
  }
  
  const { error } = await supabase
    .from('paper_trading_config')
    .update({ ...updates, updated_at: new Date().toISOString() } as never)
    .eq('id', existing.id);
  
  return !error;
}
