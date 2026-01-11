// ============================================================
// V27 SHADOW POSITION MANAGER
// ============================================================
//
// This module manages the full lifecycle of shadow positions:
// 1. Opens positions when ENTRY signals fire
// 2. Simulates entry execution (maker/taker)
// 3. Monitors for hedge opportunities
// 4. Tracks expiry and resolution
// 5. Maintains accounting (equity curve, daily PnL)
//
// CRITICAL: This is ADDITIVE to the existing shadow engine.
// It consumes signals but does NOT modify signal detection logic.
//
// ============================================================

import { v4 as uuid } from 'uuid';
import type { ShadowEvaluation } from './shadow-engine.js';
import type { V27OrderBook, V27Market } from './index.js';
import { getV27Config } from './config.js';

// ============================================================
// TYPES
// ============================================================

export type PositionResolution = 
  | 'OPEN'
  | 'PAIRED_HEDGED'
  | 'EXPIRED_ONE_SIDED'
  | 'EMERGENCY_EXITED'
  | 'NO_FILL';

export type FillType = 'MAKER' | 'TAKER';
export type FillConfidence = 'HIGH' | 'MEDIUM' | 'LOW';

export interface ShadowPosition {
  // Identifiers
  id: string;
  marketId: string;
  asset: string;
  runId: string;
  
  // Entry details
  side: 'UP' | 'DOWN';
  entryTimestamp: number;
  entryIso: string;
  
  // Entry price model
  entryPriceModel: {
    bestBidAtSignal: number;
    bestAskAtSignal: number;
    assumedFillType: FillType;
    simulatedEntryPrice: number;
    spreadAtEntry: number;
  };
  
  // Size
  sizeUsd: number;
  sizeShares: number;
  
  // Signal reference
  signalReferenceId: string;
  evaluationId: string;
  
  // Market context at entry
  timeToExpiryAtEntry: number;
  spotPriceAtEntry: number;
  strikePriceAtEntry: number;
  theoreticalPriceAtEntry: number;
  deltaAtEntry: number;
  adverseFilterStateAtEntry: string;
  
  // Hedge tracking
  hedgeAttempts: HedgeAttempt[];
  hedgeCompleted: boolean;
  hedgeTimestamp: number | null;
  hedgePrice: number | null;
  hedgeFillType: FillType | null;
  hedgeLatencyMs: number | null;
  
  // Resolution
  resolution: PositionResolution;
  resolutionTimestamp: number | null;
  resolutionReason: string | null;
  
  // P&L
  entryNotional: number;
  hedgeNotional: number | null;
  realizedPnl: number | null;
  fees: number;
  roi: number | null;
  
  // Expiry
  expiryTimestamp: number;
  marketExpired: boolean;
}

export interface HedgeAttempt {
  id: string;
  positionId: string;
  timestamp: number;
  side: 'UP' | 'DOWN';
  price: number;
  spread: number;
  fillType: FillType;
  wouldExecute: boolean;
  projectedCpp: number;
  reason: string;
  success: boolean;
}

export interface ShadowExecution {
  id: string;
  positionId: string;
  timestamp: number;
  side: 'UP' | 'DOWN';
  executionType: 'ENTRY' | 'HEDGE' | 'EMERGENCY';
  price: number;
  shares: number;
  notional: number;
  fillType: FillType;
  fillConfidence: FillConfidence;
  fillLatencyAssumedMs: number;
  spread: number;
  slippage: number;
}

export interface ShadowAccounting {
  id: string;
  timestamp: number;
  equity: number;
  realizedPnl: number;
  unrealizedPnl: number;
  openPositions: number;
  closedPositions: number;
  dailyPnl: number;
  drawdown: number;
  maxDrawdown: number;
  peakEquity: number;
  winCount: number;
  lossCount: number;
}

export interface ShadowDailyPnl {
  date: string;
  trades: number;
  wins: number;
  losses: number;
  pnl: number;
  fees: number;
  cumulativePnl: number;
  volumeTraded: number;
}

// ============================================================
// CONFIG
// ============================================================

