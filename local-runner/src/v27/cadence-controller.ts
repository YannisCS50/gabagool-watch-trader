// ============================================================
// V27 ADAPTIVE CADENCE CONTROLLER
// ============================================================
//
// Implements adaptive evaluation cadence with objective near/hot detection:
//
// NEAR SIGNAL (objective criteria):
// - mispricing >= 0.6 * enterThreshold
// - state_score >= rolling P75
// - spotMoveEventAge < 1s
// - polyQuoteMoveAge < 1s
//
// HOT SIGNAL:
// - mispricing >= 0.85 * enterThreshold
// - state_score >= rolling P90
// - spread changed >= 1 tick within 1s
//
// CADENCE STATES:
// - COLD: eval every 1000ms
// - WARM: eval every 500ms
// - HOT: eval every 250ms
//
// HYSTERESIS:
// - WARM→COLD: only if near=false for 5s
// - HOT→WARM: only if hot=false for 3s
//
// LOGGING:
// - Light heartbeat each eval
// - Full snapshot every 2s in COLD, every 1s in WARM
// - Only event-driven in HOT
//
// ============================================================

export type CadenceState = 'COLD' | 'WARM' | 'HOT';

export interface CadenceMetrics {
  mispricing: number;
  enterThreshold: number;
  stateScore: number;
  spotMoveEventAgeMs: number;
  polyQuoteMoveAgeMs: number;
  spreadChangedTick: boolean; // spread changed >= 1 tick within 1s
}

export interface CadenceEvalResult {
  isNear: boolean;
  isHot: boolean;
  nearReasons: string[];
  hotReasons: string[];
}

export interface MarketCadenceState {
  marketId: string;
  state: CadenceState;
  lastEvalTs: number;
  lastFullSnapshotTs: number;
  nearFalseSince: number | null; // When near first became false
  hotFalseSince: number | null;  // When hot first became false
  lastStateChange: number;
  evalIntervalMs: number;
  snapshotIntervalMs: number;
}

// Rolling percentile tracker for state_score
class RollingPercentile {
  private values: number[] = [];
  private readonly maxSize = 200;
  
  push(value: number): void {
    this.values.push(value);
    if (this.values.length > this.maxSize) {
      this.values.shift();
    }
  }
  
  getPercentile(p: number): number {
    if (this.values.length === 0) return 0;
    const sorted = [...this.values].sort((a, b) => a - b);
    const idx = Math.floor((p / 100) * (sorted.length - 1));
    return sorted[idx];
  }
  
  get size(): number {
    return this.values.length;
  }
}

// Spread change tracker
interface SpreadHistory {
  ts: number;
  spreadUp: number;
  spreadDown: number;
}

export class CadenceController {
  // Per-market state
  private marketStates = new Map<string, MarketCadenceState>();
  
  // Rolling percentiles for state_score per asset
  private stateScorePercentiles = new Map<string, RollingPercentile>();
  
  // Spread history per market
  private spreadHistory = new Map<string, SpreadHistory[]>();
  
  // Price move tracking
  private lastSpotMoveTs = new Map<string, number>();
  private lastPolyMoveTs = new Map<string, number>();
  
  // Interval constants
  private readonly COLD_EVAL_MS = 1000;
  private readonly WARM_EVAL_MS = 500;
  private readonly HOT_EVAL_MS = 250;
  
  // Snapshot intervals
  private readonly COLD_SNAPSHOT_MS = 2000;
  private readonly WARM_SNAPSHOT_MS = 1000;
  // HOT: only event-driven (no time-based snapshots)
  
  // Hysteresis durations
  private readonly WARM_TO_COLD_HYSTERESIS_MS = 5000;
  private readonly HOT_TO_WARM_HYSTERESIS_MS = 3000;
  
  // ============================================================
  // MARKET REGISTRATION
  // ============================================================
  
