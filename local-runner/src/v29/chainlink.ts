/**
 * V29 Chainlink Price Feed
 * 
 * Uses HTTP polling since Polygon WebSocket RPC has aggressive rate limits (429).
 * Polls every 2 seconds for near-realtime updates.
 * 
 * Chainlink on Polygon updates every ~27 seconds anyway, so polling is fine.
 */

import { Asset } from './config.js';

type PriceCallback = (asset: Asset, price: number) => void;

let pollInterval: NodeJS.Timeout | null = null;
let priceCallback: PriceCallback | null = null;
let isRunning = false;
let currentAssets: Asset[] = [];

// Use free public RPCs (rotate to avoid rate limits)
const RPC_URLS = [
  'https://polygon-rpc.com',
  'https://polygon.llamarpc.com',
  'https://rpc.ankr.com/polygon',
];
let rpcIndex = 0;

// Chainlink Aggregator Proxy addresses on Polygon
const CHAINLINK_AGGREGATORS: Record<Asset, string> = {
  BTC: '0xc907E116054Ad103354f2D350FD2514433D57F6f', // BTC/USD
  ETH: '0xF9680D99D6C9589e2a93a78A04A279e509205945', // ETH/USD
  SOL: '0x10C8264C0935b3B9870013e057f330Ff3e9C56dC', // SOL/USD
  XRP: '0x785ba89291f676b5386652eB12b30cF361020694', // XRP/USD
};

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

function getRpcUrl(): string {
  const url = RPC_URLS[rpcIndex];
  rpcIndex = (rpcIndex + 1) % RPC_URLS.length;
  return url;
}

async function fetchPrice(asset: Asset): Promise<number | null> {
  const feedAddress = CHAINLINK_AGGREGATORS[asset];
  if (!feedAddress) return null;
  
  try {
    // Call latestRoundData() - signature: 0xfeaf968c
    const response = await fetch(getRpcUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'eth_call',
        params: [{
          to: feedAddress,
          data: '0xfeaf968c', // latestRoundData()
        }, 'latest'],
        id: 1,
      }),
    });
    
    const result = await response.json();
    if (result.result && result.result !== '0x') {
      // Parse answer (second 32-byte slot)
      const hex = result.result.slice(2);
      const answerHex = hex.slice(64, 128);
      const rawPrice = BigInt('0x' + answerHex);
      
      // Chainlink uses 8 decimals for USD feeds
      const price = Number(rawPrice) / 1e8;
      
      if (price > 0) {
        return price;
      }
    }
  } catch (err) {
    // Silent fail, try next RPC on next poll
  }
  
  return null;
}

async function pollAllPrices(): Promise<void> {
  if (!isRunning) return;
  
  // Fetch all assets in parallel
  const results = await Promise.all(
    currentAssets.map(async (asset) => {
      const price = await fetchPrice(asset);
      return { asset, price };
    })
  );
  
  for (const { asset, price } of results) {
    if (price !== null && price !== currentPrices[asset]) {
      const prevPrice = currentPrices[asset];
      currentPrices[asset] = price;
      
      if (prevPrice > 0) {
        const delta = price - prevPrice;
        log(`📡 ${asset}: $${price.toFixed(2)} (${delta >= 0 ? '+' : ''}${delta.toFixed(2)})`);
      } else {
        log(`📡 ${asset}: $${price.toFixed(2)}`);
      }
      
      if (priceCallback) {
        priceCallback(asset, price);
      }
    }
  }
}

export function startChainlinkFeed(assets: Asset[], onPrice: PriceCallback): void {
  isRunning = true;
  priceCallback = onPrice;
  currentAssets = assets;
  
  log(`Starting HTTP polling for ${assets.join(', ')} (every 2s)`);
  
  // Initial fetch
  void pollAllPrices();
  
  // Poll every 2 seconds (Chainlink updates every ~27s anyway)
  pollInterval = setInterval(() => {
    void pollAllPrices();
  }, 2000);
}

export function stopChainlinkFeed(): void {
  isRunning = false;
  priceCallback = null;
  
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
  
  log('Stopped');
}

export function getChainlinkPrice(asset: Asset): number | null {
  const price = currentPrices[asset];
  return price > 0 ? price : null;
}
