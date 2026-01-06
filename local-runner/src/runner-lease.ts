/**
 * runner-lease.ts - v7.3.2
 * 
 * Enforces a hard lock: only ONE runner can be active at a time.
 * Uses a single-row table `runner_lease` with a `locked_until` timestamp.
 * 
 * - On startup, the runner tries to acquire the lease.
 * - If the lease is held by another runner and not expired, this runner HALTs.
 * - The lease is renewed every heartbeat (every 30s by default).
 * - Lease duration is 60s, so if a runner dies, another can take over after 60s.
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

// Lease configuration
export const LEASE_CONFIG = {
  leaseDurationMs: 60_000,        // 60 seconds - lease expires after this
  renewIntervalMs: 30_000,        // 30 seconds - renew lease every heartbeat
  graceOnStartupMs: 5_000,        // 5 seconds - wait before first lease attempt (allow old runner to release)
  maxRetries: 3,                  // Retry lease acquisition this many times
  retryDelayMs: 2_000,            // Wait between retries
};

const LEASE_ID = '00000000-0000-0000-0000-000000000001';

let supabase: ReturnType<typeof createClient> | null = null;
let currentRunnerId: string = '';
let leaseHeld = false;
let renewInterval: NodeJS.Timeout | null = null;

function getSupabase() {
  if (!supabase) {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
      console.error('❌ [Lease] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
      return null;
    }
    supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  }
  return supabase;
}

export interface LeaseStatus {
  held: boolean;
  runnerId: string;
  lockedUntil: Date | null;
  isOurs: boolean;
  expired: boolean;
}

/**
 * Get current lease status from database
 */
export async function getLeaseStatus(): Promise<LeaseStatus | null> {
  const sb = getSupabase();
  if (!sb) return null;

  try {
    const { data, error } = await sb
      .from('runner_lease')
      .select('*')
      .eq('id', LEASE_ID)
      .single();

    if (error) {
      console.error('❌ [Lease] Failed to fetch lease status:', error.message);
      return null;
    }

    const lockedUntil = data?.locked_until ? new Date(data.locked_until) : null;
    const now = new Date();
    const expired = !lockedUntil || lockedUntil <= now;
    const isOurs = data?.runner_id === currentRunnerId;

    return {
      held: !expired,
      runnerId: data?.runner_id || '',
      lockedUntil,
      isOurs,
      expired,
    };
  } catch (err) {
    console.error('❌ [Lease] Exception fetching lease:', err);
    return null;
  }
}

/**
 * Try to acquire the lease. Returns true if successful.
 * Uses atomic update: only succeeds if lease is expired OR we already hold it.
 */
export async function tryAcquireLease(runnerId: string): Promise<boolean> {
  const sb = getSupabase();
  if (!sb) {
    console.error('❌ [Lease] No Supabase client available');
    return false;
  }

  currentRunnerId = runnerId;
  const now = new Date();
  const newLockedUntil = new Date(now.getTime() + LEASE_CONFIG.leaseDurationMs);

  try {
    // Try to update the lease atomically:
    // Only succeeds if: locked_until < now (expired) OR runner_id = our id (renewal)
    const { data, error } = await sb
      .from('runner_lease')
      .update({
        runner_id: runnerId,
        locked_until: newLockedUntil.toISOString(),
        updated_at: now.toISOString(),
      })
      .eq('id', LEASE_ID)
      .or(`locked_until.lt.${now.toISOString()},runner_id.eq.${runnerId}`)
      .select()
      .single();

    if (error) {
      // Could be that another runner holds the lease
      console.warn('⚠️ [Lease] Failed to acquire lease:', error.message);
      return false;
    }

    if (data && data.runner_id === runnerId) {
      leaseHeld = true;
      console.log(`✅ [Lease] Acquired lease for ${runnerId} until ${newLockedUntil.toISOString()}`);
      return true;
    }

    return false;
  } catch (err) {
    console.error('❌ [Lease] Exception acquiring lease:', err);
    return false;
  }
}

/**
 * Renew the lease (extend locked_until). Only works if we hold it.
 */
export async function renewLease(): Promise<boolean> {
  if (!leaseHeld || !currentRunnerId) {
    return false;
  }

  const sb = getSupabase();
  if (!sb) return false;

  const now = new Date();
  const newLockedUntil = new Date(now.getTime() + LEASE_CONFIG.leaseDurationMs);

  try {
    const { data, error } = await sb
      .from('runner_lease')
      .update({
        locked_until: newLockedUntil.toISOString(),
        updated_at: now.toISOString(),
      })
      .eq('id', LEASE_ID)
      .eq('runner_id', currentRunnerId)
      .select()
      .single();

    if (error || !data) {
      console.error('❌ [Lease] Failed to renew lease - lost it?', error?.message);
      leaseHeld = false;
      return false;
    }

    console.log(`🔄 [Lease] Renewed lease until ${newLockedUntil.toISOString()}`);
    return true;
  } catch (err) {
    console.error('❌ [Lease] Exception renewing lease:', err);
    leaseHeld = false;
    return false;
  }
}

