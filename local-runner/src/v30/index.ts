/**
 * V30 Market-Maker Strategy
 * 
 * Bidirectional trading with fair value calculation,
 * dynamic thresholds, and active inventory control.
 * 
 * NEW: Empirical Crossing Model for statistically-validated
 * probability estimates with 95% confidence intervals.
 */

export * from './types.js';
export * from './config.js';
export { EmpiricalFairValue, getFairValueModel, resetFairValueModel } from './fair-value.js';
export { EmpiricalCrossingModel, getCrossingModel, resetCrossingModel } from './crossing-model.js';
export { EdgeCalculator } from './edge-calculator.js';
export { InventoryManager } from './inventory.js';
export * from './db.js';
