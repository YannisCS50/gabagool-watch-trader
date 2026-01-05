/**
 * Strategy v7.0 Circuit Breaker
 * ============================================================
 * Stops trading when too many failures occur
 */

import { getConfig } from './config.js';
import type { ModeChangeEvent } from './types.js';

export interface CircuitBreaker {
  isOpen: boolean;
  openedAt: number | null;
  failuresInWindow: number;
  lastFailureTs: number;
  totalFailures: number;
  totalSuccesses: number;
  consecutiveFailures: number;
}

export function createCircuitBreaker(): CircuitBreaker {
  return {
    isOpen: false,
    openedAt: null,
    failuresInWindow: 0,
    lastFailureTs: 0,
    totalFailures: 0,
    totalSuccesses: 0,
    consecutiveFailures: 0,
  };
}

// Sliding window for failure tracking
const failureTimestamps: number[] = [];
const WINDOW_MS = 60_000; // 1 minute window

export function recordFailure(
  breaker: CircuitBreaker,
  log: (event: ModeChangeEvent) => void
): CircuitBreaker {
  const cfg = getConfig();
  const now = Date.now();
  
  // Add to sliding window
  failureTimestamps.push(now);
  
  // Remove old failures outside window
  while (failureTimestamps.length > 0 && failureTimestamps[0] < now - WINDOW_MS) {
    failureTimestamps.shift();
  }
  
  const updated: CircuitBreaker = {
    ...breaker,
    failuresInWindow: failureTimestamps.length,
    lastFailureTs: now,
    totalFailures: breaker.totalFailures + 1,
    consecutiveFailures: breaker.consecutiveFailures + 1,
  };
  
  // Check if we should open the circuit
  if (!updated.isOpen && updated.failuresInWindow >= cfg.risk.circuitBreakerFailuresPerMin) {
    updated.isOpen = true;
    updated.openedAt = now;
    
    console.error(`[v7] 🔴 CIRCUIT BREAKER OPEN: ${updated.failuresInWindow} failures in last minute`);
    
    log({
      type: 'CIRCUIT_BREAKER_ENTER',
      ts: now,
      reason: `${updated.failuresInWindow} failures in ${WINDOW_MS / 1000}s window`,
    });
  }
  
  return updated;
}

export function recordSuccess(breaker: CircuitBreaker): CircuitBreaker {
  return {
    ...breaker,
    totalSuccesses: breaker.totalSuccesses + 1,
    consecutiveFailures: 0,
  };
}

export function isCircuitOpen(breaker: CircuitBreaker): boolean {
  if (!breaker.isOpen) return false;
  
  // Auto-reset after 5 minutes
  const RESET_AFTER_MS = 5 * 60 * 1000;
  if (breaker.openedAt && Date.now() - breaker.openedAt > RESET_AFTER_MS) {
    return false;
  }
  
  return true;
}

export function resetCircuitBreaker(
  breaker: CircuitBreaker,
  log: (event: ModeChangeEvent) => void
): CircuitBreaker {
  if (breaker.isOpen) {
    log({
      type: 'CIRCUIT_BREAKER_EXIT',
      ts: Date.now(),
      reason: 'Manual reset or timeout',
    });
  }
  
  // Clear the sliding window
  failureTimestamps.length = 0;
  
  return {
    ...breaker,
    isOpen: false,
    openedAt: null,
    failuresInWindow: 0,
    consecutiveFailures: 0,
  };
}

export function getCircuitBreakerStats(breaker: CircuitBreaker): {
  isOpen: boolean;
  failuresInWindow: number;
  totalFailures: number;
  totalSuccesses: number;
  successRate: number;
} {
  const total = breaker.totalFailures + breaker.totalSuccesses;
  return {
    isOpen: isCircuitOpen(breaker),
    failuresInWindow: breaker.failuresInWindow,
    totalFailures: breaker.totalFailures,
    totalSuccesses: breaker.totalSuccesses,
    successRate: total > 0 ? breaker.totalSuccesses / total : 1,
  };
}