interface PositionManagerConfig {
  startingEquity: number;
  defaultSizeUsd: number;
  minSpreadForMaker: number;
  emergencyHedgeSeconds: number;
  maxSpreadEmergency: number;
  hedgeMispricingThreshold: number; // % mispricing correction needed
  makerFeeRate: number;
  takerFeeRate: number;
}

const DEFAULT_CONFIG: PositionManagerConfig = {
  startingEquity: 3000,
  defaultSizeUsd: 50,
  minSpreadForMaker: 0.02, // 2 cents
  emergencyHedgeSeconds: 60, // 1 minute before expiry
  maxSpreadEmergency: 0.08, // 8 cents max spread for emergency hedge
  hedgeMispricingThreshold: 0.5, // 50% of mispricing must correct
  makerFeeRate: -0.0005, // -0.05% rebate
  takerFeeRate: 0.002, // 0.2% fee
};

// ============================================================
// SHADOW POSITION MANAGER
// ============================================================

export class ShadowPositionManager {
  private runId: string;
  private supabase: any;
  private config: PositionManagerConfig;
  
  // Active positions
  private positions: Map<string, ShadowPosition> = new Map();
  
  // Executions log
  private executions: ShadowExecution[] = [];
  
  // Accounting state
  private equity: number;
  private peakEquity: number;
  private maxDrawdown: number = 0;
  private realizedPnl: number = 0;
  private winCount: number = 0;
  private lossCount: number = 0;
  
  // Daily tracking
  private dailyPnl: Map<string, ShadowDailyPnl> = new Map();
  
  // Equity curve
  private equityCurve: { ts: number; equity: number; drawdown: number }[] = [];
  
  // Stats
  private stats = {
    positionsOpened: 0,
    positionsHedged: 0,
    positionsExpired: 0,
    positionsEmergency: 0,
    positionsNoFill: 0,
    hedgeAttempts: 0,
    hedgeSuccesses: 0,
    totalFees: 0,
    dbWriteErrors: 0,
  };
  
  constructor(runId: string, supabase: any, config?: Partial<PositionManagerConfig>) {
    this.runId = runId;
    this.supabase = supabase;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.equity = this.config.startingEquity;
    this.peakEquity = this.equity;
    
    // Record initial equity
    this.recordEquitySnapshot();
  }
  
  // ============================================================
  // POSITION OPENING
  // ============================================================
  
