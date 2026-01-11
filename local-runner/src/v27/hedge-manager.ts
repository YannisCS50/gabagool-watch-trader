// ============================================================
// V27 HEDGE MANAGER
// ============================================================
//
// Only attempt hedge IF:
// - Correction confirmed
// - Spread < normal_threshold
// - Book depth healthy
//
// Hedge type:
// - Passive LIMIT on opposite side
// - Objective: lock bounded outcome, not perfection
//
// EMERGENCY LOGIC (time_remaining < 90s):
// - If spread > max_spread_emergency → DO NOT hedge
// - Accept one-sided expiry if hedge cost is pathological
//
// ============================================================

import { getV27Config, getAssetConfig } from './config.js';
import type { V27OrderBook, V27Position } from './index.js';

export interface HedgeDecision {
  shouldHedge: boolean;
  
  // Order details (if shouldHedge)
  side?: 'UP' | 'DOWN';
  price?: number;
  shares?: number;
  tokenId?: string;
  
  // Reason if not hedging
  reason?: string;
  
  // State
  isEmergency: boolean;
  correctionConfirmed: boolean;
  spreadOk: boolean;
  depthOk: boolean;
  
  // Metrics
  currentSpread: number;
  spreadThreshold: number;
  oppositeDepth: number;
}

export class HedgeManager {
  /**
   * Decide whether to hedge a position
   */
  decide(
    position: V27Position,
    book: V27OrderBook,
    upTokenId: string,
    downTokenId: string,
    timeRemainingSeconds: number
  ): HedgeDecision {
    const config = getV27Config();
    const assetConfig = getAssetConfig(position.asset);
    
    if (!assetConfig) {
      return this.noHedge('UNKNOWN_ASSET', position, book, false);
    }
    
    // Already hedged
    if (position.hedged) {
      return this.noHedge('ALREADY_HEDGED', position, book, false);
    }
    
    // Determine hedge side (opposite of position)
    const hedgeSide: 'UP' | 'DOWN' = position.side === 'UP' ? 'DOWN' : 'UP';
    
    // Check if we're in emergency window
    const isEmergency = timeRemainingSeconds < config.emergencyWindowSec;
    
    // Get spread for hedge side
    const hedgeSpread = hedgeSide === 'UP' ? book.spreadUp : book.spreadDown;
    
    // Emergency logic: stricter spread threshold
    if (isEmergency) {
      if (hedgeSpread > assetConfig.maxSpreadEmergency) {
        return {
          shouldHedge: false,
          reason: 'EMERGENCY_SPREAD_TOO_WIDE',
          isEmergency: true,
          correctionConfirmed: position.correctionConfirmed,
          spreadOk: false,
          depthOk: true,
          currentSpread: hedgeSpread,
          spreadThreshold: assetConfig.maxSpreadEmergency,
          oppositeDepth: hedgeSide === 'UP' ? book.upDepthAsk : book.downDepthAsk,
        };
      }
    }
    
    // Normal logic: check correction first
    if (!position.correctionConfirmed && !isEmergency) {
      return this.noHedge('CORRECTION_NOT_CONFIRMED', position, book, isEmergency);
    }
    
    // Check spread
    const spreadThreshold = isEmergency 
      ? assetConfig.maxSpreadEmergency 
      : assetConfig.normalSpreadThreshold;
    
    if (hedgeSpread > spreadThreshold) {
      return {
        shouldHedge: false,
        reason: 'SPREAD_TOO_WIDE',
        isEmergency,
        correctionConfirmed: position.correctionConfirmed,
        spreadOk: false,
        depthOk: true,
        currentSpread: hedgeSpread,
        spreadThreshold,
        oppositeDepth: hedgeSide === 'UP' ? book.upDepthAsk : book.downDepthAsk,
      };
    }
    
    // Check depth on hedge side
    const hedgeDepth = hedgeSide === 'UP' ? book.upDepthAsk : book.downDepthAsk;
    const minDepth = position.shares * 2; // Need at least 2x our position size
    
    if (hedgeDepth < minDepth) {
      return {
        shouldHedge: false,
        reason: 'INSUFFICIENT_DEPTH',
        isEmergency,
        correctionConfirmed: position.correctionConfirmed,
        spreadOk: true,
        depthOk: false,
        currentSpread: hedgeSpread,
        spreadThreshold,
        oppositeDepth: hedgeDepth,
      };
    }
    
    // Calculate hedge price: best_bid + 1 tick (passive)
    const bestBid = hedgeSide === 'UP' ? book.upBid : book.downBid;
    const bestAsk = hedgeSide === 'UP' ? book.upAsk : book.downAsk;
    const hedgePrice = bestBid + config.tickSize;
    
    // Don't cross spread
    if (hedgePrice >= bestAsk) {
      return {
        shouldHedge: false,
        reason: 'WOULD_CROSS_SPREAD',
        isEmergency,
        correctionConfirmed: position.correctionConfirmed,
        spreadOk: true,
        depthOk: true,
        currentSpread: hedgeSpread,
        spreadThreshold,
        oppositeDepth: hedgeDepth,
      };
    }
    
    // In emergency, we might need to be more aggressive
    // But per spec, we still use passive limits
    const tokenId = hedgeSide === 'UP' ? upTokenId : downTokenId;
    
    return {
      shouldHedge: true,
      side: hedgeSide,
      price: hedgePrice,
      shares: position.shares, // Match position size
      tokenId,
      isEmergency,
      correctionConfirmed: position.correctionConfirmed,
      spreadOk: true,
      depthOk: true,
      currentSpread: hedgeSpread,
      spreadThreshold,
      oppositeDepth: hedgeDepth,
    };
  }
  
