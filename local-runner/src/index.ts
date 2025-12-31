import WebSocket from 'ws';
import os from 'os';
import dns from 'node:dns';
import { config } from './config.js';
import { placeOrder, testConnection, getBalance, getOrderbookDepth, invalidateBalanceCache, ensureValidCredentials } from './polymarket.js';
import { evaluateOpportunity, TopOfBook, MarketPosition, Outcome, checkLiquidityForAccumulate, checkBalanceForOpening, calculatePreHedgePrice, checkHardSkewStop, STRATEGY, STRATEGY_VERSION, STRATEGY_NAME } from './strategy.js';
import { enforceVpnOrExit } from './vpn-check.js';
import { fetchMarkets as backendFetchMarkets, fetchTrades, saveTrade, sendHeartbeat, sendOffline, fetchPendingOrders, updateOrder, syncPositionsToBackend, savePriceTicks, PriceTick } from './backend.js';
import { fetchChainlinkPrice } from './chain.js';
import { checkAndClaimWinnings, getClaimableValue } from './redeemer.js';
import { syncPositions, syncPositionsToDatabase, printPositionsReport, filter15mPositions } from './positions-sync.js';
import { recordSnapshot, recordFill, recordSettlement, TradeIntent } from './telemetry.js';
import { SNAPSHOT_INTERVAL_MS } from './logger.js';
// Ensure Node prefers IPv4 to avoid hangs on IPv6-only DNS results under some VPN setups.
try {
  dns.setDefaultResultOrder('ipv4first');
  console.log('🌐 DNS: default result order set to ipv4first');
} catch {
  // ignore
}

console.log('');
console.log('╔════════════════════════════════════════════════════════════════╗');
console.log('║        🚀 POLYMARKET LIVE TRADER - LOCAL RUNNER                ║');
console.log('╠════════════════════════════════════════════════════════════════╣');
console.log(`║  📋 Strategy:  ${STRATEGY_NAME.padEnd(47)}║`);
console.log(`║  📋 Version:   ${STRATEGY_VERSION.padEnd(47)}║`);
console.log('╠════════════════════════════════════════════════════════════════╣');
console.log('║  ⚙️  STRATEGY CONFIG:                                          ║');
console.log(`║     Opening: max ${(STRATEGY.opening.maxPrice * 100).toFixed(0)}¢, ${STRATEGY.opening.shares} shares`.padEnd(66) + '║');
console.log(`║     Hedge: max ${(STRATEGY.hedge.maxPrice * 100).toFixed(0)}¢, force after ${STRATEGY.hedge.forceTimeoutSec}s, ${STRATEGY.hedge.cooldownMs}ms cooldown`.padEnd(66) + '║');
console.log(`║     Edge buffer: ${(STRATEGY.edge.buffer * 100).toFixed(1)}¢, min executable: ${(STRATEGY.edge.minExecutableEdge * 100).toFixed(1)}¢`.padEnd(66) + '║');
console.log(`║     Cooldown: ${STRATEGY.cooldownMs / 1000}s (opening only), hedge cushion: ${STRATEGY.hedge.cushionTicks} ticks`.padEnd(66) + '║');
console.log(`║     Sizing: ${STRATEGY.opening.shares} shares opening, ${STRATEGY.hedge.shares} shares hedge`.padEnd(66) + '║');
console.log(`║     Stop trades: last ${STRATEGY.limits.stopTradesSec}s, unwind: last ${STRATEGY.limits.unwindStartSec}s`.padEnd(66) + '║');
console.log('╠════════════════════════════════════════════════════════════════╣');
console.log(`║     Assets: ${config.trading.assets.join(', ')}`.padEnd(66) + '║');
console.log(`║     Max notional/trade: $${config.trading.maxNotionalPerTrade}`.padEnd(66) + '║');
console.log('╚════════════════════════════════════════════════════════════════╝');
console.log('');

const RUNNER_ID = `local-${os.hostname()}`;
const RUNNER_VERSION = '1.3.0';
let currentBalance = 0;
let lastClaimCheck = 0;
let claimInFlight = false;

