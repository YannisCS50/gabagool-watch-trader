// ============================================================
// V27 STRATEGY RUNNER
// ============================================================
//
// Main orchestrator for the V27 Delta Mispricing Strategy.
//
// Order of work:
// 1) Build data + logging layer ✓
// 2) Prove filters trigger correctly
// 3) Shadow mode (NO TRADING)
// 4) Enable smallest possible live size
//
// ============================================================

import { getV27Config, loadV27Config } from './config.js';
import { MispricingDetector } from './mispricing-detector.js';
import { AdverseSelectionFilter } from './adverse-selection-filter.js';
import { EntryManager } from './entry-manager.js';
import { CorrectionMonitor } from './correction-monitor.js';
import { HedgeManager } from './hedge-manager.js';
import { V27Logger } from './logger.js';
import { logV27Status } from './index.js';
import type { V27Market, V27OrderBook, V27SpotData, V27Stats } from './index.js';

export class V27Runner {
  private mispricingDetector: MispricingDetector;
  private adverseFilter: AdverseSelectionFilter;
  private entryManager: EntryManager;
  private correctionMonitor: CorrectionMonitor;
  private hedgeManager: HedgeManager;
  private logger: V27Logger;
  
  private runId: string;
  private isRunning: boolean = false;
  private evaluationInterval?: NodeJS.Timeout;
  
  // Active markets being monitored
  private activeMarkets: Map<string, V27Market> = new Map();
  
  // Callbacks for order execution
  private onPlaceOrder?: (
    marketId: string,
    tokenId: string,
    side: 'BUY',
    price: number,
    shares: number
  ) => Promise<{ orderId: string; filled: boolean; avgFillPrice?: number }>;
  
  constructor(runId: string, supabase?: any) {
    this.runId = runId;
    
    this.mispricingDetector = new MispricingDetector();
    this.adverseFilter = new AdverseSelectionFilter();
    this.entryManager = new EntryManager();
    this.correctionMonitor = new CorrectionMonitor();
    this.hedgeManager = new HedgeManager();
    this.logger = new V27Logger(runId, supabase);
  }
  
  /**
   * Initialize with config overrides
   */
  initialize(configOverrides?: any): void {
    loadV27Config(configOverrides);
    const config = getV27Config();
    
    console.log('');
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║  🚀 V27 DELTA MISPRICING STRATEGY INITIALIZED                 ║');
    console.log('╠══════════════════════════════════════════════════════════════╣');
    console.log(`║  Run ID:       ${this.runId.slice(0, 40)}`.padEnd(66) + '║');
    console.log(`║  Shadow Mode:  ${config.shadowMode ? 'YES (no real trades)' : 'NO (LIVE)'}`.padEnd(66) + '║');
    console.log(`║  Assets:       ${config.assets.join(', ')}`.padEnd(66) + '║');
    console.log('╚══════════════════════════════════════════════════════════════╝');
    console.log('');
  }
  
  /**
   * Set order execution callback
   */
  setOrderCallback(
    callback: (
      marketId: string,
      tokenId: string,
      side: 'BUY',
      price: number,
      shares: number
    ) => Promise<{ orderId: string; filled: boolean; avgFillPrice?: number }>
  ): void {
    this.onPlaceOrder = callback;
  }
  
  /**
   * Register a market for monitoring
   */
  registerMarket(market: V27Market): void {
    const config = getV27Config();
    
    if (!config.enabled) return;
    if (!config.assets.includes(market.asset)) return;
    
    this.activeMarkets.set(market.id, market);
    console.log(`[V27] Registered market: ${market.asset} ${market.slug}`);
  }
  
  /**
   * Unregister a market
   */
  unregisterMarket(marketId: string): void {
    this.activeMarkets.delete(marketId);
  }
  
  /**
   * Feed spot price data
   */
  feedSpotPrice(asset: string, price: number, timestamp: number): void {
    this.mispricingDetector.recordSpotMove(asset, price, timestamp);
  }
  
