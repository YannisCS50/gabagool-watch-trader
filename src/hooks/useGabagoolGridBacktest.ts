import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

// ============================================
// GABAGOOL GRID MARKET MAKING BACKTEST
// Simulates passive grid-based limit order strategy
// ============================================

export interface GridBacktestConfig {
  mode: 'safe' | 'gabagool' | 'custom';
  gridMin?: number;
  gridMax?: number;
  gridStep?: number;
  baseSizeCore?: number;
  baseSizeOuter?: number;
  maxUnpairedShares?: number;
  maxImbalanceRatio?: number;
  entryDelayMs?: number;
  stopBeforeExpiryMs?: number;
}

export interface SimulatedFill {
  ts: number;
  side: 'UP' | 'DOWN';
  price: number;
  size: number;
}

export interface MarketResult {
  marketSlug: string;
  asset: string;
  strikePrice: number;
  upFills: SimulatedFill[];
  downFills: SimulatedFill[];
  totalUpQty: number;
  totalDownQty: number;
  totalUpCost: number;
  totalDownCost: number;
  paired: number;
  unpaired: number;
  avgUpPrice: number;
  avgDownPrice: number;
  combinedCost: number;
  outcome: 'UP' | 'DOWN';
  payout: number;
  pnl: number;
  lockedProfit: number;
  status: 'profit' | 'loss' | 'skipped';
  skipReason?: string;
}

export interface GridBacktestSummary {
  config_mode: string;
  grid_levels: number;
  grid_range: string;
  
  total_markets: number;
  traded_markets: number;
  skipped_markets: number;
  
  profit_markets: number;
  loss_markets: number;
  win_rate: number;
  
  total_cost: number;
  total_payout: number;
  total_pnl: number;
  total_locked_profit: number;
  
  roi_percent: number;
  avg_pnl_per_market: number;
  avg_cpp: number;
  avg_shares_per_side: number;
  
  by_asset: Record<string, {
    markets: number;
    traded: number;
    pnl: number;
    avgCpp: number;
    avgShares: number;
  }>;
}

export interface GridBacktestResult {
  config: GridBacktestConfig;
  results: MarketResult[];
  summary: GridBacktestSummary;
}

export function useGabagoolGridBacktest(config: GridBacktestConfig) {
  return useQuery({
    queryKey: ['gabagool-grid-backtest', config],
    queryFn: async (): Promise<GridBacktestResult> => {
      console.log('[GridBacktest] Calling edge function with config:', config);
      
      const { data, error } = await supabase.functions.invoke('gabagool-grid-backtest', {
        body: config,
      });
      
      if (error) {
        console.error('[GridBacktest] Edge function error:', error);
        throw error;
      }
      
      if (data?.error) {
        console.error('[GridBacktest] Error:', data.error);
        throw new Error(data.error);
      }
      
      console.log('[GridBacktest] Results:', data?.summary);
      return data as GridBacktestResult;
    },
    staleTime: 10 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
    retry: 1,
    enabled: !!config.mode,
  });
}
