// ============================================================
// V27 LOGGER
// ============================================================
//
// Required logging (NON-NEGOTIABLE):
//
// For EVERY evaluation:
// - delta_abs, delta_pct, time_remaining
// - spot_ts, polymarket_ts
// - causality_pass (true/false + delta_ms)
// - aggressive_flow_metrics
// - spread_state
// - decision (ENTER / SKIP + reason)
//
// For EVERY trade:
// - entry_price, entry_time
// - correction_time
// - hedge_price (if any)
// - outcome
//
// ============================================================

import type { MispricingSignal } from './mispricing-detector.js';
import type { FilterResult } from './adverse-selection-filter.js';
import type { EntryDecision } from './entry-manager.js';
import type { HedgeDecision } from './hedge-manager.js';
import type { CorrectionStatus } from './correction-monitor.js';
import { saveV27Evaluation } from '../backend.js';

export interface V27EvaluationLog {
  // Identifiers
  id: string;
  timestamp: number;
  iso: string;
  runId?: string;
  
  // Market context
  marketId: string;
  asset: string;
  strikePrice: number;
  timeRemainingSeconds: number;
  
  // Delta metrics
  spotPrice: number;
  spotTs: number;
  deltaAbs: number;
  deltaPct: number;
  threshold: number;
  
  // Polymarket state
  upMid: number;
  downMid: number;
  polymarketTs: number;
  spreadUp: number;
  spreadDown: number;
  
  // Causality
  causalityPass: boolean;
  spotLeadMs: number;
  
  // Mispricing
  mispricingExists: boolean;
  mispricedSide: 'UP' | 'DOWN' | null;
  expectedPolyPrice: number;
  actualPolyPrice: number;
  priceLag: number;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  
  // Adverse selection
  filterPass: boolean;
  failedFilter?: string;
  aggressiveFlowMetrics: {
    largeTakerFillsLast8s: number;
    takerVolumeLast5s: number;
    p90Threshold: number;
    p85VolumeThreshold: number;
  };
  bookShapeMetrics: {
    mispricedSideDepth: number;
    oppositeSideDepth: number;
    asymmetryRatio: number;
  };
  spreadExpansionMetrics: {
    currentSpread: number;
    medianSpread: number;
    expansionRatio: number;
  };
  
  // Decision
  decision: 'ENTER' | 'SKIP';
  reason: string;
  
  // Order details (if entering)
  orderSide?: 'UP' | 'DOWN';
  orderPrice?: number;
  orderShares?: number;
}

export interface V27TradeLog {
  // Identifiers
  id: string;
  evaluationId: string;
  marketId: string;
  asset: string;
  runId?: string;
  
  // Entry
  entrySide: 'UP' | 'DOWN';
  entryPrice: number;
  entryShares: number;
  entryTime: number;
  entryIso: string;
  
  // Correction
  correctionConfirmed: boolean;
  correctionTime?: number;
  correctionIso?: string;
  correctionMoveTowardExpectedPct?: number;
  
  // Hedge
  hedged: boolean;
  hedgeSide?: 'UP' | 'DOWN';
  hedgePrice?: number;
  hedgeShares?: number;
  hedgeTime?: number;
  hedgeIso?: string;
  hedgeReason?: string;
  
  // Outcome
  settled: boolean;
  settledAt?: number;
  settledIso?: string;
  winningOutcome?: 'UP' | 'DOWN';
  entryWon?: boolean;
  hedgeWon?: boolean;
  pnl?: number;
  pnlPct?: number;
  
  // Final state
  totalCost: number;
  totalPayout?: number;
}

export class V27Logger {
  private evaluationLogs: V27EvaluationLog[] = [];
  private tradeLogs: Map<string, V27TradeLog> = new Map();
  private runId?: string;
  
  // Supabase client for persistence
  private supabase?: any;
  
  constructor(runId?: string, supabase?: any) {
    this.runId = runId;
    this.supabase = supabase;
  }
  
