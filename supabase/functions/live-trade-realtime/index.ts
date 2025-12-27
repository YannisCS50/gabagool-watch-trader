import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ============================================================================
// LIVE TRADING BOT - Real-time WebSocket Worker (Event-Driven)
// Connects to Polymarket CLOB WebSocket and reacts to price changes
// SIGNALS ONLY - Orders go to order_queue for local-runner to execute
// (Edge functions get blocked by Cloudflare, so we queue orders instead)
// ============================================================================

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

type Outcome = "UP" | "DOWN";

interface TopOfBook {
  up: { bid: number | null; ask: number | null; isFromRealBook: boolean };
  down: { bid: number | null; ask: number | null; isFromRealBook: boolean };
  updatedAtMs: number;
}

interface MarketPosition {
  upShares: number;
  downShares: number;
  upInvested: number;
  downInvested: number;
}

interface MarketContext {
  slug: string;
  remainingSeconds: number;
  book: TopOfBook;
  position: MarketPosition;
  lastTradeAtMs: number;
  lastDecisionKey?: string | null;
  inFlight?: boolean;
}

interface MarketToken {
  slug: string;
  asset: string;
  upTokenId: string;
  downTokenId: string;
  eventStartTime: string;
  eventEndTime: string;
  marketType: string;
}

// Strategy config - CONSERVATIVE for live trading (smaller than paper)
// POLYMARKET RATE LIMITS: Respect exchange rules to avoid bans
const STRATEGY = {
  opening: {
    notional: 5,          // $5 initial trade
    maxPrice: 0.52,        // Only enter if price <= 52¢
  },
  hedge: {
    triggerCombined: 0.98, // Hedge when combined < 98¢
    notional: 5,           // $5 per hedge
    cushionTicks: 3,       // Extra ticks above ask for guaranteed fill
    tickSize: 0.01,        // 1¢ tick size
    forceTimeoutSec: 45,   // Force hedge after 45s if still one-sided
    maxPrice: 0.65,        // Max price for hedge (to prevent overpaying)
  },
  accumulate: {
    triggerCombined: 0.97, // Accumulate when combined < 97¢
    notional: 5,           // $5 per accumulate
  },
  limits: {
    maxSharesPerSide: 100,  // Max 100 shares per side
    maxTotalInvested: 50,   // Max $50 total per market
  },
  entry: {
    minSecondsRemaining: 60,
    minPrice: 0.03,
    maxPrice: 0.92,
    staleBookMs: 2000,
  },
  cooldownMs: 15000,       // 15s cooldown between trades per market (Polymarket-friendly)
  dedupeWindowMs: 10000,   // 10s dedupe window
  globalCooldownMs: 5000,  // 5s global cooldown between ANY orders
};

