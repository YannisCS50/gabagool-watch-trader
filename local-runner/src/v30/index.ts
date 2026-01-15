/**
 * V30 Market-Maker Strategy
 * 
 * Bidirectional trading with fair value calculation,
 * dynamic thresholds, and active inventory control.
 */

export * from './types.js';
export * from './config.js';
export { EmpiricalFairValue, getFairValueModel, resetFairValueModel } from './fair-value.js';
export { EdgeCalculator } from './edge-calculator.js';
export { InventoryManager } from './inventory.js';
export * from './db.js';
