/**
 * V29 Binance WebSocket Price Feed
 *
 * This implementation emits every trade event immediately to match the UI behavior.
 * The strategy can then calculate tick-to-tick deltas identically to what's shown in PriceLatencyChart.
 */

import WebSocket from 'ws';
import { Asset, BINANCE_SYMBOLS } from './config.js';

type PriceCallback = (asset: Asset, price: number, timestamp: number) => void;

type StatusEvent =
  | { type: 'open'; url: string }
  | { type: 'close'; url: string }
  | { type: 'error'; url: string; message: string };

type StatusCallback = (event: StatusEvent) => void;

let ws: WebSocket | null = null;
let reconnectTimeout: NodeJS.Timeout | null = null;

let priceCallback: PriceCallback | null = null;
let statusCallback: StatusCallback | null = null;
let isRunning = false;

let currentAssets: Asset[] = [];

const BINANCE_WS_BASE = 'wss://stream.binance.com:9443/ws';

// Buffer configuration - aggregate trades over 100ms windows
const BUFFER_MS = 100;

// Per-asset price buffer
interface PriceBuffer {
  windowStart: number;
  firstPrice: number | null;
  lastPrice: number | null;
  lastTimestamp: number;
  timeout: NodeJS.Timeout | null;
}

const priceBuffers: Record<Asset, PriceBuffer> = {
  BTC: { windowStart: 0, firstPrice: null, lastPrice: null, lastTimestamp: 0, timeout: null },
  ETH: { windowStart: 0, firstPrice: null, lastPrice: null, lastTimestamp: 0, timeout: null },
  SOL: { windowStart: 0, firstPrice: null, lastPrice: null, lastTimestamp: 0, timeout: null },
  XRP: { windowStart: 0, firstPrice: null, lastPrice: null, lastTimestamp: 0, timeout: null },
};

// Track last emitted price per asset (for delta calculation between windows)
const lastEmittedPrice: Record<Asset, number | null> = {
  BTC: null, ETH: null, SOL: null, XRP: null
};

function log(msg: string): void {
  console.log(`[V29:Binance] ${msg}`);
}

function emitBufferedPrice(asset: Asset): void {
  const buffer = priceBuffers[asset];
  
  if (buffer.lastPrice === null) return;
  
  // Emit the aggregated price
  if (priceCallback) {
    priceCallback(asset, buffer.lastPrice, buffer.lastTimestamp);
  }
  
  // Store for next window's delta calculation
  lastEmittedPrice[asset] = buffer.lastPrice;
  
  // Reset buffer
  buffer.firstPrice = null;
  buffer.lastPrice = null;
  buffer.timeout = null;
}

function bufferPrice(asset: Asset, price: number, timestamp: number): void {
  const buffer = priceBuffers[asset];
  const now = Date.now();
  
  // First price in this window
  if (buffer.firstPrice === null) {
    buffer.windowStart = now;
    buffer.firstPrice = price;
  }
  
  // Always update last price
  buffer.lastPrice = price;
  buffer.lastTimestamp = timestamp;
  
  // Schedule emit if not already scheduled
  if (buffer.timeout === null) {
    buffer.timeout = setTimeout(() => {
      emitBufferedPrice(asset);
    }, BUFFER_MS);
  }
}

function symbolToAsset(symbol: string): Asset | null {
  const upper = symbol.toUpperCase();
  if (upper === 'BTCUSDT') return 'BTC';
  if (upper === 'ETHUSDT') return 'ETH';
  if (upper === 'SOLUSDT') return 'SOL';
  if (upper === 'XRPUSDT') return 'XRP';
  return null;
}

function buildUrl(assets: Asset[]): string {
  const streams = assets.map((a) => `${BINANCE_SYMBOLS[a]}@trade`).join('/');
  return `${BINANCE_WS_BASE}/${streams}`;
}

function connect(): void {
  if (!currentAssets.length) return;

  if (ws) {
    ws.close();
    ws = null;
  }

  const url = buildUrl(currentAssets);
  log(`Connecting to: ${url}`);

  ws = new WebSocket(url);

  ws.on('open', () => {
    log('✅ Connected to Binance');
    statusCallback?.({ type: 'open', url });
  });

  ws.on('message', (data: Buffer) => {
    try {
      const msg = JSON.parse(data.toString());

      // Trade event format: { e: 'trade', s: 'BTCUSDT', p: '92000.50', T: 1768302000000 }
      if (msg?.e === 'trade' && msg?.s && msg?.p) {
        const asset = symbolToAsset(msg.s);
        const price = parseFloat(msg.p);
        const timestamp = msg.T ?? Date.now(); // Trade timestamp from Binance

        if (asset && !isNaN(price)) {
          // Buffer trades and emit aggregated price every 100ms
          bufferPrice(asset, price, timestamp);
        }
      }
    } catch {
      // ignore parse errors
    }
  });

  ws.on('close', () => {
    log('⚠️ Disconnected from Binance');
    statusCallback?.({ type: 'close', url });
    scheduleReconnect();
  });

  ws.on('error', (err) => {
    log(`❌ WebSocket error: ${err.message}`);
    statusCallback?.({ type: 'error', url, message: err.message });
  });
}

function scheduleReconnect(): void {
  if (!isRunning) return;

  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
  }

  reconnectTimeout = setTimeout(() => {
    log('Reconnecting...');
    connect();
  }, 3000);
}

/**
 * Start the Binance WebSocket feed.
 * @param assets - Assets to subscribe to
 * @param onPrice - Callback for each trade (asset, price, timestamp)
 * @param _pollMs - IGNORED (kept for backward compatibility)
 * @param onStatus - Optional callback for connection status events
 */
export function startBinanceFeed(
  assets: Asset[],
  onPrice: PriceCallback,
  _pollMs?: number,
  onStatus?: StatusCallback
): void {
  isRunning = true;
  priceCallback = onPrice;
  statusCallback = onStatus ?? null;
  currentAssets = assets;

  connect();
}

export function stopBinanceFeed(): void {
  isRunning = false;
  priceCallback = null;
  statusCallback = null;

  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }

  if (ws) {
    ws.close();
    ws = null;
  }

  log('Stopped');
}
