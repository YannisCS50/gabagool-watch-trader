/**
 * v8 Telemetry
 * 
 * Structured logging for v8 strategy events.
 * All events are prefixed with V8_ for easy filtering.
 */

import type { TokenSide, Intent, Liquidity } from './types.js';

/**
 * V8 Evaluation Event
 * Logged on every market tick/evaluation
 */
export interface V8EvalEvent {
  type: 'V8_EVAL';
  ts: number;
  marketId: string;
  asset: string;
  secRemaining: number;
  strike: number;
  spot: number;
  deltaUsd: number;
  absDeltaUsd: number;
  // UP book
  askUp: number;
  bidUp: number;
  midUp: number;
  spreadUp: number;
  depthAskUp: number;
  depthBidUp: number;
  ageUp: number;
  // DOWN book
  askDown: number;
  bidDown: number;
  midDown: number;
  spreadDown: number;
  depthAskDown: number;
  depthBidDown: number;
  ageDown: number;
  // Bucketing
  deltaBucket: number;
  tBucket: string;
  // Fair surface
  fairUp?: number;
  fairN?: number;
  fairTrusted: boolean;
  // Edge calculation
  edgeUp?: number;
  edgeDown?: number;
  // Decision
  chosen: 'UP' | 'DOWN' | 'NONE';
  reasons: string[];
  // Position
  upShares: number;
  downShares: number;
}

/**
 * V8 Order Event
 * Logged on every order attempt
 */
export interface V8OrderEvent {
  type: 'V8_ORDER';
  ts: number;
  marketId: string;
  asset: string;
  intent: Intent;
  token: TokenSide;
  side: 'BUY' | 'SELL';
  size: number;
  bestBid: number;
  bestAsk: number;
  bookAgeMs: number;
  rawPrice: number;
  finalPrice?: number;
  reject?: string;
  correlationId?: string;
}

/**
 * V8 Fill Event
 * Logged on every fill
 */
export interface V8FillEvent {
  type: 'V8_FILL';
  ts: number;
  marketId: string;
  asset: string;
  intent: Intent;
  token: TokenSide;
  price: number;
  size: number;
  feeUsd?: number;
  liquidity?: Liquidity;
  secRemaining: number;
  edgeAtFill?: number;
  correlationId?: string;
}

/**
 * V8 Correction Event
 * Logged when correction triggers hedge
 */
export interface V8CorrectionEvent {
  type: 'V8_CORRECTION';
  ts: number;
  marketId: string;
  asset: string;
  entryToken: TokenSide;
  secSinceEntryFill: number;
  edgeNow: number;
  unrealizedUsd: number;
  midEntry: number;
  entryAvg: number;
}

/**
 * V8 Skip Event
 * Logged when entry/hedge is skipped
 */
export interface V8SkipEvent {
  type: 'V8_SKIP';
  ts: number;
  marketId: string;
  asset: string;
  intent: Intent;
  token?: TokenSide;
  reason: string;
  details?: Record<string, unknown>;
}

/**
 * V8 State Change Event
 * Logged on phase transitions
 */
export interface V8StateChangeEvent {
  type: 'V8_STATE_CHANGE';
  ts: number;
  marketId: string;
  asset: string;
  fromPhase: string;
  toPhase: string;
  reason: string;
}

/**
 * V8 Kill Switch Event
 * Logged when kill switch triggers
 */
export interface V8KillSwitchEvent {
  type: 'V8_KILL_SWITCH';
  ts: number;
  reason: string;
  details: Record<string, unknown>;
}

/**
 * Union of all V8 events
 */
export type V8Event =
  | V8EvalEvent
  | V8OrderEvent
  | V8FillEvent
  | V8CorrectionEvent
  | V8SkipEvent
  | V8StateChangeEvent
  | V8KillSwitchEvent;

/**
 * Telemetry interface
 */
export interface TelemetryV8 {
  emit(event: V8Event): void;
}

/**
 * Console-based telemetry implementation
 */
export class ConsoleTelemetryV8 implements TelemetryV8 {
  private logEvals: boolean;
  private logSkips: boolean;
  private logOrders: boolean;
  private logFills: boolean;
  private logCorrections: boolean;
  
