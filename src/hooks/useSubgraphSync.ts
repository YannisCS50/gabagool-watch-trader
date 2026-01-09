import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

interface SyncResult {
  success: boolean;
  wallet: string;
  fills: number;
  payouts: number;
  cashflows: number;
  positions: number;
  errors: {
    fills?: string;
    positions?: string;
  };
  syncedAt: string;
}

export function useSubgraphSync() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (): Promise<SyncResult> => {
      const { data, error } = await supabase.functions.invoke('subgraph-sync');
      
      if (error) {
        console.error('[useSubgraphSync] Error:', error);
        throw error;
      }
      
      return data as SyncResult;
    },
    onSuccess: () => {
      // Invalidate all subgraph-related queries
      queryClient.invalidateQueries({ queryKey: ['subgraph-health'] });
      queryClient.invalidateQueries({ queryKey: ['subgraph-pnl-summary'] });
      queryClient.invalidateQueries({ queryKey: ['subgraph-pnl-markets'] });
      queryClient.invalidateQueries({ queryKey: ['subgraph-fills'] });
      queryClient.invalidateQueries({ queryKey: ['subgraph-positions'] });
      queryClient.invalidateQueries({ queryKey: ['subgraph-cashflows'] });
    },
  });
}

/**
 * Query cashflows for a wallet
 */
export function useCashflows(wallet: string | null) {
  const queryClient = useQueryClient();
  
  return {
    queryKey: ['subgraph-cashflows', wallet],
    queryFn: async () => {
      if (!wallet) return [];
      
      const { data, error } = await supabase
        .from('polymarket_cashflows')
        .select('*')
        .eq('wallet', wallet.toLowerCase())
        .order('ts', { ascending: false })
        .limit(500);
      
      if (error) throw error;
      return data || [];
    },
    enabled: !!wallet,
  };
}
