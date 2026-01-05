/**
 * Strategy v7.0 Intent Queue
 * ============================================================
 * Bounded queue with priority handling
 * HEDGE intents never dropped, ENTRY can be dropped under stress
 */

import type { Intent, IntentType } from './types.js';
import { getConfig } from './config.js';

export interface IntentQueue {
  intents: Intent[];
  byMarket: Map<string, Intent[]>;
  droppedCount: number;
  processedCount: number;
}

export function createIntentQueue(): IntentQueue {
  return {
    intents: [],
    byMarket: new Map(),
    droppedCount: 0,
    processedCount: 0,
  };
}

export function enqueueIntent(queue: IntentQueue, intent: Intent): IntentQueue {
  const cfg = getConfig();
  const updated = { ...queue };
  
  // Get market's current intents
  const marketIntents = updated.byMarket.get(intent.marketId) || [];
  
  // Check if we should drop this intent
  if (marketIntents.length >= cfg.queue.maxPendingPerMarket) {
    // Never drop HEDGE or MICRO_HEDGE
    if (intent.type === 'HEDGE' || intent.type === 'MICRO_HEDGE' || intent.type === 'UNWIND') {
      // Drop oldest non-hedge intent instead
      const dropIndex = marketIntents.findIndex(i => 
        i.type === 'ENTRY' || i.type === 'ACCUMULATE'
      );
      
      if (dropIndex >= 0) {
        marketIntents.splice(dropIndex, 1);
        updated.droppedCount++;
      }
    } else {
      // Drop this entry/accumulate intent
      updated.droppedCount++;
      return updated;
    }
  }
  
  // Check global limit
  if (updated.intents.length >= cfg.queue.maxPendingGlobal) {
    // Try to drop a low-priority intent
    const dropIndex = updated.intents.findIndex(i => 
      i.type === 'ENTRY' || i.type === 'ACCUMULATE'
    );
    
    if (dropIndex >= 0) {
      const dropped = updated.intents.splice(dropIndex, 1)[0];
      const marketList = updated.byMarket.get(dropped.marketId);
      if (marketList) {
        const idx = marketList.findIndex(i => i.id === dropped.id);
        if (idx >= 0) marketList.splice(idx, 1);
      }
      updated.droppedCount++;
    } else if (intent.type === 'ENTRY' || intent.type === 'ACCUMULATE') {
      // Can't drop anything and this is low priority - reject
      updated.droppedCount++;
      return updated;
    }
  }
  
  // Add to queues
  updated.intents.push(intent);
  marketIntents.push(intent);
  updated.byMarket.set(intent.marketId, marketIntents);
  
  // Sort by priority
  updated.intents.sort((a, b) => b.priority - a.priority);
  
  return updated;
}

export function dequeueIntent(queue: IntentQueue): { queue: IntentQueue; intent: Intent | null } {
  if (queue.intents.length === 0) {
    return { queue, intent: null };
  }
  
  const updated = { ...queue };
  const intent = updated.intents.shift()!;
  
  // Remove from market queue
  const marketIntents = updated.byMarket.get(intent.marketId);
  if (marketIntents) {
    const idx = marketIntents.findIndex(i => i.id === intent.id);
    if (idx >= 0) marketIntents.splice(idx, 1);
  }
  
  updated.processedCount++;
  
  return { queue: updated, intent };
}

export function getQueueStats(queue: IntentQueue): {
  totalPending: number;
  byType: Record<IntentType, number>;
  byMarket: Record<string, number>;
  droppedCount: number;
  processedCount: number;
  isStressed: boolean;
} {
  const cfg = getConfig();
  
  const byType: Record<IntentType, number> = {
    ENTRY: 0,
    ACCUMULATE: 0,
    HEDGE: 0,
    MICRO_HEDGE: 0,
    UNWIND: 0,
  };
  
  const byMarket: Record<string, number> = {};
  
  for (const intent of queue.intents) {
    byType[intent.type]++;
    byMarket[intent.marketId] = (byMarket[intent.marketId] || 0) + 1;
  }
  
  return {
    totalPending: queue.intents.length,
    byType,
    byMarket,
    droppedCount: queue.droppedCount,
    processedCount: queue.processedCount,
    isStressed: queue.intents.length >= cfg.risk.queueStressSize,
  };
}

export function isQueueStressed(queue: IntentQueue): boolean {
  const cfg = getConfig();
  return queue.intents.length >= cfg.risk.queueStressSize;
}

export function pruneStaleIntents(queue: IntentQueue, maxAgeMs: number = 10000): IntentQueue {
  const now = Date.now();
  const updated = { ...queue };
  
  // Find and remove stale intents
  const staleIds = new Set<string>();
  
  updated.intents = updated.intents.filter(intent => {
    if (now - intent.ts > maxAgeMs) {
      staleIds.add(intent.id);
      return false;
    }
    return true;
  });
  
  // Update market queues
  for (const [marketId, intents] of updated.byMarket) {
    updated.byMarket.set(
      marketId,
      intents.filter(i => !staleIds.has(i.id))
    );
  }
  
  if (staleIds.size > 0) {
    console.log(`[v7] Pruned ${staleIds.size} stale intents from queue`);
  }
  
  return updated;
}

export function getMarketQueueCount(queue: IntentQueue, marketId: string): number {
  return queue.byMarket.get(marketId)?.length || 0;
}

export function hasHedgePending(queue: IntentQueue, marketId: string): boolean {
  const marketIntents = queue.byMarket.get(marketId) || [];
  return marketIntents.some(i => 
    i.type === 'HEDGE' || i.type === 'MICRO_HEDGE'
  );
}