interface MarketToken {
  slug: string;
  asset: string;
  upTokenId: string;
  downTokenId: string;
  eventStartTime: string;
  eventEndTime: string;
  marketType: string;
}

interface MarketContext {
  slug: string;
  market: MarketToken;
  book: TopOfBook;
  position: MarketPosition;
  lastTradeAtMs: number;
  inFlight: boolean;
  lastSnapshotTs: number;  // For snapshot logging throttle
  spotPrice: number | null;  // Cached spot price from external source
  strikePrice: number | null;  // Cached strike price from market
}

const markets = new Map<string, MarketContext>();
const tokenToMarket = new Map<string, { slug: string; side: 'up' | 'down' }>();
let clobSocket: WebSocket | null = null;
let tradeCount = 0;
let isRunning = true;

async function fetchMarkets(): Promise<void> {
  try {
    const data = await backendFetchMarkets();
    if (!data.success || !data.markets) {
      console.error('❌ Failed to fetch markets');
      return;
    }

    const nowMs = Date.now();
    const previousTokens = new Set(tokenToMarket.keys());
    tokenToMarket.clear();

    const activeSlugs = new Set<string>();

    for (const market of data.markets) {
      // Filter by configured assets and 15-min markets
      if (market.marketType !== '15min') continue;
      if (!config.trading.assets.includes(market.asset)) continue;

      const startMs = new Date(market.eventStartTime).getTime();
      const endMs = new Date(market.eventEndTime).getTime();

      if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;
      if (nowMs < startMs || nowMs >= endMs) continue;

      activeSlugs.add(market.slug);
      tokenToMarket.set(market.upTokenId, { slug: market.slug, side: 'up' });
      tokenToMarket.set(market.downTokenId, { slug: market.slug, side: 'down' });

      if (!markets.has(market.slug)) {
        markets.set(market.slug, {
          slug: market.slug,
          market,
          book: {
            up: { bid: null, ask: null },
            down: { bid: null, ask: null },
            updatedAtMs: 0,
          },
          position: { upShares: 0, downShares: 0, upInvested: 0, downInvested: 0 },
          lastTradeAtMs: 0,
          inFlight: false,
          lastSnapshotTs: 0,
          spotPrice: null,
          strikePrice: null,
        });
      }
    }

    // Prune expired markets
    for (const slug of markets.keys()) {
      if (!activeSlugs.has(slug)) markets.delete(slug);
    }

    const newTokens = new Set(tokenToMarket.keys());
    const changed = newTokens.size !== previousTokens.size || 
      [...newTokens].some(id => !previousTokens.has(id));

    if (changed) {
      console.log(`📊 Markets updated: ${markets.size} active (${tokenToMarket.size} tokens)`);
      return; // Signal reconnect needed
    }
  } catch (error) {
    console.error('❌ Error fetching markets:', error);
  }
}

async function fetchExistingTrades(): Promise<void> {
  const slugs = Array.from(markets.keys());
  if (slugs.length === 0) return;

  const trades = await fetchTrades(slugs);

  // Reset positions
  for (const ctx of markets.values()) {
    ctx.position = { upShares: 0, downShares: 0, upInvested: 0, downInvested: 0 };
  }

  for (const trade of trades) {
    const ctx = markets.get(trade.market_slug);
    if (ctx) {
      if (trade.outcome === 'UP') {
        ctx.position.upShares += trade.shares;
        ctx.position.upInvested += trade.total;
      } else {
        ctx.position.downShares += trade.shares;
        ctx.position.downInvested += trade.total;
      }
    }
  }

  console.log(`📋 Loaded ${trades.length} existing trades`);
}

