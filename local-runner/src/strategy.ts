/**
 * strategy.ts - Active Strategy Wrapper
 * =====================================
 * GPT Strategy v6.0 – Adaptive Hedger
 * 
 * Core Principle:
 * Buy YES + NO asymmetrically when combined < $1.00
 * Guaranteed profit = min(QtyYES, QtyNO) - (CostYES + CostNO)
 * 
 * Key Features:
 * - Dynamic edge buffer adapts to liquidity/adverse conditions
 * - Execution-aware edge calculation (ask + mid, not mid + mid)
 * - Force hedge after 12s timeout (never stay one-sided)
 * - Deep Dislocation mode for extreme mispricings (≤96¢)
 * - Skew management targets 50/50, max 70/30
 * - Base trade $25, scale to $50 on strong edges (≥4¢)
 * 
 * States: FLAT → ONE_SIDED → HEDGED / SKEWED / DEEP_DISLOCATION
 */

// Re-export everything from loveable-strat (v6.0)
export * from './loveable-strat.js';

// Override version identifiers
export const STRATEGY_VERSION = '6.0.0';
export const STRATEGY_NAME = 'GPT Strategy v6.0 – Adaptive Hedger (Polymarket 15m Bot)';
