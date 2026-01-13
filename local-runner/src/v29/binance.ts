/**
 * V29 Binance WebSocket Price Feed
 *
 * NOTE: Binance emits a *trade* event for every fill, which is far more frequent
 * than our strategy "ticks". To match the intended "tick-to-tick" behavior
 * (and the UI), we:
 *  - listen to the trade stream to get the latest price
 *  - emit the latest price on a fixed cadence (pollMs)
 */

import WebSocket from 'ws';
import { Asset, BINANCE_SYMBOLS } from './config.js';

type PriceCallback = (asset: Asset, price: number) => void;

type StatusEvent =
  | { type: 'open'; url: string }
  | { type: 'close'; url: string }
  | { type: 'error'; url: string; message: string };

type StatusCallback = (event: StatusEvent) => void;

let ws: WebSocket | null = null;
let reconnectTimeout: NodeJS.Timeout | null = null;
let flushInterval: NodeJS.Timeout | null = null;

let priceCallback: PriceCallback | null = null;
let statusCallback: StatusCallback | null = null;
let isRunning = false;

let currentAssets: Asset[] = [];
let currentPollMs = 100;

const latestPrice: Record<Asset, number | null> = { BTC: null, ETH: null, SOL: null, XRP: null };
const lastEmittedPrice: Record<Asset, number | null> = { BTC: null, ETH: null, SOL: null, XRP: null };

const BINANCE_WS_BASE = 'wss://stream.binance.com:9443/ws';

function log(msg: string): void {
  console.log(`[V29:Binance] ${msg}`);
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

function startEmitter(): void {
  if (flushInterval) return;
  flushInterval = setInterval(() => {
    if (!priceCallback) return;

    for (const a of currentAssets) {
      const p = latestPrice[a];
      if (p == null) continue;

      // Emit only when price changed since last emit (prevents spam and makes deltas meaningful)
      if (lastEmittedPrice[a] !== p) {
        lastEmittedPrice[a] = p;
        priceCallback(a, p);
      }
    }
  }, currentPollMs);
}

function stopEmitter(): void {
  if (!flushInterval) return;
  clearInterval(flushInterval);
  flushInterval = null;
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

      // Trade event format
      if (msg?.e === 'trade' && msg?.s && msg?.p) {
        const asset = symbolToAsset(msg.s);
        const price = parseFloat(msg.p);

        if (asset && !isNaN(price)) {
          latestPrice[asset] = price;
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

export function startBinanceFeed(
  assets: Asset[],
  onPrice: PriceCallback,
  pollMs?: number,
  onStatus?: StatusCallback
): void {
  isRunning = true;
  priceCallback = onPrice;
  statusCallback = onStatus ?? null;
  currentAssets = assets;
  currentPollMs = Math.max(50, pollMs ?? 100);

  // reset emit tracking
  for (const a of assets) {
    lastEmittedPrice[a] = null;
  }

  startEmitter();
  connect();
}

export function stopBinanceFeed(): void {
  isRunning = false;
  priceCallback = null;
  statusCallback = null;

  stopEmitter();

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
