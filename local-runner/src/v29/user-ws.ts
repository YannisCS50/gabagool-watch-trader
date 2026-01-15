/**
 * V29 User Channel WebSocket
 * 
 * Real-time position tracking via Polymarket's authenticated User Channel.
 * Receives instant updates for:
 * - Order placements, updates, cancellations
 * - Trade fills (MATCHED, MINED, CONFIRMED)
 * 
 * This eliminates the need for polling and prevents "forgotten" positions.
 */

import WebSocket from 'ws';
import crypto from 'node:crypto';
import { config } from '../config.js';

const USER_WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/user';
const PING_INTERVAL_MS = 10_000; // Polymarket requires ping every 10s

// Event types from User Channel
export interface TradeEvent {
  type: 'TRADE';
  event_type: 'trade';
  id: string;
  market: string;          // condition ID
  asset_id: string;        // token ID
  side: 'BUY' | 'SELL';
  price: string;
  size: string;
  status: 'MATCHED' | 'MINED' | 'CONFIRMED' | 'RETRYING' | 'FAILED';
  outcome: string;
  timestamp: string;
  taker_order_id: string;
  maker_orders?: { id: string; price: string; matched_amount: string }[];
}

export interface OrderEvent {
  type: 'PLACEMENT' | 'UPDATE' | 'CANCELLATION';
  event_type: 'order';
  id: string;
  market: string;          // condition ID
  asset_id: string;        // token ID
  side: 'BUY' | 'SELL';
  price: string;
  original_size: string;
  size_matched: string;
  outcome: string;
  timestamp: string;
}

export type UserChannelEvent = TradeEvent | OrderEvent;

export type OnTradeCallback = (event: TradeEvent) => void;
export type OnOrderCallback = (event: OrderEvent) => void;

// State
let ws: WebSocket | null = null;
let pingInterval: NodeJS.Timeout | null = null;
let reconnectTimeout: NodeJS.Timeout | null = null;
let isRunning = false;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;

