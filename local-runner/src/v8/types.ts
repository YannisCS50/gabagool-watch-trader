/**
 * v8 Type Definitions
 * 
 * Core types for the v8 strategy
 */

export type TokenSide = 'UP' | 'DOWN';
export type Intent = 'ENTRY' | 'HEDGE' | 'EXIT';
export type OrderSide = 'BUY' | 'SELL';
export type Liquidity = 'MAKER' | 'TAKER';

/**
 * Top of book for a single token
 */
export interface TokenBook {
  bestBid: number;
  bestAsk: number;
  depthBid: number;   // Volume at best bid
  depthAsk: number;   // Volume at best ask
  ageMs: number;      // Book staleness in ms
}

/**
 * Market snapshot containing both UP and DOWN books
 */
export interface MarketSnapshotV8 {
  ts: number;                    // Timestamp in ms
  marketId: string;              // Market slug/identifier
  asset: string;                 // Asset symbol (BTC, ETH, etc.)
  strike: number;                // Strike price
  secRemaining: number;          // Seconds until market resolution
  up: TokenBook;                 // UP token book
  down: TokenBook;               // DOWN token book
  position: PositionV8;          // Current position
  eventStartTime: string;        // ISO timestamp of event start
  eventEndTime: string;          // ISO timestamp of event end
}

/**
 * Current position in a market
 */
export interface PositionV8 {
  upShares: number;
  downShares: number;
  avgUp?: number;      // Average UP entry price
  avgDown?: number;    // Average DOWN entry price
  upInvested?: number;
  downInvested?: number;
}

/**
 * Spot price tick from external price feed
 */
export interface SpotTick {
  ts: number;
  asset: string;
  price: number;
}

/**
 * Order request
 */
export interface OrderReqV8 {
  marketId: string;
  token: TokenSide;
  side: OrderSide;
  price: number;
  size: number;
  intent: Intent;
  correlationId: string;
  // Context for telemetry
  tokenId?: string;
  eventStartTime?: string;
  eventEndTime?: string;
}

/**
 * Order response
 */
export interface OrderResV8 {
  ok: boolean;
  orderId?: string;
  avgPrice?: number;
  filledSize?: number;
  reason?: string;
}

/**
 * Fill event
 */
export interface FillEventV8 {
  ts: number;
  marketId: string;
  asset: string;
  orderId: string;
  intent: Intent;
  token: TokenSide;
  side: OrderSide;
  price: number;
  size: number;
  feeUsd?: number;
  liquidity?: Liquidity;
  secRemaining: number;
  correlationId?: string;
}

/**
 * Execution interface that v8 strategy uses to place orders
 */
export interface ExecutionV8 {
  /**
   * Place a limit order
   */
  placeLimit(req: OrderReqV8): Promise<OrderResV8>;
  
  /**
   * Cancel orders by intent for a specific token
   */
  cancelIntent(marketId: string, token: TokenSide, intent: Intent): Promise<void>;
  
  /**
   * Get current open orders for a market/token/intent combo
   */
  getOpenOrders(marketId: string, token: TokenSide, intent: Intent): number;
}

/**
 * Strategy phase for a market
 */
export type Phase = 'IDLE' | 'HAS_ENTRY' | 'HEDGE_IN_PROGRESS' | 'DONE';

/**
 * Market state tracked by the strategy
 */
export interface MarketStateV8 {
  phase: Phase;
  entryToken?: TokenSide;
  entryFillTs?: number;       // When entry was filled
  entryAvg?: number;          // Average entry price
  entryShares?: number;       // Entry position size
  hedgeAttemptCount?: number; // Number of hedge attempts
  lastHedgeAttemptTs?: number;
  hedgeToken?: TokenSide;
  hedgeShares?: number;       // Hedge position size
  hedgeAvg?: number;          // Average hedge price
  createdTs: number;          // When this state was created
}

/**
 * Kill switch state
 */
export interface KillSwitchState {
  entriesDisabled: boolean;
  disabledReason?: string;
  disabledTs?: number;
  staleBookSkipCount: number;
  totalEvalCount: number;
  makerFillCount: number;
  takerFillCount: number;
  missingFeeCount: number;
}

/**
 * Strategy statistics
 */
export interface StrategyStatsV8 {
  totalEvals: number;
  entriesAttempted: number;
  entriesFilled: number;
  hedgesAttempted: number;
  hedgesFilled: number;
  correctionsTriggered: number;
  staleBookSkips: number;
  makerFills: number;
  takerFills: number;
  surfaceUpdates: number;
}
