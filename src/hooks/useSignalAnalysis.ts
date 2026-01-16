import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface SecondStats {
  seconds_after: number;
  sample_count: number;
  avg_price_change_pct: number;
  up_tick_pct: number;
  down_tick_pct: number;
  avg_share_change_cents: number;
  up_share_pct: number;
  down_share_pct: number;
}

export interface SignalAnalysis {
  direction: 'UP' | 'DOWN';
  total_signals: number;
  avg_signal_size: number;
  stats_by_second: SecondStats[];
}

export interface BucketAnalysis {
  bucket_label: string;
  up: SignalAnalysis;
  down: SignalAnalysis;
}

interface AnalysisResult {
  overall: { up: SignalAnalysis; down: SignalAnalysis };
  byBucket: BucketAnalysis[];
}

export function useSignalAnalysis(asset?: string) {
  return useQuery({
    queryKey: ['signal-analysis', asset],
    queryFn: async (): Promise<{ up: SignalAnalysis; down: SignalAnalysis }> => {
      const params = new URLSearchParams();
      if (asset && asset !== 'all') params.set('asset', asset);

      const { data, error } = await supabase.functions.invoke<AnalysisResult>('signal-analysis', {
        body: null,
        headers: {},
      });

      // Fallback: add query params via fetch
      const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/signal-analysis?${params.toString()}`;
      const response = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch signal analysis: ${response.statusText}`);
      }

      const result: AnalysisResult = await response.json();
      return result.overall;
    },
    staleTime: 60000,
  });
}

export function useSignalAnalysisByBucket(asset?: string) {
  return useQuery({
    queryKey: ['signal-analysis-by-bucket', asset],
    queryFn: async (): Promise<BucketAnalysis[]> => {
      const params = new URLSearchParams();
      if (asset && asset !== 'all') params.set('asset', asset);

      const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/signal-analysis?${params.toString()}`;
      const response = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch signal analysis: ${response.statusText}`);
      }

      const result: AnalysisResult = await response.json();
      return result.byBucket;
    },
    staleTime: 60000,
  });
}
