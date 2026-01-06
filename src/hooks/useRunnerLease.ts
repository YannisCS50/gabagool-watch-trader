import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';

interface RunnerHeartbeat {
  runner_id: string;
  runner_type: string;
  status: string;
  last_heartbeat: string;
  version: string | null;
  ip_address: string | null;
}

interface RunnerLease {
  runner_id: string;
  locked_until: string;
}

export interface RunnerConflictStatus {
  hasConflict: boolean;
  activeRunners: RunnerHeartbeat[];
  leaseHolder: string | null;
  leaseExpires: Date | null;
  leaseExpired: boolean;
  isLoading: boolean;
  error: string | null;
}

const HEARTBEAT_STALE_MS = 2 * 60 * 1000; // 2 minutes

export function useRunnerLease(): RunnerConflictStatus {
  const [activeRunners, setActiveRunners] = useState<RunnerHeartbeat[]>([]);
  const [leaseHolder, setLeaseHolder] = useState<string | null>(null);
  const [leaseExpires, setLeaseExpires] = useState<Date | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchStatus = async () => {
      try {
        const now = new Date();
        const staleThreshold = new Date(now.getTime() - HEARTBEAT_STALE_MS);

        // Fetch recent heartbeats
        const { data: heartbeats, error: hbError } = await supabase
          .from('runner_heartbeats')
          .select('runner_id, runner_type, status, last_heartbeat, version, ip_address')
          .gte('last_heartbeat', staleThreshold.toISOString())
          .order('last_heartbeat', { ascending: false });

        if (hbError) throw hbError;

        // Fetch lease status - use explicit type since table is new
        const { data: leaseData, error: leaseError } = await supabase
          .from('runner_lease')
          .select('runner_id, locked_until')
          .eq('id', '00000000-0000-0000-0000-000000000001')
          .single();

        if (leaseError && leaseError.code !== 'PGRST116') {
          // PGRST116 = no rows, which is fine
          console.warn('Lease fetch error:', leaseError);
        }

        const lease = leaseData as RunnerLease | null;
        const lockedUntil = lease?.locked_until ? new Date(lease.locked_until) : null;
        const expired = !lockedUntil || lockedUntil <= now;

        setActiveRunners(heartbeats || []);
        setLeaseHolder(lease?.runner_id || null);
        setLeaseExpires(lockedUntil);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to fetch runner status');
      } finally {
        setIsLoading(false);
      }
    };

    fetchStatus();

    // Refresh every 15 seconds
    const interval = setInterval(fetchStatus, 15_000);
    return () => clearInterval(interval);
  }, []);

  const now = new Date();
  const leaseExpired = !leaseExpires || leaseExpires <= now;

  // Conflict = more than 1 active runner with recent heartbeat
  const hasConflict = activeRunners.length > 1;

  return {
    hasConflict,
    activeRunners,
    leaseHolder,
    leaseExpires,
    leaseExpired,
    isLoading,
    error,
  };
}
