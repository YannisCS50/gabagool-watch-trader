import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

/**
 * Hook to subscribe to V35 realtime updates
 * Invalidates queries when new fills, settlements, or heartbeats arrive
 */
export function useV35Realtime() {
  const queryClient = useQueryClient();

  useEffect(() => {
    // Subscribe to v35_fills changes
    const fillsChannel = supabase
      .channel('v35-fills-realtime')
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'v35_fills',
        },
        () => {
          console.log('[V35] New fill received');
          queryClient.invalidateQueries({ queryKey: ['v35-fills'] });
        }
      )
      .subscribe();

    // Subscribe to v35_settlements changes
    const settlementsChannel = supabase
      .channel('v35-settlements-realtime')
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'v35_settlements',
        },
        () => {
          console.log('[V35] New settlement received');
          queryClient.invalidateQueries({ queryKey: ['v35-settlements'] });
        }
      )
      .subscribe();

    // Subscribe to runner_heartbeats for status updates
    const heartbeatChannel = supabase
      .channel('v35-heartbeat-realtime')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'runner_heartbeats',
          filter: 'runner_type=eq.v35',
        },
        () => {
          queryClient.invalidateQueries({ queryKey: ['v35-heartbeat'] });
        }
      )
      .subscribe();

    // Subscribe to bot_events for log updates
    const eventsChannel = supabase
      .channel('v35-events-realtime')
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'bot_events',
        },
        () => {
          queryClient.invalidateQueries({ queryKey: ['v35-events'] });
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(fillsChannel);
      supabase.removeChannel(settlementsChannel);
      supabase.removeChannel(heartbeatChannel);
      supabase.removeChannel(eventsChannel);
    };
  }, [queryClient]);
}
