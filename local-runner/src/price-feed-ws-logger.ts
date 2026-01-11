/**
 * price-feed-ws-logger.ts
 * 
 * Dedicated WebSocket logger for millisecond-precision price feeds.
 * Connects to Binance and Polymarket RTDS, logs every tick to database.
 * Runs independently alongside v26/v7/v8 trading strategies.
 * 
 * Usage: 
 *   import { startPriceFeedLogger, stopPriceFeedLogger } from './price-feed-ws-logger.js';
 *   startPriceFeedLogger();
 */

import WebSocket from 'ws';
import { config } from './config.js';

// Types
export interface PriceTickLog {
  source: 'binance_ws' | 'polymarket_rtds' | 'chainlink_rtds';
  asset: string;
  price: number;
  raw_timestamp: number;  // Original timestamp from source
  received_at: number;    // Local timestamp when received
}

interface LoggerStats {
  binance: {
    connected: boolean;
    messageCount: number;
    lastMessageAt: number;
    reconnects: number;
  };
  polymarket: {
    connected: boolean;
    messageCount: number;
    lastMessageAt: number;
    reconnects: number;
  };
  totalLogged: number;
  bufferSize: number;
  flushCount: number;
  startedAt: number;
  errors: number;
}

// Config
const BINANCE_WS_URL = 'wss://stream.binance.com:9443/ws';
const POLYMARKET_RTDS_URL = 'wss://ws-live-data.polymarket.com';

const ASSETS = ['BTC', 'ETH', 'SOL', 'XRP'];
const BINANCE_SYMBOLS = ['btcusdt', 'ethusdt', 'solusdt', 'xrpusdt'];

const FLUSH_INTERVAL_MS = 2000;  // Flush every 2 seconds
const MAX_BUFFER_SIZE = 200;     // Or when buffer hits 200 items
const RECONNECT_DELAY_MS = 5000; // Wait 5s before reconnect

// State
let binanceWs: WebSocket | null = null;
let polymarketWs: WebSocket | null = null;
let isRunning = false;
let logBuffer: PriceTickLog[] = [];
let lastFlushTime = Date.now();
let flushInterval: NodeJS.Timeout | null = null;
let pingInterval: NodeJS.Timeout | null = null;

const stats: LoggerStats = {
  binance: { connected: false, messageCount: 0, lastMessageAt: 0, reconnects: 0 },
  polymarket: { connected: false, messageCount: 0, lastMessageAt: 0, reconnects: 0 },
  totalLogged: 0,
  bufferSize: 0,
  flushCount: 0,
  startedAt: 0,
  errors: 0,
};

