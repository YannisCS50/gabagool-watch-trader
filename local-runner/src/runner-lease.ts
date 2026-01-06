/**
 * runner-lease.ts - v7.3.2
 *
 * Enforces a hard lock: only ONE runner can be active at a time.
 *
 * IMPORTANT: This runner does NOT need database/service keys.
 * It uses the backend proxy (config.backend.url + config.backend.secret) to claim/renew/release the lease.
 */

import { config } from './config.js';

// Lease configuration
export const LEASE_CONFIG = {
  leaseDurationMs: 60_000, // 60 seconds - lease expires after this
  renewIntervalMs: 30_000, // 30 seconds - renew lease every heartbeat
  graceOnStartupMs: 5_000, // 5 seconds - wait before first lease attempt
  maxRetries: 3,
  retryDelayMs: 2_000,
};

let currentRunnerId = '';
let leaseHeld = false;
let renewInterval: NodeJS.Timeout | null = null;

type ProxyResult<T> = T & { success: boolean; error?: string };

async function callProxy<T>(action: string, data?: Record<string, unknown>): Promise<ProxyResult<T>> {
  if (!config.backend.url || !config.backend.secret) {
    return {
      success: false,
      error: 'Missing BACKEND_URL or RUNNER_SHARED_SECRET in runner env',
    } as ProxyResult<T>;
  }

  const res = await fetch(config.backend.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Runner-Secret': config.backend.secret,
    },
    body: JSON.stringify({ action, data }),
  });

  if (!res.ok) {
    const text = await res.text();
    return { success: false, error: `Backend error ${res.status}: ${text}` } as ProxyResult<T>;
  }

  return res.json();
}

export interface LeaseStatus {
  held: boolean;
  runnerId: string;
  lockedUntil: Date | null;
  isOurs: boolean;
  expired: boolean;
}

export async function getLeaseStatus(): Promise<LeaseStatus | null> {
  try {
    const result = await callProxy<{ lease?: { runner_id: string; locked_until: string } }>('lease-status');
    if (!result.success || !result.lease) {
      console.error('❌ [Lease] Failed to fetch lease status:', result.error);
      return null;
    }

    const lockedUntil = result.lease.locked_until ? new Date(result.lease.locked_until) : null;
    const now = new Date();
    const expired = !lockedUntil || lockedUntil <= now;
    const isOurs = result.lease.runner_id === currentRunnerId;

    return {
      held: !expired,
      runnerId: result.lease.runner_id || '',
      lockedUntil,
      isOurs,
      expired,
    };
  } catch (err) {
    console.error('❌ [Lease] Exception fetching lease:', err);
    return null;
  }
}

export async function tryAcquireLease(runnerId: string, force = false): Promise<boolean> {
  currentRunnerId = runnerId;

  try {
    const result = await callProxy<{ acquired: boolean; forced?: boolean; lease?: { runner_id: string; locked_until: string } }>(
      'lease-claim',
      {
        runner_id: runnerId,
        lease_duration_ms: LEASE_CONFIG.leaseDurationMs,
        force, // v7.3.3: Force acquire option
      }
    );

    if (!result.success) {
      console.error('❌ [Lease] Failed to acquire lease:', result.error);
      return false;
    }

    if (result.acquired) {
      leaseHeld = true;
      if (result.forced) {
        console.log(`⚡ [Lease] FORCE acquired lease for ${runnerId} until ${result.lease?.locked_until}`);
      } else {
        console.log(`✅ [Lease] Acquired lease for ${runnerId} until ${result.lease?.locked_until}`);
      }
      return true;
    }

    return false;
  } catch (err) {
    console.error('❌ [Lease] Exception acquiring lease:', err);
    return false;
  }
}

export async function renewLease(): Promise<boolean> {
  if (!leaseHeld || !currentRunnerId) return false;

  try {
    const result = await callProxy<{ renewed: boolean; lease?: { runner_id: string; locked_until: string } }>(
      'lease-renew',
      {
        runner_id: currentRunnerId,
        lease_duration_ms: LEASE_CONFIG.leaseDurationMs,
      }
    );

    if (!result.success) {
      console.error('❌ [Lease] Failed to renew lease:', result.error);
      leaseHeld = false;
      return false;
    }

    if (!result.renewed) {
      console.error('❌ [Lease] Failed to renew lease - lost it?');
      leaseHeld = false;
      return false;
    }

    console.log(`🔄 [Lease] Renewed lease until ${result.lease?.locked_until}`);
    return true;
  } catch (err) {
    console.error('❌ [Lease] Exception renewing lease:', err);
    leaseHeld = false;
    return false;
  }
}

