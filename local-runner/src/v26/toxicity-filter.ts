// ============================================================
// TOXICITY FILTER v2 - Self-Calibrating Pre-Trade Filter
// Based on: toxicity_filter_spec_v_2.md
// ============================================================

import { config } from '../config.js';

// ============================================================
// TYPES
// ============================================================

export interface OrderbookTick {
  timestamp: number; // Unix ms
  bestBid: number;
  bestAsk: number;
}

export interface ToxicityFeatures {
  // Market identification
  marketId: string;
  marketSlug: string;
  asset: string;
  marketStartTime: Date;

  // Data quality (Section 6)
  nTicks: number;
  maxGapSeconds: number;
  dataQuality: 'GOOD' | 'SPARSE' | 'INSUFFICIENT';

  // Core features (Section 5)
  askVolatility: number | null;
  askChangeCount: number | null;
  minDistanceToTarget: number | null;
  meanDistanceToTarget: number | null;
  timeNearTargetPct: number | null;

  // Liquidity pull detection (Section 5.4)
  askMedianEarly: number | null;
  askMedianLate: number | null;
  liquidityPullDetected: boolean;

  // Spread dynamics (Section 5.5)
  spreadVolatility: number | null;
  spreadJumpLast20s: number | null;

  // Bid-side pressure (Section 5.6)
  bidDrift: number | null;
  midDrift: number | null;

  // Scoring output (Section 7-8)
  toxicityScore: number | null;
  percentileRank: number | null;
  classification: 'HEALTHY' | 'BORDERLINE' | 'TOXIC' | 'UNKNOWN';
  decision: 'TRADE' | 'SKIP' | 'REDUCED' | 'PENDING';
  confidence: 'LOW' | 'MEDIUM' | 'HIGH';

  // Config
  targetPrice: number;
  filterVersion: string;
}

export interface ToxicityConfig {
  targetPrice: number; // Default 0.48
  analysisWindowSeconds: number; // Default 60
  earlyWindowEndSeconds: number; // Default 20 (T-60 to T-20)
  liquidityPullThreshold: number; // Default 0.02
  minTicksRequired: number; // Default 5
  maxGapAllowed: number; // Default 20s
  nearTargetThreshold: number; // Default 0.01
  maxDeltaT: number; // Default 10s for time-weighted calculations
  acceptancePercentile: number; // Default 40 (accept top 40% least toxic)
}

const DEFAULT_CONFIG: ToxicityConfig = {
  targetPrice: 0.48,
  analysisWindowSeconds: 60,
  earlyWindowEndSeconds: 20,
  liquidityPullThreshold: 0.02,
  minTicksRequired: 5,
  maxGapAllowed: 20,
  nearTargetThreshold: 0.01,
  maxDeltaT: 10,
  acceptancePercentile: 40,
};

// ============================================================
// UTILITY FUNCTIONS
// ============================================================

