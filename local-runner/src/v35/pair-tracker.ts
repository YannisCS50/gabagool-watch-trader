// ============================================================
// V36 PAIR TRACKER - INDEPENDENT PAIR LIFECYCLE MANAGEMENT
// ============================================================
// Version: V36.1.0 - "Pair-Based Market Making"
//
// CORE CONCEPT:
// Each trade is an INDEPENDENT "Pair" with its own lifecycle:
// 1. TAKER entry on expensive (winning) side
// 2. MAKER limit order on cheap (losing) side
// 3. Settlement OR Emergency Hedge if reversal detected
//
// This replaces the symmetric passive quoting that caused us
// to accumulate losing positions (exit liquidity).
// ============================================================

import type { V35Market, V35Side, V35Asset, V35Fill } from './types.js';
import { placeOrder, cancelOrder, getOpenOrders } from '../polymarket.js';
import { getBinanceFeed } from './binance-feed.js';
import { logV35GuardEvent } from './backend.js';
import { getV35Config } from './config.js';

// ============================================================
// TYPES
// ============================================================

export type PairStatus = 
  | 'PENDING_ENTRY'      // Waiting for taker entry to fill
  | 'WAITING_HEDGE'      // Taker filled, waiting for maker hedge
  | 'HEDGED'             // Both sides filled
  | 'EMERGENCY_HEDGED'   // Stop-loss triggered
  | 'EXPIRED'            // Market expired
  | 'CANCELLED';         // Manually cancelled

export interface PendingPair {
  id: string;
  marketSlug: string;
  asset: V35Asset;
  conditionId: string;
  
  // Entry side (expensive/winning side)
  takerSide: V35Side;
  takerPrice: number;
  takerSize: number;
  takerOrderId?: string;
  takerFilledAt?: number;
  takerFilledPrice?: number;
  takerFilledSize?: number;
  
  // Hedge side (cheap/losing side)
  makerSide: V35Side;
  makerPrice: number;
  makerSize: number;
  makerOrderId?: string;
  makerFilledAt?: number;
  makerFilledPrice?: number;
  makerFilledSize?: number;
  
  // Emergency hedge (if reversal detected)
  emergencyOrderId?: string;
  emergencyFilledAt?: number;
  emergencyFilledPrice?: number;
  emergencyFilledSize?: number;
  
  // Lifecycle
  status: PairStatus;
  createdAt: number;
  updatedAt: number;
  
  // P&L tracking
  targetCpp: number;       // Target combined price per share
  actualCpp?: number;      // Actual combined cost
  pnl?: number;            // Realized P&L
}

export interface PairTrackerConfig {
  maxPendingPairs: number;           // Max concurrent pairs
  targetCpp: number;                 // Target combined cost (e.g., 0.95)
  maxCppForEntry: number;            // Max combined cost to enter
  emergencyMaxCpp: number;           // Max combined cost for emergency hedge
  makerPriceOffset: number;          // Offset below bid for maker (e.g., 0.01)
  emergencyTakerOffset: number;      // Offset above ask for emergency (e.g., 0.005)
  minSharesPerPair: number;          // Minimum shares per pair
  maxSharesPerPair: number;          // Maximum shares per pair
  makerTimeoutMs: number;            // Cancel maker if not filled after this
}

const DEFAULT_CONFIG: PairTrackerConfig = {
  maxPendingPairs: 5,
  targetCpp: 0.95,
  maxCppForEntry: 0.98,
  emergencyMaxCpp: 1.05,
  makerPriceOffset: 0.01,
  emergencyTakerOffset: 0.005,
  minSharesPerPair: 5,
  maxSharesPerPair: 20,
  makerTimeoutMs: 30_000,
};

// ============================================================
// PAIR TRACKER CLASS
// ============================================================

export class PairTracker {
  private config: PairTrackerConfig;
  private pairs: Map<string, PendingPair> = new Map();
  private pairCounter = 0;
  
  constructor(config: Partial<PairTrackerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }
  
  /**
   * Check if we can open a new pair
   */
  canOpenNewPair(): boolean {
    const activePairs = this.getActivePairs().length;
    return activePairs < this.config.maxPendingPairs;
  }
  
  /**
   * Get all active (non-terminal) pairs
   */
  getActivePairs(): PendingPair[] {
    return Array.from(this.pairs.values()).filter(p => 
      p.status === 'PENDING_ENTRY' || p.status === 'WAITING_HEDGE'
    );
  }
  
  /**
   * Get pairs for a specific market
   */
  getMarketPairs(marketSlug: string): PendingPair[] {
    return Array.from(this.pairs.values()).filter(p => 
      p.marketSlug === marketSlug
    );
  }
  
