// ============================================================
// V27 ADVERSE SELECTION FILTER
// ============================================================
//
// If ANY of the following fail → NO TRADE:
// 1. Aggressive Flow Check (large taker fills)
// 2. Book Shape Asymmetry
// 3. Spread Expansion Check
// 4. Causality (Spot Leads Polymarket) - handled in MispricingDetector
//
// ============================================================

import { getV27Config, getAssetConfig } from './config.js';
import type { V27OrderBook } from './index.js';

export interface FilterResult {
  pass: boolean;
  failedFilter?: string;
  details: {
    aggressiveFlow: {
      pass: boolean;
      largeTakerFillsLast8s: number;
      takerVolumeLast5s: number;
      p90Threshold: number;
      p85VolumeThreshold: number;
    };
    bookShape: {
      pass: boolean;
      mispricedSideDepth: number;
      oppositeSideDepth: number;
      asymmetryRatio: number;
    };
    spreadExpansion: {
      pass: boolean;
      currentSpread: number;
      medianSpread: number;
      expansionRatio: number;
    };
  };
}

interface TakerFill {
  timestamp: number;
  size: number;
  side: 'UP' | 'DOWN';
  price: number;
}

interface SpreadSnapshot {
  timestamp: number;
  spreadUp: number;
  spreadDown: number;
}

export class AdverseSelectionFilter {
  // Rolling taker fills per asset
  private takerFills: Map<string, TakerFill[]> = new Map();
  
  // Rolling spread history per asset
  private spreadHistory: Map<string, SpreadSnapshot[]> = new Map();
  
  // Calibrated percentiles (updated over time)
  private takerFillP90: Map<string, number> = new Map();
  private takerVolumeP85: Map<string, number> = new Map();
  
  constructor() {
    for (const asset of ['BTC', 'ETH', 'SOL', 'XRP']) {
      this.takerFills.set(asset, []);
      this.spreadHistory.set(asset, []);
      
      // Initialize with defaults from config
      const config = getAssetConfig(asset);
      if (config) {
        this.takerFillP90.set(asset, config.takerFillP90);
        this.takerVolumeP85.set(asset, config.takerVolumeP85);
      }
    }
  }
  
  /**
   * Record a taker fill (for calibration)
   */
  recordTakerFill(asset: string, size: number, side: 'UP' | 'DOWN', price: number): void {
    const fills = this.takerFills.get(asset) || [];
    fills.push({
      timestamp: Date.now(),
      size,
      side,
      price,
    });
    
    // Keep last 24h of fills
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const filtered = fills.filter(f => f.timestamp >= cutoff);
    this.takerFills.set(asset, filtered);
    
    // Recalibrate percentiles periodically
    if (filtered.length % 100 === 0) {
      this.recalibratePercentiles(asset);
    }
  }
  
  /**
   * Record spread snapshot
   */
  recordSpread(asset: string, book: V27OrderBook): void {
    const history = this.spreadHistory.get(asset) || [];
    history.push({
      timestamp: book.timestamp,
      spreadUp: book.spreadUp,
      spreadDown: book.spreadDown,
    });
    
    // Keep last 60 seconds
    const cutoff = Date.now() - 60 * 1000;
    const filtered = history.filter(s => s.timestamp >= cutoff);
    this.spreadHistory.set(asset, filtered);
  }
  
  /**
   * Run all adverse selection filters
   */
  evaluate(
    asset: string,
    book: V27OrderBook,
    mispricedSide: 'UP' | 'DOWN'
  ): FilterResult {
    const config = getV27Config();
    
    // 1. Aggressive Flow Check
    const flowCheck = this.checkAggressiveFlow(asset, config);
    if (!flowCheck.pass) {
      return {
        pass: false,
        failedFilter: 'AGGRESSIVE_FLOW',
        details: {
          aggressiveFlow: flowCheck,
          bookShape: this.dummyBookShape(),
          spreadExpansion: this.dummySpreadExpansion(),
        },
      };
    }
    
    // 2. Book Shape Asymmetry
    const bookCheck = this.checkBookShape(book, mispricedSide);
    if (!bookCheck.pass) {
      return {
        pass: false,
        failedFilter: 'BOOK_ASYMMETRY',
        details: {
          aggressiveFlow: flowCheck,
          bookShape: bookCheck,
          spreadExpansion: this.dummySpreadExpansion(),
        },
      };
    }
    
    // 3. Spread Expansion Check
    const spreadCheck = this.checkSpreadExpansion(asset, book, mispricedSide);
    if (!spreadCheck.pass) {
      return {
        pass: false,
        failedFilter: 'SPREAD_EXPANSION',
        details: {
          aggressiveFlow: flowCheck,
          bookShape: bookCheck,
          spreadExpansion: spreadCheck,
        },
      };
    }
    
    return {
      pass: true,
      details: {
        aggressiveFlow: flowCheck,
        bookShape: bookCheck,
        spreadExpansion: spreadCheck,
      },
    };
  }
  