function standardDeviation(values: number[]): number | null {
  if (values.length < 2) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const squaredDiffs = values.map((v) => Math.pow(v - mean, 2));
  const variance = squaredDiffs.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(variance);
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function countChanges(values: number[]): number {
  if (values.length < 2) return 0;
  let count = 0;
  for (let i = 1; i < values.length; i++) {
    if (values[i] !== values[i - 1]) count++;
  }
  return count;
}

// ============================================================
// FEATURE COMPUTATION (Section 5)
// ============================================================

export function computeDataQuality(
  ticks: OrderbookTick[],
  cfg: ToxicityConfig
): { nTicks: number; maxGapSeconds: number; quality: 'GOOD' | 'SPARSE' | 'INSUFFICIENT' } {
  const nTicks = ticks.length;

  if (nTicks < 2) {
    return { nTicks, maxGapSeconds: Infinity, quality: 'INSUFFICIENT' };
  }

  // Calculate max gap between consecutive ticks
  let maxGap = 0;
  for (let i = 1; i < ticks.length; i++) {
    const gap = (ticks[i].timestamp - ticks[i - 1].timestamp) / 1000;
    if (gap > maxGap) maxGap = gap;
  }

  if (nTicks < cfg.minTicksRequired || maxGap > cfg.maxGapAllowed) {
    return { nTicks, maxGapSeconds: maxGap, quality: nTicks < cfg.minTicksRequired ? 'INSUFFICIENT' : 'SPARSE' };
  }

  return { nTicks, maxGapSeconds: maxGap, quality: 'GOOD' };
}

export function computeAskVolatility(ticks: OrderbookTick[]): number | null {
  const asks = ticks.map((t) => t.bestAsk).filter((a) => a > 0 && a < 1);
  return standardDeviation(asks);
}

export function computeAskChangeCount(ticks: OrderbookTick[]): number | null {
  const asks = ticks.map((t) => t.bestAsk).filter((a) => a > 0 && a < 1);
  if (asks.length < 2) return null;
  return countChanges(asks);
}

export function computeProximityFeatures(
  ticks: OrderbookTick[],
  cfg: ToxicityConfig
): { minDistance: number | null; meanDistance: number | null; timeNearPct: number | null } {
  const asks = ticks.map((t) => t.bestAsk).filter((a) => a > 0 && a < 1);
  if (asks.length === 0) {
    return { minDistance: null, meanDistance: null, timeNearPct: null };
  }

  const distances = asks.map((a) => a - cfg.targetPrice);
  const minDistance = Math.min(...distances);
  const meanDistance = distances.reduce((a, b) => a + b, 0) / distances.length;

  // Time-weighted calculation for time near target
  if (ticks.length < 2) {
    return { minDistance, meanDistance, timeNearPct: null };
  }

  let totalTime = 0;
  let timeNear = 0;
  for (let i = 1; i < ticks.length; i++) {
    const dt = Math.min((ticks[i].timestamp - ticks[i - 1].timestamp) / 1000, cfg.maxDeltaT);
    const distance = ticks[i - 1].bestAsk - cfg.targetPrice;
    totalTime += dt;
    if (distance <= cfg.nearTargetThreshold) {
      timeNear += dt;
    }
  }

  const timeNearPct = totalTime > 0 ? (timeNear / totalTime) * 100 : null;

  return { minDistance, meanDistance, timeNearPct };
}

export function computeLiquidityPull(
  ticks: OrderbookTick[],
  marketStartTime: number,
  cfg: ToxicityConfig
): { askMedianEarly: number | null; askMedianLate: number | null; pullDetected: boolean } {
  const earlyWindow = marketStartTime - cfg.earlyWindowEndSeconds * 1000;
  const lateWindow = marketStartTime - cfg.earlyWindowEndSeconds * 1000;

  const earlyTicks = ticks.filter((t) => t.timestamp < lateWindow);
  const lateTicks = ticks.filter((t) => t.timestamp >= lateWindow);

  const earlyAsks = earlyTicks.map((t) => t.bestAsk).filter((a) => a > 0 && a < 1);
  const lateAsks = lateTicks.map((t) => t.bestAsk).filter((a) => a > 0 && a < 1);

  const askMedianEarly = median(earlyAsks);
  const askMedianLate = median(lateAsks);

  // Section 5.4: Liquidity pull if late median is >= 0.02 higher than early median
  let pullDetected = false;
  if (askMedianEarly !== null && askMedianLate !== null) {
    const jump = askMedianLate - askMedianEarly;
    // Only flag if significant jump AND we have sufficient data in both windows
    if (jump >= cfg.liquidityPullThreshold && earlyAsks.length >= 3 && lateAsks.length >= 3) {
      pullDetected = true;
    }
  }

  return { askMedianEarly, askMedianLate, pullDetected };
}

export function computeSpreadDynamics(
  ticks: OrderbookTick[],
  marketStartTime: number,
  cfg: ToxicityConfig
): { spreadVolatility: number | null; spreadJumpLast20s: number | null } {
  const spreads = ticks
    .filter((t) => t.bestAsk > 0 && t.bestBid > 0)
    .map((t) => t.bestAsk - t.bestBid);

  const spreadVolatility = standardDeviation(spreads);

  // Spread jump in last 20s
  const lateWindow = marketStartTime - cfg.earlyWindowEndSeconds * 1000;
  const earlyTicks = ticks.filter((t) => t.timestamp < lateWindow && t.bestAsk > 0 && t.bestBid > 0);
  const lateTicks = ticks.filter((t) => t.timestamp >= lateWindow && t.bestAsk > 0 && t.bestBid > 0);

  const earlySpreads = earlyTicks.map((t) => t.bestAsk - t.bestBid);
  const lateSpreads = lateTicks.map((t) => t.bestAsk - t.bestBid);

  const earlyMedian = median(earlySpreads);
  const lateMedian = median(lateSpreads);

  const spreadJumpLast20s =
    earlyMedian !== null && lateMedian !== null ? lateMedian - earlyMedian : null;

  return { spreadVolatility, spreadJumpLast20s };
}

export function computeBidPressure(
  ticks: OrderbookTick[]
): { bidDrift: number | null; midDrift: number | null } {
  const validTicks = ticks.filter((t) => t.bestBid > 0 && t.bestAsk > 0);
  if (validTicks.length < 2) {
    return { bidDrift: null, midDrift: null };
  }

  const first = validTicks[0];
  const last = validTicks[validTicks.length - 1];

  const bidDrift = last.bestBid - first.bestBid;
  const midDrift = (last.bestBid + last.bestAsk) / 2 - (first.bestBid + first.bestAsk) / 2;

  return { bidDrift, midDrift };
}

// ============================================================
// TOXICITY SCORING (Section 7 - Bootstrap Phase)
// ============================================================

interface HistoricalStats {
  askVolatility: { mean: number; std: number };
  askChangeCount: { mean: number; std: number };
  meanDistance: { mean: number; std: number };
  spreadVolatility: { mean: number; std: number };
  bidDrift: { mean: number; std: number };
}

// Default bootstrap stats (will be replaced by calibration)
const BOOTSTRAP_STATS: HistoricalStats = {
  askVolatility: { mean: 0.02, std: 0.01 },
  askChangeCount: { mean: 5, std: 3 },
  meanDistance: { mean: 0.03, std: 0.02 },
  spreadVolatility: { mean: 0.02, std: 0.01 },
  bidDrift: { mean: 0, std: 0.01 },
};

function zScore(value: number | null, stats: { mean: number; std: number }): number {
  if (value === null || stats.std === 0) return 0;
  return (value - stats.mean) / stats.std;
}

export function computeToxicityScore(
  features: Partial<ToxicityFeatures>,
  stats: HistoricalStats = BOOTSTRAP_STATS
): number {
  // Section 7: Combine with equal weights + 2x for liquidity pull
  let score = 0;

  // Higher volatility = more toxic
  score += zScore(features.askVolatility ?? null, stats.askVolatility);

  // More changes = more toxic
  score += zScore(features.askChangeCount ?? null, stats.askChangeCount);

  // Distance from target (negative distance = ask below target = good)
  // Higher distance = worse, so add it
  score += zScore(features.meanDistanceToTarget ?? null, stats.meanDistance);

  // Higher spread volatility = more toxic
  score += zScore(features.spreadVolatility ?? null, stats.spreadVolatility);

  // Bid drift: negative drift might indicate selling pressure
  score += zScore(features.bidDrift ?? null, stats.bidDrift);

  // Liquidity pull is the strongest signal (2x weight)
  if (features.liquidityPullDetected) {
    score += 2;
  }

  return score;
}

export function classifyToxicity(
  score: number,
  percentileRank: number | null,
  dataQuality: 'GOOD' | 'SPARSE' | 'INSUFFICIENT',
  acceptancePercentile: number
): { classification: 'HEALTHY' | 'BORDERLINE' | 'TOXIC' | 'UNKNOWN'; decision: 'TRADE' | 'SKIP' | 'REDUCED' | 'PENDING'; confidence: 'LOW' | 'MEDIUM' | 'HIGH' } {
  // Data quality gate (Section 6)
  if (dataQuality === 'INSUFFICIENT') {
    return { classification: 'UNKNOWN', decision: 'SKIP', confidence: 'LOW' };
  }

  if (dataQuality === 'SPARSE') {
    return { classification: 'BORDERLINE', decision: 'REDUCED', confidence: 'LOW' };
  }

  // Percentile-based decision (Section 9)
  if (percentileRank === null) {
    // No historical context yet - use score directly
    if (score < 0) {
      return { classification: 'HEALTHY', decision: 'TRADE', confidence: 'MEDIUM' };
    } else if (score < 1) {
      return { classification: 'BORDERLINE', decision: 'REDUCED', confidence: 'LOW' };
    } else {
      return { classification: 'TOXIC', decision: 'SKIP', confidence: 'MEDIUM' };
    }
  }

  // Section 9: Dynamic acceptance based on percentile
  // Lower percentile = less toxic = better
  if (percentileRank <= acceptancePercentile) {
    const confidence = percentileRank <= acceptancePercentile / 2 ? 'HIGH' : 'MEDIUM';
    return { classification: 'HEALTHY', decision: 'TRADE', confidence };
  } else if (percentileRank <= acceptancePercentile * 1.5) {
    return { classification: 'BORDERLINE', decision: 'REDUCED', confidence: 'LOW' };
  } else {
    return { classification: 'TOXIC', decision: 'SKIP', confidence: 'HIGH' };
  }
}

// ============================================================
// MAIN FILTER FUNCTION
// ============================================================

export function computeToxicityFeatures(
  marketId: string,
  marketSlug: string,
  asset: string,
  marketStartTime: Date,
  ticks: OrderbookTick[],
  cfg: Partial<ToxicityConfig> = {}
): ToxicityFeatures {
  const config: ToxicityConfig = { ...DEFAULT_CONFIG, ...cfg };
  const marketStartMs = marketStartTime.getTime();

  // Filter ticks to analysis window (T-60s to T)
  const windowStart = marketStartMs - config.analysisWindowSeconds * 1000;
  const windowTicks = ticks
    .filter((t) => t.timestamp >= windowStart && t.timestamp <= marketStartMs)
    .sort((a, b) => a.timestamp - b.timestamp);

  // Data quality
  const { nTicks, maxGapSeconds, quality } = computeDataQuality(windowTicks, config);

  // Core features
  const askVolatility = computeAskVolatility(windowTicks);
  const askChangeCount = computeAskChangeCount(windowTicks);
  const proximity = computeProximityFeatures(windowTicks, config);
  const liquidityPull = computeLiquidityPull(windowTicks, marketStartMs, config);
  const spreadDynamics = computeSpreadDynamics(windowTicks, marketStartMs, config);
  const bidPressure = computeBidPressure(windowTicks);

  // Compute toxicity score
  const partialFeatures = {
    askVolatility,
    askChangeCount,
    meanDistanceToTarget: proximity.meanDistance,
    spreadVolatility: spreadDynamics.spreadVolatility,
    bidDrift: bidPressure.bidDrift,
    liquidityPullDetected: liquidityPull.pullDetected,
  };

  const toxicityScore = computeToxicityScore(partialFeatures);

  // Classification (percentile will be set by caller with historical data)
  const { classification, decision, confidence } = classifyToxicity(
    toxicityScore,
    null, // Percentile set later
    quality,
    config.acceptancePercentile
  );

  return {
    marketId,
    marketSlug,
    asset,
    marketStartTime,

    nTicks,
    maxGapSeconds,
    dataQuality: quality,

    askVolatility,
    askChangeCount,
    minDistanceToTarget: proximity.minDistance,
    meanDistanceToTarget: proximity.meanDistance,
    timeNearTargetPct: proximity.timeNearPct,

    askMedianEarly: liquidityPull.askMedianEarly,
    askMedianLate: liquidityPull.askMedianLate,
    liquidityPullDetected: liquidityPull.pullDetected,

    spreadVolatility: spreadDynamics.spreadVolatility,
    spreadJumpLast20s: spreadDynamics.spreadJumpLast20s,

    bidDrift: bidPressure.bidDrift,
    midDrift: bidPressure.midDrift,

    toxicityScore,
    percentileRank: null,
    classification,
    decision,
    confidence,

    targetPrice: config.targetPrice,
    filterVersion: 'v2-bootstrap',
  };
}

// ============================================================
// DECISION FUNCTION
// ============================================================

export function shouldTrade(features: ToxicityFeatures): boolean {
  return features.decision === 'TRADE' || features.decision === 'REDUCED';
}

export function getPositionMultiplier(features: ToxicityFeatures): number {
  switch (features.decision) {
    case 'TRADE':
      return 1.0;
    case 'REDUCED':
      return 0.5;
    default:
      return 0;
  }
}

// ============================================================
// LOGGING TO BACKEND
// ============================================================

export async function saveToxicityFeatures(features: ToxicityFeatures, runId?: string): Promise<string | null> {
  try {
    const payload = {
      market_id: features.marketId,
      market_slug: features.marketSlug,
      asset: features.asset,
      market_start_time: features.marketStartTime.toISOString(),
      n_ticks: features.nTicks,
      max_gap_seconds: features.maxGapSeconds,
      data_quality: features.dataQuality,
      ask_volatility: features.askVolatility,
      ask_change_count: features.askChangeCount,
      min_distance_to_target: features.minDistanceToTarget,
      mean_distance_to_target: features.meanDistanceToTarget,
      time_near_target_pct: features.timeNearTargetPct,
      ask_median_early: features.askMedianEarly,
      ask_median_late: features.askMedianLate,
      liquidity_pull_detected: features.liquidityPullDetected,
      spread_volatility: features.spreadVolatility,
      spread_jump_last_20s: features.spreadJumpLast20s,
      bid_drift: features.bidDrift,
      mid_drift: features.midDrift,
      toxicity_score: features.toxicityScore,
      percentile_rank: features.percentileRank,
      classification: features.classification,
      decision: features.decision,
      confidence: features.confidence,
      target_price: features.targetPrice,
      filter_version: features.filterVersion,
      run_id: runId,
    };

    const response = await fetch(config.backend.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Runner-Secret': config.backend.secret,
      },
      body: JSON.stringify({ action: 'save-toxicity-features', data: payload }),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error(`[ToxicityFilter] Failed to save features: ${response.status} ${text}`);
      return null;
    }

    const result = await response.json();
    return result.id ?? null;
  } catch (err: any) {
    console.error(`[ToxicityFilter] Error saving features:`, err?.message ?? err);
    return null;
  }
}

