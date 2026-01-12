// ============================================================
// V27 ENTRY MANAGER
// ============================================================
//
// If mispricing exists AND all filters pass:
// - Buy ONLY the mispriced side
// - Order type: passive LIMIT
// - Price: best_bid + 1 tick (never cross)
// - Size: fixed small probe (e.g. 5–10 shares)
//
// No scaling. No averaging down.
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
    
    // Already have position in this market
    const positionKey = `${marketId}:${mispricing.side}`;
    if (this.activePositions.has(positionKey)) {
      return {
        shouldEnter: false,
        reason: 'ALREADY_POSITIONED',
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
    
    // Calculate entry price
    const bestBid = mispricing.side === 'UP' ? book.upBid : book.downBid;
    const bestAsk = mispricing.side === 'UP' ? book.upAsk : book.downAsk;
    const spread = bestAsk - bestBid;
    
    // If spread is tight (≤2 ticks), buy at the ask (taker)
    // Otherwise place passive limit at bid + 1 tick
    let entryPrice: number;
    if (spread <= config.tickSize * 2) {
      // Tight spread - take the ask for guaranteed fill
      entryPrice = bestAsk;
    } else {
      // Wide spread - place passive limit
      entryPrice = bestBid + config.tickSize;
      
      // Don't cross the spread
      if (entryPrice >= bestAsk) {
        return {
          shouldEnter: false,
          reason: 'WOULD_CROSS_SPREAD',
          mispricingSignal: mispricing,
          filterResult: filter,
        };
      }
    }
    
    // Check notional limit
    const shares = assetConfig?.probeShares || 5;
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
   * Record an entry
   */
  recordEntry(
    marketId: string,
    asset: string,
    side: 'UP' | 'DOWN',
    shares: number,
    avgPrice: number
  ): void {
    const positionKey = `${marketId}:${side}`;
    
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
    return position;
  }
  
  /**
   * Get position count
   */
  getPositionCount(): number {
    return this.activePositions.size;
  }
}