async function executeTrade(
  ctx: MarketContext,
  outcome: Outcome,
  price: number,
  shares: number,
  reasoning: string,
  intent: TradeIntent = 'ENTRY'
): Promise<boolean> {
  // v4.2.3: HARD SKEW STOP - block ONLY non-corrective trades.
  // Important: we must allow HEDGE orders to restore balance, otherwise we can get stuck one-sided.
  if (intent !== 'HEDGE') {
    const skewCheck = checkHardSkewStop(ctx.position);
    if (skewCheck.blocked) {
      console.log(`🛑 TRADE BLOCKED: ${skewCheck.reason}`);
      return false;
    }
  }
  const tokenId = outcome === 'UP' ? ctx.market.upTokenId : ctx.market.downTokenId;
  const total = shares * price;

  console.log(`\n📊 EXECUTING: ${outcome} ${shares} @ ${(price * 100).toFixed(0)}¢ on ${ctx.slug}`);

  const result = await placeOrder({
    tokenId,
    side: 'BUY',
    price,
    size: shares,
    orderType: 'GTC',
  });

  if (!result.success) {
    console.error(`❌ Order failed: ${result.error}`);
    return false;
  }

  // Always set a cooldown timestamp once we attempted an order (avoid spamming WAF)
  ctx.lastTradeAtMs = Date.now();

  const status = result.status ?? 'unknown';
  const filledShares =
    status === 'filled'
      ? shares
      : status === 'partial'
        ? (result.filledSize ?? 0)
        : 0;

  // CRITICAL FIX: Log ALL orders, not just filled ones
  // This ensures we track every order the bot places for accurate position tracking
  const logShares = filledShares > 0 ? filledShares : shares;
  const logStatus = filledShares > 0 
    ? (status === 'partial' ? 'partial' : 'filled')
    : 'pending';
  const logTotal = logShares * price;

  // Update local position (use filledShares for actual position, but track pending too)
  if (filledShares > 0) {
    if (outcome === 'UP') {
      ctx.position.upShares += filledShares;
      ctx.position.upInvested += filledShares * price;
    } else {
      ctx.position.downShares += filledShares;
      ctx.position.downInvested += filledShares * price;
    }
    
    // Log fill for telemetry
    const nowMs = Date.now();
    const endTime = new Date(ctx.market.eventEndTime).getTime();
    const remainingSeconds = Math.floor((endTime - nowMs) / 1000);
    
    recordFill({
      marketId: ctx.slug,
      asset: ctx.market.asset as 'BTC' | 'ETH',
      side: outcome,
      orderId: result.orderId || null,
      fillQty: filledShares,
      fillPrice: result.avgPrice || price,
      intent,
      secondsRemaining: remainingSeconds,
      spotPrice: ctx.spotPrice,
      strikePrice: ctx.strikePrice,
    });
  }

  // Always save trade to database (with appropriate status)
  await saveTrade({
    market_slug: ctx.slug,
    asset: ctx.market.asset,
    outcome,
    shares: logShares,
    price,
    total: logTotal,
    order_id: result.orderId,
    status: logStatus,
    reasoning,
    event_start_time: ctx.market.eventStartTime,
    event_end_time: ctx.market.eventEndTime,
    avg_fill_price: result.avgPrice || price,
  });

  tradeCount++;
  
  if (filledShares > 0) {
    console.log(`✅ TRADE #${tradeCount}: ${outcome} ${filledShares}@${(price * 100).toFixed(0)}¢ (${logStatus})`);
    console.log(`   Position: UP=${ctx.position.upShares} DOWN=${ctx.position.downShares}`);
    
    // Invalidate balance cache after trade
    invalidateBalanceCache();
  } else {
    console.log(`📝 ORDER #${tradeCount}: ${outcome} ${shares}@${(price * 100).toFixed(0)}¢ (pending) - ${result.orderId}`);
  }
    
  return true;
}