  /**
   * Open a shadow position from an ENTRY signal
   * Called when shadowSignal.signalType === 'ENTRY' && signalValid === true
   */
  async openPosition(
    evaluation: ShadowEvaluation,
    market: V27Market,
    book: V27OrderBook
  ): Promise<ShadowPosition | null> {
    // Only open on valid ENTRY signals
    if (evaluation.signalType !== 'ENTRY' || !evaluation.hypoSide) {
      return null;
    }
    
    const now = Date.now();
    const positionId = uuid();
    
    // Determine entry execution
    const side = evaluation.hypoSide;
    const bestBid = side === 'UP' ? book.upBid : book.downBid;
    const bestAsk = side === 'UP' ? book.upAsk : book.downAsk;
    const spread = bestAsk - bestBid;
    
    // Determine fill type
    // If spread is tight OR adverse filter is near-trigger, assume TAKER
    const adverseNearTrigger = evaluation.toxicityClass === 'POSSIBLY_INFORMED';
    const spreadTooTight = spread < this.config.minSpreadForMaker;
    const assumedFillType: FillType = (spreadTooTight || adverseNearTrigger) ? 'TAKER' : 'MAKER';
    
    // Simulated entry price
    let simulatedEntryPrice: number;
    if (assumedFillType === 'TAKER') {
      simulatedEntryPrice = bestAsk; // Cross the spread
    } else {
      simulatedEntryPrice = Math.max(bestBid + 0.01, bestAsk - 0.01); // Best bid + 1 tick
    }
    
    // Size calculation
    const sizeUsd = this.config.defaultSizeUsd;
    const sizeShares = sizeUsd / simulatedEntryPrice;
    const entryNotional = sizeShares * simulatedEntryPrice;
    
    // Calculate fees
    const feeRate = assumedFillType === 'MAKER' ? this.config.makerFeeRate : this.config.takerFeeRate;
    const entryFee = entryNotional * Math.abs(feeRate);
    
    // Fill confidence based on depth and spread
    const depth = side === 'UP' ? book.upDepthAsk : book.downDepthAsk;
    let fillConfidence: FillConfidence = 'HIGH';
    if (depth < sizeShares) {
      fillConfidence = 'LOW';
    } else if (spread > 0.05) {
      fillConfidence = 'MEDIUM';
    }
    
    const position: ShadowPosition = {
      id: positionId,
      marketId: market.id,
      asset: market.asset,
      runId: this.runId,
      
      side,
      entryTimestamp: now,
      entryIso: new Date(now).toISOString(),
      
      entryPriceModel: {
        bestBidAtSignal: bestBid,
        bestAskAtSignal: bestAsk,
        assumedFillType,
        simulatedEntryPrice,
        spreadAtEntry: spread,
      },
      
      sizeUsd,
      sizeShares,
      
      signalReferenceId: evaluation.trackingId || evaluation.id,
      evaluationId: evaluation.id,
      
      timeToExpiryAtEntry: evaluation.timeRemainingSeconds,
      spotPriceAtEntry: evaluation.spotPrice,
      strikePriceAtEntry: market.strikePrice,
      theoreticalPriceAtEntry: side === 'UP' ? evaluation.expectedUpPrice : evaluation.expectedDownPrice,
      deltaAtEntry: evaluation.deltaAbs,
      adverseFilterStateAtEntry: evaluation.toxicityClass,
      
      hedgeAttempts: [],
      hedgeCompleted: false,
      hedgeTimestamp: null,
      hedgePrice: null,
      hedgeFillType: null,
      hedgeLatencyMs: null,
      
      resolution: 'OPEN',
      resolutionTimestamp: null,
      resolutionReason: null,
      
      entryNotional,
      hedgeNotional: null,
      realizedPnl: null,
      fees: entryFee,
      roi: null,
      
      expiryTimestamp: market.eventEndTime.getTime(),
      marketExpired: false,
    };
    
    // Store position
    this.positions.set(positionId, position);
    this.stats.positionsOpened++;
    
    // Record entry execution
    const execution: ShadowExecution = {
      id: uuid(),
      positionId,
      timestamp: now,
      side,
      executionType: 'ENTRY',
      price: simulatedEntryPrice,
      shares: sizeShares,
      notional: entryNotional,
      fillType: assumedFillType,
      fillConfidence,
      fillLatencyAssumedMs: assumedFillType === 'TAKER' ? 50 : 500, // Taker fills faster
      spread,
      slippage: assumedFillType === 'TAKER' ? spread / 2 : 0,
    };
    this.executions.push(execution);
    
    // Persist to database
    await this.persistPosition(position);
    await this.persistExecution(execution);
    
    console.log(
      `[SHADOW-POS] 📈 OPENED: ${market.asset} ${side} @ ${simulatedEntryPrice.toFixed(3)} | ` +
      `${sizeShares.toFixed(1)} shares | ${assumedFillType} | ${fillConfidence} conf`
    );
    
    return position;
  }
  
  // ============================================================
  // HEDGE EVALUATION
  // ============================================================
  
  /**
   * Evaluate hedge opportunity for all open positions
   * Called every tick with current orderbook
   */
  async evaluateHedges(
    marketId: string,
    book: V27OrderBook,
    currentSpot: number,
    strikePrice: number
  ): Promise<void> {
    const now = Date.now();
    
    for (const position of this.positions.values()) {
      if (position.marketId !== marketId) continue;
      if (position.resolution !== 'OPEN') continue;
      
      const timeToExpiry = (position.expiryTimestamp - now) / 1000;
      
      // Check for emergency hedge
      if (timeToExpiry <= this.config.emergencyHedgeSeconds) {
        await this.attemptEmergencyHedge(position, book, timeToExpiry);
        continue;
      }
      
      // Check for regular hedge trigger
      const shouldHedge = this.checkHedgeTrigger(position, book, currentSpot, strikePrice);
      
      if (shouldHedge) {
        await this.attemptHedge(position, book, 'MISPRICING_CORRECTED');
      }
    }
  }
  