  /**
   * Open a new pair with a TAKER order on the expensive side
   * 
   * @param market - The market to trade
   * @param expensiveSide - Which side is expensive (likely winner)
   * @param size - Number of shares
   */
  async openPair(
    market: V35Market,
    expensiveSide: V35Side,
    size: number
  ): Promise<{ success: boolean; pairId?: string; error?: string }> {
    const config = getV35Config();
    
    // Validate
    if (!this.canOpenNewPair()) {
      return { success: false, error: `max_pairs_reached: ${this.config.maxPendingPairs}` };
    }
    
    size = Math.max(this.config.minSharesPerPair, Math.min(size, this.config.maxSharesPerPair));
    
    // Get current prices
    const expensiveAsk = expensiveSide === 'UP' ? market.upBestAsk : market.downBestAsk;
    const cheapBid = expensiveSide === 'UP' ? market.downBestBid : market.upBestBid;
    const cheapSide: V35Side = expensiveSide === 'UP' ? 'DOWN' : 'UP';
    
    // Calculate target maker price
    const makerPrice = Math.max(0.05, cheapBid - this.config.makerPriceOffset);
    
    // Check if combined cost is acceptable
    const projectedCpp = expensiveAsk + makerPrice;
    
    if (projectedCpp > this.config.maxCppForEntry) {
      console.log(`[PairTracker] ❌ CPP too high: $${projectedCpp.toFixed(3)} > $${this.config.maxCppForEntry.toFixed(2)}`);
      return { success: false, error: `cpp_too_high: ${projectedCpp.toFixed(3)}` };
    }
    
    // Create pair ID
    const pairId = `pair_${Date.now()}_${++this.pairCounter}`;
    
    // Get token IDs
    const takerTokenId = expensiveSide === 'UP' ? market.upTokenId : market.downTokenId;
    const makerTokenId = cheapSide === 'UP' ? market.upTokenId : market.downTokenId;
    
    console.log(`[PairTracker] 🎯 Opening pair ${pairId}`);
    console.log(`[PairTracker]    TAKER: ${size} ${expensiveSide} @ $${expensiveAsk.toFixed(3)}`);
    console.log(`[PairTracker]    MAKER: ${size} ${cheapSide} @ $${makerPrice.toFixed(3)} (bid=$${cheapBid.toFixed(3)})`);
    console.log(`[PairTracker]    Target CPP: $${projectedCpp.toFixed(3)}`);
    
    if (config.dryRun) {
      console.log(`[PairTracker] [DRY RUN] Would open pair`);
      return { success: false, error: 'dry_run' };
    }
    
    // 1. Place TAKER order on expensive side (market buy)
    try {
      const takerResult = await placeOrder({
        tokenId: takerTokenId,
        side: 'BUY',
        price: expensiveAsk + 0.005, // Slightly above ask for immediate fill
        size,
        orderType: 'GTC',
      });
      
      if (!takerResult.success || !takerResult.orderId) {
        console.log(`[PairTracker] ❌ Taker order failed: ${takerResult.error}`);
        return { success: false, error: takerResult.error || 'taker_failed' };
      }
      
      console.log(`[PairTracker] ✓ Taker placed: ${takerResult.orderId.slice(0, 8)}...`);
      
      // 2. Place MAKER limit order on cheap side
      const makerResult = await placeOrder({
        tokenId: makerTokenId,
        side: 'BUY',
        price: makerPrice,
        size,
        orderType: 'GTC',
      });
      
      if (!makerResult.success || !makerResult.orderId) {
        console.log(`[PairTracker] ⚠️ Maker order failed: ${makerResult.error}`);
        // Cancel taker order since we can't hedge
        await cancelOrder(takerResult.orderId);
        return { success: false, error: makerResult.error || 'maker_failed' };
      }
      
      console.log(`[PairTracker] ✓ Maker placed: ${makerResult.orderId.slice(0, 8)}...`);
      
      // Create pair record
      const pair: PendingPair = {
        id: pairId,
        marketSlug: market.slug,
        asset: market.asset,
        conditionId: market.conditionId,
        
        takerSide: expensiveSide,
        takerPrice: expensiveAsk,
        takerSize: size,
        takerOrderId: takerResult.orderId,
        
        makerSide: cheapSide,
        makerPrice: makerPrice,
        makerSize: size,
        makerOrderId: makerResult.orderId,
        
        status: 'PENDING_ENTRY',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        targetCpp: projectedCpp,
      };
      
      this.pairs.set(pairId, pair);
      
      // Log event
      logV35GuardEvent({
        marketSlug: market.slug,
        asset: market.asset,
        guardType: 'PAIR_OPENED',
        blockedSide: null,
        upQty: market.upQty,
        downQty: market.downQty,
        expensiveSide,
        reason: `Pair ${pairId}: ${size} shares, CPP target $${projectedCpp.toFixed(3)}`,
      }).catch(() => {});
      
      return { success: true, pairId };
      
    } catch (err: any) {
      console.error(`[PairTracker] Error opening pair:`, err?.message);
      return { success: false, error: err?.message };
    }
  }
  
