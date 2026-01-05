/**
 * Strategy v7.0 Main Entry Point
 * ============================================================
 * Re-exports all v7 modules for easy consumption
 */

// Types
export * from './types.js';

// Configuration
export {
  STRATEGY_VERSION,
  STRATEGY_NAME,
  DEFAULT_CONFIG,
  getConfig,
  setResolvedConfig,
  mergeWithEnvOverrides,
  validateConfig,
  logEffectiveConfig,
  type StrategyV7Config,
} from './config.js';

// Readiness Gates
export {
  isTokenReady,
  isMarketReady,
  updateReadinessCache,
  enrichSnapshotWithReadiness,
  checkReadinessGate,
  parkIntent,
  getParkedIntent,
  clearParkedIntent,
  createActionSkippedEvent,
} from './readiness.js';

// Inventory Management
export {
  createEmptyInventory,
  updateInventoryOnFill,
  calculateInventoryRisk,
  calculatePairCost,
  calculateAveragePairCost,
  projectPairCostAfterBuy,
  calculateSkew,
  getDominantSide,
  getWeakSide,
  evaluateDegradedMode,
  createInventoryLogEvent,
} from './inventory.js';

// Intent Building
export {
  calculateDeltaPct,
  getDeltaRegime,
  getMaxSkewForRegime,
  determineHedgeMode,
  determineBotState,
  buildEntryIntents,
  buildHedgeIntents,
  buildMicroHedgeIntent,
  buildIntentsV7,
} from './intents.js';

// Circuit Breaker (from separate module)
export {
  CircuitBreaker,
  createCircuitBreaker,
  recordFailure,
  recordSuccess,
  isCircuitOpen,
  getCircuitBreakerStats,
} from './circuit-breaker.js';

// Queue Management
export {
  IntentQueue,
  createIntentQueue,
  enqueueIntent,
  dequeueIntent,
  getQueueStats,
  isQueueStressed,
  pruneStaleIntents,
} from './queue.js';
