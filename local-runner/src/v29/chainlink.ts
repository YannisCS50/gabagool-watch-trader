/**
 * V29 Chainlink Price Feed via Polymarket RTDS WebSocket
 * 
 * Uses Polymarket's Real-Time Data Stream (RTDS) which broadcasts
 * Chainlink prices in real-time via WebSocket.
 * 
 * Topic: crypto_prices_chainlink
 * Format: { symbol: "btc/usd", value: 98765.43 }
 */

import WebSocket from 'ws';
import { Asset } from './config.js';

type PriceCallback = (asset: Asset, price: number) => void;

let ws: WebSocket | null = null;
let reconnectTimeout: NodeJS.Timeout | null = null;
let priceCallback: PriceCallback | null = null;
let isRunning = false;
let currentAssets: Asset[] = [];
let reconnectAttempts = 0;

const RTDS_WS_URL = 'wss://ws-live-data.polymarket.com';
const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_DELAY = 3000;

// Store current prices
const currentPrices: Record<Asset, number> = {
  BTC: 0,
  ETH: 0,
  SOL: 0,
  XRP: 0,
};

function log(msg: string): void {
  console.log(`[V29:Chainlink] ${msg}`);
}

function symbolToAsset(symbol: string): Asset | null {
  const lower = symbol.toLowerCase();
  if (lower.includes('btc')) return 'BTC';
  if (lower.includes('eth')) return 'ETH';
  if (lower.includes('sol')) return 'SOL';
  if (lower.includes('xrp')) return 'XRP';
  return null;
}

function connect(): void {
  if (ws) {
    ws.close();
    ws = null;
  }
  
  log(`Connecting to Polymarket RTDS WebSocket...`);
  
  ws = new WebSocket(RTDS_WS_URL);
  
  ws.on('open', () => {
    log('✅ Connected to Polymarket RTDS');
    reconnectAttempts = 0;
    
    // Subscribe to crypto_prices_chainlink topic
    const subscribeMsg = {
      action: 'subscribe',
      subscriptions: [
        { topic: 'crypto_prices_chainlink', type: '*', filters: '' }
      ]
    };
    
    ws?.send(JSON.stringify(subscribeMsg));
    log('📡 Subscribed to crypto_prices_chainlink');
  });
  
  ws.on('message', (data: Buffer) => {
    try {
      const msg = JSON.parse(data.toString());
      
      // Handle crypto price updates
      // Format: { topic: "crypto_prices_chainlink", payload: { symbol: "btc/usd", value: 98765.43 } }
      if (msg.topic === 'crypto_prices_chainlink' && msg.payload) {
        const symbol = String(msg.payload.symbol || '');
        const value = typeof msg.payload.value === 'number' ? msg.payload.value : 
                      typeof msg.payload.price === 'number' ? msg.payload.price : null;
        
        if (value !== null) {
          const asset = symbolToAsset(symbol);
          if (asset && currentAssets.includes(asset)) {
            const prevPrice = currentPrices[asset];
            
            if (value !== prevPrice) {
              currentPrices[asset] = value;
              
              if (prevPrice > 0) {
                const delta = value - prevPrice;
                log(`📡 ${asset}: $${value.toFixed(2)} (${delta >= 0 ? '+' : ''}${delta.toFixed(2)})`);
              } else {
                log(`📡 ${asset}: $${value.toFixed(2)}`);
              }
              
              if (priceCallback) {
                priceCallback(asset, value);
              }
            }
          }
        }
      }
    } catch (err) {
      // Ignore parse errors (PONG messages etc)
    }
  });
  
  ws.on('close', () => {
    log('⚠️ Disconnected from Polymarket RTDS');
    scheduleReconnect();
  });
  
  ws.on('error', (err) => {
    log(`❌ WebSocket error: ${err.message}`);
  });
}

function scheduleReconnect(): void {
  if (!isRunning) return;
  
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
  }
  
  if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
    reconnectAttempts++;
    const delay = RECONNECT_DELAY * Math.min(reconnectAttempts, 5);
    log(`Reconnecting in ${delay}ms (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);
    reconnectTimeout = setTimeout(connect, delay);
  } else {
    log('❌ Max reconnect attempts reached');
  }
}

export function startChainlinkFeed(assets: Asset[], onPrice: PriceCallback): void {
  isRunning = true;
  priceCallback = onPrice;
  currentAssets = assets;
  reconnectAttempts = 0;
  
  log(`Starting RTDS feed for ${assets.join(', ')}`);
  connect();
}

export function stopChainlinkFeed(): void {
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

export function getChainlinkPrice(asset: Asset): number | null {
  const price = currentPrices[asset];
  return price > 0 ? price : null;
}
