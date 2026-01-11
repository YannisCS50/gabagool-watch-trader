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
  source: 'binance_ws' | 'polymarket_rtds' | 'chainlink_rtds' | 'clob_shares';
  asset: string;
  price: number;
  raw_timestamp: number;  // Original timestamp from source
  received_at: number;    // Local timestamp when received
  outcome?: 'up' | 'down';  // For clob_shares: which side
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
  clob: {
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
// Polymarket RTDS connection details (docs.polymarket.com/developers/RTDS/RTDS-crypto-prices)
const POLYMARKET_RTDS_URL = 'wss://ws-live-data.polymarket.com';
// CLOB Market WebSocket for real UP/DOWN share prices
const CLOB_MARKET_WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';

// Import backend to get token IDs from our own API (no external rate limits)
import { fetchMarkets } from './backend.js';

const ASSETS = ['BTC', 'ETH', 'SOL', 'XRP'];
const BINANCE_SYMBOLS = ['btcusdt', 'ethusdt', 'solusdt', 'xrpusdt'];

const FLUSH_INTERVAL_MS = 2000;  // Flush every 2 seconds
const MAX_BUFFER_SIZE = 200;     // Or when buffer hits 200 items
const RECONNECT_DELAY_MS = 5000; // Wait 5s before reconnect
const HEALTH_CHECK_INTERVAL_MS = 10000; // Check health every 10s
const STALE_THRESHOLD_MS = 30000; // Consider stale if no data for 30s

// Token ID to asset mapping (populated dynamically from active markets)
const tokenToAssetMap = new Map<string, { asset: string; outcome: 'up' | 'down' }>();
let activeTokenIds: string[] = [];

// State
let binanceWs: WebSocket | null = null;
let polymarketWs: WebSocket | null = null;
let clobWs: WebSocket | null = null;
let isRunning = false;
let logBuffer: PriceTickLog[] = [];
let lastFlushTime = Date.now();
let flushInterval: NodeJS.Timeout | null = null;
let pingInterval: NodeJS.Timeout | null = null;
let clobPingInterval: NodeJS.Timeout | null = null;
let healthCheckInterval: NodeJS.Timeout | null = null;
let binanceReconnectTimer: NodeJS.Timeout | null = null;
let polymarketReconnectTimer: NodeJS.Timeout | null = null;
let clobReconnectTimer: NodeJS.Timeout | null = null;

const stats: LoggerStats = {
  binance: { connected: false, messageCount: 0, lastMessageAt: 0, reconnects: 0 },
  polymarket: { connected: false, messageCount: 0, lastMessageAt: 0, reconnects: 0 },
  clob: { connected: false, messageCount: 0, lastMessageAt: 0, reconnects: 0 },
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
    // IMPORTANT:
    // - crypto_prices requires type="update"
    // - crypto_prices_chainlink requires type="*" AND a filters field ("" is valid)
    // - Avoid unsupported topics here; we log CLOB share prices via the dedicated CLOB WS.
    polymarketWs?.send(
      JSON.stringify({
        action: 'subscribe',
        subscriptions: [
          { topic: 'crypto_prices', type: 'update' },
          { topic: 'crypto_prices_chainlink', type: '*', filters: '' },
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

      // crypto_prices_market: UP/DOWN share prices from CLOB orderbook
      // Format: { topic: 'crypto_prices_market', payload: { symbol, up_price, down_price, timestamp } }
      if (msg.topic === 'crypto_prices_market' && msg.payload) {
        const payload = msg.payload as { 
          symbol?: unknown; 
          up_price?: unknown; 
          down_price?: unknown; 
          timestamp?: unknown;
          up_mid?: unknown;
          down_mid?: unknown;
        };
        const asset = toAsset(payload.symbol);
        const ts = typeof payload.timestamp === 'number' ? payload.timestamp : Number(payload.timestamp);
        const timestamp = Number.isFinite(ts) ? ts : (msg.timestamp ?? now);

        // Try both up_price/down_price and up_mid/down_mid formats
        const upPrice = Number(payload.up_price ?? payload.up_mid);
        const downPrice = Number(payload.down_price ?? payload.down_mid);

        if (asset && ASSETS.includes(asset)) {
          // Log UP share price
          if (Number.isFinite(upPrice) && upPrice > 0 && upPrice < 1.5) {
            addTick({
              source: 'clob_shares',
              asset,
              price: upPrice,
              raw_timestamp: timestamp,
              received_at: now,
              outcome: 'up',
            });
          }
          // Log DOWN share price
          if (Number.isFinite(downPrice) && downPrice > 0 && downPrice < 1.5) {
            addTick({
              source: 'clob_shares',
              asset,
              price: downPrice,
              raw_timestamp: timestamp,
              received_at: now,
              outcome: 'down',
            });
          }
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

// ============ CLOB MARKET WEBSOCKET (UP/DOWN SHARE PRICES) ============

async function fetchActiveTokenIds(): Promise<void> {
  console.log('[PriceFeedLogger] Fetching token IDs from backend...');
  
  try {
    tokenToAssetMap.clear();
    activeTokenIds = [];
    
    // Use our own backend which has all active markets with token IDs
    const result = await fetchMarkets();
    
    if (!result.success || !result.markets) {
      console.error('[PriceFeedLogger] Failed to fetch markets from backend');
      return;
    }
    
    console.log(`[PriceFeedLogger] Backend returned ${result.markets.length} markets`);
    
    for (const market of result.markets) {
      // Only include markets for tracked assets
      if (!ASSETS.includes(market.asset)) continue;
      
      // Map UP token
      if (market.upTokenId) {
        tokenToAssetMap.set(market.upTokenId, { asset: market.asset, outcome: 'up' });
        activeTokenIds.push(market.upTokenId);
      }
      
      // Map DOWN token
      if (market.downTokenId) {
        tokenToAssetMap.set(market.downTokenId, { asset: market.asset, outcome: 'down' });
        activeTokenIds.push(market.downTokenId);
      }
    }
    
    console.log(`[PriceFeedLogger] ✅ Found ${activeTokenIds.length} tokens for ${result.markets.length} markets`);
  } catch (error) {
    console.error('[PriceFeedLogger] Error fetching token IDs:', error);
  }
}

function forceReconnectClob(): void {
  console.log('[PriceFeedLogger] 🔄 Force reconnecting CLOB...');
  
  if (clobReconnectTimer) {
    clearTimeout(clobReconnectTimer);
    clobReconnectTimer = null;
  }
  
  if (clobWs) {
    try {
      clobWs.removeAllListeners();
      clobWs.terminate();
    } catch (e) { /* ignore */ }
    clobWs = null;
  }
  
  stats.clob.connected = false;
  stats.clob.reconnects++;
  
  clobReconnectTimer = setTimeout(connectClob, RECONNECT_DELAY_MS);
}

async function connectClob(): Promise<void> {
  if (!isRunning) return;
  if (clobWs?.readyState === WebSocket.OPEN) return;
  
  if (clobReconnectTimer) {
    clearTimeout(clobReconnectTimer);
    clobReconnectTimer = null;
  }
  
  // Refresh token IDs before connecting
  await fetchActiveTokenIds();
  
  if (activeTokenIds.length === 0) {
    console.log('[PriceFeedLogger] No active tokens found, will retry in 60s...');
    clobReconnectTimer = setTimeout(connectClob, 60000);
    return;
  }
  
  console.log('[PriceFeedLogger] Connecting to CLOB Market WebSocket...');
  
  // Store token IDs locally to avoid race conditions
  const tokensToSubscribe = [...activeTokenIds];
  
  try {
    clobWs = new WebSocket(CLOB_MARKET_WS_URL);
  } catch (e) {
    console.error('[PriceFeedLogger] Failed to create CLOB WebSocket:', e);
    stats.errors++;
    clobReconnectTimer = setTimeout(connectClob, RECONNECT_DELAY_MS);
    return;
  }
  
  clobWs.on('open', () => {
    console.log('[PriceFeedLogger] ✅ CLOB Market WebSocket connected');
    stats.clob.connected = true;
    stats.clob.lastMessageAt = Date.now();
    
    // Use setTimeout to ensure the socket is truly ready before sending
    // This avoids the "WebSocket is not open: readyState 0 (CONNECTING)" error
    setTimeout(() => {
      if (!clobWs || clobWs.readyState !== WebSocket.OPEN) {
        console.warn('[PriceFeedLogger] ⚠️ CLOB socket closed before subscribe');
        return;
      }
      
      // Subscribe to orderbook updates for active tokens
      // CLOB expects: { assets_ids: [...], type: "market" }
      const subscribeMsg = {
        assets_ids: tokensToSubscribe,
        type: 'market',
      };
      try {
        clobWs.send(JSON.stringify(subscribeMsg));
        console.log(`[PriceFeedLogger] 📡 Subscribed to ${tokensToSubscribe.length} CLOB orderbooks`);
      } catch (e) {
        console.error('[PriceFeedLogger] Failed to send CLOB subscribe:', e);
        stats.errors++;
      }
    }, 100); // 100ms delay to ensure socket is fully ready
  });
  
  clobWs.on('message', (data: WebSocket.Data) => {
    try {
      const msgStr = data.toString();
      const now = Date.now();
      stats.clob.lastMessageAt = now;
      stats.clob.messageCount++;
      
      // Skip PONG messages
      if (msgStr === 'PONG') return;
      
      const msg = JSON.parse(msgStr);
      
      // Book event: { event_type: 'book', asset_id: '...', bids: [[price, size]...], asks: [[price, size]...] }
      if (msg.event_type === 'book' && msg.asset_id) {
        const tokenInfo = tokenToAssetMap.get(msg.asset_id);
        if (!tokenInfo) return;
        
        // Get best bid and best ask
        const bestBid = msg.bids?.[0]?.[0];
        const bestAsk = msg.asks?.[0]?.[0];
        
        // Use midpoint price, or best available
        let price: number | null = null;
        if (bestBid && bestAsk) {
          price = (parseFloat(bestBid) + parseFloat(bestAsk)) / 2;
        } else if (bestBid) {
          price = parseFloat(bestBid);
        } else if (bestAsk) {
          price = parseFloat(bestAsk);
        }
        
        if (price && Number.isFinite(price) && price > 0 && price < 1.5) {
          addTick({
            source: 'clob_shares',
            asset: tokenInfo.asset,
            price,
            raw_timestamp: msg.timestamp || now,
            received_at: now,
            outcome: tokenInfo.outcome,
          });
        }
      }
      
      // Price change event: { event_type: 'price_change', price_changes: [{ asset_id, price }...] }
      if (msg.event_type === 'price_change' && msg.price_changes) {
        for (const pc of msg.price_changes) {
          const tokenInfo = tokenToAssetMap.get(pc.asset_id);
          if (!tokenInfo) continue;
          
          const price = parseFloat(pc.price);
          if (Number.isFinite(price) && price > 0 && price < 1.5) {
            addTick({
              source: 'clob_shares',
              asset: tokenInfo.asset,
              price,
              raw_timestamp: msg.timestamp || now,
              received_at: now,
              outcome: tokenInfo.outcome,
            });
          }
        }
      }
      
      // Log first few messages for debugging
      if (stats.clob.messageCount <= 3) {
        console.log('[PriceFeedLogger] CLOB msg:', JSON.stringify(msg).slice(0, 200));
      }
    } catch (e) {
      // Ignore parse errors
    }
  });
  
  clobWs.on('error', (error) => {
    console.error('[PriceFeedLogger] CLOB WebSocket error:', error.message);
    stats.clob.connected = false;
    stats.errors++;
  });
  
  clobWs.on('close', (code, reason) => {
    console.log(`[PriceFeedLogger] CLOB WebSocket disconnected (code: ${code})`);
    stats.clob.connected = false;
    clobWs = null;
    
    if (isRunning) {
      stats.clob.reconnects++;
      console.log(`[PriceFeedLogger] Reconnecting CLOB in ${RECONNECT_DELAY_MS}ms...`);
      clobReconnectTimer = setTimeout(connectClob, RECONNECT_DELAY_MS);
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
  
  // Check CLOB health
  const clobStale = stats.clob.lastMessageAt > 0 && 
                    (now - stats.clob.lastMessageAt) > STALE_THRESHOLD_MS;
  
  if (!clobReconnectTimer && (clobStale || (!stats.clob.connected && clobWs?.readyState !== WebSocket.CONNECTING))) {
    console.log(`[PriceFeedLogger] ⚠️ CLOB appears stale or disconnected (last msg: ${Math.round((now - stats.clob.lastMessageAt) / 1000)}s ago)`);
    forceReconnectClob();
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
  console.log('║  Sources: Binance WS + Polymarket RTDS + CLOB (UP/DOWN)        ║');
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
  stats.clob.lastMessageAt = Date.now();

  // Connect to all WebSockets
  connectBinance();
  connectPolymarket();
  connectClob();

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

  // CLOB keep-alive pings
  clobPingInterval = setInterval(() => {
    if (clobWs?.readyState === WebSocket.OPEN) {
      clobWs.send('PING');
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
  if (clobPingInterval) {
    clearInterval(clobPingInterval);
    clobPingInterval = null;
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
  if (clobReconnectTimer) {
    clearTimeout(clobReconnectTimer);
    clobReconnectTimer = null;
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
  if (clobWs) {
    clobWs.removeAllListeners();
    clobWs.close();
    clobWs = null;
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
  console.log(`│  CLOB (UP/DOWN shares):`.padEnd(54) + '│');
  console.log(`│    Connected: ${stats.clob.connected ? '✅' : '❌'}`.padEnd(54) + '│');
  console.log(`│    Messages: ${stats.clob.messageCount.toLocaleString()}`.padEnd(54) + '│');
  console.log(`│    Reconnects: ${stats.clob.reconnects}`.padEnd(54) + '│');
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
