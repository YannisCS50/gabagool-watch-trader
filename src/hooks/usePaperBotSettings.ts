import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';

export interface PaperBotSettings {
  id: string;
  is_enabled: boolean;
  updated_at: string;
}

export function usePaperBotSettings() {
  const [settings, setSettings] = useState<PaperBotSettings | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const fetchSettings = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from('paper_bot_settings')
        .select('*')
        .limit(1)
        .maybeSingle();

      if (error) throw error;
      setSettings(data);
    } catch (err) {
      console.error('Error fetching bot settings:', err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSettings();

    // Subscribe to realtime updates
    const channel = supabase
      .channel('paper-bot-settings-changes')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'paper_bot_settings' },
        () => fetchSettings()
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [fetchSettings]);

  const toggleEnabled = useCallback(async () => {
    if (!settings) return;

    const newValue = !settings.is_enabled;
    
    // Optimistic update
    setSettings(prev => prev ? { ...prev, is_enabled: newValue } : null);

    try {
      const { error } = await supabase
        .from('paper_bot_settings')
        .update({ is_enabled: newValue, updated_at: new Date().toISOString() })
        .eq('id', settings.id);

      if (error) {
        // Revert on error
        setSettings(prev => prev ? { ...prev, is_enabled: !newValue } : null);
        throw error;
      }
    } catch (err) {
      console.error('Error toggling bot:', err);
    }
  }, [settings]);

  return {
    isEnabled: settings?.is_enabled ?? false,
    isLoading,
    toggleEnabled,
    refetch: fetchSettings,
  };
}
