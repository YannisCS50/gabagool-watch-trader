import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

/**
 * Confidence levels for PnL data
 */
export type Confidence = 'HIGH' | 'MEDIUM' | 'LOW';

export interface SubgraphFill {
  id: string;
  wallet: string;
  timestamp: string;
  block_number: number | null;
  tx_hash: string | null;
  market_id: string | null;
  token_id: string | null;
  outcome_side: string | null;
  side: string;
  price: number;
  size: number;
  notional: number;
  liquidity: string | null;
  fee_usd: number | null;
  fee_known: boolean;
}

export interface SubgraphPosition {
  id: string;
  wallet: string;
  timestamp: string;
  market_id: string | null;
  token_id: string;
  outcome_side: string | null;
  shares: number;
  avg_cost: number | null;
}

export interface SubgraphMarketPnl {
  id: string;
  wallet: string;
  market_id: string;
  market_slug: string | null;
  up_shares: number;
  down_shares: number;
  avg_up_cost: number | null;
  avg_down_cost: number | null;
  total_cost: number;
  realized_pnl_usd: number;
  realized_confidence: Confidence;
  unrealized_pnl_usd: number | null;
  unrealized_confidence: Confidence;
  mark_source: string | null;
  mark_price_up: number | null;
  mark_price_down: number | null;
  fees_known_usd: number;
  fees_unknown_count: number;
  is_settled: boolean;
  confidence: Confidence;
  updated_at: string;
}

export interface SubgraphPnlSummary {
  wallet: string;
  total_realized_pnl: number;
  total_unrealized_pnl: number | null;
  total_pnl: number | null;
  realized_confidence: Confidence;
  unrealized_confidence: Confidence;
  overall_confidence: Confidence;
  total_fees_known: number;
  total_fees_unknown_count: number;
  total_fills: number;
  total_markets: number;
  settled_markets: number;
  open_markets: number;
  drift_count: number;
  last_reconciled_at: string | null;
  first_trade_at: string | null;
  last_trade_at: string | null;
  updated_at: string;
}

export interface SubgraphSyncState {
  id: string;
  wallet: string;
  last_sync_at: string | null;
  records_synced: number;
  errors_count: number;
  last_error: string | null;
}

export interface ReconciliationEvent {
  id: string;
  timestamp: string;
  wallet: string;
  market_id: string | null;
  subgraph_shares_up: number | null;
  subgraph_shares_down: number | null;
  local_shares_up: number | null;
  local_shares_down: number | null;
  delta_shares_up: number | null;
  delta_shares_down: number | null;
  severity: 'OK' | 'DRIFT' | 'UNKNOWN';
  status: string;
}

/**
 * Hook to fetch canonical fills from subgraph
 */
export function useSubgraphFills(wallet?: string, limit = 100) {
  return useQuery({
    queryKey: ['subgraph-fills', wallet, limit],
    queryFn: async () => {
      if (!wallet) return [];
      
      const { data, error } = await supabase
        .from('subgraph_fills')
        .select('*')
        .eq('wallet', wallet.toLowerCase())
        .order('timestamp', { ascending: false })
        .limit(limit);

      if (error) throw error;
      return (data || []) as SubgraphFill[];
    },
    enabled: !!wallet,
    staleTime: 5000,
    refetchInterval: 10000,
  });
}

/**
 * Hook to fetch canonical positions from subgraph
 */
export function useSubgraphPositions(wallet?: string) {
  return useQuery({
    queryKey: ['subgraph-positions', wallet],
    queryFn: async () => {
      if (!wallet) return [];
      
      const { data, error } = await supabase
        .from('subgraph_positions')
        .select('*')
        .eq('wallet', wallet.toLowerCase())
        .order('shares', { ascending: false });

      if (error) throw error;
      return (data || []) as SubgraphPosition[];
    },
    enabled: !!wallet,
    staleTime: 5000,
    refetchInterval: 10000,
  });
}

/**
 * Hook to fetch market-level PnL data
 */
export function useSubgraphMarketPnl(wallet?: string) {
  return useQuery({
    queryKey: ['subgraph-market-pnl', wallet],
    queryFn: async () => {
      if (!wallet) return [];
      
      const { data, error } = await supabase
        .from('subgraph_pnl_markets')
        .select('*')
        .eq('wallet', wallet.toLowerCase())
        .order('updated_at', { ascending: false });

      if (error) throw error;
      return (data || []) as SubgraphMarketPnl[];
    },
    enabled: !!wallet,
    refetchInterval: 30000,
  });
}

/**
 * Hook to fetch PnL summary
 */
export function useSubgraphPnlSummary(wallet?: string) {
  return useQuery({
    queryKey: ['subgraph-pnl-summary', wallet],
    queryFn: async () => {
      if (!wallet) return null;
      
      const { data, error } = await supabase
        .from('subgraph_pnl_summary')
        .select('*')
        .eq('wallet', wallet.toLowerCase())
        .single();

      if (error && error.code !== 'PGRST116') throw error;
      return data as SubgraphPnlSummary | null;
    },
    enabled: !!wallet,
    refetchInterval: 30000,
  });
}

/**
 * Hook to fetch sync state
 */
export function useSubgraphSyncState(wallet?: string) {
  return useQuery({
    queryKey: ['subgraph-sync-state', wallet],
    queryFn: async () => {
      if (!wallet) return [];
      
      const { data, error } = await supabase
        .from('subgraph_sync_state')
        .select('*')
        .ilike('wallet', wallet.toLowerCase());

      if (error) throw error;
      return (data || []) as SubgraphSyncState[];
    },
    enabled: !!wallet,
    staleTime: 3000,
    refetchInterval: 5000,
  });
}

/**
 * Hook to fetch reconciliation events
 */
export function useSubgraphReconciliation(wallet?: string) {
  return useQuery({
    queryKey: ['subgraph-reconciliation', wallet],
    queryFn: async () => {
      if (!wallet) return [];
      
      const { data, error } = await supabase
        .from('subgraph_reconciliation')
        .select('*')
        .eq('wallet', wallet.toLowerCase())
        .order('timestamp', { ascending: false })
        .limit(100);

      if (error) throw error;
      return (data || []) as ReconciliationEvent[];
    },
    enabled: !!wallet,
    refetchInterval: 30000,
  });
}

/**
 * Hook to trigger subgraph sync
 */
export function useSubgraphSync() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke('subgraph-sync');
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      // Invalidate all subgraph queries
      queryClient.invalidateQueries({ queryKey: ['subgraph-fills'] });
      queryClient.invalidateQueries({ queryKey: ['subgraph-positions'] });
      queryClient.invalidateQueries({ queryKey: ['subgraph-market-pnl'] });
      queryClient.invalidateQueries({ queryKey: ['subgraph-pnl-summary'] });
      queryClient.invalidateQueries({ queryKey: ['subgraph-sync-state'] });
      queryClient.invalidateQueries({ queryKey: ['subgraph-reconciliation'] });
    },
  });
}

/**
 * Get active wallet used for subgraph sync.
 *
 * Source of truth: backend health endpoint (matches what ingestion uses).
 */
export function useBotWallet() {
  return useQuery({
    queryKey: ['bot-wallet'],
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke('subgraph-health');
      if (error) throw error;

      const report = data as any;
      const wallet: string | null =
        report?.wallet?.addressLowercase ?? report?.wallet?.address ?? null;

      return wallet;
    },
    staleTime: 10_000,
    refetchInterval: 30_000,
  });
}
