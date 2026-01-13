/**
 * V29 Binance WebSocket Price Feed
 * 
 * Simple, clean WebSocket connection to Binance for real-time prices
 */

import WebSocket from 'ws';
import { Asset, BINANCE_SYMBOLS } from './config.js';

type PriceCallback = (asset: Asset, price: number) => void;

let ws: WebSocket | null = null;
let reconnectTimeout: NodeJS.Timeout | null = null;
let priceCallback: PriceCallback | null = null;
let isRunning = false;

const BINANCE_WS_URL = 'wss://stream.binance.com:9443/ws';

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

function connect(assets: Asset[]): void {
  if (ws) {
    ws.close();
    ws = null;
  }
  
  // Build stream names
  const streams = assets.map(a => `${BINANCE_SYMBOLS[a]}@trade`).join('/');
  const url = `${BINANCE_WS_URL}/${streams}`;
  
  log(`Connecting to: ${url}`);
  
  ws = new WebSocket(url);
  
  ws.on('open', () => {
    log('✅ Connected to Binance');
  });
  
  ws.on('message', (data: Buffer) => {
    try {
      const msg = JSON.parse(data.toString());
      
      // Trade event format
      if (msg.e === 'trade' && msg.s && msg.p) {
        const asset = symbolToAsset(msg.s);
        const price = parseFloat(msg.p);
        
        if (asset && priceCallback && !isNaN(price)) {
          priceCallback(asset, price);
        }
      }
    } catch (err) {
      // Ignore parse errors
    }
  });
  
  ws.on('close', () => {
    log('⚠️ Disconnected from Binance');
    scheduleReconnect(assets);
  });
  
  ws.on('error', (err) => {
    log(`❌ WebSocket error: ${err.message}`);
  });
}

function scheduleReconnect(assets: Asset[]): void {
  if (!isRunning) return;
  
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
  }
  
  reconnectTimeout = setTimeout(() => {
    log('Reconnecting...');
    connect(assets);
  }, 3000);
}

export function startBinanceFeed(assets: Asset[], onPrice: PriceCallback): void {
  isRunning = true;
  priceCallback = onPrice;
  connect(assets);
}

export function stopBinanceFeed(): void {
  isRunning = false;
  priceCallback = null;
  
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