  /**
   * Log an evaluation
   */
  async logEvaluation(
    marketId: string,
    asset: string,
    strikePrice: number,
    spotPrice: number,
    spotTs: number,
    book: { upMid: number; downMid: number; spreadUp: number; spreadDown: number; timestamp: number },
    timeRemainingSeconds: number,
    mispricing: MispricingSignal,
    filter: FilterResult,
    entry: EntryDecision
  ): Promise<V27EvaluationLog> {
    const now = Date.now();
    const log: V27EvaluationLog = {
      id: `v27_eval_${now}_${Math.random().toString(36).slice(2, 8)}`,
      timestamp: now,
      iso: new Date(now).toISOString(),
      runId: this.runId,
      
      marketId,
      asset,
      strikePrice,
      timeRemainingSeconds,
      
      spotPrice,
      spotTs,
      deltaAbs: mispricing.deltaAbs,
      deltaPct: mispricing.deltaPct,
      threshold: mispricing.threshold,
      
      upMid: book.upMid,
      downMid: book.downMid,
      polymarketTs: book.timestamp,
      spreadUp: book.spreadUp,
      spreadDown: book.spreadDown,
      
      causalityPass: mispricing.causalityPass,
      spotLeadMs: mispricing.spotLeadMs,
      
      mispricingExists: mispricing.exists,
      mispricedSide: mispricing.side,
      expectedPolyPrice: mispricing.expectedPolyPrice,
      actualPolyPrice: mispricing.actualPolyPrice,
      priceLag: mispricing.priceLag,
      confidence: mispricing.confidence,
      
      filterPass: filter.pass,
      failedFilter: filter.failedFilter,
      aggressiveFlowMetrics: filter.details.aggressiveFlow,
      bookShapeMetrics: filter.details.bookShape,
      spreadExpansionMetrics: filter.details.spreadExpansion,
      
      decision: entry.shouldEnter ? 'ENTER' : 'SKIP',
      reason: entry.shouldEnter ? 'MISPRICING_DETECTED' : (entry.reason || 'UNKNOWN'),
      
      orderSide: entry.side,
      orderPrice: entry.price,
      orderShares: entry.shares,
    };
    
    this.evaluationLogs.push(log);
    
    // Keep last 10000 evaluations in memory
    if (this.evaluationLogs.length > 10000) {
      this.evaluationLogs.shift();
    }
    
    // Persist to database (prefer direct client; fallback via runner-proxy)
    try {
      if (this.supabase) {
        const { error } = await this.supabase.from('v27_evaluations').insert(insertData);
        if (error) {
          console.error('[V27] DB insert error:', error.message, error.details);
        }
      } else {
        const ok = await saveV27Evaluation(insertData);
        if (!ok) {
          console.warn('[V27] Failed to persist evaluation via runner-proxy');
        }
      }
    } catch (err) {
      console.error('[V27] Failed to persist evaluation:', err);
    }
    
    // Console log for real-time visibility
    const emoji = log.decision === 'ENTER' ? '🎯' : '⏭️';
    console.log(
      `[V27] ${emoji} ${log.asset} | strike=${log.strikePrice} spot=${log.spotPrice.toFixed(2)} delta=${log.deltaAbs.toFixed(2)} | ` +
      `mispricing=${log.mispricingExists} | filter=${log.filterPass} | ${log.decision}: ${log.reason || 'OK'}`
    );
    
    return log;
  }
  
  /**
   * Create a trade log entry
   */
  createTradeLog(
    evaluationId: string,
    marketId: string,
    asset: string,
    entrySide: 'UP' | 'DOWN',
    entryPrice: number,
    entryShares: number
  ): V27TradeLog {
    const now = Date.now();
    const log: V27TradeLog = {
      id: `v27_trade_${now}_${Math.random().toString(36).slice(2, 8)}`,
      evaluationId,
      marketId,
      asset,
      runId: this.runId,
      
      entrySide,
      entryPrice,
      entryShares,
      entryTime: now,
      entryIso: new Date(now).toISOString(),
      
      correctionConfirmed: false,
      hedged: false,
      settled: false,
      
      totalCost: entryPrice * entryShares,
    };
    
    this.tradeLogs.set(log.id, log);
    
    console.log(`[V27] 📈 TRADE OPENED: ${asset} ${entrySide} ${entryShares}@${entryPrice.toFixed(3)}`);
    
    return log;
  }
  
  /**
   * Update trade with correction
   */
  updateCorrection(tradeId: string, correction: CorrectionStatus): void {
    const log = this.tradeLogs.get(tradeId);
    if (!log) return;
    
    log.correctionConfirmed = correction.correctionConfirmed;
    log.correctionTime = Date.now();
    log.correctionIso = new Date().toISOString();
    log.correctionMoveTowardExpectedPct = correction.moveTowardExpectedPct;
    
    if (correction.correctionConfirmed) {
      console.log(`[V27] ✅ CORRECTION: ${log.asset} moved ${(correction.moveTowardExpectedPct * 100).toFixed(1)}% toward expected`);
    }
  }
  
