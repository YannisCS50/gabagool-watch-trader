import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';
import os from 'os';
import { config } from './config.js';
import { placeOrder, testConnection, getBalance } from './polymarket.js';
import { evaluateOpportunity, TopOfBook, MarketPosition, STRATEGY, Outcome } from './strategy.js';

console.log('🚀 Polymarket Live Trader - Local Runner');
console.log('========================================');

const supabase = createClient(config.supabase.url, config.supabase.serviceRoleKey);
const RUNNER_ID = `local-${os.hostname()}`;
const RUNNER_VERSION = '1.0.0';
let currentBalance = 0;

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
}

const markets = new Map<string, MarketContext>();
const tokenToMarket = new Map<string, { slug: string; side: 'up' | 'down' }>();
let clobSocket: WebSocket | null = null;
let tradeCount = 0;
let isRunning = true;

async function fetchMarkets(): Promise<void> {
  try {
    const response = await fetch(`${config.supabase.url}/functions/v1/get-market-tokens`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.supabase.serviceRoleKey}`,
        'Content-Type': 'application/json',
      },
    });

    const data = await response.json();
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

  const { data } = await supabase
    .from('live_trades')
    .select('market_slug, outcome, shares, total')
    .in('market_slug', slugs);

  // Reset positions
  for (const ctx of markets.values()) {
    ctx.position = { upShares: 0, downShares: 0, upInvested: 0, downInvested: 0 };
  }

  if (data) {
    for (const trade of data) {
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
  }

  console.log(`📋 Loaded ${data?.length || 0} existing trades`);
}

async function executeTrade(
  ctx: MarketContext,
  outcome: Outcome,
  price: number,
  shares: number,
  reasoning: string
): Promise<boolean> {
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

  // Update local position
  if (outcome === 'UP') {
    ctx.position.upShares += shares;
    ctx.position.upInvested += total;
  } else {
    ctx.position.downShares += shares;
    ctx.position.downInvested += total;
  }
  ctx.lastTradeAtMs = Date.now();

  // Record in database
  await supabase.from('live_trades').insert({
    market_slug: ctx.slug,
    asset: ctx.market.asset,
    outcome,
    shares,
    price,
    total,
    order_id: result.orderId,
    status: 'filled',
    reasoning,
    event_start_time: ctx.market.eventStartTime,
    event_end_time: ctx.market.eventEndTime,
    avg_fill_price: result.avgPrice || price,
  });

  tradeCount++;
  console.log(`✅ TRADE #${tradeCount}: ${outcome} ${shares}@${(price * 100).toFixed(0)}¢`);
  console.log(`   Position: UP=${ctx.position.upShares} DOWN=${ctx.position.downShares}`);

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

    const signal = evaluateOpportunity(
      ctx.book,
      ctx.position,
      remainingSeconds,
      ctx.lastTradeAtMs,
      nowMs
    );

    if (signal) {
      const success = await executeTrade(ctx, signal.outcome, signal.price, signal.shares, signal.reasoning);

      // For accumulate, also do the other side
      if (success && signal.type === 'accumulate' && ctx.book.down.ask) {
        await executeTrade(ctx, 'DOWN', ctx.book.down.ask, signal.shares, signal.reasoning.replace('UP', 'DOWN'));
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

async function sendHeartbeat(): Promise<void> {
  try {
    const positions = [...markets.values()].filter(
      c => c.position.upShares > 0 || c.position.downShares > 0
    ).length;

    await supabase
      .from('runner_heartbeats' as any)
      .upsert({
        runner_id: RUNNER_ID,
        runner_type: 'local',
        last_heartbeat: new Date().toISOString(),
        status: 'active',
        markets_count: markets.size,
        positions_count: positions,
        trades_count: tradeCount,
        balance: currentBalance,
        version: RUNNER_VERSION,
      }, { onConflict: 'runner_id' });
  } catch (error) {
    console.error('❌ Heartbeat error:', error);
  }
}

async function main(): Promise<void> {
  // Test Polymarket connection
  const connected = await testConnection();
  if (!connected) {
    console.error('❌ Cannot connect to Polymarket. Check your API credentials.');
    process.exit(1);
  }

  // Get initial balance
  const balanceResult = await getBalance();
  currentBalance = balanceResult.usdc;

  // Initial setup
  await fetchMarkets();
  await fetchExistingTrades();
  connectToClob();

  // Send initial heartbeat
  await sendHeartbeat();

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

  // Heartbeat every 10 seconds
  setInterval(async () => {
    const balanceResult = await getBalance();
    currentBalance = balanceResult.usdc;
    await sendHeartbeat();
  }, 10000);

  // Status logging every minute
  setInterval(async () => {
    const positions = [...markets.values()].filter(
      c => c.position.upShares > 0 || c.position.downShares > 0
    ).length;
    
    console.log(`\n📊 Status: ${markets.size} markets | ${positions} positions | ${tradeCount} trades | $${currentBalance.toFixed(2)} balance`);
  }, 60000);

  console.log('\n✅ Live trader running! Press Ctrl+C to stop.\n');
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n\n👋 Shutting down...');
  isRunning = false;
  
  // Send offline heartbeat
  await supabase
    .from('runner_heartbeats' as any)
    .update({ status: 'offline', last_heartbeat: new Date().toISOString() })
    .eq('runner_id', RUNNER_ID);
  
  if (clobSocket) clobSocket.close();
  process.exit(0);
});

main().catch(console.error);
  process.exit(0);
});

main().catch(console.error);