  /**
   * Check for aggressive taker flow
   */
  private checkAggressiveFlow(
    asset: string,
    config: { aggressiveFlowWindowSec: number; takerVolumeWindowSec: number }
  ): FilterResult['details']['aggressiveFlow'] {
    const fills = this.takerFills.get(asset) || [];
    const now = Date.now();
    
    // Get P90 threshold
    const p90 = this.takerFillP90.get(asset) || 50;
    const p85Volume = this.takerVolumeP85.get(asset) || 100;
    
    // Count large fills in last 8 seconds
    const window8s = now - config.aggressiveFlowWindowSec * 1000;
    const recentFills = fills.filter(f => f.timestamp >= window8s);
    const largeFills = recentFills.filter(f => f.size > p90);
    
    // Sum volume in last 5 seconds
    const window5s = now - config.takerVolumeWindowSec * 1000;
    const volumeLast5s = fills
      .filter(f => f.timestamp >= window5s)
      .reduce((sum, f) => sum + f.size, 0);
    
    const pass = largeFills.length === 0 && volumeLast5s <= p85Volume;
    
    return {
      pass,
      largeTakerFillsLast8s: largeFills.length,
      takerVolumeLast5s: volumeLast5s,
      p90Threshold: p90,
      p85VolumeThreshold: p85Volume,
    };
  }
  
  /**
   * Check book shape for informed pressure
   */
  private checkBookShape(
    book: V27OrderBook,
    mispricedSide: 'UP' | 'DOWN'
  ): FilterResult['details']['bookShape'] {
    // Get depths for mispriced side
    const mispricedDepth = mispricedSide === 'UP' 
      ? book.upDepthBid 
      : book.downDepthBid;
    
    const oppositeDepth = mispricedSide === 'UP'
      ? book.downDepthAsk
      : book.upDepthAsk;
    
    // Check for asymmetry: thin mispriced side + stacked opposite side
    const asymmetryRatio = oppositeDepth / (mispricedDepth || 1);
    
    // If opposite side is 3x deeper AND mispriced side is thin (<$50), skip
    const isThin = mispricedDepth < 50;
    const isStacked = asymmetryRatio > 3;
    
    const pass = !(isThin && isStacked);
    
    return {
      pass,
      mispricedSideDepth: mispricedDepth,
      oppositeSideDepth: oppositeDepth,
      asymmetryRatio,
    };
  }
  
  /**
   * Check if spread has expanded significantly
   */
  private checkSpreadExpansion(
    asset: string,
    book: V27OrderBook,
    mispricedSide: 'UP' | 'DOWN'
  ): FilterResult['details']['spreadExpansion'] {
    const history = this.spreadHistory.get(asset) || [];
    
    // Get current spread for mispriced side
    const currentSpread = mispricedSide === 'UP' ? book.spreadUp : book.spreadDown;
    
    // Calculate median spread over last 60 seconds
    if (history.length < 5) {
      // Not enough history - pass
      return {
        pass: true,
        currentSpread,
        medianSpread: currentSpread,
        expansionRatio: 1,
      };
    }
    
    const spreads = history.map(s => mispricedSide === 'UP' ? s.spreadUp : s.spreadDown);
    const sorted = [...spreads].sort((a, b) => a - b);
    const medianSpread = sorted[Math.floor(sorted.length / 2)];
    
    const expansionRatio = currentSpread / (medianSpread || 0.01);
    
    // Spread expanded > 1.5x median → SKIP
    const pass = expansionRatio <= 1.5;
    
    return {
      pass,
      currentSpread,
      medianSpread,
      expansionRatio,
    };
  }
  
  /**
   * Recalibrate percentiles from historical data
   */
  private recalibratePercentiles(asset: string): void {
    const fills = this.takerFills.get(asset) || [];
    if (fills.length < 100) return;
    
    // Calculate P90 fill size
    const sizes = fills.map(f => f.size).sort((a, b) => a - b);
    const p90Index = Math.floor(sizes.length * 0.90);
    const p90 = sizes[p90Index];
    this.takerFillP90.set(asset, p90);
    
    // Calculate P85 rolling 5s volume
    // This is more complex - would need to compute rolling windows
    // For now, use a simple heuristic
    const p85Volume = p90 * 2;
    this.takerVolumeP85.set(asset, p85Volume);
    
    console.log(`[V27] Recalibrated ${asset} taker thresholds: P90=${p90.toFixed(1)}, P85Vol=${p85Volume.toFixed(1)}`);
  }
  
  private dummyBookShape(): FilterResult['details']['bookShape'] {
    return { pass: true, mispricedSideDepth: 0, oppositeSideDepth: 0, asymmetryRatio: 1 };
  }
  
  private dummySpreadExpansion(): FilterResult['details']['spreadExpansion'] {
    return { pass: true, currentSpread: 0, medianSpread: 0, expansionRatio: 1 };
  }
}
