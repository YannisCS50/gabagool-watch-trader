#!/usr/bin/env npx ts-node
// ============================================================
// PAPER STRATEGY RUNNER - Opening + Hedge (3% Profit Lock)
// ============================================================
//
// Strategy:
// 1. OPENING: Koop goedkoopste kant (≤52¢)
// 2. HEDGE: Koop andere kant zodra combined < 97¢ (3%+ winst)
// 3. Max 5 shares per positie
//
// Run: npm run paper-live
//
// ============================================================

import { config } from './config.js';
import { testConnection, getBalance, placeOrder, getOrderbookDepth } from './polymarket.js';
import { fetchMarkets, sendHeartbeat, getSupabaseClient } from './backend.js';
import { enforceVpnOrExit } from './vpn-check.js';

// ============================================================
// STRATEGY CONFIG
// ============================================================

const STRATEGY_CONFIG = {
  // Opening trade
  opening: {
    shares: 5,           // 5 shares per opening
    maxPrice: 0.52,      // Only open if price ≤ 52¢
  },
  
  // Hedge settings - only hedge if profit locked
  hedge: {
    maxCombined: 0.97,   // Only hedge if combined < 97¢ (3%+ profit)
  },
  
  // General settings
  minSecondsRemaining: 60,  // Stop 60s before expiry
  minPrice: 0.02,           // Don't buy under 2¢
  maxPrice: 0.98,           // Don't buy above 98¢
  
  // Rate limiting
  orderCooldownMs: 10_000,  // 10 seconds between orders per market
};

// ============================================================
// TYPES
// ============================================================

interface Market {
  id: string;
  slug: string;
  asset: string;
  upTokenId: string;
  downTokenId: string;
  eventStartTime: Date;
  eventEndTime: Date;
}

interface Position {
  marketId: string;
  upShares: number;
  downShares: number;
  upAvgPrice: number;
  downAvgPrice: number;
  upCost: number;
  downCost: number;
  lastOrderAt: number;
}

interface OrderBook {
  upBid: number;
  upAsk: number;
  downBid: number;
  downAsk: number;
}

// ============================================================
// STATE
// ============================================================

const RUN_ID = `paper-live-${Date.now()}`;
const activeMarkets = new Map<string, Market>();
const positions = new Map<string, Position>();
let isRunning = false;
let tradesCount = 0;

// ============================================================
// LOGGING
// ============================================================

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

function logError(msg: string, err?: any): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.error(`[${ts}] ❌ ${msg}`, err || '');
}

// ============================================================
// POSITION MANAGEMENT
// ============================================================

function getPosition(marketId: string): Position {
  if (!positions.has(marketId)) {
    positions.set(marketId, {
      marketId,
      upShares: 0,
      downShares: 0,
      upAvgPrice: 0,
      downAvgPrice: 0,
      upCost: 0,
      downCost: 0,
      lastOrderAt: 0,
    });
  }
  return positions.get(marketId)!;
}

function recordTrade(marketId: string, side: 'UP' | 'DOWN', shares: number, price: number): void {
  const pos = getPosition(marketId);
  const cost = shares * price;
  
  if (side === 'UP') {
    const newTotal = pos.upShares + shares;
    pos.upAvgPrice = newTotal > 0 ? (pos.upCost + cost) / newTotal : price;
    pos.upShares = newTotal;
    pos.upCost += cost;
  } else {
    const newTotal = pos.downShares + shares;
    pos.downAvgPrice = newTotal > 0 ? (pos.downCost + cost) / newTotal : price;
    pos.downShares = newTotal;
    pos.downCost += cost;
  }
  
  pos.lastOrderAt = Date.now();
}

// ============================================================
// MARKET MANAGEMENT
// ============================================================

async function fetchActiveMarkets(): Promise<Market[]> {
  try {
    const result = await fetchMarkets({ v26: true });
    
    if (!result.success || !result.markets) {
      return [];
    }

    const markets: Market[] = [];
    const now = new Date();

    for (const m of result.markets) {
      const eventEnd = new Date(m.eventEndTime);
      
      // Only include markets that haven't ended
      if (eventEnd <= now) continue;
      
      // Only BTC for now (safest)
      if (m.asset !== 'BTC') continue;

      markets.push({
        id: m.slug,
        slug: m.slug,
        asset: m.asset,
        upTokenId: m.upTokenId,
        downTokenId: m.downTokenId,
        eventStartTime: new Date(m.eventStartTime),
        eventEndTime: eventEnd,
      });
    }

    return markets;
  } catch (err) {
    logError('Failed to fetch markets', err);
    return [];
  }
}