  /**
   * Feed Polymarket orderbook data
   */
  feedOrderBook(
    marketId: string,
    book: V27OrderBook
  ): void {
    const market = this.activeMarkets.get(marketId);
    if (!market) return;
    
    // Record for mispricing detection
    this.mispricingDetector.recordPolyMove(market.asset, book.upMid, book.downMid, book.timestamp);
    
    // Record spread for adverse selection
    this.adverseFilter.recordSpread(market.asset, book);
  }
  
  /**
   * Feed taker fill data (for adverse selection calibration)
   */
  feedTakerFill(asset: string, size: number, side: 'UP' | 'DOWN', price: number): void {
    this.adverseFilter.recordTakerFill(asset, size, side, price);
  }
  
  /**
   * Evaluate a market for trading opportunity
   */
  async evaluate(
    marketId: string,
    spot: V27SpotData,
    book: V27OrderBook
  ): Promise<void> {
    const config = getV27Config();
    const market = this.activeMarkets.get(marketId);
    
    if (!market || !config.enabled) return;
    
    // Calculate time remaining
    const timeRemainingSeconds = (market.eventEndTime.getTime() - Date.now()) / 1000;
    if (timeRemainingSeconds <= 0) {
      this.unregisterMarket(marketId);
      return;
    }
    
    // 1. Detect mispricing
    const mispricing = this.mispricingDetector.detect(
      market.asset,
      market.strikePrice,
      spot,
      book,
      timeRemainingSeconds
    );
    
    // 2. Run adverse selection filter (only if mispricing exists)
    const filter = mispricing.exists && mispricing.side
      ? this.adverseFilter.evaluate(market.asset, book, mispricing.side)
      : {
          pass: false,
          failedFilter: 'NO_MISPRICING',
          details: {
            aggressiveFlow: { pass: true, largeTakerFillsLast8s: 0, takerVolumeLast5s: 0, p90Threshold: 50, p85VolumeThreshold: 100 },
            bookShape: { pass: true, mispricedSideDepth: 0, oppositeSideDepth: 0, asymmetryRatio: 1 },
            spreadExpansion: { pass: true, currentSpread: 0, medianSpread: 0, expansionRatio: 1 },
          },
        };
    
    // 3. Make entry decision
    const entry = this.entryManager.decide(
      marketId,
      market.asset,
      book,
      market.upTokenId,
      market.downTokenId,
      mispricing,
      filter
    );
    
    // 4. Log evaluation
    const evalLog = await this.logger.logEvaluation(
      marketId,
      market.asset,
      market.strikePrice,
      spot.price,
      spot.timestamp,
      book,
      timeRemainingSeconds,
      mispricing,
      filter,
      entry
    );
    
    // 5. Execute entry if decided (and not in shadow mode)
    if (entry.shouldEnter && entry.side && entry.price && entry.shares && entry.tokenId) {
      if (!config.shadowMode && this.onPlaceOrder) {
        try {
          const result = await this.onPlaceOrder(
            marketId,
            entry.tokenId,
            'BUY',
            entry.price,
            entry.shares
          );
          
          if (result.filled) {
            this.entryManager.recordEntry(
              marketId,
              market.asset,
              entry.side,
              entry.shares,
              result.avgFillPrice || entry.price
            );
            
            const position = this.entryManager.getPosition(marketId, entry.side)!;
            this.correctionMonitor.startMonitoring(position, mispricing, entry.side === 'UP' ? book.upMid : book.downMid);
            
            this.logger.createTradeLog(
              evalLog.id,
              marketId,
              market.asset,
              entry.side,
              result.avgFillPrice || entry.price,
              entry.shares
            );
          }
        } catch (err) {
          console.error(`[V27] Order placement failed:`, err);
        }
      }
    }
    
    // 6. Monitor existing positions for correction/hedge
    await this.monitorPositions(book, timeRemainingSeconds);
  }
  
