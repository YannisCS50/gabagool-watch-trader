// ============================================================
// V27 ENTRY MANAGER
// ============================================================
//
// If mispricing exists AND all filters pass:
// - Buy ONLY the mispriced side
// - Market order (take the ask)
// - Size: fixed small probe (e.g. 5 shares)
// - MAX 1 entry per market per side (no scaling, no averaging)
//
// ============================================================

import { getV27Config, getAssetConfig } from './config.js';
import type { V27OrderBook, V27Position } from './index.js';
import type { MispricingSignal } from './mispricing-detector.js';
import type { FilterResult } from './adverse-selection-filter.js';

export interface EntryDecision {
  shouldEnter: boolean;
  
  // Order details (if shouldEnter)
  side?: 'UP' | 'DOWN';
  price?: number;
  shares?: number;
  tokenId?: string;
  
  // Reason if not entering
  reason?: string;
  
  // Diagnostics
  mispricingSignal: MispricingSignal;
  filterResult: FilterResult;
}

export class EntryManager {
  // Track active positions to prevent duplicate entries
  private activePositions: Map<string, V27Position> = new Map();
  
  // Track pending orders (prevents duplicate orders while waiting for fill)
  private pendingOrders: Map<string, number> = new Map(); // key -> timestamp
  
  // Cooldown period after placing an order (prevent spam)
  private static readonly ORDER_COOLDOWN_MS = 5000; // 5 seconds between orders per market
  
  // Max shares per position
  private static readonly MAX_SHARES_PER_POSITION = 5;
  
  /**
   * Decide whether to enter a trade
   */
  decide(
    marketId: string,
    asset: string,
    book: V27OrderBook,
    upTokenId: string,
    downTokenId: string,
    mispricing: MispricingSignal,
    filter: FilterResult
  ): EntryDecision {
    const config = getV27Config();
    const assetConfig = getAssetConfig(asset);
    
    // Shadow mode - never actually enter
    if (config.shadowMode) {
      return {
        shouldEnter: false,
        reason: 'SHADOW_MODE',
        mispricingSignal: mispricing,
        filterResult: filter,
      };
    }
    
    // No mispricing detected
    if (!mispricing.exists || !mispricing.side) {
      return {
        shouldEnter: false,
        reason: mispricing.reason || 'NO_MISPRICING',
        mispricingSignal: mispricing,
        filterResult: filter,
      };
    }
    
    // Filter failed
    if (!filter.pass) {
      return {
        shouldEnter: false,
        reason: filter.failedFilter || 'FILTER_FAILED',
        mispricingSignal: mispricing,
        filterResult: filter,
      };
    }
    
    const positionKey = `${marketId}:${mispricing.side}`;
    
    // Already have position in this market+side
    if (this.activePositions.has(positionKey)) {
      return {
        shouldEnter: false,
        reason: 'ALREADY_POSITIONED',
        mispricingSignal: mispricing,
        filterResult: filter,
      };
    }
    
    // Check for pending order (cooldown)
    const pendingTs = this.pendingOrders.get(positionKey);
    if (pendingTs && Date.now() - pendingTs < EntryManager.ORDER_COOLDOWN_MS) {
      return {
        shouldEnter: false,
        reason: 'ORDER_PENDING',
        mispricingSignal: mispricing,
        filterResult: filter,
      };
    }
    
    // Only enter on HIGH or MEDIUM confidence
    if (mispricing.confidence === 'LOW') {
      return {
        shouldEnter: false,
        reason: 'LOW_CONFIDENCE',
        mispricingSignal: mispricing,
        filterResult: filter,
      };
    }
    
    // Entry price: take the ask (market order for guaranteed fill)
    const bestAsk = mispricing.side === 'UP' ? book.upAsk : book.downAsk;
    const entryPrice = bestAsk;
    
    // Check notional limit
    const shares = Math.min(
      assetConfig?.probeShares || 5,
      EntryManager.MAX_SHARES_PER_POSITION
    );
    const notional = shares * entryPrice;
    const maxNotional = assetConfig?.maxProbeNotional || 5;
    
    if (notional > maxNotional) {
      return {
        shouldEnter: false,
        reason: 'EXCEEDS_MAX_NOTIONAL',
        mispricingSignal: mispricing,
        filterResult: filter,
      };
    }
    
    const tokenId = mispricing.side === 'UP' ? upTokenId : downTokenId;
    
    // Mark order as pending BEFORE returning (prevents race condition)
    this.pendingOrders.set(positionKey, Date.now());
    
    return {
      shouldEnter: true,
      side: mispricing.side,
      price: entryPrice,
      shares,
      tokenId,
      mispricingSignal: mispricing,
      filterResult: filter,
    };
  }
  
  /**
   * Record an entry (call after order is filled)
   */
  recordEntry(
    marketId: string,
    asset: string,
    side: 'UP' | 'DOWN',
    shares: number,
    avgPrice: number
  ): void {
    const positionKey = `${marketId}:${side}`;
    
    // Clear pending order
    this.pendingOrders.delete(positionKey);
    
    this.activePositions.set(positionKey, {
      marketId,
      asset,
      side,
      shares,
      avgPrice,
      entryTime: Date.now(),
      correctionConfirmed: false,
      hedged: false,
    });
  }
  
  /**
   * Clear pending order (call on order failure)
   */
  clearPendingOrder(marketId: string, side: 'UP' | 'DOWN'): void {
    this.pendingOrders.delete(`${marketId}:${side}`);
  }
  
  /**
   * Get position for a market
   */
  getPosition(marketId: string, side: 'UP' | 'DOWN'): V27Position | undefined {
    return this.activePositions.get(`${marketId}:${side}`);
  }
  
  /**
   * Get all active positions
   */
  getAllPositions(): V27Position[] {
    return Array.from(this.activePositions.values());
  }
  
  /**
   * Mark correction as confirmed
   */
  confirmCorrection(marketId: string, side: 'UP' | 'DOWN'): void {
    const position = this.activePositions.get(`${marketId}:${side}`);
    if (position) {
      position.correctionConfirmed = true;
    }
  }
  
  /**
   * Mark as hedged
   */
  recordHedge(
    marketId: string,
    side: 'UP' | 'DOWN',
    hedgeShares: number,
    hedgeAvgPrice: number
  ): void {
    const position = this.activePositions.get(`${marketId}:${side}`);
    if (position) {
      position.hedged = true;
      position.hedgeShares = hedgeShares;
      position.hedgeAvgPrice = hedgeAvgPrice;
    }
  }
  
  /**
   * Close position (on expiry)
   */
  closePosition(marketId: string, side: 'UP' | 'DOWN'): V27Position | undefined {
    const key = `${marketId}:${side}`;
    const position = this.activePositions.get(key);
    this.activePositions.delete(key);
    this.pendingOrders.delete(key); // Clean up pending too
    return position;
  }
  
  /**
   * Get position count
   */
  getPositionCount(): number {
    return this.activePositions.size;
  }
}
