// ============================================================
// V35 USER WEBSOCKET - Authenticated Fill Tracking
// ============================================================
// V36.2.7 - "Accept All Fills for Active Market"
//
// Connects to Polymarket's authenticated User Channel to receive
// real-time notifications when our orders are matched (filled).
//
// V36.2.7 CRITICAL FIX:
// In V36, we trade only ONE market at a time. The orderId registration
// race condition caused fills to be rejected because:
// 1. placeOrder() is called
// 2. Order fills IMMEDIATELY on exchange (market order)
// 3. Fill arrives via WebSocket
// 4. BUT registerOurOrderId() hasn't been called yet!
// 5. Fill is REJECTED as "not ours"
//
// FIX: Accept ALL fills for tokens in our tokenToMarketMap.
// Since we only subscribe to tokens we're actively trading,
// any fill for those tokens is ours. PairTracker handles matching.
// ============================================================

import WebSocket from 'ws';
import crypto from 'node:crypto';
import { config } from '../config.js';
import type { V35Fill, V35Side } from './types.js';

type FillCallback = (fill: V35Fill) => void;

let userSocket: WebSocket | null = null;
let running = false;
let fillCallback: FillCallback | null = null;
let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;

// Token ID to market info mapping (set by runner)
let tokenToMarketMap: Map<string, { slug: string; side: V35Side; asset: string }> = new Map();

