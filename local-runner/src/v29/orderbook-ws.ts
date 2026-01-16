/**
 * V29 Real-Time Orderbook WebSocket
 * 
 * Direct WebSocket connection to Polymarket CLOB for real-time bid/ask updates.
 * Eliminates the 1500ms polling delay - now reacts in <50ms to price changes.
 * 
 * Critical for trailing stops: We need to catch the EXACT moment bid drops!
 */

import WebSocket from 'ws';
import type { Asset } from './config.js';
import type { MarketInfo } from './types.js';

// CLOB Market WebSocket URL
const CLOB_WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';

// Reconnect settings
const RECONNECT_DELAY_MS = 3000;
const STALE_THRESHOLD_MS = 30000;
const PING_INTERVAL_MS = 15000;

// State
let ws: WebSocket | null = null;
let isRunning = false;
let reconnectTimer: NodeJS.Timeout | null = null;
let pingTimer: NodeJS.Timeout | null = null;
let healthCheckTimer: NodeJS.Timeout | null = null;

// Token ID to asset/direction mapping
const tokenMap = new Map<string, { asset: Asset; direction: 'UP' | 'DOWN' }>();

// Cache last known bid/ask per token (so we don't lose ask when price_change only gives bid)
const lastKnownPrices = new Map<string, { bestBid: number | null; bestAsk: number | null }>();

// Subscribed token IDs
let subscribedTokens: string[] = [];

// Stats
let stats = {
  connected: false,
  messageCount: 0,
  lastMessageAt: 0,
  reconnects: 0,
  lastBidUpdate: 0,
};

// Callback type for price updates
export type OrderbookCallback = (
  asset: Asset,
  direction: 'UP' | 'DOWN',
  bestBid: number | null,
  bestAsk: number | null,
  timestamp: number
) => void;

