/**
 * v8 Module Index
 * 
 * Exports all v8 strategy components
 */

// Configuration
export { V8, getAssetBucketConfig, type V8Config, type V8Asset } from './config.js';

// Bucketing
export { 
  clamp, 
  bucketDelta, 
  bucketDeltaForAsset, 
  bucketTime, 
  bucketTimeStandard, 
  formatTimeBucket,
  getBucketKey,
  type TimeBucket,
} from './buckets.js';

// Fair Price Surface
export {
  FairSurface,
  getSurface,
  resetSurface,
  type FairCell,
} from './fairSurface.js';

// Price Guard
export {
  roundDown,
  roundUp,
  roundPrice,
  isBookFresh,
  isBookValid,
  validateMakerPrice,
  computeMakerBuyPrice,
  computeMakerSellPrice,
  validateEmergencyCrossPrice,
  getSpread,
  getMid,
  type Side,
  type BookTop,
  type ValidationResult,
} from './priceGuard.js';

// Types
export type {
  TokenSide,
  Intent,
  OrderSide,
  Liquidity,
  TokenBook,
  MarketSnapshotV8,
  PositionV8,
  SpotTick,
  OrderReqV8,
  OrderResV8,
  FillEventV8,
  ExecutionV8,
  Phase,
  MarketStateV8,
  KillSwitchState,
  StrategyStatsV8,
} from './types.js';

// Telemetry
export {
  ConsoleTelemetryV8,
  getTelemetry,
  setTelemetry,
  type TelemetryV8,
  type V8Event,
  type V8EvalEvent,
  type V8OrderEvent,
  type V8FillEvent,
  type V8CorrectionEvent,
  type V8SkipEvent,
  type V8StateChangeEvent,
  type V8KillSwitchEvent,
} from './telemetryV8.js';

// Strategy
export {
  StrategyV8,
  getStrategy,
  initStrategy,
  resetStrategy,
} from './strategyV8.js';

// Execution Adapter
export {
  ExecutionAdapterV8,
  createExecutionAdapter,
  type PlaceOrderFn,
  type GetOrderbookDepthFn,
  type CancelOrdersFn,
  type TokenIdResolver,
  type ExecutionAdapterConfig,
} from './executionV8.js';
