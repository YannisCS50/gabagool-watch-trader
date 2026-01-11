// ============================================================
// V27 CORRECTION MONITOR
// ============================================================
//
// Monitor for correction:
// - Polymarket mid moves ≥ X% toward expected value
// - OR UP price increases by learned snap-back magnitude
//
// During this phase:
// - NO hedging
// - NO adding
// - NO selling
//
// ============================================================

import { getV27Config } from './config.js';
import type { V27OrderBook, V27Position } from './index.js';
import type { MispricingSignal } from './mispricing-detector.js';

export interface CorrectionStatus {
  positionKey: string;
  marketId: string;
  side: 'UP' | 'DOWN';
  
  // Entry state
  entryPrice: number;
  entryMid: number;
  expectedMid: number;
  
  // Current state
  currentMid: number;
  moveTowardExpected: number;
  moveTowardExpectedPct: number;
  
  // Status
  correctionConfirmed: boolean;
  timeInPositionMs: number;
  
  // Thresholds
  thresholdPct: number;
}

export class CorrectionMonitor {
  // Track entry state for each position
  private entryState: Map<string, {
    entryMid: number;
    expectedMid: number;
    entryTime: number;
  }> = new Map();
  
  /**
   * Start monitoring a position
   */
  startMonitoring(
    position: V27Position,
    mispricing: MispricingSignal,
    currentMid: number
  ): void {
    const key = `${position.marketId}:${position.side}`;
    
    this.entryState.set(key, {
      entryMid: currentMid,
      expectedMid: mispricing.expectedPolyPrice,
      entryTime: Date.now(),
    });
  }
  
  /**
   * Check if correction has occurred
   */
  checkCorrection(
    position: V27Position,
    book: V27OrderBook
  ): CorrectionStatus {
    const config = getV27Config();
    const key = `${position.marketId}:${position.side}`;
    const state = this.entryState.get(key);
    
    if (!state) {
      // No entry state - shouldn't happen
      return {
        positionKey: key,
        marketId: position.marketId,
        side: position.side,
        entryPrice: position.avgPrice,
        entryMid: 0.5,
        expectedMid: 0.5,
        currentMid: 0.5,
        moveTowardExpected: 0,
        moveTowardExpectedPct: 0,
        correctionConfirmed: false,
        timeInPositionMs: 0,
        thresholdPct: config.correctionThresholdPct,
      };
    }
    
    // Get current mid for our side
    const currentMid = position.side === 'UP' ? book.upMid : book.downMid;
    
    // Calculate move toward expected
    const distanceAtEntry = Math.abs(state.expectedMid - state.entryMid);
    const distanceNow = Math.abs(state.expectedMid - currentMid);
    
    // Positive move = price moved toward expected
    const moveTowardExpected = distanceAtEntry - distanceNow;
    const moveTowardExpectedPct = distanceAtEntry > 0 
      ? moveTowardExpected / distanceAtEntry 
      : 0;
    
    // Check if correction confirmed
    // Either: moved X% toward expected OR current price is at/past expected
    const correctionConfirmed = 
      moveTowardExpectedPct >= config.correctionThresholdPct ||
      distanceNow < 0.01; // Within 1 cent of expected
    
    const timeInPositionMs = Date.now() - state.entryTime;
    
    return {
      positionKey: key,
      marketId: position.marketId,
      side: position.side,
      entryPrice: position.avgPrice,
      entryMid: state.entryMid,
      expectedMid: state.expectedMid,
      currentMid,
      moveTowardExpected,
      moveTowardExpectedPct,
      correctionConfirmed,
      timeInPositionMs,
      thresholdPct: config.correctionThresholdPct,
    };
  }
  
  /**
   * Stop monitoring a position
   */
  stopMonitoring(marketId: string, side: 'UP' | 'DOWN'): void {
    this.entryState.delete(`${marketId}:${side}`);
  }
  
  /**
   * Get all monitored positions
   */
  getMonitoredPositions(): string[] {
    return Array.from(this.entryState.keys());
  }
}
