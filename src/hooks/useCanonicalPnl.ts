import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

/**
 * CANONICAL PnL HOOKS
 * 
 * These hooks read from the canonical database tables only.
 * They NEVER compute PnL - that's done by the reducer edge function.
 */

export interface MarketPnl {
  id: string;
  wallet: string;
  market_id: string;
  market_slug: string | null;
  state: 'OPEN' | 'SETTLED';
  resolved_outcome: 'UP' | 'DOWN' | 'SPLIT' | null;
  total_cost: number;
  total_payout: number;
  realized_pnl: number;
  has_buy: boolean;
  has_sell: boolean;
  has_redeem: boolean;
  is_claimed: boolean;
  is_lost: boolean;
  up_shares: number;
  down_shares: number;
  avg_up_cost: number | null;
  avg_down_cost: number | null;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  updated_at: string;
}

export interface PnlSummary {
  wallet: string;
  total_markets: number;
  settled_markets: number;
  open_markets: number;
  claimed_markets: number;
  lost_markets: number;
  markets_bought: number;
  markets_sold: number;
  total_realized_pnl: number;
  total_cost: number;
  total_payout: number;
  last_updated: string;
}

export interface CanonicalPosition {
  id: string;
  wallet: string;
  market_id: string;
  outcome: 'UP' | 'DOWN';
  shares_held: number;
  total_cost_usd: number;
  avg_cost: number;
  realized_pnl: number;
  state: 'OPEN' | 'CLAIMED' | 'LOST' | 'SOLD';
  updated_at: string;
}

export interface CashflowEntry {
  id: string;
  market_id: string;
  outcome: 'UP' | 'DOWN' | null;
  direction: 'IN' | 'OUT';
  category: 'BUY' | 'SELL' | 'REDEEM' | 'FEE' | 'LOSS' | 'TRANSFER';
  amount_usd: number;
  shares_delta: number;
  wallet: string;
  timestamp: string;
}

/**
 * Get canonical PnL summary from database view
 */
export function useCanonicalPnlSummary(wallet?: string) {
  return useQuery({
    queryKey: ['canonical-pnl-summary', wallet],
    queryFn: async (): Promise<PnlSummary | null> => {
      if (!wallet) return null;

      const { data, error } = await supabase
        .from('v_dashboard_pnl_summary')
        .select('*')
        .eq('wallet', wallet.toLowerCase())
        .single();

      if (error && error.code !== 'PGRST116') throw error;
      return data as PnlSummary | null;
    },
    enabled: !!wallet,
    refetchInterval: 30000,
  });
}

/**
 * Get per-market PnL from database view
 */
export function useCanonicalMarketPnl(wallet?: string) {
  return useQuery({
    queryKey: ['canonical-market-pnl', wallet],
    queryFn: async (): Promise<MarketPnl[]> => {
      if (!wallet) return [];

      const { data, error } = await supabase
        .from('v_market_pnl')
        .select('*')
        .eq('wallet', wallet.toLowerCase())
        .order('updated_at', { ascending: false });

      if (error) throw error;
      return (data || []) as MarketPnl[];
    },
    enabled: !!wallet,
    refetchInterval: 30000,
  });
}

/**
 * Get canonical positions
 */
export function useCanonicalPositions(wallet?: string) {
  return useQuery({
    queryKey: ['canonical-positions', wallet],
    queryFn: async (): Promise<CanonicalPosition[]> => {
      if (!wallet) return [];

      const { data, error } = await supabase
        .from('canonical_positions')
        .select('*')
        .eq('wallet', wallet.toLowerCase())
        .order('updated_at', { ascending: false });

      if (error) throw error;
      return (data || []) as CanonicalPosition[];
    },
    enabled: !!wallet,
    refetchInterval: 30000,
  });
}

/**
 * Get cashflow ledger entries
 */
export function useCashflowLedger(wallet?: string, limit = 100) {
  return useQuery({
    queryKey: ['cashflow-ledger', wallet, limit],
    queryFn: async (): Promise<CashflowEntry[]> => {
      if (!wallet) return [];

      const { data, error } = await supabase
        .from('cashflow_ledger')
        .select('*')
        .eq('wallet', wallet.toLowerCase())
        .order('timestamp', { ascending: false })
        .limit(limit);

      if (error) throw error;
      return (data || []) as CashflowEntry[];
    },
    enabled: !!wallet,
    refetchInterval: 30000,
  });
}

/**
 * Get market lifecycle data
 */
export function useMarketLifecycle(wallet?: string) {
  return useQuery({
    queryKey: ['market-lifecycle', wallet],
    queryFn: async () => {
      if (!wallet) return [];

      const { data, error } = await supabase
        .from('market_lifecycle')
        .select('*')
        .eq('wallet', wallet.toLowerCase())
        .order('updated_at', { ascending: false });

      if (error) throw error;
      return data || [];
    },
    enabled: !!wallet,
    refetchInterval: 30000,
  });
}

/**
 * Trigger the canonical reducer
 */
export function useCanonicalReducer() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke('subgraph-reducer');
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      // Invalidate all canonical queries
      queryClient.invalidateQueries({ queryKey: ['canonical-pnl-summary'] });
      queryClient.invalidateQueries({ queryKey: ['canonical-market-pnl'] });
      queryClient.invalidateQueries({ queryKey: ['canonical-positions'] });
      queryClient.invalidateQueries({ queryKey: ['cashflow-ledger'] });
      queryClient.invalidateQueries({ queryKey: ['market-lifecycle'] });
    },
  });
}
