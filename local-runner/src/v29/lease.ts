/**
 * V29 Runner Registration
 * 
 * Simple takeover system:
 * 1. New runner registers itself with a timestamp
 * 2. If another runner is active, it will see the new registration on next heartbeat and stop
 * 3. No complex lease logic - just registration + heartbeat polling
 */

import { getDb } from './db.js';

const LEASE_ID = 'v29-live';
const HEARTBEAT_INTERVAL_MS = 2_000; // Check every 2s for faster takeover detection

let heartbeatInterval: NodeJS.Timeout | null = null;
let currentRunnerId: string | null = null;
let isActive = true;

function log(msg: string): void {
  console.log(`[V29:LEASE] ${msg}`);
}

// Grace period to let old runner shutdown before we start trading
const TAKEOVER_GRACE_MS = 5_000;

/**
 * Register as the active runner (takeover any existing)
 * BLOCKS until old runner has had time to shutdown
 */
export async function acquireLease(runnerId: string): Promise<boolean> {
  const db = getDb();
  const now = new Date();
  
  try {
    // Check if there's an existing runner
    const { data: existing } = await db
      .from('runner_leases')
      .select('*')
      .eq('id', LEASE_ID)
      .single();
    
    const hadExistingRunner = existing && existing.runner_id !== runnerId;
    
    if (hadExistingRunner) {
      log(`⚠️ Taking over from ${existing.runner_id}`);
    }
    
    // Upsert - always succeed, always takeover
    const { error } = await db
      .from('runner_leases')
      .upsert({
        id: LEASE_ID,
        runner_id: runnerId,
        acquired_at: now.toISOString(),
        expires_at: new Date(now.getTime() + 60_000).toISOString(),
        heartbeat_at: now.toISOString(),
      });
    
    if (error) {
      log(`❌ Registration failed: ${error.message}`);
      return false;
    }
    
    currentRunnerId = runnerId;
    isActive = true;
    
    // Start heartbeat that also checks for takeover
    startHeartbeat(runnerId);
    
    // CRITICAL: If we took over, wait for old runner to shutdown
    if (hadExistingRunner) {
      log(`⏳ Waiting ${TAKEOVER_GRACE_MS}ms for old runner to shutdown...`);
      await new Promise(resolve => setTimeout(resolve, TAKEOVER_GRACE_MS));
      
      // Verify we still own the lease after grace period
      const stillOwner = await validateLease(runnerId);
      if (!stillOwner) {
        log(`❌ Lost lease during grace period - another runner took over`);
        isActive = false;
        stopHeartbeat();
        return false;
      }
      log(`✅ Grace period complete - we are the sole runner`);
    }
    
    log(`✅ Registered as active runner: ${runnerId}`);
    return true;
    
  } catch (err) {
    log(`❌ Registration error: ${err}`);
    return false;
  }
}

/**
 * Heartbeat: update timestamp AND check if we've been taken over
 */
async function doHeartbeat(runnerId: string): Promise<boolean> {
  const db = getDb();
  const now = new Date();
  
  try {
    // First check if we're still the active runner
    const { data } = await db
      .from('runner_leases')
      .select('runner_id')
      .eq('id', LEASE_ID)
      .single();
    
    if (!data || data.runner_id !== runnerId) {
      // We've been taken over!
      log(`🔄 TAKEOVER DETECTED - new runner: ${data?.runner_id ?? 'unknown'}`);
      log(`🛑 This runner (${runnerId}) will now shutdown...`);
      isActive = false;
      return false;
    }
    
    // Update heartbeat
    await db
      .from('runner_leases')
      .update({
        expires_at: new Date(now.getTime() + 60_000).toISOString(),
        heartbeat_at: now.toISOString(),
      })
      .eq('id', LEASE_ID)
      .eq('runner_id', runnerId);
    
    return true;
  } catch {
    return true; // Continue on error
  }
}

/**
 * Start the heartbeat interval
 */
function startHeartbeat(runnerId: string): void {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
  }
  
  heartbeatInterval = setInterval(async () => {
    const stillActive = await doHeartbeat(runnerId);
    if (!stillActive && isActive) {
      // We've been taken over - trigger shutdown
      isActive = false;
      stopHeartbeat();
      
      // Trigger graceful shutdown by sending SIGINT to ourselves
      log(`🛑 Initiating graceful shutdown due to takeover...`);
      process.kill(process.pid, 'SIGINT');
    }
  }, HEARTBEAT_INTERVAL_MS);
}

/**
 * Stop the heartbeat interval
 */
function stopHeartbeat(): void {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
}

/**
 * Release the lease on shutdown
 */
export async function releaseLease(runnerId: string): Promise<void> {
  stopHeartbeat();
  isActive = false;
  
  const db = getDb();
  
  try {
    // Only delete if we still own it
    await db
      .from('runner_leases')
      .delete()
      .eq('id', LEASE_ID)
      .eq('runner_id', runnerId);
    
    log(`🔓 Released by ${runnerId}`);
    currentRunnerId = null;
  } catch (err) {
    log(`⚠️ Failed to release: ${err}`);
  }
}

/**
 * Check if we're still the active runner
 */
export async function validateLease(runnerId: string): Promise<boolean> {
  const db = getDb();
  
  try {
    const { data } = await db
      .from('runner_leases')
      .select('runner_id')
      .eq('id', LEASE_ID)
      .single();
    
    return data?.runner_id === runnerId;
  } catch {
    return false;
  }
}

/**
 * Check if this runner is still active (not taken over)
 */
export function isRunnerActive(): boolean {
  return isActive;
}
