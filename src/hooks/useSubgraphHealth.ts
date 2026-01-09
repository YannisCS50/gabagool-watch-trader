import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface EndpointHealth {
  endpoint: string;
  lastSyncAt: string | null;
  lastSyncOk: boolean;
  lastErrorMessage: string | null;
  lastResponseRowCount: number;
  probeResult: 'success' | 'failed' | 'not_tested';
  probeError?: string;
}

export interface SubgraphHealthReport {
  timestamp: string;
  wallet: {
    configured: boolean;
    address: string | null;
    addressLowercase: string | null;
  };
  endpoints: {
    activity: EndpointHealth;
    positions: EndpointHealth;
  };
  dbCounts: {
    subgraph_fills: number;
    subgraph_positions: number;
    subgraph_pnl_markets: number;
    subgraph_sync_state: number;
  };
  diagnostics: {
    walletMissing: boolean;
    syncNeverRun: boolean;
    syncFailing: boolean;
    noDataIngested: boolean;
    rlsBlocking: boolean;
  };
  recommendations: string[];
}

export function useSubgraphHealth() {
  return useQuery({
    queryKey: ['subgraph-health'],
    queryFn: async (): Promise<SubgraphHealthReport | null> => {
      const { data, error } = await supabase.functions.invoke('subgraph-health');
      
      if (error) {
        console.error('[useSubgraphHealth] Error:', error);
        throw error;
      }
      
      return data as SubgraphHealthReport;
    },
    refetchInterval: 30000,
    staleTime: 10000,
  });
}
