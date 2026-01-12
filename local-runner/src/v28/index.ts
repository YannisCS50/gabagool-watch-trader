/**
 * V28 Strategy - Binance vs Chainlink Arbitrage
 * 
 * Standalone runner that exploits latency between Binance (fast) and Chainlink (slow)
 * to buy UP/DOWN shares before Chainlink catches up.
 * 
 * Core concept:
 * 1. Watch Binance WebSocket for price moves
 * 2. When cumulative delta exceeds threshold within rolling window
 * 3. Buy shares on the side that will win (UP if price rising, DOWN if falling)
 * 4. TP/SL monitoring until exit
 */

export const V28_VERSION = '28.0.0';
export const V28_NAME = 'Binance-Chainlink Arbitrage';

export { startV28Runner, stopV28Runner, getV28Stats } from './runner.js';
export { V28Config, loadV28Config, DEFAULT_V28_CONFIG } from './config.js';