async function refreshMarkets(): Promise<void> {
  const markets = await fetchActiveMarkets();
  
  for (const market of markets) {
    if (!activeMarkets.has(market.id)) {
      activeMarkets.set(market.id, market);
      log(`📊 Registered market: ${market.asset} ${market.slug}`);
    }
  }

  // Remove expired markets
  const now = Date.now();
  for (const [id, market] of activeMarkets) {
    if (market.eventEndTime.getTime() < now) {
      activeMarkets.delete(id);
      positions.delete(id);
      log(`🏁 Market expired: ${market.asset} ${market.slug}`);
    }
  }
}

// ============================================================
// ORDERBOOK
// ============================================================

async function fetchOrderBook(market: Market): Promise<OrderBook | null> {
  try {
    const [upDepth, downDepth] = await Promise.all([
      getOrderbookDepth(market.upTokenId),
      getOrderbookDepth(market.downTokenId),
    ]);

    if (!upDepth || !downDepth) return null;

    return {
      upBid: upDepth.topBid ?? 0,
      upAsk: upDepth.topAsk ?? 1,
      downBid: downDepth.topBid ?? 0,
      downAsk: downDepth.topAsk ?? 1,
    };
  } catch {
    return null;
  }
}

// ============================================================
// TRADING LOGIC
// ============================================================

interface TradeDecision {
  shouldTrade: boolean;
  side?: 'UP' | 'DOWN';
  price?: number;
  shares?: number;
  tokenId?: string;
  reason: string;
  tradeType?: 'OPENING' | 'HEDGE';
}

function makeDecision(
  market: Market,
  book: OrderBook,
  position: Position,
  timeRemainingSeconds: number
): TradeDecision {
  // Rate limit check
  const timeSinceLastOrder = Date.now() - position.lastOrderAt;
  if (timeSinceLastOrder < STRATEGY_CONFIG.orderCooldownMs) {
    return { shouldTrade: false, reason: `COOLDOWN (${Math.ceil((STRATEGY_CONFIG.orderCooldownMs - timeSinceLastOrder) / 1000)}s)` };
  }

  // Time check
  if (timeRemainingSeconds < STRATEGY_CONFIG.minSecondsRemaining) {
    return { shouldTrade: false, reason: `TOO_LATE (${timeRemainingSeconds}s remaining)` };
  }

  const hasUp = position.upShares > 0;
  const hasDown = position.downShares > 0;
  const isHedged = hasUp && hasDown;

  // Max position check
  if (position.upShares >= STRATEGY_CONFIG.opening.shares && 
      position.downShares >= STRATEGY_CONFIG.opening.shares) {
    return { shouldTrade: false, reason: 'MAX_POSITION_REACHED' };
  }

  // === PHASE 1: OPENING ===
  if (!hasUp && !hasDown) {
    // Find cheapest side
    const upValid = book.upAsk >= STRATEGY_CONFIG.minPrice && book.upAsk <= STRATEGY_CONFIG.opening.maxPrice;
    const downValid = book.downAsk >= STRATEGY_CONFIG.minPrice && book.downAsk <= STRATEGY_CONFIG.opening.maxPrice;

    if (!upValid && !downValid) {
      return { 
        shouldTrade: false, 
        reason: `WAITING: UP=${(book.upAsk*100).toFixed(0)}¢ DOWN=${(book.downAsk*100).toFixed(0)}¢ (need ≤${STRATEGY_CONFIG.opening.maxPrice*100}¢)` 
      };
    }

    let openSide: 'UP' | 'DOWN';
    let openPrice: number;

    if (upValid && downValid) {
      // Both valid - pick cheapest
      if (book.upAsk <= book.downAsk) {
        openSide = 'UP';
        openPrice = book.upAsk;
      } else {
        openSide = 'DOWN';
        openPrice = book.downAsk;
      }
    } else if (upValid) {
      openSide = 'UP';
      openPrice = book.upAsk;
    } else {
      openSide = 'DOWN';
      openPrice = book.downAsk;
    }

    return {
      shouldTrade: true,
      side: openSide,
      price: openPrice,
      shares: STRATEGY_CONFIG.opening.shares,
      tokenId: openSide === 'UP' ? market.upTokenId : market.downTokenId,
      reason: `🚀 OPENING: ${openSide} @ ${(openPrice*100).toFixed(1)}¢`,
      tradeType: 'OPENING',
    };
  }

  // === PHASE 2: HEDGE ===
  if (!isHedged) {
    const needsUp = !hasUp;
    const hedgeSide: 'UP' | 'DOWN' = needsUp ? 'UP' : 'DOWN';
    const hedgePrice = needsUp ? book.upAsk : book.downAsk;
    const existingAvg = needsUp ? position.downAvgPrice : position.upAvgPrice;

    // Check combined price
    const projectedCombined = existingAvg + hedgePrice;

    if (projectedCombined > STRATEGY_CONFIG.hedge.maxCombined) {
      const profitPct = ((1 - projectedCombined) * 100).toFixed(1);
      return { 
        shouldTrade: false, 
        reason: `HEDGE_WAIT: combined=${(projectedCombined*100).toFixed(0)}¢ (need <${STRATEGY_CONFIG.hedge.maxCombined*100}¢ for 3%+ profit, current: ${profitPct}%)` 
      };
    }

    if (hedgePrice > STRATEGY_CONFIG.opening.maxPrice) {
      return { 
        shouldTrade: false, 
        reason: `HEDGE_WAIT: ${hedgeSide}=${(hedgePrice*100).toFixed(0)}¢ too expensive` 
      };
    }

    const existingShares = needsUp ? position.downShares : position.upShares;
    const profitPct = ((1 - projectedCombined) * 100).toFixed(1);

    return {
      shouldTrade: true,
      side: hedgeSide,
      price: hedgePrice,
      shares: existingShares, // Match existing shares
      tokenId: hedgeSide === 'UP' ? market.upTokenId : market.downTokenId,
      reason: `🛡️ HEDGE: ${hedgeSide} @ ${(hedgePrice*100).toFixed(1)}¢ | Combined=${(projectedCombined*100).toFixed(0)}¢ = ${profitPct}% profit`,
      tradeType: 'HEDGE',
    };
  }

  // Already hedged
  return { shouldTrade: false, reason: '✅ HEDGED - locked profit' };
}