  /**
   * Check if hedge should be triggered
   */
  private checkHedgeTrigger(
    position: ShadowPosition,
    book: V27OrderBook,
    currentSpot: number,
    strikePrice: number
  ): boolean {
    // Calculate current mispricing
    const spotDelta = currentSpot - strikePrice;
    const currentDeltaPct = Math.abs(spotDelta) / strikePrice;
    
    // Original delta at entry
    const originalDeltaPct = position.deltaAtEntry / strikePrice;
    
    // Check if mispricing has corrected enough
    if (originalDeltaPct > 0 && currentDeltaPct <= originalDeltaPct * (1 - this.config.hedgeMispricingThreshold)) {
      return true;
    }
    
    // Check if theoretical price converged
    const oppositeSide = position.side === 'UP' ? 'DOWN' : 'UP';
    const oppositeMid = oppositeSide === 'UP' ? book.upMid : book.downMid;
    const combinedPrice = position.entryPriceModel.simulatedEntryPrice + oppositeMid;
    
    // Hedge if CPP would be profitable
    if (combinedPrice < 0.98) { // 2% buffer for fees
      return true;
    }
    
    return false;
  }
  
  /**
   * Attempt a regular hedge
   */
  private async attemptHedge(
    position: ShadowPosition,
    book: V27OrderBook,
    reason: string
  ): Promise<boolean> {
    const now = Date.now();
    const hedgeSide: 'UP' | 'DOWN' = position.side === 'UP' ? 'DOWN' : 'UP';
    
    const bestBid = hedgeSide === 'UP' ? book.upBid : book.downBid;
    const bestAsk = hedgeSide === 'UP' ? book.upAsk : book.downAsk;
    const spread = bestAsk - bestBid;
    
    // Determine fill type for hedge (prefer maker)
    const assumedFillType: FillType = spread >= this.config.minSpreadForMaker ? 'MAKER' : 'TAKER';
    
    let hedgePrice: number;
    if (assumedFillType === 'TAKER') {
      hedgePrice = bestAsk;
    } else {
      hedgePrice = Math.min(bestBid + 0.01, bestAsk - 0.005);
    }
    
    // Calculate projected CPP
    const projectedCpp = position.entryPriceModel.simulatedEntryPrice + hedgePrice;
    const wouldExecute = projectedCpp < 1.00;
    
    // Record hedge attempt
    const attempt: HedgeAttempt = {
      id: uuid(),
      positionId: position.id,
      timestamp: now,
      side: hedgeSide,
      price: hedgePrice,
      spread,
      fillType: assumedFillType,
      wouldExecute,
      projectedCpp,
      reason,
      success: wouldExecute,
    };
    
    position.hedgeAttempts.push(attempt);
    this.stats.hedgeAttempts++;
    
    await this.persistHedgeAttempt(attempt);
    
    if (wouldExecute) {
      return await this.executeHedge(position, hedgeSide, hedgePrice, spread, assumedFillType);
    }
    
    return false;
  }
  
  /**
   * Attempt emergency hedge near expiry
   */
  private async attemptEmergencyHedge(
    position: ShadowPosition,
    book: V27OrderBook,
    timeToExpiry: number
  ): Promise<boolean> {
    const hedgeSide: 'UP' | 'DOWN' = position.side === 'UP' ? 'DOWN' : 'UP';
    
    const bestBid = hedgeSide === 'UP' ? book.upBid : book.downBid;
    const bestAsk = hedgeSide === 'UP' ? book.upAsk : book.downAsk;
    const spread = bestAsk - bestBid;
    
    // Check if spread is acceptable for emergency
    if (spread > this.config.maxSpreadEmergency) {
      // Too expensive to hedge - will expire one-sided
      console.log(
        `[SHADOW-POS] ⚠️ EMERGENCY SKIP: ${position.asset} spread ${spread.toFixed(3)} > max ${this.config.maxSpreadEmergency}`
      );
      return false;
    }
    
    // Emergency = always taker, cross the spread
    const hedgePrice = bestAsk;
    const projectedCpp = position.entryPriceModel.simulatedEntryPrice + hedgePrice;
    
    // Record attempt
    const attempt: HedgeAttempt = {
      id: uuid(),
      positionId: position.id,
      timestamp: Date.now(),
      side: hedgeSide,
      price: hedgePrice,
      spread,
      fillType: 'TAKER',
      wouldExecute: true,
      projectedCpp,
      reason: `EMERGENCY_${Math.floor(timeToExpiry)}s`,
      success: true,
    };
    
    position.hedgeAttempts.push(attempt);
    this.stats.hedgeAttempts++;
    
    await this.persistHedgeAttempt(attempt);
    
    return await this.executeHedge(position, hedgeSide, hedgePrice, spread, 'TAKER', true);
  }
  
