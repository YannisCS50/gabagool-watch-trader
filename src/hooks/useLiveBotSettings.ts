import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';

export interface LiveBotStatus {
  isReady: boolean;
  isLoading: boolean;
  isEnabled: boolean;
  balance: number | null;
  walletAddress: string | null;
  limits: {
    maxDailyLoss: number;
    maxPositionSize: number;
    maxOrderSize: number;
    enabled: boolean;
  } | null;
  error: string | null;
}

export function useLiveBotSettings() {
  const [status, setStatus] = useState<LiveBotStatus>({
    isReady: false,
    isLoading: true,
    isEnabled: false,
    balance: null,
    walletAddress: null,
    limits: null,
    error: null,
  });

  const fetchStatus = useCallback(async () => {
    setStatus(prev => ({ ...prev, isLoading: true, error: null }));
    
    try {
      // Get bot settings from database
      const { data: settingsData } = await supabase
        .from('live_bot_settings')
        .select('is_enabled')
        .single();
      
      // Get bot status
      const statusRes = await supabase.functions.invoke('live-trade-bot', {
        body: { action: 'status' },
      });

      if (statusRes.error) throw new Error(statusRes.error.message);
      
      const statusData = statusRes.data;
      
      // Get balance
      const balanceRes = await supabase.functions.invoke('live-trade-bot', {
        body: { action: 'balance' },
      });

      const balanceData = balanceRes.data;
      
      setStatus({
        isReady: statusData?.status === 'READY',
        isLoading: false,
        isEnabled: settingsData?.is_enabled ?? false,
        balance: balanceData?.success ? balanceData.balance : null,
        walletAddress: statusData?.walletAddress || balanceData?.walletAddress || null,
        limits: statusData?.limits || null,
        error: balanceData?.success === false ? balanceData.error : null,
      });
    } catch (err) {
      console.error('Error fetching live bot status:', err);
      setStatus(prev => ({
        ...prev,
        isLoading: false,
        error: err instanceof Error ? err.message : 'Failed to fetch status',
      }));
    }
  }, []);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  const setEnabled = useCallback(async (enabled: boolean) => {
    try {
      const { error } = await supabase
        .from('live_bot_settings')
        .upsert({ 
          id: '00000000-0000-0000-0000-000000000001',
          is_enabled: enabled,
          updated_at: new Date().toISOString()
        });
      
      if (error) throw error;
      
      setStatus(prev => ({ ...prev, isEnabled: enabled }));
    } catch (err) {
      console.error('Error setting enabled state:', err);
    }
  }, []);

  const placeOrder = useCallback(async (params: {
    tokenId: string;
    side: 'BUY' | 'SELL';
    price: number;
    size: number;
    marketSlug?: string;
  }) => {
    try {
      const res = await supabase.functions.invoke('live-trade-bot', {
        body: { action: 'order', ...params },
      });

      if (res.error) throw new Error(res.error.message);
      return res.data;
    } catch (err) {
      console.error('Error placing order:', err);
      throw err;
    }
  }, []);

  const killSwitch = useCallback(async () => {
    try {
      const res = await supabase.functions.invoke('live-trade-bot', {
        body: { action: 'kill' },
      });

      if (res.error) throw new Error(res.error.message);
      return res.data;
    } catch (err) {
      console.error('Error activating kill switch:', err);
      throw err;
    }
  }, []);

  return {
    ...status,
    refetch: fetchStatus,
    setEnabled,
    placeOrder,
    killSwitch,
  };
}