// ============================================================
// ORDER EXECUTION
// ============================================================

async function executeOrder(
  market: Market,
  side: 'UP' | 'DOWN',
  tokenId: string,
  price: number,
  shares: number
): Promise<boolean> {
  const startMs = Date.now();
  
  log(`📝 Placing ${side} order: ${shares} shares @ ${(price*100).toFixed(1)}¢`);
  
  try {
    const result = await placeOrder({
      tokenId,
      side: 'BUY',
      price,
      size: shares,
      orderType: 'GTC',
    });

    const latencyMs = Date.now() - startMs;
    
    if (result.status === 'FILLED') {
      const fillPrice = result.avgFillPrice || price;
      recordTrade(market.id, side, shares, fillPrice);
      tradesCount++;
      
      log(`✅ FILLED in ${latencyMs}ms: ${shares} ${side} @ ${(fillPrice*100).toFixed(1)}¢ = $${(shares * fillPrice).toFixed(2)}`);
      return true;
    } else {
      log(`⏳ Order placed in ${latencyMs}ms but status: ${result.status}`);
      return false;
    }
  } catch (err) {
    logError(`Order failed for ${market.slug} ${side}`, err);
    return false;
  }
}

// ============================================================
// EVALUATION LOOP
// ============================================================

async function evaluateMarkets(): Promise<void> {
  for (const [marketId, market] of activeMarkets) {
    try {
      const book = await fetchOrderBook(market);
      if (!book) continue;

      const position = getPosition(marketId);
      const timeRemainingSeconds = (market.eventEndTime.getTime() - Date.now()) / 1000;

      const decision = makeDecision(market, book, position, timeRemainingSeconds);

      // Log status
      const timeStr = `${Math.floor(timeRemainingSeconds / 60)}m${Math.floor(timeRemainingSeconds % 60)}s`;
      const posStr = `${position.upShares}↑/${position.downShares}↓`;
      const combined = book.upAsk + book.downAsk;
      
      if (decision.shouldTrade) {
        log(`${market.asset} t-${timeStr} | UP:${(book.upAsk*100).toFixed(0)}¢ DOWN:${(book.downAsk*100).toFixed(0)}¢ | Σ${(combined*100).toFixed(0)}¢ | Pos:${posStr}`);
        log(`  → ${decision.reason}`);
        
        await executeOrder(
          market,
          decision.side!,
          decision.tokenId!,
          decision.price!,
          decision.shares!
        );
      } else {
        // Only log occasionally to reduce spam
        if (Math.random() < 0.05) { // ~5% of the time
          log(`${market.asset} t-${timeStr} | Σ${(combined*100).toFixed(0)}¢ | Pos:${posStr} | ${decision.reason}`);
        }
      }
    } catch (err) {
      // Non-critical, continue
    }
  }
}