  /**
   * Execute the hedge and close position
   */
  private async executeHedge(
    position: ShadowPosition,
    hedgeSide: 'UP' | 'DOWN',
    hedgePrice: number,
    spread: number,
    fillType: FillType,
    isEmergency: boolean = false
  ): Promise<boolean> {
    const now = Date.now();
    
    // Calculate hedge notional
    const hedgeNotional = position.sizeShares * hedgePrice;
    
    // Calculate fees
    const feeRate = fillType === 'MAKER' ? this.config.makerFeeRate : this.config.takerFeeRate;
    const hedgeFee = hedgeNotional * Math.abs(feeRate);
    const totalFees = position.fees + hedgeFee;
    
    // Calculate P&L
    // For paired position: payout = 1.00 per share (guaranteed)
    // Cost = entry + hedge
    // PnL = payout - cost - fees
    const totalCost = position.entryPriceModel.simulatedEntryPrice + hedgePrice;
    const grossPnl = (1.00 - totalCost) * position.sizeShares;
    const netPnl = grossPnl - totalFees;
    
    // Update position
    position.hedgeCompleted = true;
    position.hedgeTimestamp = now;
    position.hedgePrice = hedgePrice;
    position.hedgeFillType = fillType;
    position.hedgeLatencyMs = now - position.entryTimestamp;
    position.hedgeNotional = hedgeNotional;
    position.realizedPnl = netPnl;
    position.fees = totalFees;
    position.roi = netPnl / position.entryNotional;
    position.resolution = isEmergency ? 'EMERGENCY_EXITED' : 'PAIRED_HEDGED';
    position.resolutionTimestamp = now;
    position.resolutionReason = isEmergency ? 'Emergency hedge near expiry' : 'Mispricing corrected';
    
    // Record execution
    const execution: ShadowExecution = {
      id: uuid(),
      positionId: position.id,
      timestamp: now,
      side: hedgeSide,
      executionType: isEmergency ? 'EMERGENCY' : 'HEDGE',
      price: hedgePrice,
      shares: position.sizeShares,
      notional: hedgeNotional,
      fillType,
      fillConfidence: fillType === 'TAKER' ? 'HIGH' : 'MEDIUM',
      fillLatencyAssumedMs: fillType === 'TAKER' ? 50 : 500,
      spread,
      slippage: fillType === 'TAKER' ? spread / 2 : 0,
    };
    this.executions.push(execution);
    
    // Update accounting
    this.realizedPnl += netPnl;
    this.equity += netPnl;
    this.stats.totalFees += totalFees;
    
    if (netPnl >= 0) {
      this.winCount++;
    } else {
      this.lossCount++;
    }
    
    if (isEmergency) {
      this.stats.positionsEmergency++;
    } else {
      this.stats.positionsHedged++;
      this.stats.hedgeSuccesses++;
    }
    
    // Record equity and daily PnL
    this.recordEquitySnapshot();
    this.recordDailyPnl(netPnl, totalFees, position.entryNotional + hedgeNotional);
    
    // Persist
    await this.persistPosition(position);
    await this.persistExecution(execution);
    await this.persistAccounting();
    
    console.log(
      `[SHADOW-POS] ✅ ${isEmergency ? 'EMERGENCY' : 'HEDGED'}: ${position.asset} | ` +
      `CPP=${(position.entryPriceModel.simulatedEntryPrice + hedgePrice).toFixed(3)} | ` +
      `PnL=$${netPnl.toFixed(2)} | ${position.hedgeLatencyMs}ms latency`
    );
    
    return true;
  }
  
  // ============================================================
  // EXPIRY HANDLING
  // ============================================================
  