// Helper functions
function isNum(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

function makeDecisionKey(slug: string, up: number, down: number, combined: number, nowMs: number): string {
  const bucket = Math.floor(nowMs / STRATEGY.dedupeWindowMs);
  const r = (x: number) => (Math.round(x * 100) / 100).toFixed(2);
  return `${slug}|${bucket}|u=${r(up)}|d=${r(down)}|c=${r(combined)}`;
}

function calcShares(notional: number, price: number): number {
  if (price <= 0) return 0;
  return Math.floor(notional / price);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const { headers } = req;
  const upgradeHeader = headers.get("upgrade") || "";

  if (upgradeHeader.toLowerCase() !== "websocket") {
    return new Response("Live Trade Bot WebSocket - Expected WebSocket connection", { 
      status: 200,
      headers: corsHeaders,
    });
  }

  const { socket, response } = Deno.upgradeWebSocket(req);

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, supabaseKey);

  let clobSocket: WebSocket | null = null;
  let markets: Map<string, MarketToken> = new Map();
  let tokenToMarket: Map<string, { slug: string; side: 'up' | 'down' }> = new Map();
  let marketContexts: Map<string, MarketContext> = new Map();
  let isEnabled = false;
  let tradeCount = 0;
  let evaluationCount = 0;
  let statusLogInterval: ReturnType<typeof setInterval> | null = null;
  let lastGlobalOrderAtMs = 0; // Global cooldown tracker

  const log = (msg: string) => {
    console.log(`[LiveBot] ${msg}`);
    try {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'log', message: msg, timestamp: Date.now() }));
      }
    } catch {}
  };

  const sendStatus = () => {
    try {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
          type: 'status',
          isEnabled,
          marketsCount: markets.size,
          positionsCount: [...marketContexts.values()].filter(c => c.position.upShares > 0 || c.position.downShares > 0).length,
          timestamp: Date.now(),
        }));
      }
    } catch {}
  };

  const checkBotEnabled = async (): Promise<boolean> => {
    try {
      const { data } = await supabase
        .from('live_bot_settings')
        .select('is_enabled')
        .eq('id', '00000000-0000-0000-0000-000000000001')
        .single();
      return (data as any)?.is_enabled ?? false;
    } catch {
      return false;
    }
  };

  const fetchMarkets = async (): Promise<boolean> => {
    try {
      const previousTokenCount = tokenToMarket.size;
      const previousTokenIds = new Set(tokenToMarket.keys());
      
      const marketsResponse = await fetch(`${supabaseUrl}/functions/v1/get-market-tokens`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${supabaseKey}`,
          'Content-Type': 'application/json',
        },
      });

      const data = await marketsResponse.json();
      if (data.success && data.markets) {
        const nowMs = Date.now();
        markets.clear();
        tokenToMarket.clear();
        const activeSlugs = new Set<string>();

        for (const market of data.markets) {
          // Only trade BTC 15-min markets for live
          if (market.marketType !== '15min') continue;
          if (market.asset !== 'BTC') continue;

          const startMs = new Date(market.eventStartTime).getTime();
          const endMs = new Date(market.eventEndTime).getTime();

          if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;
          if (nowMs < startMs || nowMs >= endMs) continue;

          activeSlugs.add(market.slug);
          markets.set(market.slug, market);
          tokenToMarket.set(market.upTokenId, { slug: market.slug, side: 'up' });
          tokenToMarket.set(market.downTokenId, { slug: market.slug, side: 'down' });

          if (!marketContexts.has(market.slug)) {
            marketContexts.set(market.slug, {
              slug: market.slug,
              remainingSeconds: 0,
              book: {
                up: { bid: null, ask: null, isFromRealBook: false },
                down: { bid: null, ask: null, isFromRealBook: false },
                updatedAtMs: 0,
              },
              position: { upShares: 0, downShares: 0, upInvested: 0, downInvested: 0 },
              lastTradeAtMs: 0,
              lastDecisionKey: null,
              inFlight: false,
            });
          }
        }

        // Prune old contexts
        for (const slug of Array.from(marketContexts.keys())) {
          if (!activeSlugs.has(slug)) marketContexts.delete(slug);
        }

        // Check if tokens changed - need to reconnect CLOB
        const newTokenIds = new Set(tokenToMarket.keys());
        const tokensChanged = newTokenIds.size !== previousTokenIds.size || 
          [...newTokenIds].some(id => !previousTokenIds.has(id));

        if (tokensChanged) {
          log(`📊 Markets changed: ${previousTokenCount} → ${tokenToMarket.size} tokens (${markets.size} BTC markets)`);
          return true; // Signal to reconnect
        } else {
          log(`📊 Markets unchanged: ${markets.size} BTC markets`);
          return false;
        }
      }
      return false;
    } catch (error) {
      log(`❌ Error fetching markets: ${error}`);
      return false;
    }
  };

  const fetchExistingTrades = async () => {
    try {
      const slugs = Array.from(markets.keys());
      if (slugs.length === 0) return;

      const { data } = await supabase
        .from('live_trades')
        .select('market_slug, outcome, shares, total, created_at')
        .in('market_slug', slugs);

      // Reset positions
      for (const ctx of marketContexts.values()) {
        ctx.position = { upShares: 0, downShares: 0, upInvested: 0, downInvested: 0 };
        ctx.lastTradeAtMs = 0;
      }

      if (data) {
        for (const trade of data) {
          const ctx = marketContexts.get(trade.market_slug);
          if (ctx) {
            if (trade.outcome === 'UP') {
              ctx.position.upShares += trade.shares;
              ctx.position.upInvested += trade.total;
            } else {
              ctx.position.downShares += trade.shares;
              ctx.position.downInvested += trade.total;
            }
            const tradeTime = new Date(trade.created_at).getTime();
            if (tradeTime > (ctx.lastTradeAtMs ?? 0)) {
              ctx.lastTradeAtMs = tradeTime;
            }
          }
        }
      }

      const totalTrades = data?.length ?? 0;
      log(`📋 Loaded ${totalTrades} existing trades`);
    } catch (error) {
      log(`❌ Error fetching trades: ${error}`);
    }
  };

  const connectToClob = () => {
    const tokenIds = Array.from(tokenToMarket.keys());
    if (tokenIds.length === 0) {
      log('⚠️ No tokens to subscribe');
      return;
    }

    log(`🔌 Connecting to CLOB with ${tokenIds.length} tokens...`);
    clobSocket = new WebSocket('wss://ws-subscriptions-clob.polymarket.com/ws/market');

    clobSocket.onopen = () => {
      log('✅ Connected to Polymarket CLOB');
      clobSocket!.send(JSON.stringify({ type: 'market', assets_ids: tokenIds }));
      sendStatus();
    };

    clobSocket.onmessage = async (event) => {
      try {
        const data = JSON.parse(event.data.toString());
        await processMarketEvent(data);
      } catch {}
    };

    clobSocket.onerror = (error) => log(`❌ CLOB error: ${error}`);

    clobSocket.onclose = () => {
      log('🔌 CLOB disconnected, reconnecting...');
      setTimeout(() => {
        if (isEnabled) connectToClob();
      }, 5000);
    };
  };

  let bookEventCount = 0;
  
  const processMarketEvent = async (data: any) => {
    const eventType = data.event_type;
    const nowMs = Date.now();

    // Log first 3 raw events
    if (bookEventCount < 3) {
      log(`📨 RAW: type=${eventType}, keys=${Object.keys(data).join(',')}`);
    }

    if (eventType === 'book') {
      bookEventCount++;
      const assetId = data.asset_id;
      const marketInfo = tokenToMarket.get(assetId);

      // Log first 3 book events
      if (bookEventCount <= 3) {
        log(`📖 BOOK #${bookEventCount}: asset=${assetId?.slice(0,10)}..., matched=${!!marketInfo}, asks=${(data.asks||[]).length}, bids=${(data.bids||[]).length}`);
        if (data.asks?.length > 0) {
          log(`📖 Ask[0]: ${JSON.stringify(data.asks[0])}`);
        }
      }

      if (marketInfo) {
        const ctx = marketContexts.get(marketInfo.slug);
        if (ctx) {
          const asks = (data.asks || []) as [string, string][];
          const bids = (data.bids || []) as [string, string][];

          const topAsk = asks.length > 0 ? parseFloat(asks[0][0]) : null;
          const topBid = bids.length > 0 ? parseFloat(bids[0][0]) : null;

          if (marketInfo.side === 'up') {
            ctx.book.up.ask = topAsk;
            ctx.book.up.bid = topBid;
            if (topAsk !== null && !isNaN(topAsk)) ctx.book.up.isFromRealBook = true;
          } else {
            ctx.book.down.ask = topAsk;
            ctx.book.down.bid = topBid;
            if (topAsk !== null && !isNaN(topAsk)) ctx.book.down.isFromRealBook = true;
          }
          ctx.book.updatedAtMs = nowMs;

          await evaluateTradeOpportunity(marketInfo.slug, nowMs);
        }
      }
    } else if (eventType === 'price_change') {
      // Also handle price_change events as fallback
      const changes = data.changes || data.price_changes || [];
      
      // Log first price_change
      if (bookEventCount < 5) {
        log(`💰 PRICE_CHANGE: ${changes.length} changes`);
      }
      
      for (const change of changes) {
        const assetId = change.asset_id;
        const marketInfo = tokenToMarket.get(assetId);
        if (marketInfo) {
          const ctx = marketContexts.get(marketInfo.slug);
          if (ctx) {
            const price = parseFloat(change.price);
            if (!isNaN(price)) {
              if (marketInfo.side === 'up') {
                if (ctx.book.up.ask === null || isNaN(ctx.book.up.ask as number)) {
                  ctx.book.up.ask = price;
                  ctx.book.up.isFromRealBook = true;
                }
              } else {
                if (ctx.book.down.ask === null || isNaN(ctx.book.down.ask as number)) {
                  ctx.book.down.ask = price;
                  ctx.book.down.isFromRealBook = true;
                }
              }
              ctx.book.updatedAtMs = nowMs;
              await evaluateTradeOpportunity(marketInfo.slug, nowMs);
            }
          }
        }
      }
    }
  };

  const evaluateTradeOpportunity = async (slug: string, nowMs: number) => {
    if (!isEnabled) return;

    const market = markets.get(slug);
    const ctx = marketContexts.get(slug);
    if (!market || !ctx) return;

    // Lock check
    if (ctx.inFlight) return;
    ctx.inFlight = true;

    try {
      const startTime = new Date(market.eventStartTime).getTime();
      const endTime = new Date(market.eventEndTime).getTime();
      if (nowMs < startTime || nowMs >= endTime) {
        log(`⏭️ SKIP: Market not in active window`);
        return;
      }

      ctx.remainingSeconds = Math.floor((endTime - nowMs) / 1000);
      evaluationCount++;

      // GLOBAL cooldown - prevent spamming Polymarket across ALL markets
      if (lastGlobalOrderAtMs && nowMs - lastGlobalOrderAtMs < STRATEGY.globalCooldownMs) {
        return; // Silent skip - global cooldown active
      }

      // Per-market cooldown check (longer to respect rate limits)
      if (ctx.lastTradeAtMs && nowMs - ctx.lastTradeAtMs < STRATEGY.cooldownMs) return;

      // Time check
      if (ctx.remainingSeconds < STRATEGY.entry.minSecondsRemaining) {
        if (evaluationCount % 20 === 0) log(`⏭️ SKIP: Too close to expiry (${ctx.remainingSeconds}s)`);
        return;
      }

      // Book freshness
      if (nowMs - ctx.book.updatedAtMs > STRATEGY.entry.staleBookMs) {
        if (evaluationCount % 20 === 0) log(`⏭️ SKIP: Stale book data`);
        return;
      }

      // Need real book data
      if (!ctx.book.up.isFromRealBook || !ctx.book.down.isFromRealBook) {
        if (evaluationCount % 20 === 0) log(`⏭️ SKIP: No real book data (up=${ctx.book.up.isFromRealBook}, down=${ctx.book.down.isFromRealBook})`);
        return;
      }

      const upAsk = ctx.book.up.ask;
      const downAsk = ctx.book.down.ask;
      if (!isNum(upAsk) || !isNum(downAsk)) {
        if (evaluationCount % 20 === 0) log(`⏭️ SKIP: Missing prices (up=${upAsk}, down=${downAsk})`);
        return;
      }

      const combined = upAsk + downAsk;

      // Sanity checks
      if (combined < 0.90 || combined > 1.10) {
        if (evaluationCount % 20 === 0) log(`⏭️ SKIP: Combined out of range (${(combined*100).toFixed(0)}¢)`);
        return;
      }
      if (upAsk < STRATEGY.entry.minPrice || upAsk > STRATEGY.entry.maxPrice) {
        if (evaluationCount % 20 === 0) log(`⏭️ SKIP: UP price out of range (${(upAsk*100).toFixed(0)}¢)`);
        return;
      }
      if (downAsk < STRATEGY.entry.minPrice || downAsk > STRATEGY.entry.maxPrice) {
        if (evaluationCount % 20 === 0) log(`⏭️ SKIP: DOWN price out of range (${(downAsk*100).toFixed(0)}¢)`);
        return;
      }

      // Position limits
      const totalInvested = ctx.position.upInvested + ctx.position.downInvested;
      if (totalInvested >= STRATEGY.limits.maxTotalInvested) return;

      // Dedupe
      const decisionKey = makeDecisionKey(slug, upAsk, downAsk, combined, nowMs);
      if (ctx.lastDecisionKey === decisionKey) return;
      ctx.lastDecisionKey = decisionKey;

      const pos = ctx.position;

      // Log every 10th evaluation with full info
      if (evaluationCount % 10 === 0) {
        log(`📊 ${slug.slice(-15)}: ${(upAsk*100).toFixed(0)}¢+${(downAsk*100).toFixed(0)}¢=${(combined*100).toFixed(0)}¢ | pos: ${pos.upShares}UP/${pos.downShares}DOWN | eval #${evaluationCount}`);
      }

      // ========== TRADING LOGIC ==========

      // PHASE 1: OPENING - No position yet
      if (pos.upShares === 0 && pos.downShares === 0) {
        const cheaperSide: Outcome = upAsk <= downAsk ? "UP" : "DOWN";
        const cheaperPrice = cheaperSide === "UP" ? upAsk : downAsk;

        log(`🎯 OPENING CHECK: ${cheaperSide} @ ${(cheaperPrice*100).toFixed(0)}¢ (max: ${(STRATEGY.opening.maxPrice*100).toFixed(0)}¢)`);

        if (cheaperPrice <= STRATEGY.opening.maxPrice) {
          const shares = calcShares(STRATEGY.opening.notional, cheaperPrice);
          if (shares >= 1) {
            await executeTrade(market, ctx, cheaperSide, cheaperPrice, shares, 
              `Opening ${cheaperSide} @ ${(cheaperPrice*100).toFixed(0)}¢`);
          }
        } else {
          log(`⏭️ SKIP OPENING: ${(cheaperPrice*100).toFixed(0)}¢ > max ${(STRATEGY.opening.maxPrice*100).toFixed(0)}¢`);
        }
        return;
      }

      // PHASE 2: HEDGE - One side filled, buy other at MARKETABLE price
      if (pos.upShares === 0 || pos.downShares === 0) {
        const missingSide: Outcome = pos.upShares === 0 ? "UP" : "DOWN";
        const missingPrice = missingSide === "UP" ? upAsk : downAsk;
        const existingShares = missingSide === "UP" ? pos.downShares : pos.upShares;
        const existingInvested = missingSide === "UP" ? pos.downInvested : pos.upInvested;
        const existingAvg = existingShares > 0 ? existingInvested / existingShares : 0;
        
        // MARKETABLE LIMIT: Add cushion ticks above ask for guaranteed fill
        const cushion = STRATEGY.hedge.cushionTicks * STRATEGY.hedge.tickSize;
        const marketablePrice = Math.min(
          missingPrice + cushion, 
          STRATEGY.hedge.maxPrice
        );
        const projectedCombined = existingAvg + marketablePrice;

        // Calculate time since opening trade for force-hedge timeout
        const timeSinceOpeningMs = ctx.lastTradeAtMs > 0 ? nowMs - ctx.lastTradeAtMs : 0;
        const timeSinceOpeningSec = timeSinceOpeningMs / 1000;
        const isForceHedge = timeSinceOpeningSec >= STRATEGY.hedge.forceTimeoutSec;

        // Log hedge evaluation details
        log(`🔍 HEDGE EVAL: ${missingSide} ask=${(missingPrice*100).toFixed(0)}¢ → marketable=${(marketablePrice*100).toFixed(0)}¢ | projected=${(projectedCombined*100).toFixed(0)}¢ | timeSinceOpen=${timeSinceOpeningSec.toFixed(0)}s | force=${isForceHedge}`);

        // FORCE HEDGE: If timeout exceeded, hedge regardless of combined price
        if (isForceHedge) {
          log(`⚠️ FORCE HEDGE: ${timeSinceOpeningSec.toFixed(0)}s since opening > ${STRATEGY.hedge.forceTimeoutSec}s timeout`);
          await executeTrade(market, ctx, missingSide, marketablePrice, existingShares,
            `FORCE Hedge ${missingSide} @ ${(marketablePrice*100).toFixed(0)}¢ (timeout ${timeSinceOpeningSec.toFixed(0)}s)`);
          return;
        }

        // NORMAL HEDGE: Check if combined price is good
        if (projectedCombined < STRATEGY.hedge.triggerCombined && missingPrice <= STRATEGY.opening.maxPrice) {
          const edgePct = ((1 - projectedCombined) * 100).toFixed(1);
          await executeTrade(market, ctx, missingSide, marketablePrice, existingShares,
            `Hedge ${missingSide} @ ${(marketablePrice*100).toFixed(0)}¢ (${edgePct}% edge, +${STRATEGY.hedge.cushionTicks} ticks)`);
        }
        return;
      }

      // PHASE 3: ACCUMULATE - Both sides filled, add equal shares if good combined
      if (combined < STRATEGY.accumulate.triggerCombined) {
        const priceSum = upAsk + downAsk;
        const sharesToAdd = Math.floor(STRATEGY.accumulate.notional / priceSum);
        
        if (sharesToAdd >= 1 && 
            pos.upShares + sharesToAdd <= STRATEGY.limits.maxSharesPerSide &&
            pos.downShares + sharesToAdd <= STRATEGY.limits.maxSharesPerSide) {
          const edgePct = ((1 - combined) * 100).toFixed(1);
          
          // Execute both sides
          await executeTrade(market, ctx, "UP", upAsk, sharesToAdd,
            `Accumulate UP @ ${(upAsk*100).toFixed(0)}¢ (${edgePct}% edge)`);
          await executeTrade(market, ctx, "DOWN", downAsk, sharesToAdd,
            `Accumulate DOWN @ ${(downAsk*100).toFixed(0)}¢ (${edgePct}% edge)`);
        }
      }
    } catch (err) {
      log(`❌ Evaluation error: ${err}`);
    } finally {
      ctx.inFlight = false;
    }
  };

  const executeTrade = async (
    market: MarketToken,
    ctx: MarketContext,
    outcome: Outcome,
    price: number,
    shares: number,
    reasoning: string
  ): Promise<boolean> => {
    try {
      const tokenId = outcome === "UP" ? market.upTokenId : market.downTokenId;
      const total = shares * price;

      log(`📋 QUEUING: ${outcome} ${shares} @ ${(price*100).toFixed(0)}¢ on ${market.slug.slice(-20)}`);

      // Check if we already have a pending order for this market+outcome (prevent duplicates)
      const { data: existingOrders } = await supabase
        .from('order_queue')
        .select('id')
        .eq('market_slug', market.slug)
        .eq('outcome', outcome)
        .in('status', ['pending', 'processing'])
        .limit(1);

      if (existingOrders && existingOrders.length > 0) {
        log(`⏭️ SKIP: Already have pending order for ${outcome} on ${market.slug}`);
        return false;
      }

      // Queue order for local-runner to execute (edge functions get blocked by Cloudflare)
      const { error: queueError } = await supabase.from('order_queue').insert({
        market_slug: market.slug,
        asset: market.asset,
        outcome,
        token_id: tokenId,
        shares,
        price,
        reasoning,
        order_type: 'GTC',
        status: 'pending',
        event_start_time: market.eventStartTime,
        event_end_time: market.eventEndTime,
      });

      if (queueError) {
        log(`❌ Queue error: ${queueError.message}`);
        return false;
      }

      // Update local position (optimistic - local-runner will confirm)
      if (outcome === "UP") {
        ctx.position.upShares += shares;
        ctx.position.upInvested += total;
      } else {
        ctx.position.downShares += shares;
        ctx.position.downInvested += total;
      }
      ctx.lastTradeAtMs = Date.now();
      lastGlobalOrderAtMs = Date.now(); // Update global cooldown
      const combined = (ctx.book.up.ask || 0) + (ctx.book.down.ask || 0);
      log(`✅ QUEUED #${tradeCount}: ${outcome} ${shares}@${(price*100).toFixed(0)}¢ | Combined: ${(combined*100).toFixed(0)}¢`);

      // Notify client
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
          type: 'signal',
          market: market.slug,
          outcome,
          shares,
          price,
          status: 'queued',
          timestamp: Date.now(),
        }));
      }

      return true;
    } catch (err) {
      log(`❌ Queue error: ${err}`);
      return false;
    }
  };

  const startBot = async () => {
    log('🚀 Live trading bot starting...');

    isEnabled = await checkBotEnabled();
    log(isEnabled ? '✅ Bot is ENABLED' : '⏸️ Bot is DISABLED');

    if (isEnabled) {
      await fetchMarkets();
      await fetchExistingTrades();
      connectToClob();
    }

    sendStatus();

    // Periodic status check & market refresh
    statusLogInterval = setInterval(async () => {
      const wasEnabled = isEnabled;
      isEnabled = await checkBotEnabled();

      if (isEnabled !== wasEnabled) {
        log(isEnabled ? '✅ Bot ENABLED' : '⏸️ Bot DISABLED');

        if (isEnabled && !clobSocket) {
          const marketsChanged = await fetchMarkets();
          await fetchExistingTrades();
          connectToClob();
        } else if (!isEnabled && clobSocket) {
          clobSocket.close();
          clobSocket = null;
        }
      }

      // Refresh markets every 15 seconds if enabled - reconnect if new markets found
      if (isEnabled) {
        const marketsChanged = await fetchMarkets();
        if (marketsChanged && clobSocket) {
          log('🔄 New markets detected - reconnecting CLOB...');
          clobSocket.close();
          clobSocket = null;
          await fetchExistingTrades();
          connectToClob();
        }
      }

      sendStatus();
    }, 15000); // Check every 15 seconds for new markets
  };

  socket.onopen = () => {
    log('WebSocket client connected');
    startBot();
  };

  socket.onmessage = async (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'ping') {
        socket.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
      } else if (data.type === 'status') {
        sendStatus();
      }
    } catch {}
  };

  socket.onerror = (error) => {
    log(`WebSocket error: ${error}`);
  };

  socket.onclose = () => {
    log('WebSocket client disconnected');
    if (statusLogInterval) clearInterval(statusLogInterval);
    if (clobSocket) clobSocket.close();
  };

  return response;
});