// ============================================================
// HEARTBEAT
// ============================================================

function normalizeUsdAmount(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') {
    const n = Number(value.replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

async function sendPaperHeartbeat(): Promise<void> {
  try {
    const balance = await getBalance();
    const balanceTotal = normalizeUsdAmount((balance as any)?.usdc) ?? normalizeUsdAmount(balance) ?? 0;
    
    let totalPositions = 0;
    let lockedProfit = 0;
    
    for (const pos of positions.values()) {
      if (pos.upShares > 0 && pos.downShares > 0) {
        // Hedged position - calculate locked profit
        const paired = Math.min(pos.upShares, pos.downShares);
        const combinedCost = pos.upAvgPrice + pos.downAvgPrice;
        lockedProfit += paired * (1 - combinedCost);
        totalPositions++;
      } else if (pos.upShares > 0 || pos.downShares > 0) {
        totalPositions++;
      }
    }

    await sendHeartbeat({
      runner_id: RUN_ID,
      runner_type: 'paper-live',
      last_heartbeat: new Date().toISOString(),
      status: 'online',
      markets_count: activeMarkets.size,
      positions_count: totalPositions,
      trades_count: tradesCount,
      balance: balanceTotal,
      version: 'paper-strategy-v1',
    });

    log(`💓 Heartbeat | Markets: ${activeMarkets.size} | Positions: ${totalPositions} | Trades: ${tradesCount} | Locked: $${lockedProfit.toFixed(2)}`);
  } catch (err) {
    logError('Heartbeat failed', err);
  }
}

// ============================================================
// MAIN
// ============================================================

async function main(): Promise<void> {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  💰 PAPER STRATEGY RUNNER - Opening + Hedge (3% Lock)        ║');
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log(`║  Run ID: ${RUN_ID.slice(0, 50).padEnd(53)}║`);
  console.log(`║  Max shares per position: ${STRATEGY_CONFIG.opening.shares}`.padEnd(66) + '║');
  console.log(`║  Opening max price: ${(STRATEGY_CONFIG.opening.maxPrice * 100)}¢`.padEnd(66) + '║');
  console.log(`║  Hedge target: combined < ${(STRATEGY_CONFIG.hedge.maxCombined * 100)}¢`.padEnd(66) + '║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');

  // 1. VPN check
  await enforceVpnOrExit();

  // 2. Test Polymarket connection
  log('Testing Polymarket connection...');
  const connected = await testConnection();
  if (!connected) {
    logError('Polymarket connection failed');
    process.exit(1);
  }
  log('✅ Polymarket connected');

  // 3. Get initial balance
  const balance = await getBalance();
  log(`💰 Balance: $${normalizeUsdAmount(balance) ?? 'unknown'}`);

  // 4. Initial market fetch
  await refreshMarkets();

  // 5. Start loops
  isRunning = true;

  // Market refresh every 30s
  setInterval(refreshMarkets, 30_000);

  // Evaluate markets every 2s
  setInterval(evaluateMarkets, 2_000);

  // Heartbeat every 30s
  setInterval(sendPaperHeartbeat, 30_000);
  await sendPaperHeartbeat();

  log('');
  log('╔══════════════════════════════════════════════════════════════╗');
  log('║  ✅ Paper Strategy Runner is LIVE                             ║');
  log('║  Strategy: Buy cheapest side → Hedge when combined < 97¢      ║');
  log('╚══════════════════════════════════════════════════════════════╝');
  log('');

  // Handle shutdown
  const shutdown = () => {
    log('Shutting down...');
    isRunning = false;
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  logError('Fatal error', err);
  process.exit(1);
});
