import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from '@/hooks/use-toast';

export interface MarketConfig {
  id: string;
  asset: string;
  
  // Enable/disable
  enabled: boolean;
  shadow_only: boolean;
  
  // Position limits
  max_shares: number;
  max_notional_usd: number;
  max_exposure_usd: number;
  
  // Entry thresholds
  min_edge_pct: number;
  min_delta_usd: number;
  max_combined_price: number;
  min_ask_price: number;
  max_ask_price: number;
  
  // TP/SL settings
  take_profit_pct: number;
  stop_loss_pct: number;
  trailing_stop_enabled: boolean;
  trailing_stop_pct: number | null;
  
  // Timing
  min_seconds_remaining: number;
  max_seconds_remaining: number;
  
  // Metadata
  created_at: string;
  updated_at: string;
}

export function useMarketConfig() {
  const [configs, setConfigs] = useState<MarketConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const fetchConfigs = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from('market_config')
        .select('*')
        .order('asset', { ascending: true });

      if (error) throw error;
      setConfigs(data || []);
    } catch (err) {
      console.error('Error fetching market configs:', err);
      toast({
        title: 'Error',
        description: 'Failed to load market configurations',
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial fetch
  useEffect(() => {
    fetchConfigs();
  }, [fetchConfigs]);

  // Realtime subscription for hot-reload
  useEffect(() => {
    const channel = supabase
      .channel('market_config_changes')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'market_config',
        },
        (payload) => {
          console.log('[MarketConfig] Realtime update:', payload);
          fetchConfigs();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [fetchConfigs]);

  const updateConfig = useCallback(async (asset: string, updates: Partial<MarketConfig>) => {
    setSaving(true);
    try {
      const { error } = await supabase
        .from('market_config')
        .update({
          ...updates,
          updated_at: new Date().toISOString(),
        })
        .eq('asset', asset);

      if (error) throw error;

      // Update local state optimistically
      setConfigs(prev => 
        prev.map(c => 
          c.asset === asset 
            ? { ...c, ...updates, updated_at: new Date().toISOString() }
            : c
        )
      );

      toast({
        title: 'Saved',
        description: `${asset} configuration updated`,
      });

      return true;
    } catch (err) {
      console.error('Error updating market config:', err);
      toast({
        title: 'Error',
        description: 'Failed to save configuration',
        variant: 'destructive',
      });
      return false;
    } finally {
      setSaving(false);
    }
  }, []);

  const toggleEnabled = useCallback(async (asset: string, enabled: boolean) => {
    return updateConfig(asset, { enabled });
  }, [updateConfig]);

  const getConfig = useCallback((asset: string): MarketConfig | undefined => {
    return configs.find(c => c.asset === asset);
  }, [configs]);

  return {
    configs,
    loading,
    saving,
    updateConfig,
    toggleEnabled,
    getConfig,
    refetch: fetchConfigs,
  };
}
