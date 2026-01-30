// ============================================================
// V36 PAIR TRACKER - INDEPENDENT PAIR LIFECYCLE MANAGEMENT
// ============================================================
// Version: V36.2.4 - "One-at-a-Time Pair Entries"
//
// V36.2.4 CHANGES:
// - FIX: Only allow ONE pending entry at a time (wait for taker fill)
// - FIX: Log MAKER_PLACED event to database for visibility
//
// V36.2.2 CHANGES:
// - FIX: Create pair BEFORE placing order to avoid race condition
// - FIX: Match fills on side+status when orderId not yet set
// - The WebSocket fill can arrive before placeOrder() returns!
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
// CRITICAL: Register our order IDs so fills are recognized as ours!
import { registerOurOrderId } from './user-ws.js';

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
  emergencyMaxCpp: number;           // Max combined cost for emergency hedge
  emergencyTakerOffset: number;      // Offset above ask for emergency (e.g., 0.005)
  minSharesPerPair: number;          // Minimum shares per pair
  maxSharesPerPair: number;          // Maximum shares per pair
  startupDelayMs: number;            // Wait after market open before first pair
  // NOTE: NO makerTimeoutMs - maker order stays until fill or emergency
}

const DEFAULT_CONFIG: PairTrackerConfig = {
  maxPendingPairs: 5,
  targetCpp: 0.95,
  emergencyMaxCpp: 1.05,
  emergencyTakerOffset: 0.005,
  minSharesPerPair: 5,
  maxSharesPerPair: 20,
  startupDelayMs: 30_000,            // 30 seconds observation period
};

// ============================================================
// PAIR TRACKER CLASS
// ============================================================

export class PairTracker {
  private config: PairTrackerConfig;
  private pairs: Map<string, PendingPair> = new Map();
  private pairCounter = 0;
  private marketStartTimes: Map<string, number> = new Map(); // Track when each market started
  
  constructor(config: Partial<PairTrackerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }
  
  /**
   * Register when a market window starts (for startup delay calculation)
   */
  registerMarketStart(marketSlug: string): void {
    if (!this.marketStartTimes.has(marketSlug)) {
      this.marketStartTimes.set(marketSlug, Date.now());
      console.log(`[PairTracker] 📍 Registered market start: ${marketSlug} | Waiting ${this.config.startupDelayMs / 1000}s before trading`);
    }
  }
  
  /**
   * Check if startup delay has passed for this market
   */
  isStartupDelayComplete(marketSlug: string): boolean {
    const startTime = this.marketStartTimes.get(marketSlug);
    if (!startTime) {
      // First time seeing this market, register it
      this.registerMarketStart(marketSlug);
      return false;
    }
    
    const elapsed = Date.now() - startTime;
    const complete = elapsed >= this.config.startupDelayMs;
    
    if (!complete) {
      const remaining = Math.ceil((this.config.startupDelayMs - elapsed) / 1000);
      // Only log every 5 seconds to avoid spam
      if (remaining % 5 === 0 || remaining <= 3) {
        console.log(`[PairTracker] ⏳ Startup delay: ${remaining}s remaining for ${marketSlug}`);
      }
    }
    
    return complete;
  }
  
  /**
   * Clear market start time (for cleanup when market ends)
   */
  clearMarketStart(marketSlug: string): void {
    this.marketStartTimes.delete(marketSlug);
  }
  
