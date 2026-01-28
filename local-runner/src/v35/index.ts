// ============================================================
// V35 INDEX - Re-exports all V35 modules
// ============================================================
// Version: V35.3.3 - "Proactive Hedging"
// ============================================================

export * from './config.js';
export * from './types.js';
export * from './quoting-engine.js';
export * from './market-discovery.js';
export * from './order-manager.js';
export * from './fill-tracker.js';
export * from './hedge-manager.js';
export * from './proactive-rebalancer.js';
export * from './circuit-breaker.js';
export * from './backend.js';
export * from './utils.js';
export * from './user-ws.js';

export const V35_VERSION = 'V35.3.6';
export const V35_NAME = 'Strict Balance - Only quote on lagging side to maintain 1:1 ratio';