let onTradeCallback: OnTradeCallback | null = null;
let onOrderCallback: OnOrderCallback | null = null;

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] [V29:UserWS] ${msg}`);
}

function logError(msg: string, err?: unknown): void {
  const ts = new Date().toISOString().slice(11, 23);
  console.error(`[${ts}] [V29:UserWS] ❌ ${msg}`, err ?? '');
}

/**
 * Generate HMAC signature for WebSocket authentication
 */
function generateHmacSignature(
  secret: string,
  timestamp: string,
  method: string,
  path: string,
  body: string = ''
): string {
  const message = timestamp + method + path + body;
  const hmac = crypto.createHmac('sha256', Buffer.from(secret, 'base64'));
  hmac.update(message);
  return hmac.digest('base64');
}

/**
 * Get API credentials (from config or derived)
 */
function getCredentials(): { apiKey: string; secret: string; passphrase: string } | null {
  const apiKey = config.polymarket.apiKey;
  const secret = config.polymarket.apiSecret;
  const passphrase = config.polymarket.passphrase;
  
  if (!apiKey || !secret || !passphrase) {
    return null;
  }
  
  return { apiKey, secret, passphrase };
}

/**
 * Build authentication message for User Channel
 */
function buildAuthMessage(): object | null {
  const creds = getCredentials();
  if (!creds) {
    logError('No API credentials available for User Channel');
    return null;
  }
  
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const method = 'GET';
  const path = '/ws/user';
  
  const signature = generateHmacSignature(creds.secret, timestamp, method, path);
  
  return {
    type: 'subscribe',
    channel: 'user',
    auth: {
      apiKey: creds.apiKey,
      secret: creds.secret,
      passphrase: creds.passphrase,
      timestamp,
      signature,
    },
  };
}

function startPingInterval(): void {
  stopPingInterval();
  
  pingInterval = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send('PING');
      } catch (err) {
        logError('Failed to send ping', err);
      }
    }
  }, PING_INTERVAL_MS);
}

function stopPingInterval(): void {
  if (pingInterval) {
    clearInterval(pingInterval);
    pingInterval = null;
  }
}

function connect(): void {
  if (ws) {
    ws.terminate();
    ws = null;
  }
  
  const authMessage = buildAuthMessage();
  if (!authMessage) {
    logError('Cannot connect: no auth credentials');
    return;
  }
  
  log(`Connecting to User Channel...`);
  
  ws = new WebSocket(USER_WS_URL);
  
  ws.on('open', () => {
    log('✅ Connected, sending auth...');
    reconnectAttempts = 0;
    
    // Send authentication message
    ws!.send(JSON.stringify(authMessage));
    
    startPingInterval();
  });
  
  ws.on('message', (data: Buffer) => {
    try {
      const msg = data.toString();
      
      // Handle PONG
      if (msg === 'PONG') {
        return;
      }
      
      const parsed = JSON.parse(msg);
      
      // Handle subscription confirmation
      if (parsed.type === 'subscribed' || parsed.channel === 'user') {
        log('✅ Subscribed to User Channel');
        return;
      }
      
      // Handle error
      if (parsed.type === 'error' || parsed.error) {
        logError(`Channel error: ${parsed.error || parsed.message || JSON.stringify(parsed)}`);
        return;
      }
      
      // Handle trade events
      if (parsed.event_type === 'trade' || parsed.type === 'TRADE') {
        const event = parsed as TradeEvent;
        log(`📈 Trade: ${event.side} ${event.size} @ ${event.price} (${event.status}) token=${event.asset_id?.slice(0, 12)}...`);
        onTradeCallback?.(event);
        return;
      }
      
      // Handle order events
      if (parsed.event_type === 'order') {
        const event = parsed as OrderEvent;
        log(`📝 Order: ${event.type} ${event.side} ${event.original_size} @ ${event.price} (matched: ${event.size_matched})`);
        onOrderCallback?.(event);
        return;
      }
      
      // Unknown message
      log(`Unknown message: ${msg.slice(0, 100)}`);
      
    } catch (err) {
      // Ignore parse errors for non-JSON messages
    }
  });
  
  ws.on('close', () => {
    log('⚠️ Disconnected from User Channel');
    stopPingInterval();
    scheduleReconnect();
  });
  
  ws.on('error', (err) => {
    logError('WebSocket error', err);
    stopPingInterval();
  });
}

function scheduleReconnect(): void {
  if (!isRunning) return;
  
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    logError(`Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached, giving up`);
    return;
  }
  
  reconnectAttempts++;
  const delay = Math.min(30_000, 3000 * Math.pow(1.5, reconnectAttempts - 1));
  
  log(`Reconnecting in ${(delay / 1000).toFixed(1)}s (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);
  
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
  }
  
  reconnectTimeout = setTimeout(() => {
    connect();
  }, delay);
}

/**
 * Start the User Channel WebSocket feed
 */
export function startUserChannel(
  onTrade: OnTradeCallback,
  onOrder?: OnOrderCallback
): boolean {
  const creds = getCredentials();
  if (!creds) {
    logError('Cannot start User Channel: no API credentials configured');
    return false;
  }
  
  isRunning = true;
  onTradeCallback = onTrade;
  onOrderCallback = onOrder ?? null;
  reconnectAttempts = 0;
  
  connect();
  
  return true;
}

/**
 * Stop the User Channel WebSocket feed
 */
export function stopUserChannel(): void {
  isRunning = false;
  onTradeCallback = null;
  onOrderCallback = null;
  
  stopPingInterval();
  
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }
  
  if (ws) {
    ws.terminate();
    ws = null;
  }
  
  log('Stopped');
}

/**
 * Check if User Channel is connected
 */
export function isUserChannelConnected(): boolean {
  return ws !== null && ws.readyState === WebSocket.OPEN;
}