  /**
   * Handle a fill event - update pair status
   */
  async onFill(fill: V35Fill, market: V35Market): Promise<{
    pairUpdated: boolean;
    pair?: PendingPair;
  }> {
    // Find matching pair
    for (const pair of this.pairs.values()) {
      if (pair.marketSlug !== market.slug) continue;
      
      // Check taker fill
      if (pair.takerOrderId === fill.orderId && pair.status === 'PENDING_ENTRY') {
        pair.takerFilledAt = Date.now();
        pair.takerFilledPrice = fill.price;
        pair.takerFilledSize = fill.size;
        pair.status = 'WAITING_HEDGE';
        pair.updatedAt = Date.now();
        
        console.log(`[PairTracker] 🎯 Taker FILLED: ${pair.id} | ${fill.size} ${pair.takerSide} @ $${fill.price.toFixed(3)}`);
        return { pairUpdated: true, pair };
      }
      
      // Check maker fill
      if (pair.makerOrderId === fill.orderId && pair.status === 'WAITING_HEDGE') {
        pair.makerFilledAt = Date.now();
        pair.makerFilledPrice = fill.price;
        pair.makerFilledSize = fill.size;
        pair.status = 'HEDGED';
        pair.updatedAt = Date.now();
        
        // Calculate actual CPP
        const takerCost = pair.takerFilledPrice || pair.takerPrice;
        const makerCost = fill.price;
        pair.actualCpp = takerCost + makerCost;
        pair.pnl = (1.0 - pair.actualCpp) * Math.min(pair.takerFilledSize || 0, fill.size);
        
        console.log(`[PairTracker] ✅ PAIR COMPLETE: ${pair.id}`);
        console.log(`[PairTracker]    CPP: $${pair.actualCpp.toFixed(3)} | P&L: $${pair.pnl.toFixed(2)}`);
        
        return { pairUpdated: true, pair };
      }
      
      // Check emergency fill
      if (pair.emergencyOrderId === fill.orderId) {
        pair.emergencyFilledAt = Date.now();
        pair.emergencyFilledPrice = fill.price;
        pair.emergencyFilledSize = fill.size;
        pair.status = 'EMERGENCY_HEDGED';
        pair.updatedAt = Date.now();
        
        // Calculate actual CPP
        const takerCost = pair.takerFilledPrice || pair.takerPrice;
        pair.actualCpp = takerCost + fill.price;
        pair.pnl = (1.0 - pair.actualCpp) * Math.min(pair.takerFilledSize || 0, fill.size);
        
        console.log(`[PairTracker] 🛑 EMERGENCY HEDGE COMPLETE: ${pair.id}`);
        console.log(`[PairTracker]    CPP: $${pair.actualCpp.toFixed(3)} | P&L: $${pair.pnl.toFixed(2)}`);
        
        return { pairUpdated: true, pair };
      }
    }
    
    return { pairUpdated: false };
  }
  