  registerMarket(marketId: string, asset: string): void {
    if (!this.marketStates.has(marketId)) {
      const now = Date.now();
      this.marketStates.set(marketId, {
        marketId,
        state: 'COLD',
        lastEvalTs: 0,
        lastFullSnapshotTs: 0,
        nearFalseSince: null,
        hotFalseSince: null,
        lastStateChange: now,
        evalIntervalMs: this.COLD_EVAL_MS,
        snapshotIntervalMs: this.COLD_SNAPSHOT_MS,
      });
    }
    
    if (!this.stateScorePercentiles.has(asset)) {
      this.stateScorePercentiles.set(asset, new RollingPercentile());
    }
  }
  
  unregisterMarket(marketId: string): void {
    this.marketStates.delete(marketId);
    this.spreadHistory.delete(marketId);
  }
  
  // ============================================================
  // PRICE MOVE TRACKING
  // ============================================================
  
  recordSpotMove(asset: string, _price: number, ts: number): void {
    this.lastSpotMoveTs.set(asset, ts);
  }
  
  recordPolyMove(marketId: string, _upMid: number, _downMid: number, ts: number): void {
    this.lastPolyMoveTs.set(marketId, ts);
  }
  
  recordSpread(marketId: string, spreadUp: number, spreadDown: number): void {
    const now = Date.now();
    let history = this.spreadHistory.get(marketId);
    if (!history) {
      history = [];
      this.spreadHistory.set(marketId, history);
    }
    
    history.push({ ts: now, spreadUp, spreadDown });
    
    // Keep only last 2 seconds of history
    const cutoff = now - 2000;
    this.spreadHistory.set(marketId, history.filter(h => h.ts >= cutoff));
  }
  
  recordStateScore(asset: string, score: number): void {
    const percentile = this.stateScorePercentiles.get(asset);
    if (percentile) {
      percentile.push(score);
    }
  }
  
  // ============================================================
  // NEAR / HOT DETECTION
  // ============================================================
  
  evaluateCadence(
    marketId: string,
    asset: string,
    metrics: CadenceMetrics
  ): CadenceEvalResult {
    const now = Date.now();
    const percentile = this.stateScorePercentiles.get(asset);
    const p75 = percentile?.getPercentile(75) ?? 0;
    const p90 = percentile?.getPercentile(90) ?? 0;
    
    const nearReasons: string[] = [];
    const hotReasons: string[] = [];
    
    // ---- NEAR DETECTION ----
    
    // 1. mispricing >= 0.6 * enterThreshold
    if (metrics.mispricing >= 0.6 * metrics.enterThreshold) {
      nearReasons.push(`mispricing(${metrics.mispricing.toFixed(3)})>=0.6*threshold(${(0.6 * metrics.enterThreshold).toFixed(3)})`);
    }
    
    // 2. state_score >= rolling P75
    if (metrics.stateScore >= p75 && p75 > 0) {
      nearReasons.push(`stateScore(${metrics.stateScore.toFixed(3)})>=P75(${p75.toFixed(3)})`);
    }
    
    // 3. spotMoveEventAge < 1s
    if (metrics.spotMoveEventAgeMs < 1000) {
      nearReasons.push(`spotMoveAge(${metrics.spotMoveEventAgeMs}ms)<1s`);
    }
    
    // 4. polyQuoteMoveAge < 1s
    if (metrics.polyQuoteMoveAgeMs < 1000) {
      nearReasons.push(`polyMoveAge(${metrics.polyQuoteMoveAgeMs}ms)<1s`);
    }
    
    // ---- HOT DETECTION ----
    
    // 1. mispricing >= 0.85 * enterThreshold
    if (metrics.mispricing >= 0.85 * metrics.enterThreshold) {
      hotReasons.push(`mispricing(${metrics.mispricing.toFixed(3)})>=0.85*threshold(${(0.85 * metrics.enterThreshold).toFixed(3)})`);
    }
    
    // 2. state_score >= rolling P90
    if (metrics.stateScore >= p90 && p90 > 0) {
      hotReasons.push(`stateScore(${metrics.stateScore.toFixed(3)})>=P90(${p90.toFixed(3)})`);
    }
    
    // 3. spread changed >= 1 tick within 1s
    if (metrics.spreadChangedTick) {
      hotReasons.push('spreadChanged>=1tick/1s');
    }
    
    return {
      isNear: nearReasons.length > 0,
      isHot: hotReasons.length > 0,
      nearReasons,
      hotReasons,
    };
  }
  
