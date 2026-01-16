/**
 * V30 Empirical Crossing Model
 * 
 * Tracks historical price crossing probabilities by delta/time bucket
 * Uses Wilson score intervals for statistical significance
 * 
 * Key insight: Given current delta and time remaining, what's the probability
 * that price will cross the strike before expiry?
 * 
 * If crossing probability is low → current side will likely win
 * If crossing probability is high → outcome is still uncertain
 */

import type { Asset } from './types.js';

interface CrossingCell {
  total: number;     // Total observations
  crossed: number;   // Times price crossed strike after this tick
  lastUpdate: number;
}

interface CrossingResult {
  crossingProb: number;        // P(price crosses strike before expiry)
  ci_lower: number;            // 95% CI lower bound
  ci_upper: number;            // 95% CI upper bound
  isSignificant: boolean;      // Has enough samples for significance
  samples: number;
  winProb: number;             // P(current side wins) = 1 - crossingProb
}

// Minimum samples for statistical significance
const MIN_SAMPLES = 30;

// Z-score for 95% confidence interval
const Z_95 = 1.96;

// Asset-specific delta buckets (in $ for BTC, scaled for others)
const DELTA_BUCKETS = [0, 25, 50, 100, 200, 300] as const;

// Time buckets in seconds
const TIME_BUCKETS = [0, 60, 120, 180, 300, 600, 900] as const;

export class EmpiricalCrossingModel {
  // Separate cells for ABOVE and BELOW strike
  private aboveCells: Map<string, CrossingCell> = new Map();
  private belowCells: Map<string, CrossingCell> = new Map();

  /**
   * Generate bucket key
   */
  private key(asset: Asset, deltaBucket: number, timeBucket: number): string {
    return `${asset}:${deltaBucket}:${timeBucket}`;
  }

  /**
   * Get delta bucket (minimum delta threshold)
   */
  private getDeltaBucket(asset: Asset, absDelta: number): number {
    // Scale delta for different assets (relative to BTC)
    const scaledDelta = this.scaleTobtc(asset, absDelta);
    
    // Find largest bucket that delta exceeds
    for (let i = DELTA_BUCKETS.length - 1; i >= 0; i--) {
      if (scaledDelta >= DELTA_BUCKETS[i]) {
        return DELTA_BUCKETS[i];
      }
    }
    return 0;
  }

  /**
   * Scale delta to BTC-equivalent for bucketing
   */
  private scaleTobtc(asset: Asset, delta: number): number {
    // Price ratios (approx): BTC ~95k, ETH ~3.5k, SOL ~200, XRP ~2.5
    const scales: Record<Asset, number> = {
      BTC: 1,
      ETH: 27,     // 95000/3500 ≈ 27
      SOL: 475,    // 95000/200 ≈ 475
      XRP: 38000,  // 95000/2.5 ≈ 38000
    };
    return Math.abs(delta) * (scales[asset] || 1);
  }

  /**
   * Get time bucket (minimum time remaining)
   */
  private getTimeBucket(secRemaining: number): number {
    for (let i = TIME_BUCKETS.length - 1; i >= 0; i--) {
      if (secRemaining >= TIME_BUCKETS[i]) {
        return TIME_BUCKETS[i];
      }
    }
    return 0;
  }

  /**
   * Calculate Wilson score confidence interval
   */
  private wilsonInterval(n: number, x: number): { lower: number; upper: number; p: number } {
    if (n === 0) return { lower: 0, upper: 1, p: 0.5 };
    
    const p = x / n;
    const z2 = Z_95 * Z_95;
    
    const denominator = 1 + z2 / n;
    const center = p + z2 / (2 * n);
    const spread = Z_95 * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
    
    return {
      p,
      lower: Math.max(0, (center - spread) / denominator),
      upper: Math.min(1, (center + spread) / denominator),
    };
  }

