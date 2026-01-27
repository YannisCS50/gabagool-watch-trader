// ============================================================
// V35 FILL SYNC TRACKER
// ============================================================
// Tracks recent fills and stops quoting if one side dominates.
// This prevents us from buying heavily on one side while the
// other side receives no fills.
//
// LOGIC:
// - If last N fills are all UP → STOP UP quotes, wait for DOWN
// - If last N fills are all DOWN → STOP DOWN quotes, wait for UP
// - Otherwise → quote both sides
// ============================================================

import type { V35Side } from './types.js';

interface FillRecord {
  timestamp: number;
  side: V35Side;
  qty: number;
  price: number;
  marketId: string;
}

interface FillSyncStats {
  totalRecent: number;
  recentUp: number;
  recentDown: number;
  currentStreak: number;
  streakSide: V35Side | null;
}

interface ShouldQuoteResult {
  allowed: boolean;
  reason: string;
}

class FillSyncTracker {
  private recentFills: FillRecord[] = [];
  private maxFills: number = 20;  // Keep last 20 fills
  
  // Config
  private windowSize: number;     // How many fills to check
  private maxStreak: number;      // Max fills on 1 side before stopping
  
  constructor(windowSize: number = 5, maxStreak: number = 3) {
    this.windowSize = windowSize;
    this.maxStreak = maxStreak;
  }
  
  /**
   * Update configuration at runtime
   */
  configure(windowSize: number, maxStreak: number): void {
    this.windowSize = windowSize;
    this.maxStreak = maxStreak;
    console.log(`[FillSync] Configured: window=${windowSize}, maxStreak=${maxStreak}`);
  }
  
  /**
   * Record a new fill
   */
  recordFill(side: V35Side, qty: number, price: number, marketId: string): void {
    this.recentFills.push({
      timestamp: Date.now(),
      side,
      qty,
      price,
      marketId,
    });
    
    // Trim old fills
    if (this.recentFills.length > this.maxFills) {
      this.recentFills = this.recentFills.slice(-this.maxFills);
    }
    
    // Log for debugging
    const stats = this.getStats();
    console.log(
      `[FillSync] ${side} fill recorded | ` +
      `Recent: ${stats.recentUp} UP / ${stats.recentDown} DOWN | ` +
      `Streak: ${stats.currentStreak}x ${stats.streakSide || 'NONE'}`
    );
  }
  
  /**
   * Check if we should quote on this side.
   * 
   * LOGIC:
   * - If last N fills are all UP → STOP UP quotes, wait for DOWN
   * - If last N fills are all DOWN → STOP DOWN quotes, wait for UP
   * - Otherwise → quote both sides
   */
  shouldQuote(side: V35Side): ShouldQuoteResult {
    const stats = this.getStats();
    
    // Not enough data, allow both sides
    if (stats.totalRecent < this.maxStreak) {
      return { allowed: true, reason: 'Insufficient fill history' };
    }
    
    // Check for streak
    if (stats.currentStreak >= this.maxStreak) {
      // There's a streak on one side
      if (stats.streakSide === side) {
        // We want to quote on the dominating side → STOP
        return { 
          allowed: false, 
          reason: `Fill streak: ${stats.currentStreak}x ${side} - waiting for ${side === 'UP' ? 'DOWN' : 'UP'} fill`
        };
      }
    }
    
    return { allowed: true, reason: 'OK' };
  }
  
  /**
   * Calculate statistics about recent fills
   */
  getStats(): FillSyncStats {
    // Get last N fills
    const recent = this.recentFills.slice(-this.windowSize);
    
    const recentUp = recent.filter(f => f.side === 'UP').length;
    const recentDown = recent.filter(f => f.side === 'DOWN').length;
    
    // Calculate current streak (from the end)
    let streak = 0;
    let streakSide: V35Side | null = null;
    
    for (let i = this.recentFills.length - 1; i >= 0; i--) {
      const fill = this.recentFills[i];
      if (streakSide === null) {
        streakSide = fill.side;
        streak = 1;
      } else if (fill.side === streakSide) {
        streak++;
      } else {
        break; // Streak broken
      }
    }
    
    return {
      totalRecent: recent.length,
      recentUp,
      recentDown,
      currentStreak: streak,
      streakSide,
    };
  }
  
  /**
   * Reset tracker (e.g., at new market)
   */
  reset(): void {
    this.recentFills = [];
    console.log('[FillSync] Tracker reset');
  }
  
  /**
   * Get all fills for debugging
   */
  getRecentFills(): FillRecord[] {
    return [...this.recentFills];
  }
  
  /**
   * Get current streak info for heartbeat
   */
  getStreakInfo(): { streak: number; side: V35Side | null } {
    const stats = this.getStats();
    return {
      streak: stats.currentStreak,
      side: stats.streakSide,
    };
  }
}

// Singleton instance with default config
export const fillSyncTracker = new FillSyncTracker(5, 3);

// Export class for testing
export { FillSyncTracker };
