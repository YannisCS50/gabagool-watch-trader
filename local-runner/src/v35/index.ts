// ============================================================
// V35 INDEX - Re-exports all V35 modules
// ============================================================
// Version: V35.3.0 - "Robust Hedging"
// ============================================================

export * from './config.js';
export * from './types.js';
export * from './quoting-engine.js';
export * from './market-discovery.js';
export * from './order-manager.js';
export * from './fill-tracker.js';
export * from './hedge-manager.js';
export * from './circuit-breaker.js';
export * from './backend.js';

export const V35_VERSION = 'V35.3.0';
export const V35_NAME = 'Robust Hedging - Circuit Breaker Protected';