export async function releaseLease(): Promise<void> {
  if (!leaseHeld || !currentRunnerId) return;

  if (renewInterval) {
    clearInterval(renewInterval);
    renewInterval = null;
  }

  try {
    const result = await callProxy<{ released: boolean }>('lease-release', { runner_id: currentRunnerId });
    if (!result.success) {
      console.error('❌ [Lease] Failed to release lease:', result.error);
      return;
    }

    console.log(`🔓 [Lease] Released lease for ${currentRunnerId}`);
    leaseHeld = false;
  } catch (err) {
    console.error('❌ [Lease] Exception releasing lease:', err);
  }
}

export function startLeaseRenewal(): void {
  if (renewInterval) {
    clearInterval(renewInterval);
  }

  renewInterval = setInterval(async () => {
    const ok = await renewLease();
    if (!ok) {
      console.error('🚨 [Lease] LOST LEASE - stopping renewal loop');
      if (renewInterval) {
        clearInterval(renewInterval);
        renewInterval = null;
      }
      leaseHeld = false;
    }
  }, LEASE_CONFIG.renewIntervalMs);

  console.log(`⏰ [Lease] Started renewal loop every ${LEASE_CONFIG.renewIntervalMs / 1000}s`);
}

export async function acquireLeaseOrHalt(runnerId: string, force = false): Promise<boolean> {
  console.log(`\n🔒 [Lease] Attempting to acquire exclusive runner lease...`);
  console.log(`   Runner ID: ${runnerId}`);
  console.log(`   Lease duration: ${LEASE_CONFIG.leaseDurationMs / 1000}s`);
  if (force) {
    console.log(`   ⚡ FORCE MODE: Will override existing lease`);
  }

  if (!force && LEASE_CONFIG.graceOnStartupMs > 0) {
    console.log(`   Waiting ${LEASE_CONFIG.graceOnStartupMs / 1000}s grace period...`);
    await new Promise((r) => setTimeout(r, LEASE_CONFIG.graceOnStartupMs));
  }

  const status = await getLeaseStatus();
  if (status) {
    console.log(`   Current lease: runner=${status.runnerId || '(none)'}, expired=${status.expired}`);
    if (!status.expired && status.runnerId && status.runnerId !== runnerId) {
      if (force) {
        console.log(`   ⚡ FORCING takeover from ${status.runnerId}`);
      } else {
        console.log(`   ⚠️ Another runner (${status.runnerId}) holds the lease until ${status.lockedUntil?.toISOString()}`);
      }
    }
  }

  // v7.3.3: If force mode, try once with force flag
  if (force) {
    const acquired = await tryAcquireLease(runnerId, true);
    if (acquired) {
      startLeaseRenewal();
      return true;
    }
    console.error('❌ [Lease] Force acquire failed unexpectedly');
    return false;
  }

  for (let attempt = 1; attempt <= LEASE_CONFIG.maxRetries; attempt++) {
    console.log(`   Attempt ${attempt}/${LEASE_CONFIG.maxRetries}...`);

    const acquired = await tryAcquireLease(runnerId, false);
    if (acquired) {
      startLeaseRenewal();
      return true;
    }

    if (attempt < LEASE_CONFIG.maxRetries) {
      console.log(`   Retrying in ${LEASE_CONFIG.retryDelayMs / 1000}s...`);
      await new Promise((r) => setTimeout(r, LEASE_CONFIG.retryDelayMs));
    }
  }

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
  console.error('   3. Restart with --force flag to override: docker-compose up -d runner --force');
  console.error('═'.repeat(70) + '\n');

  return false;
}

export function isLeaseHeld(): boolean {
  return leaseHeld;
}

export function getCurrentRunnerId(): string {
  return currentRunnerId;
}

export { LEASE_CONFIG as _LEASE_CONFIG_INTERNAL }; // for debugging/import consistency