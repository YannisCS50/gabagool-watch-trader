import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

// ============================================
// GABAGOOL HISTORICAL BACKTEST
// Uses edge function for fast server-side processing
// ============================================

export interface HistoricalBacktestConfig {
  shares_per_side: number;
  max_entry_price: number;
  max_cpp: number;
  min_delay_second_leg_ms: number;
  max_wait_second_leg_ms: number;
  entry_after_market_start_ms: number;
}

export interface SimulatedTrade {
  market_slug: string;
  asset: string;
  strike_price: number;
  first_side: 'UP' | 'DOWN';
  first_price: number;
  second_price: number | null;
  cpp: number | null;
  delay_ms: number | null;
  total_cost: number;
  outcome: 'UP' | 'DOWN';
  payout: number;
  pnl: number;
  status: 'paired-win' | 'paired-loss' | 'single-win' | 'single-loss' | 'skipped';
  skip_reason?: string;
}

export interface HistoricalBacktestResult {
  config: HistoricalBacktestConfig;
  trades: SimulatedTrade[];
  summary: {
    total_markets: number;
    traded_markets: number;
    skipped_markets: number;
    paired_markets: number;
    single_sided_markets: number;
    total_cost: number;
    total_payout: number;
    total_pnl: number;
    win_rate: number;
    paired_wins: number;
    paired_losses: number;
    single_wins: number;
    single_losses: number;
    avg_cpp: number;
    avg_pnl_per_trade: number;
    roi_percent: number;
    by_asset: Record<string, {
      markets: number;
      traded: number;
      wins: number;
      losses: number;
      pnl: number;
      avg_cpp: number;
    }>;
  };
}

export function useGabagoolHistoricalBacktest(config: HistoricalBacktestConfig) {
  return useQuery({
    queryKey: ['gabagool-historical-backtest', config],
    queryFn: async (): Promise<HistoricalBacktestResult> => {
      console.log('[Backtest] Calling edge function with config:', config);
      
      const { data, error } = await supabase.functions.invoke('gabagool-backtest', {
        body: config,
      });
      
      if (error) {
        console.error('[Backtest] Edge function error:', error);
        throw error;
      }
      
      if (data?.error) {
        console.error('[Backtest] Backtest error:', data.error);
        throw new Error(data.error);
      }
      
      console.log('[Backtest] Got results:', data?.summary);
      return data as HistoricalBacktestResult;
    },
    staleTime: 10 * 60 * 1000, // 10 minutes cache
    gcTime: 30 * 60 * 1000,    // 30 min garbage collection
    retry: 1,
  });
}