// Backend save function
async function savePriceTicksToDb(ticks: PriceTickLog[]): Promise<boolean> {
  if (ticks.length === 0) return true;
  
  try {
    const response = await fetch(config.backend.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Runner-Secret': config.backend.secret,
      },
      body: JSON.stringify({
        action: 'save-realtime-price-logs',
        data: { logs: ticks }
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error(`[PriceFeedLogger] DB save error ${response.status}: ${text}`);
      stats.errors++;
      return false;
    }

    return true;
  } catch (error) {
    console.error('[PriceFeedLogger] DB save error:', error);
    stats.errors++;
    return false;
  }
}

// Flush buffer to database
async function flushBuffer(): Promise<void> {
  if (logBuffer.length === 0) return;

  const logsToSave = [...logBuffer];
  logBuffer = [];
  stats.bufferSize = 0;

  const success = await savePriceTicksToDb(logsToSave);
  
  if (success) {
    stats.flushCount++;
    console.log(`[PriceFeedLogger] Flushed ${logsToSave.length} ticks (total: ${stats.totalLogged})`);
  } else {
    // Put back failed logs
    logBuffer = [...logsToSave, ...logBuffer];
    stats.bufferSize = logBuffer.length;
  }

  lastFlushTime = Date.now();
}

// Add tick to buffer
function addTick(tick: PriceTickLog): void {
  logBuffer.push(tick);
  stats.totalLogged++;
  stats.bufferSize = logBuffer.length;

  // Flush if buffer is full
  if (logBuffer.length >= MAX_BUFFER_SIZE) {
    flushBuffer();
  }
}

// ============ BINANCE WEBSOCKET ============

function connectBinance(): void {
  if (binanceWs?.readyState === WebSocket.OPEN) return;

  console.log('[PriceFeedLogger] Connecting to Binance WebSocket...');
  
  // Subscribe to all asset mini tickers
  const streams = BINANCE_SYMBOLS.map(s => `${s}@trade`).join('/');
  const url = `${BINANCE_WS_URL}/${streams}`;
  
  binanceWs = new WebSocket(url);

  binanceWs.on('open', () => {
    console.log('[PriceFeedLogger] ✅ Binance WebSocket connected');
    stats.binance.connected = true;
  });

  binanceWs.on('message', (data: WebSocket.Data) => {
    try {
      const msg = JSON.parse(data.toString());
      const now = Date.now();
      stats.binance.lastMessageAt = now;
      stats.binance.messageCount++;

      // Trade event: { s: 'BTCUSDT', p: '43000.12', T: 1234567890123 }
      if (msg.e === 'trade' && msg.s && msg.p && msg.T) {
        const symbol = msg.s.replace('USDT', '').toUpperCase();
        if (ASSETS.includes(symbol)) {
          addTick({
            source: 'binance_ws',
            asset: symbol,
            price: parseFloat(msg.p),
            raw_timestamp: msg.T,
            received_at: now,
          });
        }
      }
    } catch (e) {
      // Ignore parse errors
    }
  });

  binanceWs.on('error', (error) => {
    console.error('[PriceFeedLogger] Binance WebSocket error:', error.message);
    stats.binance.connected = false;
    stats.errors++;
  });

  binanceWs.on('close', () => {
    console.log('[PriceFeedLogger] Binance WebSocket disconnected');
    stats.binance.connected = false;
    
    if (isRunning) {
      stats.binance.reconnects++;
      console.log(`[PriceFeedLogger] Reconnecting Binance in ${RECONNECT_DELAY_MS}ms...`);
      setTimeout(connectBinance, RECONNECT_DELAY_MS);
    }
  });
}

// ============ POLYMARKET RTDS WEBSOCKET ============

function connectPolymarket(): void {
  if (polymarketWs?.readyState === WebSocket.OPEN) return;

  console.log('[PriceFeedLogger] Connecting to Polymarket RTDS...');
  
  polymarketWs = new WebSocket(POLYMARKET_RTDS_URL);

  polymarketWs.on('open', () => {
    console.log('[PriceFeedLogger] ✅ Polymarket RTDS connected');
    stats.polymarket.connected = true;

    // Subscribe to crypto prices (both Polymarket and Chainlink)
    polymarketWs?.send(JSON.stringify({
      action: 'subscribe',
      topic: 'crypto_prices'
    }));
    
    polymarketWs?.send(JSON.stringify({
      action: 'subscribe',
      topic: 'crypto_prices_chainlink'
    }));
  });

  polymarketWs.on('message', (data: WebSocket.Data) => {
    try {
      const msg = JSON.parse(data.toString());
      const now = Date.now();
      stats.polymarket.lastMessageAt = now;
      stats.polymarket.messageCount++;

      // Handle crypto_prices topic (Polymarket prices)
      if (msg.topic === 'crypto_prices' && msg.data) {
        const timestamp = msg.timestamp || now;
        for (const [asset, priceData] of Object.entries(msg.data)) {
          if (priceData && typeof priceData === 'object' && 'value' in (priceData as object)) {
            const price = (priceData as { value: number }).value;
            if (price > 0 && ASSETS.includes(asset.toUpperCase())) {
              addTick({
                source: 'polymarket_rtds',
                asset: asset.toUpperCase(),
                price,
                raw_timestamp: timestamp,
                received_at: now,
              });
            }
          }
        }
      }

      // Handle crypto_prices_chainlink topic (Chainlink oracle prices)
      if (msg.topic === 'crypto_prices_chainlink' && msg.data) {
        const timestamp = msg.timestamp || now;
        for (const [asset, priceData] of Object.entries(msg.data)) {
          if (priceData && typeof priceData === 'object' && 'value' in (priceData as object)) {
            const price = (priceData as { value: number }).value;
            if (price > 0 && ASSETS.includes(asset.toUpperCase())) {
              addTick({
                source: 'chainlink_rtds',
                asset: asset.toUpperCase(),
                price,
                raw_timestamp: timestamp,
                received_at: now,
              });
            }
          }
        }
      }
    } catch (e) {
      // Ignore parse errors
    }
  });

  polymarketWs.on('error', (error) => {
    console.error('[PriceFeedLogger] Polymarket RTDS error:', error.message);
    stats.polymarket.connected = false;
    stats.errors++;
  });

  polymarketWs.on('close', () => {
    console.log('[PriceFeedLogger] Polymarket RTDS disconnected');
    stats.polymarket.connected = false;
    
    if (isRunning) {
      stats.polymarket.reconnects++;
      console.log(`[PriceFeedLogger] Reconnecting Polymarket in ${RECONNECT_DELAY_MS}ms...`);
      setTimeout(connectPolymarket, RECONNECT_DELAY_MS);
    }
  });
}

// ============ PUBLIC API ============

export function startPriceFeedLogger(): void {
  if (isRunning) {
    console.log('[PriceFeedLogger] Already running');
    return;
  }

  console.log('');
  console.log('╔════════════════════════════════════════════════════════════════╗');
  console.log('║  📊 PRICE FEED WEBSOCKET LOGGER                                ║');
  console.log('╠════════════════════════════════════════════════════════════════╣');
  console.log('║  Sources: Binance WS + Polymarket RTDS (incl. Chainlink)       ║');
  console.log('║  Assets:  BTC, ETH, SOL, XRP                                   ║');
  console.log(`║  Flush:   Every ${FLUSH_INTERVAL_MS}ms or ${MAX_BUFFER_SIZE} ticks                            ║`);
  console.log('╚════════════════════════════════════════════════════════════════╝');
  console.log('');

  isRunning = true;
  stats.startedAt = Date.now();
  stats.totalLogged = 0;
  stats.flushCount = 0;
  stats.errors = 0;

  // Connect to both WebSockets
  connectBinance();
  connectPolymarket();

  // Periodic flush timer
  flushInterval = setInterval(() => {
    if (Date.now() - lastFlushTime > FLUSH_INTERVAL_MS && logBuffer.length > 0) {
      flushBuffer();
    }
  }, FLUSH_INTERVAL_MS);

  // Keep-alive pings
  pingInterval = setInterval(() => {
    if (polymarketWs?.readyState === WebSocket.OPEN) {
      polymarketWs.send(JSON.stringify({ action: 'ping' }));
    }
  }, 30000);
}

export function stopPriceFeedLogger(): void {
  if (!isRunning) return;

  console.log('[PriceFeedLogger] Stopping...');
  isRunning = false;

  // Clear intervals
  if (flushInterval) {
    clearInterval(flushInterval);
    flushInterval = null;
  }
  if (pingInterval) {
    clearInterval(pingInterval);
    pingInterval = null;
  }

  // Close WebSockets
  if (binanceWs) {
    binanceWs.close();
    binanceWs = null;
  }
  if (polymarketWs) {
    polymarketWs.close();
    polymarketWs = null;
  }

  // Final flush
  flushBuffer();

  console.log('[PriceFeedLogger] Stopped');
  logPriceFeedLoggerStats();
}

export function getPriceFeedLoggerStats(): LoggerStats {
  return { ...stats, bufferSize: logBuffer.length };
}

export function logPriceFeedLoggerStats(): void {
  const uptime = isRunning ? Date.now() - stats.startedAt : 0;
  const uptimeMin = Math.floor(uptime / 60000);
  const uptimeSec = Math.floor((uptime % 60000) / 1000);

  console.log('');
  console.log('┌─────────────────────────────────────────────────────┐');
  console.log('│  📊 PRICE FEED LOGGER STATUS                        │');
  console.log('├─────────────────────────────────────────────────────┤');
  console.log(`│  Running: ${isRunning ? '✅ YES' : '❌ NO'}`.padEnd(54) + '│');
  console.log(`│  Uptime: ${uptimeMin}m ${uptimeSec}s`.padEnd(54) + '│');
  console.log('├─────────────────────────────────────────────────────┤');
  console.log(`│  Binance:`.padEnd(54) + '│');
  console.log(`│    Connected: ${stats.binance.connected ? '✅' : '❌'}`.padEnd(54) + '│');
  console.log(`│    Messages: ${stats.binance.messageCount.toLocaleString()}`.padEnd(54) + '│');
  console.log(`│    Reconnects: ${stats.binance.reconnects}`.padEnd(54) + '│');
  console.log('├─────────────────────────────────────────────────────┤');
  console.log(`│  Polymarket RTDS:`.padEnd(54) + '│');
  console.log(`│    Connected: ${stats.polymarket.connected ? '✅' : '❌'}`.padEnd(54) + '│');
  console.log(`│    Messages: ${stats.polymarket.messageCount.toLocaleString()}`.padEnd(54) + '│');
  console.log(`│    Reconnects: ${stats.polymarket.reconnects}`.padEnd(54) + '│');
  console.log('├─────────────────────────────────────────────────────┤');
  console.log(`│  Total logged: ${stats.totalLogged.toLocaleString()}`.padEnd(54) + '│');
  console.log(`│  Buffer size: ${logBuffer.length}`.padEnd(54) + '│');
  console.log(`│  Flush count: ${stats.flushCount}`.padEnd(54) + '│');
  console.log(`│  Errors: ${stats.errors}`.padEnd(54) + '│');
  console.log('└─────────────────────────────────────────────────────┘');
  console.log('');
}

export function isPriceFeedLoggerRunning(): boolean {
  return isRunning;
}
