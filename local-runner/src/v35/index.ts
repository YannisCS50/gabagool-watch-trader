// ============================================================
// V36 INDEX - Re-exports all V35/V36 modules
// ============================================================
// Version: V36.0.0 - "Professional Market Making"
// ============================================================

export * from './config.js';
export * from './types.js';
export * from './quoting-engine.js';
export * from './market-discovery.js';
export * from './order-manager.js';
export * from './fill-tracker.js';
export * from './hedge-manager.js';
export * from './proactive-rebalancer.js';
export * from './emergency-recovery.js';
export * from './circuit-breaker.js';
export * from './backend.js';
export * from './utils.js';
export * from './user-ws.js';

// V36: New professional market making modules
export * from './combined-book.js';
export * from './depth-parser.js';
export * from './v36-quoting-engine.js';

export const V35_VERSION = 'V36.0.0';
export const V35_NAME = 'Professional Market Making - Combined Book Analysis';