async function evaluateMarket(slug: string): Promise<void> {
  const ctx = markets.get(slug);
  if (!ctx || ctx.inFlight) return;

  ctx.inFlight = true;

  try {
    const nowMs = Date.now();
    const endTime = new Date(ctx.market.eventEndTime).getTime();
    const remainingSeconds = Math.floor((endTime - nowMs) / 1000);

    // Check if this is a potential opening trade - if so, do balance check first
    const isOpeningCandidate = ctx.position.upShares === 0 && ctx.position.downShares === 0;
    let balanceForCheck: number | undefined = undefined;
    
    if (isOpeningCandidate) {
      // Check balance before evaluating opening opportunity
      const balanceResult = await getBalance();
      balanceForCheck = balanceResult.usdc;
      
      // Pre-check: log if balance is too low for opening + hedge
      const balanceCheck = checkBalanceForOpening(balanceForCheck, STRATEGY.opening.notional);
      if (!balanceCheck.canProceed) {
        console.log(`⚠️ ${ctx.slug}: ${balanceCheck.reason}`);
        ctx.inFlight = false;
        return;
      }
    }

    const signal = evaluateOpportunity(
      ctx.book,
      ctx.position,
      remainingSeconds,
      ctx.lastTradeAtMs,
      nowMs,
      balanceForCheck // Pass balance for opening trade validation
    );

    if (signal) {
      // For accumulate trades, check position is balanced AND both sides have liquidity
      if (signal.type === 'accumulate') {
        // Extra balance check (redundant with strategy, but safety net)
        if (ctx.position.upShares !== ctx.position.downShares) {
          console.log(`⚖️ Skip accumulate: position not balanced (${ctx.position.upShares} UP vs ${ctx.position.downShares} DOWN)`);
          ctx.inFlight = false;
          return;
        }

        const upDepth = await getOrderbookDepth(ctx.market.upTokenId);
        const downDepth = await getOrderbookDepth(ctx.market.downTokenId);
        
        const liquidityOk = checkLiquidityForAccumulate(upDepth, downDepth, signal.shares);
        if (!liquidityOk.canProceed) {
          console.log(`⛔ Skip accumulate: ${liquidityOk.reason}`);
          console.log(`   📊 UP liquidity: ${upDepth.askVolume.toFixed(0)} shares, DOWN: ${downDepth.askVolume.toFixed(0)} shares`);
          ctx.inFlight = false;
          return;
        }

        // Log projected combined cost
        const projectedCombined = (ctx.book.up.ask || 0) + (ctx.book.down.ask || 0);
        console.log(`📊 Accumulate: projected combined cost = ${(projectedCombined * 100).toFixed(0)}¢ (target < 96¢)`);
        
        // Execute both sides atomically
        const upSuccess = await executeTrade(ctx, 'UP', ctx.book.up.ask!, signal.shares, signal.reasoning, 'ACCUMULATE');
        if (upSuccess && ctx.book.down.ask) {
          await executeTrade(ctx, 'DOWN', ctx.book.down.ask, signal.shares, signal.reasoning.replace('UP', 'DOWN'), 'ACCUMULATE');
        } else if (!upSuccess) {
          console.log(`⚠️ Accumulate aborted: UP side failed, skipping DOWN`);
        }
      } else {
        // Single-side trade (opening or hedge)
        const tokenId = signal.outcome === 'UP' ? ctx.market.upTokenId : ctx.market.downTokenId;
        const depth = await getOrderbookDepth(tokenId);
        
        if (!depth.hasLiquidity || depth.askVolume < signal.shares) {
          console.log(`⛔ Skip ${signal.type}: insufficient liquidity for ${signal.outcome}`);
          console.log(`   📊 Need ${signal.shares} shares, only ${depth.askVolume.toFixed(0)} available`);
          ctx.inFlight = false;
          return;
        }
        
        // ========== PRE-FLIGHT HEDGE CHECK (SOFT) ==========
        // For opening trades: LOG if hedge would be expensive, but DON'T block
        // Exposed positions are OK at market open - we hedge later when prices stabilize
        if (signal.type === 'opening') {
          const hedgeSide = signal.outcome === 'UP' ? 'DOWN' : 'UP';
          const hedgeTokenId = hedgeSide === 'UP' ? ctx.market.upTokenId : ctx.market.downTokenId;
          const hedgeDepth = await getOrderbookDepth(hedgeTokenId);
          const hedgeAsk = hedgeDepth.topAsk;
          
          // Just log - don't block opening trades
          const preHedgeCheck = calculatePreHedgePrice(signal.price, signal.outcome, hedgeAsk ?? undefined);
          if (!preHedgeCheck) {
            console.log(`⚠️ Opening with EXPENSIVE hedge warning:`);
            console.log(`   Opening: ${signal.outcome} @ ${(signal.price * 100).toFixed(0)}¢`);
            console.log(`   Hedge ask: ${hedgeAsk ? (hedgeAsk * 100).toFixed(0) + '¢' : 'unknown'}`);
            console.log(`   📊 Will hedge later when prices stabilize (gabagool style)`);
          } else {
            console.log(`✅ Hedge available: ${hedgeSide} @ ${(preHedgeCheck.hedgePrice * 100).toFixed(0)}¢`);
          }
        }
        
        const tradeIntent: TradeIntent = signal.type === 'opening' ? 'ENTRY' : signal.type === 'hedge' ? 'HEDGE' : 'ENTRY';
        const tradeSuccess = await executeTrade(ctx, signal.outcome, signal.price, signal.shares, signal.reasoning, tradeIntent);
        
        // PRE-HEDGE: Try to place hedge, but don't panic if too expensive
        if (tradeSuccess && signal.type === 'opening') {
          const hedgeSide = signal.outcome === 'UP' ? 'DOWN' : 'UP';
          const hedgeTokenId = hedgeSide === 'UP' ? ctx.market.upTokenId : ctx.market.downTokenId;
          const hedgeDepth = await getOrderbookDepth(hedgeTokenId);
          const hedgeAsk = hedgeDepth.topAsk;
          
          const preHedge = calculatePreHedgePrice(signal.price, signal.outcome, hedgeAsk ?? undefined);
          if (preHedge) {
            console.log(`\n🎯 PRE-HEDGE: Placing GTC limit order for ${preHedge.hedgeSide} @ ${(preHedge.hedgePrice * 100).toFixed(0)}¢`);
            console.log(`   Opening: ${signal.outcome} @ ${(signal.price * 100).toFixed(0)}¢`);
            console.log(`   Orderbook ask: ${hedgeAsk ? (hedgeAsk * 100).toFixed(0) + '¢' : 'unknown'}`);
            console.log(`   Target combined: ${((signal.price + preHedge.hedgePrice) * 100).toFixed(0)}¢`);
            
            await executeTrade(ctx, preHedge.hedgeSide, preHedge.hedgePrice, signal.shares, preHedge.reasoning, 'HEDGE');
          } else if (hedgeAsk && hedgeAsk <= 0.55) {
            // FORCE HEDGE: If preHedge logic skipped but ask is still reasonable, force it
            const forceHedgePrice = Math.min(hedgeAsk + 0.01, 0.54); // Max 54¢ forced hedge
            console.log(`⚡ FORCE HEDGE: ${hedgeSide} @ ${(forceHedgePrice * 100).toFixed(0)}¢ (ask: ${(hedgeAsk * 100).toFixed(0)}¢)`);
            await executeTrade(ctx, hedgeSide, forceHedgePrice, signal.shares, `Force hedge - ask ${(hedgeAsk * 100).toFixed(0)}¢ reasonable`, 'HEDGE');
          } else {
            console.log(`📊 Hedge skipped (ask ${hedgeAsk ? (hedgeAsk * 100).toFixed(0) + '¢' : 'unknown'} too expensive) - will hedge later via ONE_SIDED logic`);
          }
        }
      }
    }
  } catch (error) {
    console.error(`❌ Evaluation error for ${slug}:`, error);
  } finally {
    ctx.inFlight = false;
  }
}