  /**
   * Process expired markets - resolve any open positions
   */
  async processExpiry(marketId: string, outcome: 'UP' | 'DOWN'): Promise<void> {
    const now = Date.now();
    
    for (const position of this.positions.values()) {
      if (position.marketId !== marketId) continue;
      if (position.resolution !== 'OPEN') continue;
      
      // Position expired without hedge
      position.marketExpired = true;
      position.resolution = 'EXPIRED_ONE_SIDED';
      position.resolutionTimestamp = now;
      
      // Calculate P&L based on outcome
      // If we held the winning side, we get $1 per share
      // If we held the losing side, we get $0
      const wonBet = position.side === outcome;
      const payout = wonBet ? position.sizeShares : 0;
      const cost = position.entryNotional;
      const grossPnl = payout - cost;
      const netPnl = grossPnl - position.fees;
      
      position.realizedPnl = netPnl;
      position.roi = netPnl / position.entryNotional;
      position.resolutionReason = wonBet 
        ? 'Expired one-sided (won)' 
        : 'Expired one-sided (lost)';
      
      // Update accounting
      this.realizedPnl += netPnl;
      this.equity += netPnl;
      this.stats.positionsExpired++;
      
      if (netPnl >= 0) {
        this.winCount++;
      } else {
        this.lossCount++;
      }
      
      this.recordEquitySnapshot();
      this.recordDailyPnl(netPnl, position.fees, position.entryNotional);
      
      await this.persistPosition(position);
      await this.persistAccounting();
      
      console.log(
        `[SHADOW-POS] 🏁 EXPIRED: ${position.asset} ${position.side} | ` +
        `Outcome=${outcome} | Won=${wonBet} | PnL=$${netPnl.toFixed(2)}`
      );
    }
  }
  
  // ============================================================
  // ACCOUNTING
  // ============================================================
  
  private recordEquitySnapshot(): void {
    const now = Date.now();
    
    // Calculate drawdown
    if (this.equity > this.peakEquity) {
      this.peakEquity = this.equity;
    }
    const drawdown = (this.peakEquity - this.equity) / this.peakEquity;
    if (drawdown > this.maxDrawdown) {
      this.maxDrawdown = drawdown;
    }
    
    this.equityCurve.push({
      ts: now,
      equity: this.equity,
      drawdown,
    });
    
    // Keep last 10000 points
    if (this.equityCurve.length > 10000) {
      this.equityCurve.shift();
    }
  }
  
  private recordDailyPnl(pnl: number, fees: number, volume: number): void {
    const date = new Date().toISOString().slice(0, 10);
    
    let daily = this.dailyPnl.get(date);
    if (!daily) {
      daily = {
        date,
        trades: 0,
        wins: 0,
        losses: 0,
        pnl: 0,
        fees: 0,
        cumulativePnl: this.realizedPnl - pnl, // Before this trade
        volumeTraded: 0,
      };
      this.dailyPnl.set(date, daily);
    }
    
    daily.trades++;
    daily.pnl += pnl;
    daily.fees += fees;
    daily.volumeTraded += volume;
    daily.cumulativePnl = this.realizedPnl;
    
    if (pnl >= 0) {
      daily.wins++;
    } else {
      daily.losses++;
    }
  }
  
  // ============================================================
  // GETTERS
  // ============================================================
  
  getOpenPositions(): ShadowPosition[] {
    return Array.from(this.positions.values()).filter(p => p.resolution === 'OPEN');
  }
  
  getAllPositions(): ShadowPosition[] {
    return Array.from(this.positions.values());
  }
  
  getPositionsByMarket(marketId: string): ShadowPosition[] {
    return Array.from(this.positions.values()).filter(p => p.marketId === marketId);
  }
  
  getEquity(): number {
    return this.equity;
  }
  
  getEquityCurve(): { ts: number; equity: number; drawdown: number }[] {
    return this.equityCurve;
  }
  
  getDailyPnl(): ShadowDailyPnl[] {
    return Array.from(this.dailyPnl.values()).sort((a, b) => a.date.localeCompare(b.date));
  }
  
