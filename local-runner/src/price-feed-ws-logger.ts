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
// Polymarket RTDS connection details (official docs): wss://ws-live-data.polymarket.com
const POLYMARKET_RTDS_URL = 'wss://ws-live-data.polymarket.com';

const ASSETS = ['BTC', 'ETH', 'SOL', 'XRP'];
const BINANCE_SYMBOLS = ['btcusdt', 'ethusdt', 'solusdt', 'xrpusdt'];

const FLUSH_INTERVAL_MS = 2000;  // Flush every 2 seconds
const MAX_BUFFER_SIZE = 200;     // Or when buffer hits 200 items
const RECONNECT_DELAY_MS = 5000; // Wait 5s before reconnect
const HEALTH_CHECK_INTERVAL_MS = 10000; // Check health every 10s
const STALE_THRESHOLD_MS = 30000; // Consider stale if no data for 30s

// State
let binanceWs: WebSocket | null = null;
let polymarketWs: WebSocket | null = null;
let isRunning = false;
let logBuffer: PriceTickLog[] = [];
let lastFlushTime = Date.now();
let flushInterval: NodeJS.Timeout | null = null;
let pingInterval: NodeJS.Timeout | null = null;
let healthCheckInterval: NodeJS.Timeout | null = null;
let binanceReconnectTimer: NodeJS.Timeout | null = null;
let polymarketReconnectTimer: NodeJS.Timeout | null = null;

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

function forceReconnectBinance(): void {
  console.log('[PriceFeedLogger] 🔄 Force reconnecting Binance...');
  
  // Clear any pending reconnect timer
  if (binanceReconnectTimer) {
    clearTimeout(binanceReconnectTimer);
    binanceReconnectTimer = null;
  }
  
  // Close existing connection if any
  if (binanceWs) {
    try {
      binanceWs.removeAllListeners();
      binanceWs.terminate();
    } catch (e) { /* ignore */ }
    binanceWs = null;
  }
  
  stats.binance.connected = false;
  stats.binance.reconnects++;
  
  // Reconnect after delay
  binanceReconnectTimer = setTimeout(connectBinance, RECONNECT_DELAY_MS);
}