  /**
   * Get crossing probability for given conditions
   */
  getCrossingProb(
    asset: Asset,
    deltaToStrike: number,
    secRemaining: number
  ): CrossingResult {
    const isAbove = deltaToStrike > 0;
    const absDelta = Math.abs(deltaToStrike);
    const deltaBucket = this.getDeltaBucket(asset, absDelta);
    const timeBucket = this.getTimeBucket(secRemaining);
    const k = this.key(asset, deltaBucket, timeBucket);
    
    const cells = isAbove ? this.aboveCells : this.belowCells;
    const cell = cells.get(k);
    
    if (!cell || cell.total < MIN_SAMPLES) {
      // Not enough data - use conservative fallback
      return this.fallbackEstimate(asset, deltaToStrike, secRemaining, cell?.total ?? 0);
    }

    const wilson = this.wilsonInterval(cell.total, cell.crossed);
    
    return {
      crossingProb: wilson.p,
      ci_lower: wilson.lower,
      ci_upper: wilson.upper,
      isSignificant: true,
      samples: cell.total,
      winProb: 1 - wilson.p, // If no crossing, current side wins
    };
  }

  /**
   * Fallback estimate when not enough empirical data
   * Uses conservative logistic model
   */
  private fallbackEstimate(
    asset: Asset,
    deltaToStrike: number,
    secRemaining: number,
    existingSamples: number
  ): CrossingResult {
    // Asset volatility in BTC-equivalent terms
    const volatility: Record<Asset, number> = {
      BTC: 150,
      ETH: 15,
      SOL: 1.5,
      XRP: 0.02,
    };
    
    const sigma = volatility[asset] || 150;
    const absDelta = Math.abs(deltaToStrike);
    
    // Time scaling - less time = less chance to cross
    const timeScale = Math.sqrt(Math.max(1, secRemaining) / 900);
    
    // Expected move in remaining time
    const expectedMove = sigma * timeScale;
    
    // Probability of crossing ≈ P(price moves > delta)
    // Use simplified normal approximation
    const zScore = absDelta / expectedMove;
    
    // Approximate P(cross) using logistic function
    // Higher z-score = lower crossing probability
    const crossingProb = 1 / (1 + Math.exp(zScore * 1.5));
    
    // Very wide CI since this is just a heuristic
    return {
      crossingProb,
      ci_lower: Math.max(0, crossingProb - 0.3),
      ci_upper: Math.min(1, crossingProb + 0.3),
      isSignificant: false,
      samples: existingSamples,
      winProb: 1 - crossingProb,
    };
  }

  /**
   * Calculate fair value P(UP wins) using crossing model
   * 
   * If delta > 0 (price above strike):
   *   P(UP wins) = P(stays above) = 1 - P(crosses down)
   * 
   * If delta < 0 (price below strike):
   *   P(UP wins) = P(crosses up)
   */
  getFairP(
    asset: Asset,
    deltaToStrike: number,
    secRemaining: number
  ): { p_up: number; p_down: number; confidence: number; samples: number; ci_lower: number; ci_upper: number } {
    const crossing = this.getCrossingProb(asset, deltaToStrike, secRemaining);
    
    let p_up: number;
    let ci_lower: number;
    let ci_upper: number;
    
    if (deltaToStrike > 0) {
      // Price above strike → UP wins if NO crossing
      p_up = crossing.winProb;
      ci_lower = 1 - crossing.ci_upper;
      ci_upper = 1 - crossing.ci_lower;
    } else {
      // Price below strike → UP wins if crossing occurs
      p_up = crossing.crossingProb;
      ci_lower = crossing.ci_lower;
      ci_upper = crossing.ci_upper;
    }
    
    // Clamp to reasonable bounds
    const minP = secRemaining > 30 ? 0.02 : 0.01;
    const maxP = secRemaining > 30 ? 0.98 : 0.99;
    p_up = Math.max(minP, Math.min(maxP, p_up));
    
    return {
      p_up,
      p_down: 1 - p_up,
      confidence: crossing.isSignificant ? 0.95 : 0.5,
      samples: crossing.samples,
      ci_lower,
      ci_upper,
    };
  }

  /**
   * Record an observation for learning
   * Called during market with price updates
   */
  recordTick(
    asset: Asset,
    deltaToStrike: number,
    secRemaining: number,
    didCrossAfter: boolean,
    ts: number = Date.now()
  ): void {
    const isAbove = deltaToStrike > 0;
    const absDelta = Math.abs(deltaToStrike);
    const deltaBucket = this.getDeltaBucket(asset, absDelta);
    const timeBucket = this.getTimeBucket(secRemaining);
    const k = this.key(asset, deltaBucket, timeBucket);
    
    const cells = isAbove ? this.aboveCells : this.belowCells;
    const existing = cells.get(k);
    
    if (existing) {
      existing.total++;
      if (didCrossAfter) existing.crossed++;
      existing.lastUpdate = ts;
    } else {
      cells.set(k, {
        total: 1,
        crossed: didCrossAfter ? 1 : 0,
        lastUpdate: ts,
      });
    }
  }

