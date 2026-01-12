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

interface PaperTrade {
  id: string;
  evaluationId: string;
  asset: string;
  side: 'UP' | 'DOWN';
  entryPrice: number;
  shares: number;
  cost: number;
  expectedWinProb: number;
  expectedPnL: number;
  timestamp: number;
  timeRemaining: number;
  settled: boolean;
  actualOutcome?: 'UP' | 'DOWN';
  actualPnL?: number;
}

export class V27Logger {
  private evaluationLogs: V27EvaluationLog[] = [];
  private tradeLogs: Map<string, V27TradeLog> = new Map();
  private paperTrades: PaperTrade[] = [];
  private runId?: string;
  
  // Supabase client for persistence
  private supabase?: any;
  
  constructor(runId?: string, supabase?: any) {
    this.runId = runId;
    this.supabase = supabase;
  }
  
  /**
   * Log an evaluation with paper trade simulation
   */
  async logEvaluation(
    marketId: string,
    asset: string,
    strikePrice: number,
    spotPrice: number,
    spotTs: number,
    book: { upMid: number; downMid: number; upAsk: number; downAsk: number; upBid: number; downBid: number; spreadUp: number; spreadDown: number; timestamp: number },
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
    
    // Calculate time remaining in human format
    const mins = Math.floor(timeRemainingSeconds / 60);
    const secs = Math.floor(timeRemainingSeconds % 60);
    const timeStr = `${mins}m${secs}s`;
    
    // Get appropriate decimals for asset
    const decimals = this.getDecimals(asset);
    const deltaStr = Math.abs(mispricing.deltaAbs).toFixed(decimals);
    const spotStr = spotPrice.toFixed(decimals);
    const strikeStr = strikePrice.toFixed(decimals);
    
    // Determine direction indicator
    const direction = mispricing.deltaAbs > 0 ? '📈' : mispricing.deltaAbs < 0 ? '📉' : '➖';
    
    // Build detailed log
    const insertData = {
      id: log.id,
      ts: log.timestamp,
      run_id: log.runId,
      market_id: log.marketId,
      asset: log.asset,
      spot_price: log.spotPrice,
      pm_up_ask: book.upAsk,
      pm_up_bid: book.upBid,
      pm_down_ask: book.downAsk,
      pm_down_bid: book.downBid,
      delta_up: mispricing.side === 'UP' ? mispricing.deltaAbs : 0,
      delta_down: mispricing.side === 'DOWN' ? mispricing.deltaAbs : 0,
      theoretical_up: mispricing.expectedPolyPrice,
      theoretical_down: 1 - mispricing.expectedPolyPrice,
      base_threshold: log.threshold,
      dynamic_threshold: log.threshold,
      threshold_source: 'config',
      signal_valid: log.mispricingExists && log.filterPass,
      adverse_blocked: !log.filterPass,
      adverse_reason: log.failedFilter || null,
      causality_passed: log.causalityPass,
      spot_leading_ms: log.spotLeadMs,
      book_imbalance: 0,
      taker_flow_p90: log.aggressiveFlowMetrics.p90Threshold,
      spread_expansion: log.spreadExpansionMetrics.expansionRatio,
      action: log.decision,
      skip_reason: log.decision === 'SKIP' ? log.reason : null,
      mispricing_magnitude: log.priceLag,
      mispricing_side: log.mispricedSide,
    };

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
    
    // ====================================================================
    // ENHANCED CONSOLE LOGGING with Paper Trade Simulation
    // ====================================================================
    const divider = '─'.repeat(70);
    
    // Only log detailed output for potential signals or every 50th evaluation
    const shouldLogDetailed = log.mispricingExists || this.evaluationLogs.length % 50 === 0;
    
    if (shouldLogDetailed) {
      console.log('');
      console.log(divider);
      console.log(`[V27] ${direction} ${asset} EVALUATION @ ${new Date(now).toISOString()}`);
      console.log(divider);
      
      // Market Info
      console.log(`  📊 MARKET: ${marketId}`);
      console.log(`     ├─ Time Remaining: ${timeStr} (${timeRemainingSeconds.toFixed(0)}s)`);
      console.log(`     ├─ Strike Price:   $${strikeStr}`);
      console.log(`     └─ Spot Price:     $${spotStr}`);
      
      // Delta Analysis
      const deltaDirection = mispricing.deltaAbs > 0 ? 'ABOVE' : 'BELOW';
      console.log(`  📐 DELTA: ${deltaDirection} strike by $${deltaStr} (${(mispricing.deltaPct * 100).toFixed(3)}%)`);
      console.log(`     ├─ Threshold: $${mispricing.threshold.toFixed(decimals)}`);
      console.log(`     └─ Exceeds:   ${Math.abs(mispricing.deltaAbs) > mispricing.threshold ? '✅ YES' : '❌ NO'}`);
      
      // Polymarket Orderbook
      console.log(`  📈 POLYMARKET ORDERBOOK:`);
      console.log(`     ├─ UP:   Bid $${book.upBid.toFixed(2)} | Ask $${book.upAsk.toFixed(2)} | Spread ${(book.spreadUp * 100).toFixed(1)}%`);
      console.log(`     └─ DOWN: Bid $${book.downBid.toFixed(2)} | Ask $${book.downAsk.toFixed(2)} | Spread ${(book.spreadDown * 100).toFixed(1)}%`);
      
      // Empirical Pricing
      if (log.mispricingExists) {
        console.log(`  💰 MISPRICING DETECTED on ${log.mispricedSide}:`);
        console.log(`     ├─ Expected Price: $${log.expectedPolyPrice.toFixed(3)}`);
        console.log(`     ├─ Actual Ask:     $${log.actualPolyPrice.toFixed(3)}`);
        console.log(`     ├─ Edge:           ${(log.priceLag * 100).toFixed(1)}% underpriced`);
        console.log(`     └─ Confidence:     ${log.confidence}`);
      } else {
        console.log(`  ❌ NO MISPRICING: ${mispricing.reason || 'Market fairly priced'}`);
      }
      
      // Causality Check
      console.log(`  ⏱️  CAUSALITY: ${log.causalityPass ? '✅ PASS' : '❌ FAIL'} (spot leads by ${log.spotLeadMs}ms)`);
      
      // Adverse Selection Filter
      console.log(`  🛡️ ADVERSE FILTER: ${log.filterPass ? '✅ PASS' : '❌ BLOCKED'}`);
      if (!log.filterPass && log.failedFilter) {
        console.log(`     └─ Reason: ${log.failedFilter}`);
      }
      
      // Decision
      console.log(divider);
      if (log.decision === 'ENTER' && entry.shouldEnter) {
        console.log(`  🎯 DECISION: BUY ${entry.shares} ${entry.side} @ $${entry.price?.toFixed(3)}`);
        console.log(`     ├─ Notional:     $${((entry.shares || 0) * (entry.price || 0)).toFixed(2)}`);
        console.log(`     └─ Expected Win: ${(log.expectedPolyPrice * 100).toFixed(0)}% probability`);
        
        // PAPER TRADE SIMULATION
        this.logPaperTrade(asset, entry.side!, entry.price!, entry.shares!, log.expectedPolyPrice, timeRemainingSeconds, log.id);
      } else {
        console.log(`  ⏭️  DECISION: SKIP - ${log.reason}`);
      }
      console.log(divider);
      console.log('');
    } else {
      // Brief log for non-signal evaluations
      const brief = `[V27] ${direction} ${asset} t-${timeStr} | δ=$${deltaStr} | UP:${book.upAsk.toFixed(2)} DOWN:${book.downAsk.toFixed(2)} | ${log.decision}`;
      console.log(brief);
    }
    
    return log;
  }
  