  /**
   * Calculate bounded PnL for hedged position
   */
  calculateBoundedPnl(
    position: V27Position
  ): { minPnl: number; maxPnl: number; expectedPnl: number } {
    if (!position.hedged || !position.hedgeShares || !position.hedgeAvgPrice) {
      // Unhedged - binary outcome
      const cost = position.shares * position.avgPrice;
      return {
        minPnl: -cost, // Total loss
        maxPnl: position.shares - cost, // Full win
        expectedPnl: (position.shares / 2) - cost, // 50/50
      };
    }
    
    // Hedged position
    const entryCost = position.shares * position.avgPrice;
    const hedgeCost = position.hedgeShares * position.hedgeAvgPrice;
    const totalCost = entryCost + hedgeCost;
    
    // One side wins, one loses
    // If entry side wins: get $1 per share on entry
    // If hedge side wins: get $1 per share on hedge
    
    const winOnEntry = position.shares - totalCost;
    const winOnHedge = position.hedgeShares - totalCost;
    
    return {
      minPnl: Math.min(winOnEntry, winOnHedge),
      maxPnl: Math.max(winOnEntry, winOnHedge),
      expectedPnl: (winOnEntry + winOnHedge) / 2,
    };
  }
  
  private noHedge(
    reason: string,
    position: V27Position,
    book: V27OrderBook,
    isEmergency: boolean
  ): HedgeDecision {
    const assetConfig = getAssetConfig(position.asset);
    const hedgeSide = position.side === 'UP' ? 'DOWN' : 'UP';
    const hedgeSpread = hedgeSide === 'UP' ? book.spreadUp : book.spreadDown;
    
    return {
      shouldHedge: false,
      reason,
      isEmergency,
      correctionConfirmed: position.correctionConfirmed,
      spreadOk: hedgeSpread <= (assetConfig?.normalSpreadThreshold || 0.04),
      depthOk: true,
      currentSpread: hedgeSpread,
      spreadThreshold: assetConfig?.normalSpreadThreshold || 0.04,
      oppositeDepth: hedgeSide === 'UP' ? book.upDepthAsk : book.downDepthAsk,
    };
  }
}