export async function updateToxicityOutcome(
  marketId: string,
  asset: string,
  outcome: 'WIN' | 'LOSS',
  pnl: number
): Promise<boolean> {
  try {
    const response = await fetch(config.backend.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Runner-Secret': config.backend.secret,
      },
      body: JSON.stringify({
        action: 'update-toxicity-outcome',
        data: {
          market_id: marketId,
          asset,
          outcome,
          pnl,
          settled_at: new Date().toISOString(),
        },
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error(`[ToxicityFilter] Failed to update outcome: ${response.status} ${text}`);
      return false;
    }

    return true;
  } catch (err: any) {
    console.error(`[ToxicityFilter] Error updating outcome:`, err?.message ?? err);
    return false;
  }
}

// ============================================================
// LOG OUTPUT (Section 10)
// ============================================================

export function logToxicityDecision(features: ToxicityFeatures): void {
  const icon = features.decision === 'TRADE' ? '✅' : features.decision === 'REDUCED' ? '⚠️' : '❌';
  const pullIcon = features.liquidityPullDetected ? '🚨' : '✓';

  console.log(
    `[ToxicityFilter] ${icon} ${features.asset} ${features.marketSlug} | ` +
      `Score: ${features.toxicityScore?.toFixed(2) ?? 'N/A'} | ` +
      `Class: ${features.classification} | ` +
      `Decision: ${features.decision} (${features.confidence}) | ` +
      `Ticks: ${features.nTicks} | ` +
      `LiqPull: ${pullIcon} | ` +
      `AskVol: ${features.askVolatility?.toFixed(4) ?? 'N/A'}`
  );
}