function connectToClob(): void {
  const tokenIds = Array.from(tokenToMarket.keys());
  if (tokenIds.length === 0) {
    console.log('⚠️ No tokens to subscribe');
    return;
  }

  console.log(`🔌 Connecting to CLOB with ${tokenIds.length} tokens...`);
  clobSocket = new WebSocket('wss://ws-subscriptions-clob.polymarket.com/ws/market');

  clobSocket.on('open', () => {
    console.log('✅ Connected to Polymarket CLOB WebSocket');
    clobSocket!.send(JSON.stringify({ type: 'market', assets_ids: tokenIds }));
  });

  clobSocket.on('message', async (data: WebSocket.Data) => {
    try {
      const event = JSON.parse(data.toString());
      await processMarketEvent(event);
    } catch {}
  });

  clobSocket.on('error', (error) => {
    console.error('❌ CLOB WebSocket error:', error.message);
  });

  clobSocket.on('close', () => {
    console.log('🔌 CLOB disconnected, reconnecting in 5s...');
    setTimeout(() => {
      if (isRunning) connectToClob();
    }, 5000);
  });
}

async function processMarketEvent(data: any): Promise<void> {
  const eventType = data.event_type;

  if (eventType === 'book') {
    const assetId = data.asset_id;
    const marketInfo = tokenToMarket.get(assetId);

    if (marketInfo) {
      const ctx = markets.get(marketInfo.slug);
      if (ctx) {
        const asks = (data.asks || []) as [string, string][];
        const bids = (data.bids || []) as [string, string][];

        const topAsk = asks.length > 0 ? parseFloat(asks[0][0]) : null;
        const topBid = bids.length > 0 ? parseFloat(bids[0][0]) : null;

        if (marketInfo.side === 'up') {
          ctx.book.up.ask = topAsk;
          ctx.book.up.bid = topBid;
        } else {
          ctx.book.down.ask = topAsk;
          ctx.book.down.bid = topBid;
        }
        ctx.book.updatedAtMs = Date.now();

        await evaluateMarket(marketInfo.slug);
      }
    }
  } else if (eventType === 'price_change') {
    const changes = data.changes || data.price_changes || [];
    for (const change of changes) {
      const assetId = change.asset_id;
      const marketInfo = tokenToMarket.get(assetId);
      if (marketInfo) {
        const ctx = markets.get(marketInfo.slug);
        if (ctx) {
          const price = parseFloat(change.price);
          if (!isNaN(price)) {
            if (marketInfo.side === 'up') {
              if (ctx.book.up.ask === null) ctx.book.up.ask = price;
            } else {
              if (ctx.book.down.ask === null) ctx.book.down.ask = price;
            }
            ctx.book.updatedAtMs = Date.now();
            await evaluateMarket(marketInfo.slug);
          }
        }
      }
    }
  }
}

