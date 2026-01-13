/**
 * V29 Chainlink WebSocket Price Feed
 * 
 * Real-time Chainlink prices via Polygon WebSocket RPC
 * Subscribes to AnswerUpdated events from Chainlink Aggregator contracts
 */

import WebSocket from 'ws';
import { Asset } from './config.js';

type PriceCallback = (asset: Asset, price: number) => void;

let ws: WebSocket | null = null;
let reconnectTimeout: NodeJS.Timeout | null = null;
let priceCallback: PriceCallback | null = null;
let isRunning = false;
let currentAssets: Asset[] = [];

// Polygon WebSocket RPC (free tier)
const POLYGON_WS_URL = 'wss://polygon-mainnet.g.alchemy.com/v2/demo';

// Chainlink Aggregator Proxy addresses on Polygon
// These are the proxy contracts that emit AnswerUpdated events
const CHAINLINK_AGGREGATORS: Record<Asset, string> = {
  BTC: '0xc907E116054Ad103354f2D350FD2514433D57F6f', // BTC/USD
  ETH: '0xF9680D99D6C9589e2a93a78A04A279e509205945', // ETH/USD
  SOL: '0x10C8264C0935b3B9870013e057f330Ff3e9C56dC', // SOL/USD
  XRP: '0x785ba89291f676b5386652eB12b30cF361020694', // XRP/USD
};

// AnswerUpdated event signature: AnswerUpdated(int256 indexed current, uint256 indexed roundId, uint256 updatedAt)
const ANSWER_UPDATED_TOPIC = '0x0559884fd3a460db3073b7fc896cc77986f16e378210ded43186175bf646fc5f';

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

function addressToAsset(address: string): Asset | null {
  const lower = address.toLowerCase();
  for (const [asset, addr] of Object.entries(CHAINLINK_AGGREGATORS)) {
    if (addr.toLowerCase() === lower) {
      return asset as Asset;
    }
  }
  return null;
}

async function fetchInitialPrices(assets: Asset[]): Promise<void> {
  // Use HTTP RPC to get initial prices
  const rpcUrl = 'https://polygon-rpc.com';
  
  for (const asset of assets) {
    try {
      const feedAddress = CHAINLINK_AGGREGATORS[asset];
      if (!feedAddress) continue;
      
      // Call latestRoundData() - signature: 0xfeaf968c
      const response = await fetch(rpcUrl, {
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
          currentPrices[asset] = price;
          log(`Initial ${asset}: $${price.toFixed(2)}`);
          if (priceCallback) {
            priceCallback(asset, price);
          }
        }
      }
    } catch (err) {
      log(`⚠️ Failed to fetch initial ${asset} price`);
    }
  }
}

function connect(assets: Asset[]): void {
  if (ws) {
    ws.close();
    ws = null;
  }
  
  // Build list of contract addresses to watch
  const addresses = assets
    .map(a => CHAINLINK_AGGREGATORS[a])
    .filter(Boolean)
    .map(a => a.toLowerCase());
  
  log(`Connecting to Polygon WebSocket...`);
  
  ws = new WebSocket(POLYGON_WS_URL);
  
  ws.on('open', () => {
    log('✅ Connected to Polygon WebSocket');
    
    // Subscribe to AnswerUpdated events from Chainlink aggregators
    const subscribeMsg = {
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_subscribe',
      params: [
        'logs',
        {
          address: addresses,
          topics: [ANSWER_UPDATED_TOPIC],
        },
      ],
    };
    
    ws?.send(JSON.stringify(subscribeMsg));
    log(`Subscribed to ${addresses.length} Chainlink feeds`);
  });
  
  ws.on('message', (data: Buffer) => {
    try {
      const msg = JSON.parse(data.toString());
      
      // Handle subscription confirmation
      if (msg.id === 1 && msg.result) {
        log(`Subscription ID: ${msg.result}`);
        return;
      }
      
      // Handle log events
      if (msg.method === 'eth_subscription' && msg.params?.result) {
        const logData = msg.params.result;
        const address = logData.address;
        const topics = logData.topics;
        
        if (topics && topics[0] === ANSWER_UPDATED_TOPIC && topics[1]) {
          const asset = addressToAsset(address);
          if (!asset) return;
          
          // topics[1] is the indexed "current" price (int256)
          // It's already hex encoded
          const priceHex = topics[1];
          const rawPrice = BigInt(priceHex);
          const price = Number(rawPrice) / 1e8;
          
          if (price > 0 && price !== currentPrices[asset]) {
            const prevPrice = currentPrices[asset];
            currentPrices[asset] = price;
            
            const delta = prevPrice > 0 ? price - prevPrice : 0;
            log(`📡 ${asset}: $${price.toFixed(2)} (${delta >= 0 ? '+' : ''}${delta.toFixed(2)})`);
            
            if (priceCallback) {
              priceCallback(asset, price);
            }
          }
        }
      }
    } catch (err) {
      // Ignore parse errors
    }
  });
  
  ws.on('close', () => {
    log('⚠️ Disconnected from Polygon WebSocket');
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

export function startChainlinkFeed(assets: Asset[], onPrice: PriceCallback): void {
  isRunning = true;
  priceCallback = onPrice;
  currentAssets = assets;
  
  // Fetch initial prices first, then connect to WebSocket
  void fetchInitialPrices(assets).then(() => {
    connect(assets);
  });
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
