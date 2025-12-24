import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';

const SETTINGS_ID = '00000000-0000-0000-0000-000000000001';

export interface LiveBotPersistentSettings {
  isEnabled: boolean;
  isLoading: boolean;
  error: string | null;
  toggle: () => Promise<void>;
  setEnabled: (enabled: boolean) => Promise<void>;
}

export function useLiveBotPersistence(): LiveBotPersistentSettings {
  const [isEnabled, setIsEnabledState] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchSettings = useCallback(async () => {
    try {
      // Use raw query since types may not be updated yet
      const { data, error: fetchError } = await supabase
        .from('live_bot_settings' as any)
        .select('is_enabled')
        .eq('id', SETTINGS_ID)
        .single();

      if (fetchError) throw fetchError;
      setIsEnabledState((data as any)?.is_enabled ?? false);
    } catch (err) {
      console.error('Error fetching live bot settings:', err);
      setError(err instanceof Error ? err.message : 'Failed to fetch settings');
    } finally {
      setIsLoading(false);
    }
  }, []);

  const setEnabled = useCallback(async (enabled: boolean) => {
    try {
      setError(null);
      const { error: updateError } = await supabase
        .from('live_bot_settings' as any)
        .update({ is_enabled: enabled, updated_at: new Date().toISOString() })
        .eq('id', SETTINGS_ID);

      if (updateError) throw updateError;
      setIsEnabledState(enabled);
    } catch (err) {
      console.error('Error updating live bot settings:', err);
      setError(err instanceof Error ? err.message : 'Failed to update settings');
      throw err;
    }
  }, []);

  const toggle = useCallback(async () => {
    await setEnabled(!isEnabled);
  }, [isEnabled, setEnabled]);

  // Initial fetch
  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  // Subscribe to realtime updates
  useEffect(() => {
    const channel = supabase
      .channel('live-bot-settings-changes')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'live_bot_settings' },
        (payload) => {
          if (payload.new && 'is_enabled' in payload.new) {
            setIsEnabledState(payload.new.is_enabled as boolean);
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  return {
    isEnabled,
    isLoading,
    error,
    toggle,
    setEnabled,
  };
}