/**
 * Release the lease (set locked_until to past). Call on graceful shutdown.
 */
export async function releaseLease(): Promise<void> {
  if (!leaseHeld || !currentRunnerId) {
    return;
  }

  if (renewInterval) {
    clearInterval(renewInterval);
    renewInterval = null;
  }

  const sb = getSupabase();
  if (!sb) return;

  try {
    await sb
      .from('runner_lease')
      .update({
        locked_until: new Date(Date.now() - 1000).toISOString(), // Set to past
        updated_at: new Date().toISOString(),
      })
      .eq('id', LEASE_ID)
      .eq('runner_id', currentRunnerId);

    console.log(`🔓 [Lease] Released lease for ${currentRunnerId}`);
    leaseHeld = false;
  } catch (err) {
    console.error('❌ [Lease] Exception releasing lease:', err);
  }
}

/**
 * Start automatic lease renewal loop
 */
export function startLeaseRenewal(): void {
  if (renewInterval) {
    clearInterval(renewInterval);
  }

  renewInterval = setInterval(async () => {
    const success = await renewLease();
    if (!success) {
      console.error('🚨 [Lease] LOST LEASE - stopping renewal loop');
      if (renewInterval) {
        clearInterval(renewInterval);
        renewInterval = null;
      }
      // Signal to main loop that we should halt
      leaseHeld = false;
    }
  }, LEASE_CONFIG.renewIntervalMs);

  console.log(`⏰ [Lease] Started renewal loop every ${LEASE_CONFIG.renewIntervalMs / 1000}s`);
}

/**
 * Main entry point: try to acquire lease with retries.
 * Returns true if we got the lease, false if we should HALT.
 */
export async function acquireLeaseOrHalt(runnerId: string): Promise<boolean> {
  console.log(`\n🔒 [Lease] Attempting to acquire exclusive runner lease...`);
  console.log(`   Runner ID: ${runnerId}`);
  console.log(`   Lease duration: ${LEASE_CONFIG.leaseDurationMs / 1000}s`);

  // Optional: wait a bit to let a dying runner's lease expire
  if (LEASE_CONFIG.graceOnStartupMs > 0) {
    console.log(`   Waiting ${LEASE_CONFIG.graceOnStartupMs / 1000}s grace period...`);
    await new Promise(resolve => setTimeout(resolve, LEASE_CONFIG.graceOnStartupMs));
  }

  // Check current status
  const status = await getLeaseStatus();
  if (status) {
    console.log(`   Current lease: runner=${status.runnerId || '(none)'}, expired=${status.expired}`);
    if (!status.expired && status.runnerId && status.runnerId !== runnerId) {
      console.log(`   ⚠️ Another runner (${status.runnerId}) holds the lease until ${status.lockedUntil?.toISOString()}`);
    }
  }

  // Try to acquire with retries
  for (let attempt = 1; attempt <= LEASE_CONFIG.maxRetries; attempt++) {
    console.log(`   Attempt ${attempt}/${LEASE_CONFIG.maxRetries}...`);
    
    const acquired = await tryAcquireLease(runnerId);
    if (acquired) {
      startLeaseRenewal();
      return true;
    }

    if (attempt < LEASE_CONFIG.maxRetries) {
      console.log(`   Retrying in ${LEASE_CONFIG.retryDelayMs / 1000}s...`);
      await new Promise(resolve => setTimeout(resolve, LEASE_CONFIG.retryDelayMs));
    }
  }

  // Failed to acquire
  const finalStatus = await getLeaseStatus();
  console.error('\n' + '═'.repeat(70));
  console.error('🚨 RUNNER LEASE CONFLICT - HALTING');
  console.error('═'.repeat(70));
  console.error(`   This runner: ${runnerId}`);
  console.error(`   Lease holder: ${finalStatus?.runnerId || 'unknown'}`);
  console.error(`   Lease expires: ${finalStatus?.lockedUntil?.toISOString() || 'unknown'}`);
  console.error('');
  console.error('   Only ONE runner can be active at a time to prevent conflicts.');
  console.error('   Either:');
  console.error('   1. Stop the other runner, OR');
  console.error('   2. Wait for the lease to expire (~60s after the other runner stops)');
  console.error('═'.repeat(70) + '\n');

  return false;
}

/**
 * Check if we currently hold the lease
 */
export function isLeaseHeld(): boolean {
  return leaseHeld;
}

/**
 * Get current runner ID
 */
export function getCurrentRunnerId(): string {
  return currentRunnerId;
}