  /**
   * Monitor positions for correction and hedge opportunities
   */
  private async monitorPositions(
    book: V27OrderBook,
    timeRemainingSeconds: number
  ): Promise<void> {
    const positions = this.entryManager.getAllPositions();
    
    for (const position of positions) {
      const market = this.activeMarkets.get(position.marketId);
      if (!market) continue;
      
      // Check correction status
      const correction = this.correctionMonitor.checkCorrection(position, book);
      
      if (correction.correctionConfirmed && !position.correctionConfirmed) {
        this.entryManager.confirmCorrection(position.marketId, position.side);
        
        // Find trade log and update
        const trades = this.logger.getAllTrades();
        const trade = trades.find(t => t.marketId === position.marketId && t.entrySide === position.side && !t.settled);
        if (trade) {
          this.logger.updateCorrection(trade.id, correction);
        }
      }
      
      // Check for hedge opportunity
      if (!position.hedged) {
        const hedge = this.hedgeManager.decide(
          position,
          book,
          market.upTokenId,
          market.downTokenId,
          timeRemainingSeconds
        );
        
        if (hedge.shouldHedge && hedge.side && hedge.price && hedge.shares && hedge.tokenId) {
          const config = getV27Config();
          
          if (!config.shadowMode && this.onPlaceOrder) {
            try {
              const result = await this.onPlaceOrder(
                position.marketId,
                hedge.tokenId,
                'BUY',
                hedge.price,
                hedge.shares
              );
              
              if (result.filled) {
                this.entryManager.recordHedge(
                  position.marketId,
                  position.side,
                  hedge.shares,
                  result.avgFillPrice || hedge.price
                );
                
                const trades = this.logger.getAllTrades();
                const trade = trades.find(t => t.marketId === position.marketId && t.entrySide === position.side && !t.settled);
                if (trade) {
                  this.logger.updateHedge(trade.id, hedge);
                }
              }
            } catch (err) {
              console.error(`[V27] Hedge order failed:`, err);
            }
          }
        }
      }
    }
  }
  
  /**
   * Handle market settlement
   */
  async handleSettlement(marketId: string, winningOutcome: 'UP' | 'DOWN'): Promise<void> {
    const position = this.entryManager.closePosition(marketId, 'UP') || 
                     this.entryManager.closePosition(marketId, 'DOWN');
    
    if (position) {
      const trades = this.logger.getAllTrades();
      const trade = trades.find(t => t.marketId === marketId && !t.settled);
      
      if (trade) {
        await this.logger.updateSettlement(trade.id, winningOutcome);
      }
      
      // Record outcome for threshold learning
      const market = this.activeMarkets.get(marketId);
      if (market) {
        const snappedBack = position.correctionConfirmed;
        // We'd need the delta at entry - simplified for now
        this.mispricingDetector.recordOutcome(market.asset, 0, snappedBack);
      }
    }
    
    this.correctionMonitor.stopMonitoring(marketId, 'UP');
    this.correctionMonitor.stopMonitoring(marketId, 'DOWN');
    this.unregisterMarket(marketId);
  }
  
  /**
   * Start the runner
   */
  start(): void {
    if (this.isRunning) return;
    
    this.isRunning = true;
    const config = getV27Config();
    
    console.log('[V27] Runner started');
    logV27Status(config, this.getStats());
  }
  
  /**
   * Stop the runner
   */
  stop(): void {
    this.isRunning = false;
    
    if (this.evaluationInterval) {
      clearInterval(this.evaluationInterval);
    }
    
    console.log('[V27] Runner stopped');
    logV27Status(getV27Config(), this.getStats());
  }
  
  /**
   * Get stats
   */
  getStats(): V27Stats {
    const loggerStats = this.logger.getStats();
    
    return {
      totalEvaluations: loggerStats.totalEvaluations,
      mispricingsDetected: loggerStats.mispricingsDetected,
      tradesEntered: loggerStats.tradesOpened,
      correctionsConfirmed: this.entryManager.getAllPositions().filter(p => p.correctionConfirmed).length,
      hedgesExecuted: this.entryManager.getAllPositions().filter(p => p.hedged).length,
      totalPnl: loggerStats.totalPnl,
      winRate: loggerStats.winRate,
    };
  }
  
  /**
   * Get active market count
   */
  getActiveMarketCount(): number {
    return this.activeMarkets.size;
  }
  
  /**
   * Get position count
   */
  getPositionCount(): number {
    return this.entryManager.getPositionCount();
  }
}
