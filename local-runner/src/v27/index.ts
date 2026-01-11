// ============================================================
// V27 POLYMARKET — DELTA MISPRICING STRATEGY
// ============================================================
//
// Core Philosophy: Trade ONLY state mispricing, never spread arbitrage.
//
// Mispricing definition:
// - Spot price has moved meaningfully relative to strike
// - Polymarket UP/DOWN prices have NOT yet adjusted proportionally
// - The lag is temporary and historically mean-reverting
//
// Sequence:
// 1) Detect mispricing using spot → Polymarket lag
// 2) Enter ONLY the mispriced side
// 3) Wait for correction
// 4) Hedge ONLY AFTER correction (optional, risk-managed)
//
// ============================================================

export const V27_VERSION = '27.0.0';
export const V27_NAME = 'Polymarket V27 - Delta Mispricing Strategy';

// Core modules
export { V27Config, getV27Config, loadV27Config } from './config.js';
export { MispricingDetector, MispricingSignal } from './mispricing-detector.js';
export { AdverseSelectionFilter, FilterResult } from './adverse-selection-filter.js';
export { EntryManager, EntryDecision } from './entry-manager.js';
export { CorrectionMonitor, CorrectionStatus } from './correction-monitor.js';
export { HedgeManager, HedgeDecision } from './hedge-manager.js';
export { V27Logger, V27EvaluationLog, V27TradeLog } from './logger.js';

// Types
export interface V27Market {
  id: string;
  slug: string;
  asset: string;
  strikePrice: number;
  eventStartTime: Date;
  eventEndTime: Date;
  upTokenId: string;
  downTokenId: string;
}

export interface V27OrderBook {
  upBid: number;
  upAsk: number;
  upMid: number;
  upDepthBid: number;
  upDepthAsk: number;
  downBid: number;
  downAsk: number;
  downMid: number;
  downDepthBid: number;
  downDepthAsk: number;
  spreadUp: number;
  spreadDown: number;
  timestamp: number;
}

export interface V27SpotData {
  price: number;
  timestamp: number;
  source: string;
}

export interface V27Position {
  marketId: string;
  asset: string;
  side: 'UP' | 'DOWN';
  shares: number;
  avgPrice: number;
  entryTime: number;
  correctionConfirmed: boolean;
  hedged: boolean;
  hedgeShares?: number;
  hedgeAvgPrice?: number;
}

export interface V27Stats {
  totalEvaluations: number;
  mispricingsDetected: number;
  tradesEntered: number;
  correctionsConfirmed: number;
  hedgesExecuted: number;
  totalPnl: number;
  winRate: number;
}

/**
 * Log V27 status
 */
export function logV27Status(config: { enabled: boolean; assets: string[] }, stats: V27Stats): void {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  📊 V27 DELTA MISPRICING STRATEGY STATUS                      ║');
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log(`║  Version:      ${V27_VERSION.padEnd(46)}║`);
  console.log(`║  Enabled:      ${config.enabled ? 'YES' : 'NO'}`.padEnd(66) + '║');
  console.log(`║  Assets:       ${config.assets.join(', ')}`.padEnd(66) + '║');
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log(`║  Evaluations:  ${stats.totalEvaluations}`.padEnd(66) + '║');
  console.log(`║  Mispricings:  ${stats.mispricingsDetected}`.padEnd(66) + '║');
  console.log(`║  Entries:      ${stats.tradesEntered}`.padEnd(66) + '║');
  console.log(`║  Corrections:  ${stats.correctionsConfirmed}`.padEnd(66) + '║');
  console.log(`║  Hedges:       ${stats.hedgesExecuted}`.padEnd(66) + '║');
  console.log(`║  Total PnL:    $${stats.totalPnl.toFixed(2)}`.padEnd(66) + '║');
  console.log(`║  Win Rate:     ${(stats.winRate * 100).toFixed(1)}%`.padEnd(66) + '║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');
}