  constructor(options: {
    logEvals?: boolean;
    logSkips?: boolean;
    logOrders?: boolean;
    logFills?: boolean;
    logCorrections?: boolean;
  } = {}) {
    this.logEvals = options.logEvals ?? false;
    this.logSkips = options.logSkips ?? true;
    this.logOrders = options.logOrders ?? true;
    this.logFills = options.logFills ?? true;
    this.logCorrections = options.logCorrections ?? true;
  }
  
  emit(event: V8Event): void {
    switch (event.type) {
      case 'V8_EVAL':
        if (this.logEvals) {
          console.log(`[V8_EVAL] ${event.asset} ${event.marketId} ` +
            `spot=${event.spot.toFixed(2)} strike=${event.strike.toFixed(2)} ` +
            `delta=${event.deltaUsd.toFixed(2)} sec=${event.secRemaining} ` +
            `fairUp=${event.fairUp?.toFixed(3) ?? 'NA'} trusted=${event.fairTrusted} ` +
            `edgeUp=${event.edgeUp?.toFixed(3) ?? 'NA'} edgeDown=${event.edgeDown?.toFixed(3) ?? 'NA'} ` +
            `chosen=${event.chosen} reasons=[${event.reasons.join(',')}]`);
        }
        break;
        
      case 'V8_ORDER':
        if (this.logOrders) {
          const status = event.finalPrice ? `price=${(event.finalPrice * 100).toFixed(0)}¢` : `REJECTED:${event.reject}`;
          console.log(`[V8_ORDER] ${event.asset} ${event.marketId} ` +
            `${event.intent} ${event.token} ${event.side} ` +
            `size=${event.size} ${status} ` +
            `book=[${(event.bestBid * 100).toFixed(0)}/${(event.bestAsk * 100).toFixed(0)}¢] age=${event.bookAgeMs}ms`);
        }
        break;
        
      case 'V8_FILL':
        if (this.logFills) {
          console.log(`[V8_FILL] ${event.asset} ${event.marketId} ` +
            `${event.intent} ${event.token} ` +
            `size=${event.size} price=${(event.price * 100).toFixed(1)}¢ ` +
            `fee=$${event.feeUsd?.toFixed(4) ?? 'NA'} liq=${event.liquidity ?? 'NA'} ` +
            `sec=${event.secRemaining}`);
        }
        break;
        
      case 'V8_CORRECTION':
        if (this.logCorrections) {
          console.log(`[V8_CORRECTION] 🎯 ${event.asset} ${event.marketId} ` +
            `entry=${event.entryToken} ` +
            `secSinceFill=${event.secSinceEntryFill.toFixed(1)} ` +
            `edgeNow=${(event.edgeNow * 100).toFixed(1)}¢ ` +
            `unrealized=$${event.unrealizedUsd.toFixed(2)}`);
        }
        break;
        
      case 'V8_SKIP':
        if (this.logSkips) {
          console.log(`[V8_SKIP] ${event.asset} ${event.marketId} ` +
            `${event.intent} ${event.token ?? ''} reason=${event.reason}`);
        }
        break;
        
      case 'V8_STATE_CHANGE':
        console.log(`[V8_STATE] ${event.asset} ${event.marketId} ` +
          `${event.fromPhase} → ${event.toPhase} (${event.reason})`);
        break;
        
      case 'V8_KILL_SWITCH':
        console.log(`[V8_KILL_SWITCH] ⚠️ ${event.reason} ` +
          `details=${JSON.stringify(event.details)}`);
        break;
    }
  }
}

// Default telemetry instance
let telemetryInstance: TelemetryV8 | null = null;

/**
 * Get the telemetry instance
 */
export function getTelemetry(): TelemetryV8 {
  if (!telemetryInstance) {
    telemetryInstance = new ConsoleTelemetryV8({
      logEvals: false,
      logSkips: true,
      logOrders: true,
      logFills: true,
      logCorrections: true,
    });
  }
  return telemetryInstance;
}

/**
 * Set a custom telemetry instance
 */
export function setTelemetry(tel: TelemetryV8): void {
  telemetryInstance = tel;
}
