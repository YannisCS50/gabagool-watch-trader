/**
 * strategy.ts - Active Strategy Wrapper
 * =====================================
 * Reverted to v2.1.0 (loveable-strat) - the profitable version from Jan 2 ~13:00
 * 
 * Key differences from v5.2.4:
 * - Conservative expensive side buying (only hedge expensive side if locks profit, high certainty ≥85%, or time critical)
 * - Probability bias: skips losing hedge when price is far from strike
 * - Strict 1:1 balance requirement for accumulation
 * - Standard cooldown (10s) instead of 0
 * - Combined cost must be <1.00 for hedge (not 1.05)
 */

// Re-export everything from loveable-strat (v2.1.0)
export * from './loveable-strat.js';

// Override version identifiers
export const STRATEGY_VERSION = '2.1.0-strict-balance';
export const STRATEGY_NAME = 'Polymarket 15m Hedge & Arbitrage (v2.1.0 - Profitable)';