  // ============================================================
  // STATE TRANSITIONS WITH HYSTERESIS
  // ============================================================
  
  updateState(marketId: string, asset: string, metrics: CadenceMetrics): CadenceState {
    const state = this.marketStates.get(marketId);
    if (!state) return 'COLD';
    
    const now = Date.now();
    const result = this.evaluateCadence(marketId, asset, metrics);
    const currentState = state.state;
    
    let newState: CadenceState = currentState;
    
    // ---- Handle hysteresis tracking ----
    
    // Track when near first became false
    if (!result.isNear) {
      if (state.nearFalseSince === null) {
        state.nearFalseSince = now;
      }
    } else {
      state.nearFalseSince = null;
    }
    
    // Track when hot first became false
    if (!result.isHot) {
      if (state.hotFalseSince === null) {
        state.hotFalseSince = now;
      }
    } else {
      state.hotFalseSince = null;
    }
    
    // ---- State transitions ----
    
    if (currentState === 'COLD') {
      // COLD → WARM: if near
      if (result.isNear) {
        newState = 'WARM';
      }
      // COLD → HOT: if hot
      if (result.isHot) {
        newState = 'HOT';
      }
    } else if (currentState === 'WARM') {
      // WARM → HOT: if hot
      if (result.isHot) {
        newState = 'HOT';
      }
      // WARM → COLD: only if near=false for 5s (hysteresis)
      if (state.nearFalseSince !== null && (now - state.nearFalseSince) >= this.WARM_TO_COLD_HYSTERESIS_MS) {
        newState = 'COLD';
      }
    } else if (currentState === 'HOT') {
      // HOT → WARM: only if hot=false for 3s (hysteresis)
      if (state.hotFalseSince !== null && (now - state.hotFalseSince) >= this.HOT_TO_WARM_HYSTERESIS_MS) {
        newState = 'WARM';
        // If not near either, go to COLD
        if (state.nearFalseSince !== null && (now - state.nearFalseSince) >= this.WARM_TO_COLD_HYSTERESIS_MS) {
          newState = 'COLD';
        }
      }
    }
    
    // Apply state change
    if (newState !== currentState) {
      state.state = newState;
      state.lastStateChange = now;
      
      // Update intervals
      switch (newState) {
        case 'COLD':
          state.evalIntervalMs = this.COLD_EVAL_MS;
          state.snapshotIntervalMs = this.COLD_SNAPSHOT_MS;
          break;
        case 'WARM':
          state.evalIntervalMs = this.WARM_EVAL_MS;
          state.snapshotIntervalMs = this.WARM_SNAPSHOT_MS;
          break;
        case 'HOT':
          state.evalIntervalMs = this.HOT_EVAL_MS;
          state.snapshotIntervalMs = Infinity; // Event-driven only
          break;
      }
      
      console.log(`[CADENCE] ${marketId.slice(0, 16)}... ${currentState} → ${newState} | ` +
        `near=${result.isNear} hot=${result.isHot} | interval=${state.evalIntervalMs}ms`);
    }
    
    return newState;
  }
  
  // ============================================================
  // TIMING CHECKS
  // ============================================================
  
  /**
   * Check if this market should be evaluated now based on its cadence
   */
  shouldEvaluate(marketId: string): boolean {
    const state = this.marketStates.get(marketId);
    if (!state) return true;
    
    const now = Date.now();
    const elapsed = now - state.lastEvalTs;
    return elapsed >= state.evalIntervalMs;
  }
  
