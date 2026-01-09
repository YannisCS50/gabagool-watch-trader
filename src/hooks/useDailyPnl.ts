import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

/**
 * DAILY PnL HOOKS
 * 
 * Read from database tables only - never compute in frontend
 */

export interface DailyPnlEntry {
  date: string;
  wallet: string;
  realized_pnl: number;
  unrealized_pnl: number;
  total_pnl: number;
  volume_traded: number;
  markets_active: number;
  buy_count: number;
  sell_count: number;
  redeem_count: number;
}

export interface DailyPnlCumulative extends DailyPnlEntry {
  cumulative_realized_pnl: number;
  cumulative_total_pnl: number;
}

export interface AccountPnlSummary {
  wallet: string;
  total_realized_pnl: number;
  total_unrealized_pnl: number;
  total_pnl: number;
  first_trade_ts: string | null;
  last_trade_ts: string | null;
  total_trades: number;
  total_markets: number;
  total_volume: number;
  claimed_markets: number;
  lost_markets: number;
  open_markets: number;
}

export interface IngestState {
  wallet: string;
  oldest_event_ts: string | null;
  newest_event_ts: string | null;
  total_events_ingested: number;
  last_sync_at: string;
  is_complete: boolean;
}

/**
 * Get daily PnL with cumulative totals
 */
export function useDailyPnlCumulative(wallet?: string) {
  return useQuery({
    queryKey: ['daily-pnl-cumulative', wallet],
    queryFn: async (): Promise<DailyPnlCumulative[]> => {
      if (!wallet) return [];

      // Fetch from daily_pnl table and compute cumulative in JS
      // (view may not exist in types yet)
      const { data, error } = await supabase
        .from('daily_pnl')
        .select('*')
        .eq('wallet', wallet.toLowerCase())
        .order('date', { ascending: true });

      if (error) throw error;

      // Compute cumulative values
      let cumulativeRealized = 0;
      let cumulativeTotal = 0;

      return (data || []).map((row: DailyPnlEntry) => {
        cumulativeRealized += row.realized_pnl || 0;
        cumulativeTotal += row.total_pnl || 0;
        return {
          ...row,
          cumulative_realized_pnl: cumulativeRealized,
          cumulative_total_pnl: cumulativeTotal,
        };
      });
    },
    enabled: !!wallet,
    refetchInterval: 60000,
  });
}

/**
 * Get daily PnL entries (recent first)
 */
export function useDailyPnl(wallet?: string, limit = 30) {
  return useQuery({
    queryKey: ['daily-pnl', wallet, limit],
    queryFn: async (): Promise<DailyPnlEntry[]> => {
      if (!wallet) return [];

      const { data, error } = await supabase
        .from('daily_pnl')
        .select('*')
        .eq('wallet', wallet.toLowerCase())
        .order('date', { ascending: false })
        .limit(limit);

      if (error) throw error;
      return (data || []) as DailyPnlEntry[];
    },
    enabled: !!wallet,
    refetchInterval: 60000,
  });
}

/**
 * Get account-level PnL summary
 */
export function useAccountPnlSummary(wallet?: string) {
  return useQuery({
    queryKey: ['account-pnl-summary', wallet],
    queryFn: async (): Promise<AccountPnlSummary | null> => {
      if (!wallet) return null;

      const { data, error } = await supabase
        .from('account_pnl_summary')
        .select('*')
        .eq('wallet', wallet.toLowerCase())
        .single();

      if (error && error.code !== 'PGRST116') throw error;
      return data as AccountPnlSummary | null;
    },
    enabled: !!wallet,
    refetchInterval: 30000,
  });
}

/**
 * Get ingestion state
 */
export function useIngestState(wallet?: string) {
  return useQuery({
    queryKey: ['ingest-state', wallet],
    queryFn: async (): Promise<IngestState | null> => {
      if (!wallet) return null;

      const { data, error } = await supabase
        .from('subgraph_ingest_state')
        .select('*')
        .eq('wallet', wallet.toLowerCase())
        .single();

      if (error && error.code !== 'PGRST116') throw error;
      return data as IngestState | null;
    },
    enabled: !!wallet,
    refetchInterval: 30000,
  });
}