async function doHeartbeat(): Promise<void> {
  try {
    const positions = [...markets.values()].filter(
      c => c.position.upShares > 0 || c.position.downShares > 0
    ).length;

    await sendHeartbeat({
      runner_id: RUNNER_ID,
      runner_type: 'local',
      last_heartbeat: new Date().toISOString(),
      status: 'active',
      markets_count: markets.size,
      positions_count: positions,
      trades_count: tradeCount,
      balance: currentBalance,
      version: RUNNER_VERSION,
    });
  } catch (error) {
    console.error('❌ Heartbeat error:', error);
  }
}

async function main(): Promise<void> {
  // CRITICAL: Verify VPN is active before ANY trading activity
  await enforceVpnOrExit();

  // Test Polymarket connection
  const connected = await testConnection();
  if (!connected) {
    console.error('❌ Cannot connect to Polymarket. Check your API credentials.');
    process.exit(1);
  }

  // CRITICAL: Validate/derive API credentials BEFORE any trading
  console.log('\n🔐 Ensuring valid API credentials...');
  const credsValid = await ensureValidCredentials();
  if (!credsValid) {
    console.error('❌ Failed to validate API credentials. Check your private key and address.');
    console.error('   The runner will continue but trading may fail.');
  }

  // Get initial balance (will use newly derived creds if auto-derived)
  const balanceResult = await getBalance();
  currentBalance = balanceResult.usdc;
  
  if (balanceResult.error) {
    console.error(`⚠️ Initial balance check had error: ${balanceResult.error}`);
  }

  // Initial setup
  await fetchMarkets();
  await fetchExistingTrades();
  connectToClob();

  // Send initial heartbeat
  await doHeartbeat();

  // Periodic market refresh
  setInterval(async () => {
    const previousCount = tokenToMarket.size;
    await fetchMarkets();
    
    // Reconnect if markets changed
    if (tokenToMarket.size !== previousCount && clobSocket) {
      console.log('🔄 Markets changed, reconnecting CLOB...');
      clobSocket.close();
    }
  }, 15000);

  // Poll order queue every 2 seconds (execute orders from edge function)
  setInterval(async () => {
    const orders = await fetchPendingOrders();
    
    for (const order of orders) {
      console.log(`\n📥 RECEIVED ORDER: ${order.outcome} ${order.shares}@${(order.price * 100).toFixed(0)}¢ on ${order.market_slug}`);
      
      try {
        const result = await placeOrder({
          tokenId: order.token_id,
          side: 'BUY',
          price: order.price,
          size: order.shares,
          orderType: order.order_type as 'GTC' | 'FOK' | 'GTD',
        });

        if (result.success) {
          const status = result.status ?? 'unknown';
          const filledShares =
            status === 'filled'
              ? order.shares
              : status === 'partial'
                ? (result.filledSize ?? 0)
                : 0;

          // CRITICAL FIX: Log ALL orders, not just filled ones
          const logShares = filledShares > 0 ? filledShares : order.shares;
          const logStatus = filledShares > 0 
            ? (status === 'partial' ? 'partial' : 'filled')
            : 'pending';

          // Always save trade to database for tracking
          await saveTrade({
            market_slug: order.market_slug,
            asset: order.asset,
            outcome: order.outcome,
            shares: logShares,
            price: order.price,
            total: logShares * order.price,
            order_id: result.orderId,
            status: logStatus,
            reasoning: order.reasoning || 'Order from edge function',
            event_start_time: order.event_start_time || new Date().toISOString(),
            event_end_time: order.event_end_time || new Date().toISOString(),
            avg_fill_price: result.avgPrice || order.price,
          });

          // Update order queue status
          await updateOrder(order.id, logStatus === 'pending' ? 'placed' : logStatus, {
            order_id: result.orderId,
            avg_fill_price: result.avgPrice,
          });

          tradeCount++;
          
          if (filledShares > 0) {
            console.log(`✅ ORDER EXECUTED: ${order.outcome} ${filledShares}@${(order.price * 100).toFixed(0)}¢ (${logStatus})`);
          } else {
            console.log(`📝 ORDER PLACED: ${order.outcome} ${order.shares}@${(order.price * 100).toFixed(0)}¢ (pending) - ${result.orderId}`);
          }
        } else {
          await updateOrder(order.id, 'failed', { error: result.error });
          console.error(`❌ ORDER FAILED: ${result.error}`);
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        await updateOrder(order.id, 'failed', { error: msg });
        console.error(`❌ ORDER ERROR: ${msg}`);
      }
    }
  }, 2000);

  // Heartbeat every 10 seconds
  setInterval(async () => {
    const balanceResult = await getBalance();
    currentBalance = balanceResult.usdc;
    await doHeartbeat();
  }, 10000);

  // Auto-claim winnings every 30 seconds
  setInterval(async () => {
    const nowMs = Date.now();

    // Only check every 30 seconds
    if (nowMs - lastClaimCheck < 30000) return;

    // Prevent overlapping claim loops (can cause duplicate tx attempts)
    if (claimInFlight) {
      console.log('⏳ Auto-claim already running, skipping this tick');
      return;
    }

    claimInFlight = true;
    lastClaimCheck = nowMs;

    try {
      const result = await checkAndClaimWinnings();
      if (result.claimed > 0) {
        console.log(`💰 Auto-claimed ${result.claimed} winning positions!`);
      }
    } catch (error) {
      console.error('❌ Auto-claim error:', error);
    } finally {
      claimInFlight = false;
    }
  }, 30000);

  // Sync positions from Polymarket API every 10 seconds
  // This reconciles pending orders with actual fills in near real-time
  let lastSyncAt = 0;
  let syncInFlight = false;
  setInterval(async () => {
    const nowMs = Date.now();
    if (nowMs - lastSyncAt < 10000) return;
    if (syncInFlight) return; // Prevent overlapping syncs
    
    syncInFlight = true;
    lastSyncAt = nowMs;

    try {
      // Sync positions from Polymarket AND write to database
      const syncResult = await syncPositionsToDatabase(config.polymarket.address);
      
      // Only print report if we have positions (reduce noise)
      if (syncResult.positions.length > 0 && syncResult.summary.totalPositions > 0) {
        console.log(`🔄 Sync: ${syncResult.summary.totalPositions} positions, $${syncResult.summary.totalValue.toFixed(2)} value, $${syncResult.summary.unrealizedPnl.toFixed(2)} P/L`);
        if (syncResult.dbResult) {
          console.log(`   💾 DB: ${syncResult.dbResult.upserted} upserted, ${syncResult.dbResult.deleted} deleted`);
        }
      }

      // Sync to backend (reconcile pending orders)
      const positions15m = filter15mPositions(syncResult.positions);
      const positionsData = positions15m.map(p => ({
        conditionId: p.conditionId,
        market: p.market,
        outcome: p.outcome,
        size: p.size,
        avgPrice: p.avgPrice,
        currentValue: p.currentValue,
        initialValue: p.initialValue,
        eventSlug: p.eventSlug,
      }));

      const backendResult = await syncPositionsToBackend(config.polymarket.address, positionsData);
      if (backendResult.success && (backendResult.updated || backendResult.cancelled)) {
        console.log(`✅ Reconciled: ${backendResult.updated || 0} fills, ${backendResult.cancelled || 0} cancelled`);
      }
    } catch (error) {
      console.error('❌ Position sync error:', error);
    } finally {
      syncInFlight = false;
    }
  }, 10000);

  // ===================================================================
  // PRICE TICK LOGGING: Save BTC/ETH Chainlink prices every 1 second
  // ===================================================================
  let lastBtcPrice: number | null = null;
  let lastEthPrice: number | null = null;
  let tickLogInFlight = false;

  setInterval(async () => {
    if (tickLogInFlight) return;
    tickLogInFlight = true;

    try {
      const [btcResult, ethResult] = await Promise.all([
        fetchChainlinkPrice('BTC'),
        fetchChainlinkPrice('ETH'),
      ]);

      const ticks: PriceTick[] = [];

      if (btcResult) {
        const prev = lastBtcPrice ?? btcResult.price;
        const delta = btcResult.price - prev;
        const deltaPct = prev > 0 ? (delta / prev) * 100 : 0;
        ticks.push({
          asset: 'BTC',
          price: btcResult.price,
          delta,
          delta_percent: deltaPct,
          source: 'runner_chainlink',
        });
        lastBtcPrice = btcResult.price;
      }

      if (ethResult) {
        const prev = lastEthPrice ?? ethResult.price;
        const delta = ethResult.price - prev;
        const deltaPct = prev > 0 ? (delta / prev) * 100 : 0;
        ticks.push({
          asset: 'ETH',
          price: ethResult.price,
          delta,
          delta_percent: deltaPct,
          source: 'runner_chainlink',
        });
        lastEthPrice = ethResult.price;
      }

      if (ticks.length > 0) {
        await savePriceTicks(ticks);
      }
    } catch (e) {
      // silent – non-critical
    } finally {
      tickLogInFlight = false;
    }
  }, 1000);

  // Status logging every minute
  setInterval(async () => {
    const positions = [...markets.values()].filter(
      c => c.position.upShares > 0 || c.position.downShares > 0
    ).length;
    
    // Also show claimable value
    const claimableValue = await getClaimableValue();
    const claimableStr = claimableValue > 0 ? ` | $${claimableValue.toFixed(2)} claimable` : '';
    
    console.log(`\n📊 Status: ${markets.size} markets | ${positions} positions | ${tradeCount} trades | $${currentBalance.toFixed(2)} balance${claimableStr}`);
  }, 60000);

  console.log('\n✅ Live trader running with auto-claim! Press Ctrl+C to stop.\n');
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n\n👋 Shutting down...');
  isRunning = false;
  
  // Send offline heartbeat via backend
  await sendOffline(RUNNER_ID);
  
  if (clobSocket) clobSocket.close();
  process.exit(0);
});

main().catch(console.error);