function connectBinance(): void {
  if (!isRunning) return;
  if (binanceWs?.readyState === WebSocket.OPEN) return;

  // Clear any pending reconnect timer
  if (binanceReconnectTimer) {
    clearTimeout(binanceReconnectTimer);
    binanceReconnectTimer = null;
  }

  console.log('[PriceFeedLogger] Connecting to Binance WebSocket...');
  
  // Subscribe to all asset mini tickers
  const streams = BINANCE_SYMBOLS.map(s => `${s}@trade`).join('/');
  const url = `${BINANCE_WS_URL}/${streams}`;
  
  try {
    binanceWs = new WebSocket(url);
  } catch (e) {
    console.error('[PriceFeedLogger] Failed to create Binance WebSocket:', e);
    stats.errors++;
    binanceReconnectTimer = setTimeout(connectBinance, RECONNECT_DELAY_MS);
    return;
  }

  binanceWs.on('open', () => {
    console.log('[PriceFeedLogger] ✅ Binance WebSocket connected');
    stats.binance.connected = true;
    stats.binance.lastMessageAt = Date.now(); // Reset to prevent immediate health check trigger
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

  binanceWs.on('close', (code, reason) => {
    console.log(`[PriceFeedLogger] Binance WebSocket disconnected (code: ${code})`);
    stats.binance.connected = false;
    binanceWs = null;
    
    if (isRunning) {
      stats.binance.reconnects++;
      console.log(`[PriceFeedLogger] Reconnecting Binance in ${RECONNECT_DELAY_MS}ms...`);
      binanceReconnectTimer = setTimeout(connectBinance, RECONNECT_DELAY_MS);
    }
  });
}

// ============ POLYMARKET RTDS WEBSOCKET ============

function forceReconnectPolymarket(): void {
  console.log('[PriceFeedLogger] 🔄 Force reconnecting Polymarket...');
  
  // Clear any pending reconnect timer
  if (polymarketReconnectTimer) {
    clearTimeout(polymarketReconnectTimer);
    polymarketReconnectTimer = null;
  }
  
  // Close existing connection if any
  if (polymarketWs) {
    try {
      polymarketWs.removeAllListeners();
      polymarketWs.terminate();
    } catch (e) { /* ignore */ }
    polymarketWs = null;
  }
  
  stats.polymarket.connected = false;
  stats.polymarket.reconnects++;
  
  // Reconnect after delay
  polymarketReconnectTimer = setTimeout(connectPolymarket, RECONNECT_DELAY_MS);
}

function connectPolymarket(): void {
  if (!isRunning) return;
  if (polymarketWs?.readyState === WebSocket.OPEN) return;

  // Clear any pending reconnect timer
  if (polymarketReconnectTimer) {
    clearTimeout(polymarketReconnectTimer);
    polymarketReconnectTimer = null;
  }

  console.log('[PriceFeedLogger] Connecting to Polymarket RTDS...');
  
  try {
    polymarketWs = new WebSocket(POLYMARKET_RTDS_URL);
  } catch (e) {
    console.error('[PriceFeedLogger] Failed to create Polymarket WebSocket:', e);
    stats.errors++;
    polymarketReconnectTimer = setTimeout(connectPolymarket, RECONNECT_DELAY_MS);
    return;
  }

  polymarketWs.on('open', () => {
    console.log('[PriceFeedLogger] ✅ Polymarket RTDS connected');
    stats.polymarket.connected = true;
    stats.polymarket.lastMessageAt = Date.now();

    // Subscribe using RTDS format (docs.polymarket.com/developers/RTDS/RTDS-crypto-prices)
    // Filters are OPTIONAL - omit them to get all symbols
    polymarketWs?.send(
      JSON.stringify({
        action: 'subscribe',
        subscriptions: [
          { topic: 'crypto_prices', type: 'update' },
          { topic: 'crypto_prices_chainlink', type: '*' },
        ],
      })
    );

    console.log('[PriceFeedLogger] 📡 Subscribed to crypto_prices + crypto_prices_chainlink');
  });

  polymarketWs.on('message', (data: WebSocket.Data) => {
    try {
      const msg = JSON.parse(data.toString());
      const now = Date.now();
      stats.polymarket.lastMessageAt = now;
      stats.polymarket.messageCount++;

      // Log first few messages for debugging
      if (stats.polymarket.messageCount <= 5) {
        console.log('[PriceFeedLogger] PM msg:', JSON.stringify(msg).slice(0, 220));
      }

      const toAsset = (raw: unknown): string | null => {
        if (typeof raw !== 'string' || raw.length === 0) return null;
        const s = raw.toLowerCase();
        // Chainlink format: "btc/usd"
        if (s.includes('/')) return s.split('/')[0]?.toUpperCase() ?? null;
        // Binance format: "btcusdt"
        if (s.endsWith('usdt')) return s.slice(0, -4).toUpperCase();
        return s.toUpperCase();
      };

      // Message format (both topics): { topic, type, timestamp, payload: { symbol, value, timestamp } }
      if ((msg.topic === 'crypto_prices' || msg.topic === 'crypto_prices_chainlink') && msg.payload) {
        const payload = msg.payload as { symbol?: unknown; value?: unknown; timestamp?: unknown };
        const asset = toAsset(payload.symbol);
        const price = typeof payload.value === 'number' ? payload.value : Number(payload.value);
        const ts = typeof payload.timestamp === 'number' ? payload.timestamp : Number(payload.timestamp);
        const timestamp = Number.isFinite(ts) ? ts : (msg.timestamp ?? now);

        if (asset && ASSETS.includes(asset) && Number.isFinite(price) && price > 0) {
          addTick({
            source: msg.topic === 'crypto_prices' ? 'polymarket_rtds' : 'chainlink_rtds',
            asset,
            price,
            raw_timestamp: timestamp,
            received_at: now,
          });
        }
      }

      // Legacy batch format fallback (older RTDS versions)
      if (msg.topic === 'crypto_prices' && msg.data && !msg.payload) {
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
    } catch (e) {
      // Ignore parse errors
    }
  });

  polymarketWs.on('error', (error) => {
    console.error('[PriceFeedLogger] Polymarket RTDS error:', error.message);
    stats.polymarket.connected = false;
    stats.errors++;
  });

  polymarketWs.on('close', (code, reason) => {
    console.log(`[PriceFeedLogger] Polymarket RTDS disconnected (code: ${code})`);
    stats.polymarket.connected = false;
    polymarketWs = null;
    
    if (isRunning) {
      stats.polymarket.reconnects++;
      console.log(`[PriceFeedLogger] Reconnecting Polymarket in ${RECONNECT_DELAY_MS}ms...`);
      polymarketReconnectTimer = setTimeout(connectPolymarket, RECONNECT_DELAY_MS);
    }
  });
}

// ============ HEALTH CHECK ============

function checkWebSocketHealth(): void {
  if (!isRunning) return;
  
  const now = Date.now();
  
  // Check Binance health
  const binanceStale = stats.binance.lastMessageAt > 0 && 
                       (now - stats.binance.lastMessageAt) > STALE_THRESHOLD_MS;
  
  if (!binanceReconnectTimer && (binanceStale || (!stats.binance.connected && binanceWs?.readyState !== WebSocket.CONNECTING))) {
    console.log(`[PriceFeedLogger] ⚠️ Binance appears stale or disconnected (last msg: ${Math.round((now - stats.binance.lastMessageAt) / 1000)}s ago)`);
    forceReconnectBinance();
  }
  
  // Check Polymarket health
  const polymarketStale = stats.polymarket.lastMessageAt > 0 && 
                          (now - stats.polymarket.lastMessageAt) > STALE_THRESHOLD_MS;
  
  if (!polymarketReconnectTimer && (polymarketStale || (!stats.polymarket.connected && polymarketWs?.readyState !== WebSocket.CONNECTING))) {
    console.log(`[PriceFeedLogger] ⚠️ Polymarket appears stale or disconnected (last msg: ${Math.round((now - stats.polymarket.lastMessageAt) / 1000)}s ago)`);
    forceReconnectPolymarket();
  }
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
  console.log(`║  Health:  Auto-reconnect if stale >${STALE_THRESHOLD_MS / 1000}s                        ║`);
  console.log('╚════════════════════════════════════════════════════════════════╝');
  console.log('');

  isRunning = true;
  stats.startedAt = Date.now();
  stats.totalLogged = 0;
  stats.flushCount = 0;
  stats.errors = 0;
  stats.binance.lastMessageAt = Date.now();
  stats.polymarket.lastMessageAt = Date.now();

  // Connect to both WebSockets
  connectBinance();
  connectPolymarket();

  // Periodic flush timer
  flushInterval = setInterval(() => {
    if (Date.now() - lastFlushTime > FLUSH_INTERVAL_MS && logBuffer.length > 0) {
      flushBuffer();
    }
  }, FLUSH_INTERVAL_MS);

  // Keep-alive pings (RTDS expects literal "PING")
  pingInterval = setInterval(() => {
    if (polymarketWs?.readyState === WebSocket.OPEN) {
      polymarketWs.send('PING');
    }
  }, 10000);

  // Health check - auto-reconnect stale connections
  healthCheckInterval = setInterval(checkWebSocketHealth, HEALTH_CHECK_INTERVAL_MS);
}

export async function stopPriceFeedLogger(): Promise<void> {
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
  if (healthCheckInterval) {
    clearInterval(healthCheckInterval);
    healthCheckInterval = null;
  }
  
  // Clear reconnect timers
  if (binanceReconnectTimer) {
    clearTimeout(binanceReconnectTimer);
    binanceReconnectTimer = null;
  }
  if (polymarketReconnectTimer) {
    clearTimeout(polymarketReconnectTimer);
    polymarketReconnectTimer = null;
  }

  // Close WebSockets
  if (binanceWs) {
    binanceWs.removeAllListeners();
    binanceWs.close();
    binanceWs = null;
  }
  if (polymarketWs) {
    polymarketWs.removeAllListeners();
    polymarketWs.close();
    polymarketWs = null;
  }

  // Final flush
  await flushBuffer();

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