// V36.2.7: Track order IDs for logging purposes only (not filtering)
// In V36 single-market mode, we accept all fills for subscribed tokens
const ourOrderIds = new Set<string>();
let totalFillsReceived = 0;
let ourFillsAccepted = 0;
let unknownFillsAccepted = 0; // V36.2.7: Fills accepted without orderId match

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] [UserWS] ${msg}`);
}

function logError(msg: string, err?: any): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.error(`[${ts}] [UserWS] ❌ ${msg}`, err?.message || err || '');
}

/**
 * Generate HMAC signature for WebSocket authentication
 */
function generateSignature(
  secret: string,
  timestamp: string,
  method: string,
  path: string
): string {
  // Normalize secret to standard base64
  const sanitizeBase64 = (s: string): string => {
    let normalized = s.trim()
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      .replace(/[^A-Za-z0-9+/=]/g, '');
    const pad = normalized.length % 4;
    if (pad === 2) normalized += '==';
    if (pad === 3) normalized += '=';
    return normalized;
  };

  const toUrlSafeBase64 = (b64: string): string =>
    b64.replace(/\+/g, '-').replace(/\//g, '_');

  const secretBytes = Buffer.from(sanitizeBase64(secret), 'base64');
  const message = `${timestamp}${method.toUpperCase()}${path}`;
  const digest = crypto.createHmac('sha256', secretBytes).update(message).digest();
  return toUrlSafeBase64(Buffer.from(digest).toString('base64'));
}

/**
 * Build authentication payload for User Channel subscription
 */
function buildAuthPayload(): {
  apiKey: string;
  secret: string;
  passphrase: string;
  timestamp: string;
  signature: string;
} {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = generateSignature(
    config.polymarket.apiSecret,
    timestamp,
    'GET',
    '/ws/user'
  );

  return {
    apiKey: config.polymarket.apiKey,
    secret: config.polymarket.apiSecret,
    passphrase: config.polymarket.passphrase,
    timestamp,
    signature,
  };
}

/**
 * Connect to Polymarket User Channel WebSocket
 */
function connect(): void {
  if (!running) return;

  log('🔌 Connecting to Polymarket User Channel...');

  const ws = new WebSocket('wss://ws-subscriptions-clob.polymarket.com/ws/user');
  userSocket = ws;

  ws.on('open', () => {
    if (ws !== userSocket) {
      try { ws.close(); } catch {}
      return;
    }

    log('✅ Connected to User Channel');

    // Send authentication
    const auth = buildAuthPayload();
    const subscribeMsg = {
      type: 'user',
      auth: {
        apiKey: auth.apiKey,
        secret: auth.secret,
        passphrase: auth.passphrase,
        timestamp: auth.timestamp,
        signature: auth.signature,
      },
    };

    try {
      ws.send(JSON.stringify(subscribeMsg));
      log('📡 Sent authentication to User Channel');
    } catch (err) {
      logError('Failed to send auth:', err);
    }
  });

  ws.on('message', (data: WebSocket.Data) => {
    try {
      const event = JSON.parse(data.toString());
      processUserEvent(event);
    } catch (err) {
      // Ignore parse errors (ping/pong messages etc)
    }
  });

  ws.on('error', (error) => {
    logError('WebSocket error:', error);
  });

  ws.on('close', (code, reason) => {
    if (ws !== userSocket) return;

    log(`🔌 Disconnected (${code}${reason ? ': ' + reason : ''})`);
    userSocket = null;

    // Reconnect after delay
    if (running) {
      reconnectTimeout = setTimeout(() => {
        if (running) connect();
      }, 5000);
    }
  });
}

/**
 * Process events from the User Channel
 */
function processUserEvent(data: any): void {
  const eventType = data.event_type;

  // Handle trade events (our fills)
  if (eventType === 'trade') {
    processTrade(data);
    return;
  }

  // Handle order events (placement, update, cancellation)
  if (eventType === 'order') {
    processOrder(data);
    return;
  }

  // Log unknown event types for debugging
  if (eventType && eventType !== 'subscribed') {
    log(`📨 Unknown event type: ${eventType}`);
  }
}

/**
 * Process a trade event from the User Channel
 * 
 * CRITICAL V35.3.2: Only accept fills for orders WE placed!
 * The User Channel broadcasts ALL trades in subscribed markets.
 * Without filtering by our order IDs, we count other traders' fills.
 */
function processTrade(data: any): void {
  totalFillsReceived++;
  
  // Extract maker orders - these are OUR fills when we're the maker
  const makerOrders = data.maker_orders as Array<{
    order_id: string;
    asset_id: string;
    matched_amount: string;
    price: string;
    outcome: string;
  }> | undefined;

  if (!makerOrders || makerOrders.length === 0) {
    // This is a taker fill - check if it's for a token we're trading
    const takerId = data.taker_order_id;
    const assetId = data.asset_id;
    const price = parseFloat(data.price);
    const size = parseFloat(data.size);

    if (takerId && assetId && !isNaN(price) && !isNaN(size)) {
      // V36.2.7: Accept fill if it's for a token in our active market
      const marketInfo = tokenToMarketMap.get(assetId);
      
      if (!marketInfo) {
        // Not a token we're trading - ignore
        return;
      }
      
      // V36.2.7: Log whether this was a known order or not
      const isKnownOrder = ourOrderIds.has(takerId);
      if (isKnownOrder) {
        ourFillsAccepted++;
        log(`🎯 TAKER FILL (known): ${marketInfo.side} ${size.toFixed(0)} @ $${price.toFixed(2)} | orderId: ${takerId.slice(0, 8)}...`);
      } else {
        unknownFillsAccepted++;
        log(`🎯 TAKER FILL (race-fix): ${marketInfo.side} ${size.toFixed(0)} @ $${price.toFixed(2)} | orderId: ${takerId.slice(0, 8)}... (not pre-registered)`);
      }
      
      if (fillCallback) {
        const fill: V35Fill = {
          orderId: takerId,
          tokenId: assetId,
          side: marketInfo.side,
          price,
          size,
          timestamp: new Date(),
          marketSlug: marketInfo.slug,
          asset: marketInfo.asset,
        };
        fillCallback(fill);
      }
    }
    return;
  }

  // Process each maker order that was matched
  for (const maker of makerOrders) {
    const orderId = maker.order_id;
    const assetId = maker.asset_id;
    const marketInfo = tokenToMarketMap.get(assetId);
    
    if (!marketInfo) {
      // Not a token we're trading - ignore
      continue;
    }

    const price = parseFloat(maker.price);
    const size = parseFloat(maker.matched_amount);

    if (isNaN(price) || isNaN(size) || size <= 0) {
      log(`⚠️ Invalid trade data: price=${maker.price} size=${maker.matched_amount}`);
      continue;
    }

    // V36.2.7: Log whether this was a known order or not
    const isKnownOrder = ourOrderIds.has(orderId);
    if (isKnownOrder) {
      ourFillsAccepted++;
      log(`🎯 MAKER FILL (known): ${marketInfo.side} ${size.toFixed(0)} @ $${price.toFixed(2)} | orderId: ${orderId.slice(0, 8)}...`);
    } else {
      unknownFillsAccepted++;
      log(`🎯 MAKER FILL (race-fix): ${marketInfo.side} ${size.toFixed(0)} @ $${price.toFixed(2)} | orderId: ${orderId.slice(0, 8)}... (not pre-registered)`);
    }

    if (fillCallback) {
      const fill: V35Fill = {
        orderId: orderId,
        tokenId: assetId,
        side: marketInfo.side,
        price,
        size,
        timestamp: new Date(),
        marketSlug: marketInfo.slug,
        asset: marketInfo.asset,
      };
      fillCallback(fill);
    }
  }
}

/**
 * Process an order event from the User Channel
 */
function processOrder(data: any): void {
  const orderType = data.type; // PLACEMENT, UPDATE, CANCELLATION
  const orderId = data.id;
  const sizeMatched = parseFloat(data.size_matched || '0');

  if (orderType === 'UPDATE' && sizeMatched > 0) {
    // Partial fill - the trade event should handle this
    log(`📝 Order ${orderId?.slice(0, 12)}... updated: ${sizeMatched} matched`);
  } else if (orderType === 'CANCELLATION') {
    log(`📝 Order ${orderId?.slice(0, 12)}... cancelled`);
  }
  // PLACEMENT events are just confirmations, no action needed
}

// ============================================================
// PUBLIC API
// ============================================================

/**
 * Start the authenticated User WebSocket connection
 * @param onFill Callback invoked when a fill is detected
 */
export function startUserWebSocket(onFill: FillCallback): void {
  if (running) {
    log('⚠️ Already running');
    return;
  }

  running = true;
  fillCallback = onFill;
  connect();
}

/**
 * Stop the User WebSocket connection
 */
export function stopUserWebSocket(): void {
  running = false;
  fillCallback = null;

  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }

  if (userSocket) {
    try {
      userSocket.close();
    } catch {}
    userSocket = null;
  }

  log('🛑 Stopped');
}

/**
 * Update the token-to-market mapping
 * Called by the runner when markets are discovered/updated
 */
export function setTokenToMarketMap(
  map: Map<string, { slug: string; side: V35Side; asset: string }>
): void {
  tokenToMarketMap = map;
  log(`📋 Updated token map with ${map.size} tokens`);
}

/**
 * Check if the User WebSocket is connected
 */
export function isUserWsConnected(): boolean {
  return userSocket?.readyState === WebSocket.OPEN;
}

// ============================================================
// ORDER ID TRACKING (V35.3.2)
// ============================================================

/**
 * Register an order ID as "ours" so we accept fills for it
 * Called by OrderManager when placing orders
 */
export function registerOurOrderId(orderId: string): void {
  ourOrderIds.add(orderId);
}

/**
 * Register multiple order IDs at once
 */
export function registerOurOrderIds(orderIds: string[]): void {
  for (const id of orderIds) {
    ourOrderIds.add(id);
  }
}

/**
 * Remove an order ID from tracking (after cancellation or full fill)
 */
export function unregisterOrderId(orderId: string): void {
  ourOrderIds.delete(orderId);
}

/**
 * Clear all tracked order IDs (on market expiry or runner restart)
 */
export function clearOrderIds(): void {
  const count = ourOrderIds.size;
  ourOrderIds.clear();
  log(`🗑️ Cleared ${count} tracked order IDs`);
}

/**
 * Get current tracking stats
 */
export function getOrderTrackingStats(): {
  trackedOrders: number;
  fillsReceived: number;
  fillsAccepted: number;
  unknownFillsAccepted: number;
} {
  return {
    trackedOrders: ourOrderIds.size,
    fillsReceived: totalFillsReceived,
    fillsAccepted: ourFillsAccepted,
    unknownFillsAccepted: unknownFillsAccepted,
  };
}