  getStats() {
    return {
      ...this.stats,
      equity: this.equity,
      realizedPnl: this.realizedPnl,
      maxDrawdown: this.maxDrawdown,
      peakEquity: this.peakEquity,
      winCount: this.winCount,
      lossCount: this.lossCount,
      winRate: this.winCount + this.lossCount > 0 
        ? this.winCount / (this.winCount + this.lossCount) 
        : 0,
      openPositions: this.getOpenPositions().length,
      totalPositions: this.positions.size,
      hedgeSuccessRate: this.stats.hedgeAttempts > 0 
        ? this.stats.hedgeSuccesses / this.stats.hedgeAttempts 
        : 0,
    };
  }
  
  // ============================================================
  // PERSISTENCE
  // ============================================================
  
  private async persistPosition(position: ShadowPosition): Promise<void> {
    if (!this.supabase) return;
    
    try {
      const { error } = await this.supabase.from('shadow_positions').upsert({
        id: position.id,
        market_id: position.marketId,
        asset: position.asset,
        run_id: position.runId,
        side: position.side,
        entry_timestamp: position.entryTimestamp,
        entry_iso: position.entryIso,
        entry_price_model: position.entryPriceModel,
        size_usd: position.sizeUsd,
        size_shares: position.sizeShares,
        signal_reference_id: position.signalReferenceId,
        evaluation_id: position.evaluationId,
        time_to_expiry_at_entry: position.timeToExpiryAtEntry,
        spot_price_at_entry: position.spotPriceAtEntry,
        strike_price_at_entry: position.strikePriceAtEntry,
        theoretical_price_at_entry: position.theoreticalPriceAtEntry,
        delta_at_entry: position.deltaAtEntry,
        adverse_filter_state_at_entry: position.adverseFilterStateAtEntry,
        hedge_completed: position.hedgeCompleted,
        hedge_timestamp: position.hedgeTimestamp,
        hedge_price: position.hedgePrice,
        hedge_fill_type: position.hedgeFillType,
        hedge_latency_ms: position.hedgeLatencyMs,
        resolution: position.resolution,
        resolution_timestamp: position.resolutionTimestamp,
        resolution_reason: position.resolutionReason,
        entry_notional: position.entryNotional,
        hedge_notional: position.hedgeNotional,
        realized_pnl: position.realizedPnl,
        fees: position.fees,
        roi: position.roi,
        expiry_timestamp: position.expiryTimestamp,
        market_expired: position.marketExpired,
      });
      
      if (error) {
        console.error('[SHADOW-POS] Position persist error:', error.message);
        this.stats.dbWriteErrors++;
      }
    } catch (err) {
      console.error('[SHADOW-POS] Position persist failed:', err);
      this.stats.dbWriteErrors++;
    }
  }
  
  private async persistExecution(execution: ShadowExecution): Promise<void> {
    if (!this.supabase) return;
    
    try {
      const { error } = await this.supabase.from('shadow_executions').insert({
        id: execution.id,
        position_id: execution.positionId,
        timestamp: execution.timestamp,
        side: execution.side,
        execution_type: execution.executionType,
        price: execution.price,
        shares: execution.shares,
        notional: execution.notional,
        fill_type: execution.fillType,
        fill_confidence: execution.fillConfidence,
        fill_latency_assumed_ms: execution.fillLatencyAssumedMs,
        spread: execution.spread,
        slippage: execution.slippage,
      });
      
      if (error) {
        console.error('[SHADOW-POS] Execution persist error:', error.message);
        this.stats.dbWriteErrors++;
      }
    } catch (err) {
      console.error('[SHADOW-POS] Execution persist failed:', err);
      this.stats.dbWriteErrors++;
    }
  }
  
  private async persistHedgeAttempt(attempt: HedgeAttempt): Promise<void> {
    if (!this.supabase) return;
    
    try {
      const { error } = await this.supabase.from('shadow_hedge_attempts').insert({
        id: attempt.id,
        position_id: attempt.positionId,
        timestamp: attempt.timestamp,
        side: attempt.side,
        price: attempt.price,
        spread: attempt.spread,
        fill_type: attempt.fillType,
        would_execute: attempt.wouldExecute,
        projected_cpp: attempt.projectedCpp,
        reason: attempt.reason,
        success: attempt.success,
      });
      
      if (error) {
        console.error('[SHADOW-POS] Hedge attempt persist error:', error.message);
        this.stats.dbWriteErrors++;
      }
    } catch (err) {
      console.error('[SHADOW-POS] Hedge attempt persist failed:', err);
      this.stats.dbWriteErrors++;
    }
  }
  
