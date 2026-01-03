/**
 * strategy.ts - Active Strategy Wrapper
 * =====================================
 * v5.3.0 - Always Hedge Edition (Overpay Strategy)
 * 
 * Key features:
 * - allowOverpay: 0.02 → hedge allowed up to 1.02 combined (2% overpay)
 * - No probability bias skip - ALWAYS hedge
 * - Time-critical mode: hedge up to 1.05 combined if <2 min left
 * - High certainty mode: hedge if market ≥85% confident
 * - Fallback: hedge after 20s stuck one-sided
 */

// Re-export everything from loveable-strat (v5.3.0)
export * from './loveable-strat.js';

// Override version identifiers
export const STRATEGY_VERSION = '5.3.0-overpay';
export const STRATEGY_NAME = 'Polymarket 15m Hedge & Arbitrage (v5.3.0 - Always Hedge)';
