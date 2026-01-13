/**
 * V29 Runner Lease Manager
 * 
 * Ensures only ONE runner can be active at a time using a database lease.
 * If another runner tries to start, it will fail to acquire the lease.
 */

import { getDb } from './db.js';

const LEASE_ID = 'v29-live';
const LEASE_DURATION_MS = 30_000; // 30 seconds
const HEARTBEAT_INTERVAL_MS = 10_000; // Refresh every 10 seconds

let heartbeatInterval: NodeJS.Timeout | null = null;
let currentRunnerId: string | null = null;

function log(msg: string): void {
  console.log(`[V29:LEASE] ${msg}`);
}

/**
 * Try to acquire the exclusive runner lease.
 * Returns true if successful, false if another runner holds the lease.
 */
export async function acquireLease(runnerId: string): Promise<boolean> {
  const db = getDb();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + LEASE_DURATION_MS);
  
  try {
    // First, check if there's an existing valid lease
    const { data: existing, error: fetchError } = await db
      .from('runner_leases')
      .select('*')
      .eq('id', LEASE_ID)
      .single();
    
    if (fetchError && fetchError.code !== 'PGRST116') {
      // PGRST116 = no rows found, that's OK
      log(`❌ Failed to check lease: ${fetchError.message}`);
      return false;
    }
    
    if (existing) {
      const expiresAtTime = new Date(existing.expires_at).getTime();
      
      // Check if lease is still valid (not expired)
      if (expiresAtTime > now.getTime()) {
        // Lease is valid - check if it's ours
        if (existing.runner_id === runnerId) {
          log(`✅ Already holding lease`);
          return true;
        }
        
        // Another runner holds the lease
        const remainingMs = expiresAtTime - now.getTime();
        log(`🚫 Lease held by ${existing.runner_id}, expires in ${Math.round(remainingMs / 1000)}s`);
        return false;
      }
      
      // Lease expired - try to take over
      log(`⏰ Lease from ${existing.runner_id} expired, taking over...`);
    }
    
    // Try to upsert the lease
    const { error: upsertError } = await db
      .from('runner_leases')
      .upsert({
        id: LEASE_ID,
        runner_id: runnerId,
        acquired_at: now.toISOString(),
        expires_at: expiresAt.toISOString(),
        heartbeat_at: now.toISOString(),
      });
    
    if (upsertError) {
      log(`❌ Failed to acquire lease: ${upsertError.message}`);
      return false;
    }
    
    // Verify we actually got it (race condition check)
    const { data: verify } = await db
      .from('runner_leases')
      .select('runner_id')
      .eq('id', LEASE_ID)
      .single();
    
    if (verify?.runner_id !== runnerId) {
      log(`🚫 Lost race condition to ${verify?.runner_id}`);
      return false;
    }
    
    currentRunnerId = runnerId;
    log(`✅ Lease acquired by ${runnerId}`);
    
    // Start heartbeat
    startHeartbeat(runnerId);
    
    return true;
    
  } catch (err) {
    log(`❌ Lease error: ${err}`);
    return false;
  }
}

/**
 * Refresh the lease heartbeat
 */
async function refreshLease(runnerId: string): Promise<boolean> {
  const db = getDb();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + LEASE_DURATION_MS);
  
  try {
    const { error } = await db
      .from('runner_leases')
      .update({
        expires_at: expiresAt.toISOString(),
        heartbeat_at: now.toISOString(),
      })
      .eq('id', LEASE_ID)
      .eq('runner_id', runnerId);
    
    if (error) {
      log(`⚠️ Heartbeat failed: ${error.message}`);
      return false;
    }
    
    return true;
  } catch {
    return false;
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
    const success = await refreshLease(runnerId);
    if (!success) {
      log(`⚠️ Lost lease - another runner may have taken over`);
      stopHeartbeat();
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
  
  const db = getDb();
  
  try {
    // Only delete if we still own it
    await db
      .from('runner_leases')
      .delete()
      .eq('id', LEASE_ID)
      .eq('runner_id', runnerId);
    
    log(`🔓 Lease released by ${runnerId}`);
    currentRunnerId = null;
  } catch (err) {
    log(`⚠️ Failed to release lease: ${err}`);
  }
}

/**
 * Check if we still hold the lease
 */
export async function validateLease(runnerId: string): Promise<boolean> {
  const db = getDb();
  
  try {
    const { data } = await db
      .from('runner_leases')
      .select('runner_id, expires_at')
      .eq('id', LEASE_ID)
      .single();
    
    if (!data) return false;
    
    const isOurs = data.runner_id === runnerId;
    const notExpired = new Date(data.expires_at).getTime() > Date.now();
    
    return isOurs && notExpired;
  } catch {
    return false;
  }
}

/**
 * Get current lease holder info
 */
export async function getLeaseInfo(): Promise<{
  holderId: string;
  acquiredAt: Date;
  expiresAt: Date;
} | null> {
  const db = getDb();
  
  try {
    const { data } = await db
      .from('runner_leases')
      .select('*')
      .eq('id', LEASE_ID)
      .single();
    
    if (!data) return null;
    
    return {
      holderId: data.runner_id,
      acquiredAt: new Date(data.acquired_at),
      expiresAt: new Date(data.expires_at),
    };
  } catch {
    return null;
  }
}