  /**
   * Get appropriate decimal places for asset
   */
  private getDecimals(asset: string): number {
    const decimalsMap: Record<string, number> = {
      BTC: 2,
      ETH: 2,
      SOL: 4,
      XRP: 6,
    };
    return decimalsMap[asset] || 2;
  }
  
  /**
   * Log a paper trade simulation
   */
  private logPaperTrade(
    asset: string,
    side: 'UP' | 'DOWN',
    price: number,
    shares: number,
    expectedWinProb: number,
    timeRemaining: number,
    evaluationId: string
  ): void {
    const now = Date.now();
    const cost = price * shares;
    const expectedPayout = expectedWinProb * shares;
    const expectedPnL = expectedPayout - cost;
    const expectedROI = (expectedPnL / cost) * 100;
    
    console.log('');
    console.log('  📝 PAPER TRADE SIMULATION:');
    console.log('  ┌────────────────────────────────────────────────────────┐');
    console.log(`  │ Asset: ${asset.padEnd(6)} │ Side: ${side.padEnd(4)} │ Time Left: ${Math.floor(timeRemaining)}s    │`);
    console.log('  ├────────────────────────────────────────────────────────┤');
    console.log(`  │ Entry Price:      $${price.toFixed(3).padStart(8)}                       │`);
    console.log(`  │ Shares:           ${shares.toString().padStart(8)}                       │`);
    console.log(`  │ Cost:             $${cost.toFixed(2).padStart(8)}                       │`);
    console.log('  ├────────────────────────────────────────────────────────┤');
    console.log(`  │ Win Probability:  ${(expectedWinProb * 100).toFixed(1).padStart(7)}%                       │`);
    console.log(`  │ Expected Payout:  $${expectedPayout.toFixed(2).padStart(8)}                       │`);
    console.log(`  │ Expected PnL:     ${expectedPnL >= 0 ? '+' : ''}$${expectedPnL.toFixed(2).padStart(7)}                       │`);
    console.log(`  │ Expected ROI:     ${expectedROI >= 0 ? '+' : ''}${expectedROI.toFixed(1).padStart(7)}%                       │`);
    console.log('  └────────────────────────────────────────────────────────┘');
    
    // Track paper trades in memory
    this.paperTrades.push({
      id: `paper_${now}_${Math.random().toString(36).slice(2, 6)}`,
      evaluationId,
      asset,
      side,
      entryPrice: price,
      shares,
      cost,
      expectedWinProb,
      expectedPnL,
      timestamp: now,
      timeRemaining,
      settled: false,
    });
    
    // Keep only last 500 paper trades
    if (this.paperTrades.length > 500) {
      this.paperTrades.shift();
    }
  }
  
  /**
   * Get paper trade stats
   */
  getPaperTradeStats(): {
    totalTrades: number;
    totalCost: number;
    expectedTotalPnL: number;
    avgExpectedROI: number;
    byAsset: Record<string, { count: number; cost: number; expectedPnL: number }>;
  } {
    const byAsset: Record<string, { count: number; cost: number; expectedPnL: number }> = {};
    
    for (const trade of this.paperTrades) {
      if (!byAsset[trade.asset]) {
        byAsset[trade.asset] = { count: 0, cost: 0, expectedPnL: 0 };
      }
      byAsset[trade.asset].count++;
      byAsset[trade.asset].cost += trade.cost;
      byAsset[trade.asset].expectedPnL += trade.expectedPnL;
    }
    
    const totalCost = this.paperTrades.reduce((sum, t) => sum + t.cost, 0);
    const totalExpectedPnL = this.paperTrades.reduce((sum, t) => sum + t.expectedPnL, 0);
    
    return {
      totalTrades: this.paperTrades.length,
      totalCost,
      expectedTotalPnL: totalExpectedPnL,
      avgExpectedROI: totalCost > 0 ? (totalExpectedPnL / totalCost) * 100 : 0,
      byAsset,
    };
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
