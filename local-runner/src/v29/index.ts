/**
 * V29 Simple Live Runner
 * 
 * A clean, simple implementation for live trading on Polymarket:
 * 
 * Key Features:
 * - Tick-to-tick delta detection (same as UI visualization)
 * - Realtime orderbook pricing (no pre-signed cache complexity)
 * - Direct GTC orders at bestAsk + buffer
 * - Simple TP/SL/Timeout position management
 * - Single position at a time (no concurrent trades)
 * 
 * Usage:
 *   npm run v29
 * 
 * Configuration via v27_config table (id='v29-live' or 'v28-live')
 */

export { DEFAULT_CONFIG } from './config.js';
export type { V29Config, Asset } from './config.js';
export type { MarketInfo, PriceState, Signal, Position } from './types.js';