  private async persistAccounting(): Promise<void> {
    if (!this.supabase) return;
    
    try {
      const now = Date.now();
      const drawdown = (this.peakEquity - this.equity) / this.peakEquity;
      
      // Calculate unrealized PnL from open positions
      let unrealizedPnl = 0;
      for (const pos of this.getOpenPositions()) {
        // Approximate: assume 50% chance of winning
        unrealizedPnl += -pos.fees; // At least we've paid fees
      }
      
      // Get today's PnL
      const today = new Date().toISOString().slice(0, 10);
      const dailyPnlRecord = this.dailyPnl.get(today);
      
      const { error } = await this.supabase.from('shadow_accounting').insert({
        id: uuid(),
        run_id: this.runId,
        timestamp: now,
        equity: this.equity,
        realized_pnl: this.realizedPnl,
        unrealized_pnl: unrealizedPnl,
        open_positions: this.getOpenPositions().length,
        closed_positions: this.positions.size - this.getOpenPositions().length,
        daily_pnl: dailyPnlRecord?.pnl ?? 0,
        drawdown,
        max_drawdown: this.maxDrawdown,
        peak_equity: this.peakEquity,
        win_count: this.winCount,
        loss_count: this.lossCount,
      });
      
      if (error) {
        console.error('[SHADOW-POS] Accounting persist error:', error.message);
        this.stats.dbWriteErrors++;
      }
      
      // Also persist daily PnL
      if (dailyPnlRecord) {
        await this.persistDailyPnl(dailyPnlRecord);
      }
    } catch (err) {
      console.error('[SHADOW-POS] Accounting persist failed:', err);
      this.stats.dbWriteErrors++;
    }
  }
  
  private async persistDailyPnl(daily: ShadowDailyPnl): Promise<void> {
    if (!this.supabase) return;
    
    try {
      const { error } = await this.supabase.from('shadow_daily_pnl').upsert({
        id: `${this.runId}_${daily.date}`,
        run_id: this.runId,
        date: daily.date,
        trades: daily.trades,
        wins: daily.wins,
        losses: daily.losses,
        pnl: daily.pnl,
        fees: daily.fees,
        cumulative_pnl: daily.cumulativePnl,
        volume_traded: daily.volumeTraded,
      });
      
      if (error && !error.message.includes('duplicate key')) {
        console.error('[SHADOW-POS] Daily PnL persist error:', error.message);
      }
    } catch (err) {
      // Non-critical
    }
  }
  
  // ============================================================
  // STATS PRINTING
  // ============================================================
  
  printStats(): void {
    const s = this.getStats();
    console.log('');
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║  💰 SHADOW POSITION MANAGER STATS                             ║');
    console.log('╠══════════════════════════════════════════════════════════════╣');
    console.log(`║  Equity:               $${s.equity.toFixed(2).padEnd(38)}║`);
    console.log(`║  Realized PnL:         $${s.realizedPnl.toFixed(2).padEnd(38)}║`);
    console.log(`║  Max Drawdown:         ${(s.maxDrawdown * 100).toFixed(2)}%${' '.repeat(36)}║`);
    console.log('║                                                               ║');
    console.log(`║  Positions Opened:     ${s.positionsOpened.toString().padEnd(40)}║`);
    console.log(`║  ├─ Hedged:            ${s.positionsHedged.toString().padEnd(40)}║`);
    console.log(`║  ├─ Emergency:         ${s.positionsEmergency.toString().padEnd(40)}║`);
    console.log(`║  └─ Expired:           ${s.positionsExpired.toString().padEnd(40)}║`);
    console.log('║                                                               ║');
    console.log(`║  Win Rate:             ${(s.winRate * 100).toFixed(1)}% (${s.winCount}W / ${s.lossCount}L)${' '.repeat(26)}║`);
    console.log(`║  Hedge Success Rate:   ${(s.hedgeSuccessRate * 100).toFixed(1)}%${' '.repeat(36)}║`);
    console.log(`║  Total Fees:           $${s.totalFees.toFixed(2).padEnd(38)}║`);
    console.log('╚══════════════════════════════════════════════════════════════╝');
    console.log('');
  }
}