  /**
   * Bulk load from v30_ticks data
   * Analyzes each tick to see if price crossed after that point
   */
  async loadFromDatabase(supabase: any): Promise<{ loaded: number; cells: number }> {
    // Query to calculate crossing for each tick
    const { data, error } = await supabase.rpc('calculate_crossing_stats') || 
      await supabase.from('v30_ticks').select(`
        asset,
        market_slug,
        ts,
        c_price,
        strike_price,
        delta_to_strike,
        seconds_remaining
      `).order('ts', { ascending: true }).limit(10000);
    
    if (error || !data) {
      console.error('Failed to load crossing data:', error);
      return { loaded: 0, cells: 0 };
    }

    // Group by market to calculate future crossings
    const byMarket = new Map<string, typeof data>();
    for (const tick of data) {
      if (!tick.market_slug) continue;
      if (!byMarket.has(tick.market_slug)) {
        byMarket.set(tick.market_slug, []);
      }
      byMarket.get(tick.market_slug)!.push(tick);
    }

    let loaded = 0;
    
    // Process each market
    for (const [slug, ticks] of byMarket) {
      // Sort by time
      ticks.sort((a, b) => a.ts - b.ts);
      
      // For each tick, check if price crossed strike before end
      for (let i = 0; i < ticks.length; i++) {
        const tick = ticks[i];
        if (!tick.delta_to_strike || !tick.strike_price || tick.seconds_remaining === null) continue;
        
        const isAbove = tick.delta_to_strike > 0;
        
        // Look at all future ticks in this market
        let didCross = false;
        for (let j = i + 1; j < ticks.length; j++) {
          const futureTick = ticks[j];
          if (!futureTick.c_price) continue;
          
          const futureAbove = futureTick.c_price > tick.strike_price;
          if (isAbove && !futureAbove) {
            didCross = true;
            break;
          }
          if (!isAbove && futureAbove) {
            didCross = true;
            break;
          }
        }
        
        this.recordTick(
          tick.asset as Asset,
          tick.delta_to_strike,
          tick.seconds_remaining,
          didCross,
          tick.ts
        );
        loaded++;
      }
    }

    return {
      loaded,
      cells: this.aboveCells.size + this.belowCells.size,
    };
  }

  /**
   * Get summary statistics
   */
  getStats(): {
    aboveCells: number;
    belowCells: number;
    significantCells: number;
    totalSamples: number;
  } {
    let significant = 0;
    let totalSamples = 0;
    
    for (const cell of this.aboveCells.values()) {
      totalSamples += cell.total;
      if (cell.total >= MIN_SAMPLES) significant++;
    }
    for (const cell of this.belowCells.values()) {
      totalSamples += cell.total;
      if (cell.total >= MIN_SAMPLES) significant++;
    }
    
    return {
      aboveCells: this.aboveCells.size,
      belowCells: this.belowCells.size,
      significantCells: significant,
      totalSamples,
    };
  }

  /**
   * Export model state for persistence
   */
  export(): { above: Record<string, CrossingCell>; below: Record<string, CrossingCell> } {
    return {
      above: Object.fromEntries(this.aboveCells),
      below: Object.fromEntries(this.belowCells),
    };
  }

  /**
   * Import model state
   */
  import(data: { above: Record<string, CrossingCell>; below: Record<string, CrossingCell> }): void {
    this.aboveCells = new Map(Object.entries(data.above));
    this.belowCells = new Map(Object.entries(data.below));
  }

  /**
   * Clear all data
   */
  clear(): void {
    this.aboveCells.clear();
    this.belowCells.clear();
  }
}

// Singleton instance
let instance: EmpiricalCrossingModel | null = null;

export function getCrossingModel(): EmpiricalCrossingModel {
  if (!instance) {
    instance = new EmpiricalCrossingModel();
  }
  return instance;
}

export function resetCrossingModel(): void {
  instance = null;
}