  /**
   * Trigger emergency hedge for a pair (Binance reversal detected)
   */
  async triggerEmergencyHedge(
    pair: PendingPair,
    market: V35Market,
    currentAsk: number
  ): Promise<{ success: boolean; error?: string }> {
    if (pair.status !== 'WAITING_HEDGE') {
      return { success: false, error: 'wrong_status' };
    }
    
    const config = getV35Config();
    const takerCost = pair.takerFilledPrice || pair.takerPrice;
    const projectedCpp = takerCost + currentAsk;
    
    // Check if emergency hedge is within limits
    if (projectedCpp > this.config.emergencyMaxCpp) {
      console.log(`[PairTracker] ⚠️ Emergency CPP too high: $${projectedCpp.toFixed(3)} > $${this.config.emergencyMaxCpp.toFixed(2)}`);
      return { success: false, error: `emergency_cpp_too_high: ${projectedCpp.toFixed(3)}` };
    }
    
    // Cancel the maker limit order first
    if (pair.makerOrderId) {
      try {
        await cancelOrder(pair.makerOrderId);
        console.log(`[PairTracker] 🗑️ Cancelled maker order: ${pair.makerOrderId.slice(0, 8)}...`);
      } catch (err) {
        console.warn(`[PairTracker] Failed to cancel maker:`, err);
      }
    }
    
    // Get token ID for cheap side
    const tokenId = pair.makerSide === 'UP' ? market.upTokenId : market.downTokenId;
    const emergencyPrice = currentAsk + this.config.emergencyTakerOffset;
    const size = pair.takerFilledSize || pair.takerSize;
    
    console.log(`[PairTracker] 🛑 EMERGENCY HEDGE: ${pair.id}`);
    console.log(`[PairTracker]    ${size} ${pair.makerSide} @ $${emergencyPrice.toFixed(3)}`);
    console.log(`[PairTracker]    Projected CPP: $${projectedCpp.toFixed(3)}`);
    
    if (config.dryRun) {
      console.log(`[PairTracker] [DRY RUN] Would place emergency hedge`);
      return { success: false, error: 'dry_run' };
    }
    
    try {
      const result = await placeOrder({
        tokenId,
        side: 'BUY',
        price: emergencyPrice,
        size,
        orderType: 'GTC',
      });
      
      if (!result.success || !result.orderId) {
        console.log(`[PairTracker] ❌ Emergency hedge failed: ${result.error}`);
        return { success: false, error: result.error || 'emergency_failed' };
      }
      
      pair.emergencyOrderId = result.orderId;
      pair.updatedAt = Date.now();
      
      console.log(`[PairTracker] ✓ Emergency order placed: ${result.orderId.slice(0, 8)}...`);
      
      // Log event
      logV35GuardEvent({
        marketSlug: market.slug,
        asset: market.asset,
        guardType: 'EMERGENCY_HEDGE',
        blockedSide: pair.makerSide,
        upQty: market.upQty,
        downQty: market.downQty,
        expensiveSide: pair.takerSide,
        reason: `Pair ${pair.id}: Emergency @ $${emergencyPrice.toFixed(3)}, CPP $${projectedCpp.toFixed(3)}`,
      }).catch(() => {});
      
      return { success: true };
      
    } catch (err: any) {
      console.error(`[PairTracker] Error placing emergency hedge:`, err?.message);
      return { success: false, error: err?.message };
    }
  }
  
  /**
   * Check for stale maker orders and handle timeouts
   */
  async checkTimeouts(market: V35Market): Promise<void> {
    const now = Date.now();
    
    for (const pair of this.getMarketPairs(market.slug)) {
      if (pair.status !== 'WAITING_HEDGE') continue;
      
      const waitingTime = now - (pair.takerFilledAt || pair.createdAt);
      
      if (waitingTime >= this.config.makerTimeoutMs) {
        console.log(`[PairTracker] ⏰ Maker timeout for ${pair.id}: ${(waitingTime / 1000).toFixed(0)}s`);
        
        // Get current ask for emergency hedge
        const currentAsk = pair.makerSide === 'UP' ? market.upBestAsk : market.downBestAsk;
        await this.triggerEmergencyHedge(pair, market, currentAsk);
      }
    }
  }
  
  /**
   * Get summary statistics
   */
  getStats(): {
    totalPairs: number;
    activePairs: number;
    completedPairs: number;
    totalPnl: number;
    avgCpp: number;
  } {
    const all = Array.from(this.pairs.values());
    const completed = all.filter(p => p.status === 'HEDGED' || p.status === 'EMERGENCY_HEDGED');
    const active = all.filter(p => p.status === 'PENDING_ENTRY' || p.status === 'WAITING_HEDGE');
    
    const totalPnl = completed.reduce((sum, p) => sum + (p.pnl || 0), 0);
    const avgCpp = completed.length > 0
      ? completed.reduce((sum, p) => sum + (p.actualCpp || 0), 0) / completed.length
      : 0;
    
    return {
      totalPairs: all.length,
      activePairs: active.length,
      completedPairs: completed.length,
      totalPnl,
      avgCpp,
    };
  }
  
  /**
   * Clean up completed pairs older than 5 minutes
   */
  cleanup(): void {
    const cutoff = Date.now() - 5 * 60 * 1000;
    
    for (const [id, pair] of this.pairs.entries()) {
      if (
        (pair.status === 'HEDGED' || pair.status === 'EMERGENCY_HEDGED' || pair.status === 'CANCELLED') &&
        pair.updatedAt < cutoff
      ) {
        this.pairs.delete(id);
      }
    }
  }
  
  /**
   * Reset all pairs (for new market cycle)
   */
  reset(): void {
    this.pairs.clear();
    this.pairCounter = 0;
  }
}

// ============================================================
// SINGLETON INSTANCE
// ============================================================

let pairTrackerInstance: PairTracker | null = null;

export function getPairTracker(): PairTracker {
  if (!pairTrackerInstance) {
    pairTrackerInstance = new PairTracker();
  }
  return pairTrackerInstance;
}

export function resetPairTracker(): void {
  if (pairTrackerInstance) {
    pairTrackerInstance.reset();
  }
  pairTrackerInstance = null;
}