  /**
   * Update trade with hedge
   */
  updateHedge(tradeId: string, hedge: HedgeDecision): void {
    const log = this.tradeLogs.get(tradeId);
    if (!log || !hedge.shouldHedge) return;
    
    log.hedged = true;
    log.hedgeSide = hedge.side;
    log.hedgePrice = hedge.price;
    log.hedgeShares = hedge.shares;
    log.hedgeTime = Date.now();
    log.hedgeIso = new Date().toISOString();
    
    if (hedge.price && hedge.shares) {
      log.totalCost += hedge.price * hedge.shares;
    }
    
    console.log(`[V27] 🔒 HEDGED: ${log.asset} ${hedge.side} ${hedge.shares}@${hedge.price?.toFixed(3)}`);
  }
  
  /**
   * Update trade with settlement
   */
  async updateSettlement(
    tradeId: string,
    winningOutcome: 'UP' | 'DOWN'
  ): Promise<void> {
    const log = this.tradeLogs.get(tradeId);
    if (!log) return;
    
    log.settled = true;
    log.settledAt = Date.now();
    log.settledIso = new Date().toISOString();
    log.winningOutcome = winningOutcome;
    log.entryWon = log.entrySide === winningOutcome;
    log.hedgeWon = log.hedged ? log.hedgeSide === winningOutcome : undefined;
    
    // Calculate PnL
    let payout = 0;
    if (log.entryWon) {
      payout += log.entryShares; // $1 per share
    }
    if (log.hedged && log.hedgeWon && log.hedgeShares) {
      payout += log.hedgeShares;
    }
    
    log.totalPayout = payout;
    log.pnl = payout - log.totalCost;
    log.pnlPct = log.totalCost > 0 ? (log.pnl / log.totalCost) * 100 : 0;
    
    const emoji = log.pnl >= 0 ? '💰' : '💸';
    console.log(
      `[V27] ${emoji} SETTLED: ${log.asset} | ` +
      `winner=${winningOutcome} | ` +
      `PnL=$${log.pnl.toFixed(2)} (${log.pnlPct.toFixed(1)}%)`
    );
    
    // Persist final state
    if (this.supabase) {
      try {
        await this.supabase.from('v27_trades').upsert({
          id: log.id,
          evaluation_id: log.evaluationId,
          market_id: log.marketId,
          asset: log.asset,
          run_id: log.runId,
          entry_side: log.entrySide,
          entry_price: log.entryPrice,
          entry_shares: log.entryShares,
          entry_time: log.entryTime,
          entry_iso: log.entryIso,
          correction_confirmed: log.correctionConfirmed,
          correction_time: log.correctionTime,
          correction_iso: log.correctionIso,
          correction_move_pct: log.correctionMoveTowardExpectedPct,
          hedged: log.hedged,
          hedge_side: log.hedgeSide,
          hedge_price: log.hedgePrice,
          hedge_shares: log.hedgeShares,
          hedge_time: log.hedgeTime,
          hedge_iso: log.hedgeIso,
          settled: log.settled,
          settled_at: log.settledAt,
          settled_iso: log.settledIso,
          winning_outcome: log.winningOutcome,
          entry_won: log.entryWon,
          hedge_won: log.hedgeWon,
          total_cost: log.totalCost,
          total_payout: log.totalPayout,
          pnl: log.pnl,
          pnl_pct: log.pnlPct,
        });
      } catch (err) {
        console.error('[V27] Failed to persist trade:', err);
      }
    }
  }
  
  /**
   * Get recent evaluations
   */
  getRecentEvaluations(limit: number = 100): V27EvaluationLog[] {
    return this.evaluationLogs.slice(-limit);
  }
  
  /**
   * Get all trades
   */
  getAllTrades(): V27TradeLog[] {
    return Array.from(this.tradeLogs.values());
  }
  
  /**
   * Get stats
   */
  getStats(): {
    totalEvaluations: number;
    mispricingsDetected: number;
    entriesDecided: number;
    tradesOpened: number;
    tradesSettled: number;
    totalPnl: number;
    winRate: number;
  } {
    const trades = this.getAllTrades();
    const settledTrades = trades.filter(t => t.settled);
    const wins = settledTrades.filter(t => (t.pnl || 0) > 0);
    
    return {
      totalEvaluations: this.evaluationLogs.length,
      mispricingsDetected: this.evaluationLogs.filter(e => e.mispricingExists).length,
      entriesDecided: this.evaluationLogs.filter(e => e.decision === 'ENTER').length,
      tradesOpened: trades.length,
      tradesSettled: settledTrades.length,
      totalPnl: settledTrades.reduce((sum, t) => sum + (t.pnl || 0), 0),
      winRate: settledTrades.length > 0 ? wins.length / settledTrades.length : 0,
    };
  }
}