  /**
   * Check if we can open a new pair
   * V36.2.4: Also block if ANY pair is still in PENDING_ENTRY (awaiting taker fill)
   * This prevents opening multiple pairs before the first taker fill arrives.
   */
  canOpenNewPair(): boolean {
    const activePairs = this.getActivePairs();
    
    // V36.2.4: Block if we have any PENDING_ENTRY pairs (awaiting taker fill)
    // This ensures we wait for the taker to fill before opening a new pair
    const pendingEntry = activePairs.filter(p => p.status === 'PENDING_ENTRY');
    if (pendingEntry.length > 0) {
      console.log(`[PairTracker] ⏳ Waiting for ${pendingEntry.length} taker fill(s) before opening new pair`);
      return false;
    }
    
    // Also check total active pairs limit
    return activePairs.length < this.config.maxPendingPairs;
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
   * Open a new pair: ALWAYS execute TAKER on expensive side
   * Maker limit order will be placed AFTER taker fill (see onFill)
   * 
   * V36.2 CHANGES:
   * - NO CPP check for entry - taker is ALWAYS placed
   * - Maker price calculated AFTER taker fill: targetCpp - fillPrice
   * - Only BTC markets allowed
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
    
    // ONLY BTC
    if (market.asset !== 'BTC') {
      return { success: false, error: 'only_btc_allowed' };
    }
    
    // Check startup delay - wait for market to stabilize
    if (!this.isStartupDelayComplete(market.slug)) {
      return { success: false, error: 'startup_delay_active' };
    }
    
    // Validate
    if (!this.canOpenNewPair()) {
      return { success: false, error: `max_pairs_reached: ${this.config.maxPendingPairs}` };
    }
    
    size = Math.max(this.config.minSharesPerPair, Math.min(size, this.config.maxSharesPerPair));
    
    // Get current prices
    const expensiveAsk = expensiveSide === 'UP' ? market.upBestAsk : market.downBestAsk;
    const cheapSide: V35Side = expensiveSide === 'UP' ? 'DOWN' : 'UP';
    
    // V36.2: NO CPP CHECK - we ALWAYS buy the expensive side
    // The maker price will be calculated AFTER the fill based on actual fill price
    
    // Create pair ID
    const pairId = `pair_${Date.now()}_${++this.pairCounter}`;
    
    // Get token ID for taker
    const takerTokenId = expensiveSide === 'UP' ? market.upTokenId : market.downTokenId;
    
    console.log(`[PairTracker] 🎯 Opening pair ${pairId} (V36.2 - no CPP check)`);
    console.log(`[PairTracker]    TAKER: ${size} ${expensiveSide} @ market (~$${expensiveAsk.toFixed(3)})`);
    console.log(`[PairTracker]    MAKER: Will be placed AFTER taker fill at targetCpp - fillPrice`);
    
    if (config.dryRun) {
      console.log(`[PairTracker] [DRY RUN] Would open pair`);
      return { success: false, error: 'dry_run' };
    }
    
    // V36.2.2: Create pair FIRST, then place order to avoid race condition
    // The fill can arrive via WebSocket before placeOrder() returns!
    const pair: PendingPair = {
      id: pairId,
      marketSlug: market.slug,
      asset: market.asset,
      conditionId: market.conditionId,
      
      takerSide: expensiveSide,
      takerPrice: expensiveAsk,
      takerSize: size,
      takerOrderId: undefined, // Will be set after order is placed
      
      // Maker will be set after taker fill
      makerSide: cheapSide,
      makerPrice: 0, // Will be calculated after fill
      makerSize: size,
      makerOrderId: undefined,
      
      status: 'PENDING_ENTRY',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      targetCpp: this.config.targetCpp,
    };
    
    // Store pair BEFORE placing order so onFill can find it
    this.pairs.set(pairId, pair);
    
    // 1. Place TAKER order on expensive side (market buy)
    try {
      const takerResult = await placeOrder({
        tokenId: takerTokenId,
        side: 'BUY',
        price: expensiveAsk + 0.01, // Slightly above ask for immediate fill
        size,
        orderType: 'GTC',
      });
      
      if (!takerResult.success || !takerResult.orderId) {
        console.log(`[PairTracker] ❌ Taker order failed: ${takerResult.error}`);
        // Remove the pair we pre-created
        this.pairs.delete(pairId);
        return { success: false, error: takerResult.error || 'taker_failed' };
      }
      
      // CRITICAL: Register order ID so user-ws recognizes fills as ours!
      registerOurOrderId(takerResult.orderId);
      
      // NOW set the takerOrderId on the pair (it already exists in the map)
      pair.takerOrderId = takerResult.orderId;
      pair.updatedAt = Date.now();
      
      console.log(`[PairTracker] ✓ Taker placed & registered: ${takerResult.orderId.slice(0, 8)}...`);
      
      // Log event
      logV35GuardEvent({
        marketSlug: market.slug,
        asset: market.asset,
        guardType: 'PAIR_OPENED',
        blockedSide: null,
        upQty: market.upQty,
        downQty: market.downQty,
        expensiveSide,
        reason: `Pair ${pairId}: ${size} shares TAKER placed, awaiting fill for MAKER`,
      }).catch(() => {});
      
      return { success: true, pairId };
      
    } catch (err: any) {
      console.error(`[PairTracker] Error opening pair:`, err?.message);
      // Remove the pair we pre-created
      this.pairs.delete(pairId);
      return { success: false, error: err?.message };
    }
  }
  
