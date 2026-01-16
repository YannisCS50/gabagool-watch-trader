/**
 * Tracked Wallet WebSocket
 * 
 * Connects to Polymarket CLOB Market WebSocket and filters trades
 * by a specific wallet address in real-time.
 * 
 * The CLOB Market WS broadcasts ALL trades for subscribed markets.
 * We filter client-side for the target wallet.
 */

import WebSocket from 'ws';

const CLOB_WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const RECONNECT_DELAY_MS = 5000;
const PING_INTERVAL_MS = 15000;

export interface TrackedTrade {
  tradeId: string;
  timestamp: number;
  asset: string | null;
  marketSlug: string | null;
  tokenId: string;
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
  makerAddress: string;
  takerAddress: string;
}

export type OnTrackedTradeCallback = (trade: TrackedTrade) => void;

// State
let ws: WebSocket | null = null;
let isRunning = false;
let reconnectTimer: NodeJS.Timeout | null = null;
let pingTimer: NodeJS.Timeout | null = null;

let targetWallet: string = '';
let subscribedTokens: string[] = [];
let onTradeCallback: OnTrackedTradeCallback | null = null;

// Token ID to market info mapping
const tokenInfoMap = new Map<string, { asset: string | null; marketSlug: string | null }>();

// Stats
let stats = {
  connected: false,
  messagesReceived: 0,
  tradesMatched: 0,
  lastMessageAt: 0,
};

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] [TrackedWalletWS] ${msg}`);
}

/**
 * Update the list of token IDs to subscribe to
 */
export function setSubscribedTokens(
  tokens: Array<{ tokenId: string; asset?: string; marketSlug?: string }>
): void {
  tokenInfoMap.clear();
  subscribedTokens = [];

  for (const t of tokens) {
    subscribedTokens.push(t.tokenId);
    tokenInfoMap.set(t.tokenId, {
      asset: t.asset || null,
      marketSlug: t.marketSlug || null,
    });
  }

  // Resubscribe if connected
  if (ws?.readyState === WebSocket.OPEN && subscribedTokens.length > 0) {
    subscribe();
  }
}

/**
 * Set the wallet address to track
 */
export function setTargetWallet(wallet: string): void {
  targetWallet = wallet.toLowerCase();
  log(`🎯 Tracking wallet: ${targetWallet.slice(0, 10)}...`);
}

/**
 * Subscribe to market updates
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
    log(`📡 Subscribed to ${subscribedTokens.length} markets`);
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
    stats.messagesReceived++;

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

    // Look for trade/last_trade_price events which contain trade info
    // The CLOB WS sends different event types - we need to find which contains addresses
    
    // last_trade_price event contains maker/taker
    if (msg.event_type === 'last_trade_price' && msg.asset_id) {
      handleTradeEvent(msg, now);
      return;
    }

    // tick event might contain trade data
    if (msg.event_type === 'tick' && msg.asset_id) {
      // Tick events contain bid/ask but also last trade info
      if (msg.last_trade_price && (msg.maker_address || msg.taker_address)) {
        handleTradeEvent({
          ...msg,
          price: msg.last_trade_price,
          size: msg.last_trade_size || 0,
        }, now);
      }
      return;
    }

    // trade event (if exists)
    if (msg.event_type === 'trade' && msg.asset_id) {
      handleTradeEvent(msg, now);
      return;
    }

  } catch (e) {
    // Ignore parse errors
  }
}

/**
 * Handle a potential trade event and check if it matches our target wallet
 */
function handleTradeEvent(msg: Record<string, unknown>, timestamp: number): void {
  const makerAddress = (msg.maker_address as string || '').toLowerCase();
  const takerAddress = (msg.taker_address as string || '').toLowerCase();

  // Check if target wallet is involved
  if (!targetWallet) return;
  if (makerAddress !== targetWallet && takerAddress !== targetWallet) return;

  stats.tradesMatched++;

  const tokenId = msg.asset_id as string;
  const tokenInfo = tokenInfoMap.get(tokenId) || { asset: null, marketSlug: null };

  // Determine side from perspective of target wallet
  const isMaker = makerAddress === targetWallet;
  // If maker, they provided liquidity (could be buy or sell)
  // Use maker_side/taker_side if available
  let side: 'BUY' | 'SELL' = 'BUY';
  if (msg.taker_side) {
    side = isMaker 
      ? (msg.taker_side === 'BUY' ? 'SELL' : 'BUY')
      : (msg.taker_side as 'BUY' | 'SELL');
  }

  const trade: TrackedTrade = {
    tradeId: (msg.id as string) || `${tokenId}-${timestamp}`,
    timestamp,
    asset: tokenInfo.asset,
    marketSlug: tokenInfo.marketSlug,
    tokenId,
    side,
    price: parseFloat(msg.price as string) || 0,
    size: parseFloat(msg.size as string) || 0,
    makerAddress,
    takerAddress,
  };

  log(`🎯 MATCHED TRADE: ${trade.side} ${trade.size} @ ${(trade.price * 100).toFixed(1)}¢ (${trade.asset || 'unknown'})`);

  onTradeCallback?.(trade);
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

  log(`🔌 Connecting to CLOB WebSocket...`);

  try {
    ws = new WebSocket(CLOB_WS_URL);
  } catch (e) {
    log(`❌ WebSocket creation failed: ${(e as Error).message}`);
    scheduleReconnect();
    return;
  }

  ws.on('open', () => {
    log('✅ Connected to CLOB WebSocket');
    stats.connected = true;
    stats.lastMessageAt = Date.now();

    // Subscribe after short delay
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

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  log(`🔄 Reconnecting in ${RECONNECT_DELAY_MS / 1000}s...`);
  reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
}

/**
 * Start tracking trades for a wallet
 */
export function startTrackedWalletWs(
  wallet: string,
  tokens: Array<{ tokenId: string; asset?: string; marketSlug?: string }>,
  onTrade: OnTrackedTradeCallback
): void {
  if (isRunning) {
    log('⚠️ Already running - updating config');
    setTargetWallet(wallet);
    setSubscribedTokens(tokens);
    onTradeCallback = onTrade;
    return;
  }

  log('🚀 Starting tracked wallet WebSocket...');

  setTargetWallet(wallet);
  setSubscribedTokens(tokens);
  onTradeCallback = onTrade;
  isRunning = true;

  stats = {
    connected: false,
    messagesReceived: 0,
    tradesMatched: 0,
    lastMessageAt: 0,
  };

  connect();
}

/**
 * Stop tracking
 */
export function stopTrackedWalletWs(): void {
  if (!isRunning) return;

  log('🛑 Stopping tracked wallet WebSocket...');
  isRunning = false;
  onTradeCallback = null;

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
      ws.close();
    } catch (e) { /* ignore */ }
    ws = null;
  }

  stats.connected = false;
}

/**
 * Check if connected
 */
export function isTrackedWalletWsConnected(): boolean {
  return stats.connected;
}

/**
 * Get stats
 */
export function getTrackedWalletWsStats(): typeof stats {
  return { ...stats };
}