let priceCallback: OrderbookCallback | null = null;

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] [V29:OB-WS] ${msg}`);
}

/**
 * Update the token mapping from current markets
 */
export function updateMarkets(markets: Map<Asset, MarketInfo>): void {
  tokenMap.clear();
  const newTokens: string[] = [];
  
  for (const [asset, market] of markets) {
    if (market.upTokenId) {
      tokenMap.set(market.upTokenId, { asset, direction: 'UP' });
      newTokens.push(market.upTokenId);
    }
    if (market.downTokenId) {
      tokenMap.set(market.downTokenId, { asset, direction: 'DOWN' });
      newTokens.push(market.downTokenId);
    }
  }
  
  // If tokens changed and we're connected, resubscribe
  const tokensChanged = JSON.stringify(newTokens.sort()) !== JSON.stringify(subscribedTokens.sort());
  if (tokensChanged && ws?.readyState === WebSocket.OPEN) {
    subscribedTokens = newTokens;
    subscribe();
  } else {
    subscribedTokens = newTokens;
  }
}

/**
 * Subscribe to orderbook updates for current tokens
 */
function subscribe(): void {
  if (!ws || ws.readyState !== WebSocket.OPEN || subscribedTokens.length === 0) {
    return;
  }
  
  const msg = {
    assets_ids: subscribedTokens,
    type: 'market',
  };
  
  try {
    ws.send(JSON.stringify(msg));
    log(`📡 Subscribed to ${subscribedTokens.length} orderbooks`);
  } catch (e) {
    log(`⚠️ Subscribe failed: ${(e as Error).message}`);
  }
}

/**
 * Handle incoming WebSocket messages
 */
function handleMessage(data: WebSocket.Data): void {
  try {
    const msgStr = data.toString();
    const now = Date.now();
    
    stats.lastMessageAt = now;
    stats.messageCount++;
    
    // Skip control messages
    if (msgStr === 'PONG' || msgStr === 'INVALID') {
      return;
    }
    
    // Parse JSON
    const trimmed = msgStr.trimStart();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
      return;
    }
    
    const msg = JSON.parse(trimmed);
    
    // Book snapshot event: { event_type: 'book', asset_id, bids, asks }
    if (msg.event_type === 'book' && msg.asset_id) {
      const tokenInfo = tokenMap.get(msg.asset_id);
      if (!tokenInfo) return;
      
      // Parse bids and asks - CLOB sends as [[price, size], ...]
      // bids are sorted highest first, asks are sorted lowest first
      const bids = (msg.bids ?? []) as Array<[string, string]>;
      const asks = (msg.asks ?? []) as Array<[string, string]>;
      
      // Best bid = highest price willing to buy
      const bestBid = bids.length > 0 ? parseFloat(bids[0][0]) : null;
      // Best ask = lowest price willing to sell
      const bestAsk = asks.length > 0 ? parseFloat(asks[0][0]) : null;
      
      // Cache the prices so we don't lose them on price_change events
      const cached = lastKnownPrices.get(msg.asset_id) ?? { bestBid: null, bestAsk: null };
      if (bestBid !== null) cached.bestBid = bestBid;
      if (bestAsk !== null) cached.bestAsk = bestAsk;
      lastKnownPrices.set(msg.asset_id, cached);
      
      if (priceCallback && (bestBid !== null || bestAsk !== null)) {
        stats.lastBidUpdate = now;
        priceCallback(tokenInfo.asset, tokenInfo.direction, cached.bestBid, cached.bestAsk, now);
      }
    }
    
    // Price change event: { event_type: 'price_change', price_changes: [...] }
    if (msg.event_type === 'price_change' && msg.price_changes) {
      for (const pc of msg.price_changes as Array<{ asset_id: string; price: string; side?: string }>) {
        const tokenInfo = tokenMap.get(pc.asset_id);
        if (!tokenInfo) continue;
        
        const price = parseFloat(pc.price);
        if (!Number.isFinite(price) || price <= 0 || price >= 1.5) continue;
        
        // Update cached bid, preserve cached ask
        const cached = lastKnownPrices.get(pc.asset_id) ?? { bestBid: null, bestAsk: null };
        cached.bestBid = price;
        lastKnownPrices.set(pc.asset_id, cached);
        
        if (priceCallback) {
          stats.lastBidUpdate = now;
          // Fire with cached ask so we don't lose it
          priceCallback(tokenInfo.asset, tokenInfo.direction, price, cached.bestAsk, now);
        }
      }
    }
    
    // Tick event: individual trade or quote update
    if (msg.event_type === 'tick' && msg.asset_id) {
      const tokenInfo = tokenMap.get(msg.asset_id);
      if (!tokenInfo) return;
      
      const tickBid = msg.bid ? parseFloat(msg.bid) : null;
      const tickAsk = msg.ask ? parseFloat(msg.ask) : null;
      
      // Update cache with tick data
      const cached = lastKnownPrices.get(msg.asset_id) ?? { bestBid: null, bestAsk: null };
      if (tickBid !== null) cached.bestBid = tickBid;
      if (tickAsk !== null) cached.bestAsk = tickAsk;
      lastKnownPrices.set(msg.asset_id, cached);
      
      if (priceCallback && (tickBid !== null || tickAsk !== null)) {
        stats.lastBidUpdate = now;
        priceCallback(tokenInfo.asset, tokenInfo.direction, cached.bestBid, cached.bestAsk, now);
      }
    }
    
  } catch (e) {
    // Ignore parse errors
  }
}

/**
 * Connect to CLOB WebSocket
 */
function connect(): void {
  if (!isRunning) return;
  if (ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING) return;
  
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  
  if (subscribedTokens.length === 0) {
    log('⏳ No tokens to subscribe - waiting for markets...');
    reconnectTimer = setTimeout(connect, 5000);
    return;
  }
  
  log(`🔌 Connecting to CLOB WebSocket (${subscribedTokens.length} tokens)...`);
  
  try {
    ws = new WebSocket(CLOB_WS_URL);
  } catch (e) {
    log(`❌ WebSocket creation failed: ${(e as Error).message}`);
    scheduleReconnect();
    return;
  }
  
  ws.on('open', () => {
    log('✅ CLOB WebSocket connected');
    stats.connected = true;
    stats.lastMessageAt = Date.now();
    
    // Subscribe after short delay to ensure socket is ready
    setTimeout(() => {
      if (ws?.readyState === WebSocket.OPEN) {
        subscribe();
      }
    }, 100);
    
    // Start ping interval
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = setInterval(() => {
      if (ws?.readyState === WebSocket.OPEN) {
        try {
          ws.ping();
        } catch (e) { /* ignore */ }
      }
    }, PING_INTERVAL_MS);
  });
  
  ws.on('message', handleMessage);
  
  ws.on('error', (error) => {
    log(`⚠️ WebSocket error: ${error.message}`);
    stats.connected = false;
  });
  
  ws.on('close', (code) => {
    log(`🔌 WebSocket closed (code: ${code})`);
    stats.connected = false;
    ws = null;
    
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
    
    if (isRunning) {
      scheduleReconnect();
    }
  });
}

/**
 * Schedule a reconnect attempt
 */
function scheduleReconnect(): void {
  if (reconnectTimer) return;
  stats.reconnects++;
  log(`🔄 Reconnecting in ${RECONNECT_DELAY_MS}ms...`);
  reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
}

/**
 * Health check - force reconnect if stale
 */
function checkHealth(): void {
  if (!isRunning) return;
  
  const now = Date.now();
  const stale = stats.lastMessageAt > 0 && (now - stats.lastMessageAt) > STALE_THRESHOLD_MS;
  
  if (stale || (!stats.connected && !reconnectTimer)) {
    log(`⚠️ Connection stale (last msg: ${Math.round((now - stats.lastMessageAt) / 1000)}s ago) - reconnecting`);
    forceReconnect();
  }
}

/**
 * Force a reconnection
 */
function forceReconnect(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  
  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
  
  if (ws) {
    try {
      ws.removeAllListeners();
      ws.terminate();
    } catch (e) { /* ignore */ }
    ws = null;
  }
  
  stats.connected = false;
  scheduleReconnect();
}

/**
 * Start the orderbook WebSocket
 */
export function startOrderbookWs(callback: OrderbookCallback): void {
  if (isRunning) {
    log('⚠️ Already running');
    return;
  }
  
  log('🚀 Starting real-time orderbook WebSocket...');
  
  priceCallback = callback;
  isRunning = true;
  
  // Reset stats
  stats = {
    connected: false,
    messageCount: 0,
    lastMessageAt: 0,
    reconnects: 0,
    lastBidUpdate: 0,
  };
  
  // Connect
  connect();
  
  // Health check every 10s
  healthCheckTimer = setInterval(checkHealth, 10000);
}

/**
 * Stop the orderbook WebSocket
 */
export function stopOrderbookWs(): void {
  if (!isRunning) return;
  
  log('🛑 Stopping orderbook WebSocket...');
  isRunning = false;
  priceCallback = null;
  
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  
  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
  
  if (healthCheckTimer) {
    clearInterval(healthCheckTimer);
    healthCheckTimer = null;
  }
  
  if (ws) {
    try {
      ws.removeAllListeners();
      ws.close();
    } catch (e) { /* ignore */ }
    ws = null;
  }
  
  stats.connected = false;
}

/**
 * Check if connected
 */
export function isOrderbookWsConnected(): boolean {
  return stats.connected;
}

/**
 * Get stats
 */
export function getOrderbookWsStats(): typeof stats {
  return { ...stats };
}