  /**
   * Handle a fill event - update pair status
   * 
   * V36.2: When taker fills, NOW place the maker limit order
   * Maker price = targetCpp - takerFillPrice
   */
  async onFill(fill: V35Fill, market: V35Market): Promise<{
    pairUpdated: boolean;
    pair?: PendingPair;
  }> {
    // Find matching pair
    for (const pair of this.pairs.values()) {
      if (pair.marketSlug !== market.slug) continue;
      
      // Check taker fill - V36.2.2: Match on orderId OR on side (for race condition)
      // The fill can arrive before openPair() sets the orderId, so we also match
      // on takerSide + PENDING_ENTRY status when orderId is not yet set
      const isTakerOrderIdMatch = pair.takerOrderId && pair.takerOrderId === fill.orderId;
      const isTakerSideMatch = !pair.takerOrderId && 
                                pair.status === 'PENDING_ENTRY' && 
                                pair.takerSide === fill.side &&
                                !pair.takerFilledAt; // Not already filled
      
      if ((isTakerOrderIdMatch || isTakerSideMatch) && pair.status === 'PENDING_ENTRY') {
        // If we matched on side, update the orderId now that we know it
        if (isTakerSideMatch && fill.orderId) {
          pair.takerOrderId = fill.orderId;
          console.log(`[PairTracker] 🔗 Linked fill orderId to pair: ${fill.orderId.slice(0, 8)}...`);
        }
        pair.takerFilledAt = Date.now();
        pair.takerFilledPrice = fill.price;
        pair.takerFilledSize = fill.size;
        pair.updatedAt = Date.now();
        
        console.log(`[PairTracker] 🎯 Taker FILLED: ${pair.id} | ${fill.size} ${pair.takerSide} @ $${fill.price.toFixed(3)}`);
        
        // V36.2: Calculate maker price based on ACTUAL fill price
        // makerPrice = targetCpp - takerFillPrice
        const makerPrice = this.config.targetCpp - fill.price;
        
        // Validate maker price (must be between 5¢ and 95¢)
        if (makerPrice < 0.05) {
          console.log(`[PairTracker] ⚠️ Maker price too low: $${makerPrice.toFixed(3)} - skipping`);
          pair.status = 'CANCELLED';
          return { pairUpdated: true, pair };
        }
        
        const clampedMakerPrice = Math.min(0.95, Math.max(0.05, makerPrice));
        
        console.log(`[PairTracker] 📝 Placing MAKER: ${pair.makerSide} @ $${clampedMakerPrice.toFixed(3)}`);
        console.log(`[PairTracker]    Calculation: $${this.config.targetCpp.toFixed(2)} - $${fill.price.toFixed(3)} = $${makerPrice.toFixed(3)}`);
        
        // Get token ID for maker
        const makerTokenId = pair.makerSide === 'UP' ? market.upTokenId : market.downTokenId;
        
        try {
          const makerResult = await placeOrder({
            tokenId: makerTokenId,
            side: 'BUY',
            price: clampedMakerPrice,
            size: fill.size, // Same size as filled taker
            orderType: 'GTC',
          });
          
          if (!makerResult.success || !makerResult.orderId) {
            console.log(`[PairTracker] ❌ Maker order failed: ${makerResult.error}`);
            pair.status = 'CANCELLED';
            return { pairUpdated: true, pair };
          }
          
          // CRITICAL: Register order ID so user-ws recognizes fills as ours!
          registerOurOrderId(makerResult.orderId);
          
          pair.makerOrderId = makerResult.orderId;
          pair.makerPrice = clampedMakerPrice;
          pair.status = 'WAITING_HEDGE';
          
          console.log(`[PairTracker] ✓ Maker placed & registered: ${makerResult.orderId.slice(0, 8)}...`);
          console.log(`[PairTracker]    Projected CPP: $${(fill.price + clampedMakerPrice).toFixed(3)}`);
          
          // V36.2.4: Log maker placement to database for visibility
          logV35GuardEvent({
            marketSlug: market.slug,
            asset: market.asset,
            guardType: 'MAKER_PLACED',
            blockedSide: null,
            upQty: market.upQty,
            downQty: market.downQty,
            expensiveSide: pair.takerSide,
            reason: `Pair ${pair.id}: MAKER ${pair.makerSide} @ $${clampedMakerPrice.toFixed(3)} placed (CPP target: $${(fill.price + clampedMakerPrice).toFixed(3)})`,
          }).catch(() => {});
          
          return { pairUpdated: true, pair };
          
        } catch (err: any) {
          console.error(`[PairTracker] Error placing maker:`, err?.message);
          pair.status = 'CANCELLED';
          return { pairUpdated: true, pair };
        }
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
      
      // CRITICAL: Register order ID so user-ws recognizes fills as ours!
      registerOurOrderId(result.orderId);
      
      pair.emergencyOrderId = result.orderId;
      pair.updatedAt = Date.now();
      
      console.log(`[PairTracker] ✓ Emergency order placed & registered: ${result.orderId.slice(0, 8)}...`);
      
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
   * V36.2: Check for stale pairs that need cleanup
   * 
   * PENDING_ENTRY pairs: If taker order didn't fill within 60s, 
   * the order probably failed/expired. Cancel the pair.
   * 
   * WAITING_HEDGE pairs: Maker order stays open indefinitely.
   * Only emergency hedge (Binance $30 reversal) can close them.
   */
  async checkTimeouts(_market: V35Market): Promise<void> {
    const now = Date.now();
    const PENDING_ENTRY_TIMEOUT_MS = 60_000; // 60 seconds for taker to fill
    
    for (const pair of this.pairs.values()) {
      // Check stale PENDING_ENTRY pairs (taker never filled)
      if (pair.status === 'PENDING_ENTRY') {
        const age = now - pair.createdAt;
        
        if (age > PENDING_ENTRY_TIMEOUT_MS) {
          console.log(`[PairTracker] 🗑️ Cleaning stale PENDING_ENTRY: ${pair.id} (age: ${Math.round(age / 1000)}s)`);
          console.log(`[PairTracker]    Taker order ${pair.takerOrderId?.slice(0, 8)}... never filled - cancelling pair`);
          
          // Try to cancel the taker order if it exists
          if (pair.takerOrderId) {
            try {
              await cancelOrder(pair.takerOrderId);
              console.log(`[PairTracker]    ✓ Cancelled stale taker order`);
            } catch (err) {
              // Order might already be expired/cancelled
              console.log(`[PairTracker]    ⚠️ Could not cancel (already expired?)`);
            }
          }
          
          pair.status = 'CANCELLED';
          pair.updatedAt = now;
        }
      }
      
      // WAITING_HEDGE pairs: No timeout - maker stays open until fill or emergency
      // This is intentional for V36.2
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
    this.marketStartTimes.clear();
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