  /**
   * Mark that an evaluation just happened
   */
  markEvaluated(marketId: string): void {
    const state = this.marketStates.get(marketId);
    if (state) {
      state.lastEvalTs = Date.now();
    }
  }
  
  /**
   * Check if we should log a full snapshot (based on state timing rules)
   */
  shouldLogFullSnapshot(marketId: string): boolean {
    const state = this.marketStates.get(marketId);
    if (!state) return true;
    
    // HOT: no time-based snapshots (event-driven only)
    if (state.state === 'HOT') return false;
    
    const now = Date.now();
    const elapsed = now - state.lastFullSnapshotTs;
    return elapsed >= state.snapshotIntervalMs;
  }
  
  /**
   * Mark that a full snapshot was just logged
   */
  markFullSnapshot(marketId: string): void {
    const state = this.marketStates.get(marketId);
    if (state) {
      state.lastFullSnapshotTs = Date.now();
    }
  }
  
  /**
   * Get the evaluation interval for a market
   */
  getEvalIntervalMs(marketId: string): number {
    return this.marketStates.get(marketId)?.evalIntervalMs ?? this.COLD_EVAL_MS;
  }
  
  /**
   * Get current state for a market
   */
  getState(marketId: string): CadenceState {
    return this.marketStates.get(marketId)?.state ?? 'COLD';
  }
  
  /**
   * Check if spread changed by >= 1 tick in last 1s
   */
  checkSpreadChanged(marketId: string): boolean {
    const history = this.spreadHistory.get(marketId);
    if (!history || history.length < 2) return false;
    
    const now = Date.now();
    const cutoff = now - 1000;
    const recent = history.filter(h => h.ts >= cutoff);
    
    if (recent.length < 2) return false;
    
    const first = recent[0];
    const last = recent[recent.length - 1];
    
    // Check if spread changed by >= 1 tick (0.01)
    const upSpreadChange = Math.abs(last.spreadUp - first.spreadUp);
    const downSpreadChange = Math.abs(last.spreadDown - first.spreadDown);
    
    return upSpreadChange >= 0.01 || downSpreadChange >= 0.01;
  }
  
  /**
   * Get spot move age in ms
   */
  getSpotMoveAgeMs(asset: string): number {
    const lastMove = this.lastSpotMoveTs.get(asset);
    if (!lastMove) return Infinity;
    return Date.now() - lastMove;
  }
  
  /**
   * Get poly move age in ms
   */
  getPolyMoveAgeMs(marketId: string): number {
    const lastMove = this.lastPolyMoveTs.get(marketId);
    if (!lastMove) return Infinity;
    return Date.now() - lastMove;
  }
  
  // ============================================================
  // STATS
  // ============================================================
  
  getStats(): {
    coldCount: number;
    warmCount: number;
    hotCount: number;
    totalMarkets: number;
  } {
    let coldCount = 0;
    let warmCount = 0;
    let hotCount = 0;
    
    for (const state of this.marketStates.values()) {
      switch (state.state) {
        case 'COLD': coldCount++; break;
        case 'WARM': warmCount++; break;
        case 'HOT': hotCount++; break;
      }
    }
    
    return {
      coldCount,
      warmCount,
      hotCount,
      totalMarkets: this.marketStates.size,
    };
  }
  
  /**
   * Build cadence metrics from current data
   */
  buildMetrics(
    marketId: string,
    asset: string,
    mispricing: number,
    enterThreshold: number,
    stateScore: number,
    spreadUp: number,
    spreadDown: number
  ): CadenceMetrics {
    // Record current spread
    this.recordSpread(marketId, spreadUp, spreadDown);
    
    // Record state score for percentile tracking
    this.recordStateScore(asset, stateScore);
    
    return {
      mispricing,
      enterThreshold,
      stateScore,
      spotMoveEventAgeMs: this.getSpotMoveAgeMs(asset),
      polyQuoteMoveAgeMs: this.getPolyMoveAgeMs(marketId),
      spreadChangedTick: this.checkSpreadChanged(marketId),
    };
  }
}
