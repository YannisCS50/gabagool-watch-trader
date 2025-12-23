import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Trading configuration with orderbook awareness
const TRADE_CONFIG = {
  arbitrage: {
    minEdge: 2.0,
    budget: 100,
    maxSlippage: 2.0, // Max 2% slippage allowed
    minLiquidity: 50, // Minimum $50 liquidity required
  },
  dualSide: {
    minEdge: 0.5,
    budget: 80,
    maxSlippage: 1.5,
    minLiquidity: 40,
  },
  directional: {
    minProbability: 0.65,
    budget: 50,
    maxSlippage: 3.0,
    minLiquidity: 30,
  },
  lateEntry: {
    minRemainingSeconds: 30,
    maxRemainingSeconds: 180,
    budget: 40,
    maxSlippage: 5.0,
  },
};

interface OrderbookLevel {
  price: number;
  size: number;
}

interface MarketOrderbook {
  upAsks: OrderbookLevel[];
  upBids: OrderbookLevel[];
  downAsks: OrderbookLevel[];
  downBids: OrderbookLevel[];
  lastUpdate: number;
}

interface MarketToken {
  slug: string;
  asset: 'BTC' | 'ETH';
  upTokenId: string;
  downTokenId: string;
  eventStartTime: string;
  eventEndTime: string;
  openPrice: number | null;
}

interface SlippageResult {
  avgFillPrice: number;
  slippagePercent: number;
  filledShares: number;
  availableLiquidity: number;
}

interface TradeDecision {
  shouldTrade: boolean;
  outcome?: 'UP' | 'DOWN' | 'BOTH';
  upShares?: number;
  downShares?: number;
  tradeType?: string;
  reasoning: string;
  upSlippage?: SlippageResult;
  downSlippage?: SlippageResult;
}

interface PaperTrade {
  market_slug: string;
  asset: string;
  outcome: string;
  price: number;
  shares: number;
  total: number;
  trade_type: string;
  reasoning: string;
  crypto_price: number | null;
  open_price: number | null;
  combined_price: number;
  arbitrage_edge: number;
  event_start_time: string;
  event_end_time: string;
  remaining_seconds: number;
  price_delta: number | null;
  price_delta_percent: number | null;
  best_bid: number | null;
  best_ask: number | null;
  estimated_slippage: number | null;
  available_liquidity: number | null;
  avg_fill_price: number | null;
}

/**
 * Calculate slippage for a given order size through the orderbook
 */
function calculateSlippage(
  orderbook: OrderbookLevel[],
  orderSizeUsd: number
): SlippageResult {
  if (orderbook.length === 0) {
    return { avgFillPrice: 0, slippagePercent: 0, filledShares: 0, availableLiquidity: 0 };
  }

  const bestPrice = orderbook[0].price;
  let remaining = orderSizeUsd;
  let totalCost = 0;
  let totalShares = 0;
  let availableLiquidity = 0;

  // Calculate available liquidity in top 3 levels
  for (let i = 0; i < Math.min(3, orderbook.length); i++) {
    availableLiquidity += orderbook[i].size * orderbook[i].price;
  }

  for (const level of orderbook) {
    const levelValue = level.size * level.price;
    const fill = Math.min(remaining, levelValue);
    const sharesToFill = fill / level.price;
    
    totalCost += fill;
    totalShares += sharesToFill;
    remaining -= fill;
    
    if (remaining <= 0) break;
  }

  const filledAmount = orderSizeUsd - remaining;
  const avgFillPrice = totalShares > 0 ? totalCost / totalShares : bestPrice;
  const slippagePercent = bestPrice > 0 
    ? ((avgFillPrice - bestPrice) / bestPrice) * 100 
    : 0;

  return {
    avgFillPrice,
    slippagePercent: Math.abs(slippagePercent),
    filledShares: totalShares,
    availableLiquidity,
  };
}

/**
 * Make real-time trade decision with orderbook awareness
 */
function makeRealtimeTradeDecision(
  orderbook: MarketOrderbook,
  cryptoPrice: number | null,
  openPrice: number | null,
  remainingSeconds: number
): TradeDecision {
  const upBestAsk = orderbook.upAsks[0]?.price ?? 0.5;
  const downBestAsk = orderbook.downAsks[0]?.price ?? 0.5;
  const combinedPrice = upBestAsk + downBestAsk;
  const arbitrageEdge = (1 - combinedPrice) * 100;

  // Skip if market is too close to expiry or already expired
  if (remainingSeconds < TRADE_CONFIG.lateEntry.minRemainingSeconds) {
    return { shouldTrade: false, reasoning: `Too close to expiry: ${remainingSeconds}s` };
  }

  // Strategy 1: Pure arbitrage with slippage check
  if (arbitrageEdge >= TRADE_CONFIG.arbitrage.minEdge) {
    const upSlippage = calculateSlippage(orderbook.upAsks, TRADE_CONFIG.arbitrage.budget / 2);
    const downSlippage = calculateSlippage(orderbook.downAsks, TRADE_CONFIG.arbitrage.budget / 2);

    // Check slippage limits
    if (upSlippage.slippagePercent > TRADE_CONFIG.arbitrage.maxSlippage) {
      return { 
        shouldTrade: false, 
        reasoning: `UP slippage too high: ${upSlippage.slippagePercent.toFixed(2)}% > ${TRADE_CONFIG.arbitrage.maxSlippage}%` 
      };
    }
    if (downSlippage.slippagePercent > TRADE_CONFIG.arbitrage.maxSlippage) {
      return { 
        shouldTrade: false, 
        reasoning: `DOWN slippage too high: ${downSlippage.slippagePercent.toFixed(2)}% > ${TRADE_CONFIG.arbitrage.maxSlippage}%` 
      };
    }

    // Check liquidity
    if (upSlippage.availableLiquidity < TRADE_CONFIG.arbitrage.minLiquidity ||
        downSlippage.availableLiquidity < TRADE_CONFIG.arbitrage.minLiquidity) {
      return {
        shouldTrade: false,
        reasoning: `Insufficient liquidity: UP=$${upSlippage.availableLiquidity.toFixed(0)}, DOWN=$${downSlippage.availableLiquidity.toFixed(0)}`
      };
    }

    return {
      shouldTrade: true,
      outcome: 'BOTH',
      upShares: upSlippage.filledShares,
      downShares: downSlippage.filledShares,
      tradeType: 'ARBITRAGE_REALTIME',
      reasoning: `Arb edge ${arbitrageEdge.toFixed(1)}% | Slippage: UP=${upSlippage.slippagePercent.toFixed(2)}%, DOWN=${downSlippage.slippagePercent.toFixed(2)}%`,
      upSlippage,
      downSlippage,
    };
  }

  // Strategy 2: Dual-side with favorable combined price
  if (combinedPrice < 0.99 && arbitrageEdge >= TRADE_CONFIG.dualSide.minEdge) {
    const upSlippage = calculateSlippage(orderbook.upAsks, TRADE_CONFIG.dualSide.budget / 2);
    const downSlippage = calculateSlippage(orderbook.downAsks, TRADE_CONFIG.dualSide.budget / 2);

    const totalSlippage = (upSlippage.slippagePercent + downSlippage.slippagePercent) / 2;
    if (totalSlippage > TRADE_CONFIG.dualSide.maxSlippage) {
      return {
        shouldTrade: false,
        reasoning: `Dual-side slippage too high: ${totalSlippage.toFixed(2)}%`
      };
    }

    return {
      shouldTrade: true,
      outcome: 'BOTH',
      upShares: upSlippage.filledShares,
      downShares: downSlippage.filledShares,
      tradeType: 'DUAL_SIDE_REALTIME',
      reasoning: `Dual-side edge ${arbitrageEdge.toFixed(1)}% | Combined: ${(combinedPrice * 100).toFixed(1)}¢`,
      upSlippage,
      downSlippage,
    };
  }

  // Strategy 3: Directional based on crypto price movement
  if (cryptoPrice && openPrice && remainingSeconds > 60) {
    const priceDelta = cryptoPrice - openPrice;
    const priceDeltaPercent = (priceDelta / openPrice) * 100;
    
    // Strong upward movement - bet UP
    if (priceDeltaPercent > 0.1 && upBestAsk < 0.65) {
      const upSlippage = calculateSlippage(orderbook.upAsks, TRADE_CONFIG.directional.budget);
      
      if (upSlippage.slippagePercent <= TRADE_CONFIG.directional.maxSlippage) {
        return {
          shouldTrade: true,
          outcome: 'UP',
          upShares: upSlippage.filledShares,
          tradeType: 'DIRECTIONAL_UP_REALTIME',
          reasoning: `Price +${priceDeltaPercent.toFixed(2)}% | UP @ ${(upBestAsk * 100).toFixed(0)}¢`,
          upSlippage,
        };
      }
    }

    // Strong downward movement - bet DOWN
    if (priceDeltaPercent < -0.1 && downBestAsk < 0.65) {
      const downSlippage = calculateSlippage(orderbook.downAsks, TRADE_CONFIG.directional.budget);
      
      if (downSlippage.slippagePercent <= TRADE_CONFIG.directional.maxSlippage) {
        return {
          shouldTrade: true,
          outcome: 'DOWN',
          downShares: downSlippage.filledShares,
          tradeType: 'DIRECTIONAL_DOWN_REALTIME',
          reasoning: `Price ${priceDeltaPercent.toFixed(2)}% | DOWN @ ${(downBestAsk * 100).toFixed(0)}¢`,
          downSlippage,
        };
      }
    }
  }

  // Strategy 4: Late entry when one side is very cheap
  if (remainingSeconds <= TRADE_CONFIG.lateEntry.maxRemainingSeconds && remainingSeconds >= TRADE_CONFIG.lateEntry.minRemainingSeconds) {
    if (upBestAsk <= 0.25) {
      const upSlippage = calculateSlippage(orderbook.upAsks, TRADE_CONFIG.lateEntry.budget);
      if (upSlippage.slippagePercent <= TRADE_CONFIG.lateEntry.maxSlippage) {
        return {
          shouldTrade: true,
          outcome: 'UP',
          upShares: upSlippage.filledShares,
          tradeType: 'LATE_ENTRY_UP_REALTIME',
          reasoning: `Late entry: UP @ ${(upBestAsk * 100).toFixed(0)}¢ with ${remainingSeconds}s left`,
          upSlippage,
        };
      }
    }
    if (downBestAsk <= 0.25) {
      const downSlippage = calculateSlippage(orderbook.downAsks, TRADE_CONFIG.lateEntry.budget);
      if (downSlippage.slippagePercent <= TRADE_CONFIG.lateEntry.maxSlippage) {
        return {
          shouldTrade: true,
          outcome: 'DOWN',
          downShares: downSlippage.filledShares,
          tradeType: 'LATE_ENTRY_DOWN_REALTIME',
          reasoning: `Late entry: DOWN @ ${(downBestAsk * 100).toFixed(0)}¢ with ${remainingSeconds}s left`,
          downSlippage,
        };
      }
    }
  }

  return { 
    shouldTrade: false, 
    reasoning: `No opportunity: edge=${arbitrageEdge.toFixed(1)}%, UP=${(upBestAsk * 100).toFixed(0)}¢, DOWN=${(downBestAsk * 100).toFixed(0)}¢` 
  };
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const { headers } = req;
  const upgradeHeader = headers.get("upgrade") || "";

  // WebSocket upgrade for persistent connection
  if (upgradeHeader.toLowerCase() === "websocket") {
    return handleWebSocket(req);
  }

  // HTTP endpoint for manual trigger / status check
  return handleHttpRequest(req);
});

async function handleWebSocket(req: Request): Promise<Response> {
  const { socket, response } = Deno.upgradeWebSocket(req);

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, supabaseKey);

  let clobSocket: WebSocket | null = null;
  let markets: Map<string, MarketToken> = new Map();
  let orderbooks: Map<string, MarketOrderbook> = new Map();
  let tokenToMarket: Map<string, { slug: string; side: 'up' | 'down' }> = new Map();
  let cryptoPrices: { btc: number | null; eth: number | null } = { btc: null, eth: null };
  let existingTrades: Set<string> = new Set();
  let isEnabled = false;

  const log = (msg: string) => {
    console.log(`[PaperTradeRT] ${msg}`);
    socket.send(JSON.stringify({ type: 'log', message: msg, timestamp: Date.now() }));
  };

  const fetchMarkets = async () => {
    try {
      const response = await fetch(`${supabaseUrl}/functions/v1/get-market-tokens`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${supabaseKey}`,
          'Content-Type': 'application/json',
        },
      });
      
      const data = await response.json();
      if (data.success && data.markets) {
        markets.clear();
        tokenToMarket.clear();
        
        for (const market of data.markets) {
          if (market.marketType === '15min') {
            markets.set(market.slug, market);
            tokenToMarket.set(market.upTokenId, { slug: market.slug, side: 'up' });
            tokenToMarket.set(market.downTokenId, { slug: market.slug, side: 'down' });
            
            // Initialize orderbook
            orderbooks.set(market.slug, {
              upAsks: [],
              upBids: [],
              downAsks: [],
              downBids: [],
              lastUpdate: 0,
            });
          }
        }
        log(`Loaded ${markets.size} markets with ${tokenToMarket.size} tokens`);
      }
    } catch (error) {
      log(`Error fetching markets: ${error}`);
    }
  };

  const fetchExistingTrades = async () => {
    try {
      const slugs = Array.from(markets.keys());
      const { data } = await supabase
        .from('paper_trades')
        .select('market_slug, outcome')
        .in('market_slug', slugs);
      
      existingTrades.clear();
      if (data) {
        for (const trade of data) {
          existingTrades.add(`${trade.market_slug}-${trade.outcome}`);
        }
      }
      log(`Found ${existingTrades.size} existing trades`);
    } catch (error) {
      log(`Error fetching existing trades: ${error}`);
    }
  };

  const checkBotEnabled = async (): Promise<boolean> => {
    const { data } = await supabase
      .from('paper_bot_settings')
      .select('is_enabled')
      .limit(1)
      .maybeSingle();
    return data?.is_enabled ?? false;
  };

  const connectToClob = () => {
    const tokenIds = Array.from(tokenToMarket.keys());
    if (tokenIds.length === 0) {
      log('No tokens to subscribe to');
      return;
    }

    log(`Connecting to CLOB with ${tokenIds.length} tokens...`);
    
    clobSocket = new WebSocket('wss://ws-subscriptions-clob.polymarket.com/ws/market');
    
    clobSocket.onopen = () => {
      log('Connected to Polymarket CLOB');
      
      // Subscribe to all markets
      const subscribeMsg = {
        type: 'market',
        assets_ids: tokenIds,
      };
      clobSocket!.send(JSON.stringify(subscribeMsg));
      log(`Subscribed to ${tokenIds.length} assets`);
      
      socket.send(JSON.stringify({ type: 'connected', markets: markets.size, tokens: tokenIds.length }));
    };

    clobSocket.onmessage = async (event) => {
      try {
        const data = JSON.parse(event.data.toString());
        await processMarketEvent(data);
      } catch (error) {
        // Ignore parse errors for non-JSON messages
      }
    };

    clobSocket.onerror = (error) => {
      log(`CLOB error: ${error}`);
    };

    clobSocket.onclose = () => {
      log('CLOB connection closed');
      socket.send(JSON.stringify({ type: 'disconnected' }));
      
      // Reconnect after delay
      setTimeout(() => {
        if (isEnabled) {
          connectToClob();
        }
      }, 5000);
    };
  };

  const parseOrderbookLevels = (levels: [string, string][]): OrderbookLevel[] => {
    return levels.map(([price, size]) => ({
      price: parseFloat(price),
      size: parseFloat(size),
    })).filter(l => l.price > 0 && l.size > 0);
  };

  const processMarketEvent = async (data: any) => {
    const eventType = data.event_type;
    
    if (eventType === 'book') {
      // Full orderbook update
      const assetId = data.asset_id;
      const marketInfo = tokenToMarket.get(assetId);
      
      if (marketInfo) {
        const orderbook = orderbooks.get(marketInfo.slug);
        if (orderbook) {
          const asks = parseOrderbookLevels(data.asks || []);
          const bids = parseOrderbookLevels(data.bids || []);
          
          if (marketInfo.side === 'up') {
            orderbook.upAsks = asks;
            orderbook.upBids = bids;
          } else {
            orderbook.downAsks = asks;
            orderbook.downBids = bids;
          }
          orderbook.lastUpdate = Date.now();
          
          // Check for trading opportunity
          await evaluateTradeOpportunity(marketInfo.slug);
        }
      }
    } else if (eventType === 'price_change') {
      // Price update - still triggers evaluation
      const changes = data.changes || [];
      const affectedSlugs = new Set<string>();
      
      for (const change of changes) {
        const assetId = change.asset_id;
        const marketInfo = tokenToMarket.get(assetId);
        if (marketInfo) {
          const orderbook = orderbooks.get(marketInfo.slug);
          if (orderbook) {
            // Update best ask price from price_change
            const price = parseFloat(change.price);
            if (marketInfo.side === 'up' && orderbook.upAsks.length > 0) {
              orderbook.upAsks[0].price = price;
            } else if (marketInfo.side === 'down' && orderbook.downAsks.length > 0) {
              orderbook.downAsks[0].price = price;
            } else {
              // Create synthetic level if none exists
              if (marketInfo.side === 'up') {
                orderbook.upAsks = [{ price, size: 100 }];
              } else {
                orderbook.downAsks = [{ price, size: 100 }];
              }
            }
            orderbook.lastUpdate = Date.now();
            affectedSlugs.add(marketInfo.slug);
          }
        }
      }
      
      // Evaluate all affected markets
      for (const slug of affectedSlugs) {
        await evaluateTradeOpportunity(slug);
      }
    }
  };

  const evaluateTradeOpportunity = async (slug: string) => {
    // Check if bot is still enabled
    if (!isEnabled) return;
    
    const market = markets.get(slug);
    const orderbook = orderbooks.get(slug);
    
    if (!market || !orderbook) return;
    
    // Check if we have orderbook data
    if (orderbook.upAsks.length === 0 && orderbook.downAsks.length === 0) return;
    
    const now = Date.now();
    const endTime = new Date(market.eventEndTime).getTime();
    const remainingSeconds = Math.floor((endTime - now) / 1000);
    
    // Get crypto price
    const cryptoPrice = market.asset === 'BTC' ? cryptoPrices.btc : cryptoPrices.eth;
    
    // Make trade decision
    const decision = makeRealtimeTradeDecision(
      orderbook,
      cryptoPrice,
      market.openPrice,
      remainingSeconds
    );
    
    if (!decision.shouldTrade) {
      return;
    }
    
    // Check for duplicates
    const trades: PaperTrade[] = [];
    const upBestAsk = orderbook.upAsks[0]?.price ?? 0.5;
    const downBestAsk = orderbook.downAsks[0]?.price ?? 0.5;
    const combinedPrice = upBestAsk + downBestAsk;
    const arbitrageEdge = (1 - combinedPrice) * 100;
    
    const priceDelta = cryptoPrice && market.openPrice 
      ? cryptoPrice - market.openPrice 
      : null;
    const priceDeltaPercent = priceDelta && market.openPrice 
      ? (priceDelta / market.openPrice) * 100 
      : null;
    
    // Create UP trade
    if ((decision.outcome === 'UP' || decision.outcome === 'BOTH') && decision.upShares && decision.upShares > 0) {
      const tradeKey = `${slug}-UP`;
      if (!existingTrades.has(tradeKey)) {
        const trade: PaperTrade = {
          market_slug: slug,
          asset: market.asset,
          outcome: 'UP',
          price: decision.upSlippage?.avgFillPrice ?? upBestAsk,
          shares: decision.upShares,
          total: decision.upShares * (decision.upSlippage?.avgFillPrice ?? upBestAsk),
          trade_type: decision.tradeType ?? 'REALTIME',
          reasoning: decision.reasoning,
          crypto_price: cryptoPrice,
          open_price: market.openPrice,
          combined_price: combinedPrice,
          arbitrage_edge: arbitrageEdge,
          event_start_time: market.eventStartTime,
          event_end_time: market.eventEndTime,
          remaining_seconds: remainingSeconds,
          price_delta: priceDelta,
          price_delta_percent: priceDeltaPercent,
          best_bid: orderbook.upBids[0]?.price ?? null,
          best_ask: upBestAsk,
          estimated_slippage: decision.upSlippage?.slippagePercent ?? null,
          available_liquidity: decision.upSlippage?.availableLiquidity ?? null,
          avg_fill_price: decision.upSlippage?.avgFillPrice ?? null,
        };
        trades.push(trade);
        existingTrades.add(tradeKey);
      }
    }
    
    // Create DOWN trade
    if ((decision.outcome === 'DOWN' || decision.outcome === 'BOTH') && decision.downShares && decision.downShares > 0) {
      const tradeKey = `${slug}-DOWN`;
      if (!existingTrades.has(tradeKey)) {
        const trade: PaperTrade = {
          market_slug: slug,
          asset: market.asset,
          outcome: 'DOWN',
          price: decision.downSlippage?.avgFillPrice ?? downBestAsk,
          shares: decision.downShares,
          total: decision.downShares * (decision.downSlippage?.avgFillPrice ?? downBestAsk),
          trade_type: decision.tradeType ?? 'REALTIME',
          reasoning: decision.reasoning,
          crypto_price: cryptoPrice,
          open_price: market.openPrice,
          combined_price: combinedPrice,
          arbitrage_edge: arbitrageEdge,
          event_start_time: market.eventStartTime,
          event_end_time: market.eventEndTime,
          remaining_seconds: remainingSeconds,
          price_delta: priceDelta,
          price_delta_percent: priceDeltaPercent,
          best_bid: orderbook.downBids[0]?.price ?? null,
          best_ask: downBestAsk,
          estimated_slippage: decision.downSlippage?.slippagePercent ?? null,
          available_liquidity: decision.downSlippage?.availableLiquidity ?? null,
          avg_fill_price: decision.downSlippage?.avgFillPrice ?? null,
        };
        trades.push(trade);
        existingTrades.add(tradeKey);
      }
    }
    
    // Insert trades
    if (trades.length > 0) {
      const { error } = await supabase.from('paper_trades').insert(trades);
      
      if (error) {
        log(`Error inserting trades: ${error.message}`);
      } else {
        log(`🚀 TRADED: ${slug} | ${decision.tradeType} | ${trades.map(t => t.outcome).join(', ')}`);
        socket.send(JSON.stringify({ 
          type: 'trade', 
          trades: trades.map(t => ({
            slug: t.market_slug,
            outcome: t.outcome,
            price: t.price,
            shares: t.shares,
            slippage: t.estimated_slippage,
            reasoning: t.reasoning,
          }))
        }));
      }
    }
  };

  // Connect to Chainlink RTDS for crypto prices
  const connectToRtds = () => {
    const rtdsSocket = new WebSocket(`${supabaseUrl.replace('https', 'wss')}/functions/v1/rtds-proxy`);
    
    rtdsSocket.onopen = () => {
      log('Connected to RTDS for crypto prices');
      rtdsSocket.send(JSON.stringify({
        action: 'subscribe',
        subscriptions: [{ topic: 'crypto_prices_chainlink', type: '*', filters: '' }]
      }));
    };
    
    rtdsSocket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data.toString());
        if (data.payload?.symbol === 'btc/usd') {
          cryptoPrices.btc = data.payload.value;
        } else if (data.payload?.symbol === 'eth/usd') {
          cryptoPrices.eth = data.payload.value;
        }
      } catch {
        // Ignore parse errors
      }
    };
    
    rtdsSocket.onerror = () => {
      log('RTDS connection error');
    };
    
    rtdsSocket.onclose = () => {
      log('RTDS disconnected, reconnecting...');
      setTimeout(connectToRtds, 5000);
    };
  };

  socket.onopen = async () => {
    log('Client connected');
    
    // Check if bot is enabled
    isEnabled = await checkBotEnabled();
    if (!isEnabled) {
      log('Bot is disabled');
      socket.send(JSON.stringify({ type: 'disabled' }));
      return;
    }
    
    log('Bot is enabled, starting...');
    socket.send(JSON.stringify({ type: 'enabled' }));
    
    // Fetch markets and existing trades
    await fetchMarkets();
    await fetchExistingTrades();
    
    // Connect to data sources
    connectToClob();
    connectToRtds();
    
    // Refresh markets periodically
    const refreshInterval = setInterval(async () => {
      isEnabled = await checkBotEnabled();
      if (!isEnabled) {
        log('Bot disabled, stopping');
        clobSocket?.close();
        clearInterval(refreshInterval);
        return;
      }
      
      await fetchMarkets();
      await fetchExistingTrades();
    }, 60000);
  };

  socket.onmessage = async (event) => {
    try {
      const msg = JSON.parse(event.data.toString());
      if (msg.type === 'ping') {
        socket.send(JSON.stringify({ type: 'pong' }));
      }
    } catch {
      // Ignore
    }
  };

  socket.onclose = () => {
    log('Client disconnected');
    clobSocket?.close();
  };

  return response;
}

async function handleHttpRequest(req: Request): Promise<Response> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    // Check bot status
    const { data: settings } = await supabase
      .from('paper_bot_settings')
      .select('is_enabled')
      .limit(1)
      .maybeSingle();

    const isEnabled = settings?.is_enabled ?? false;

    // Get recent trades
    const { data: recentTrades } = await supabase
      .from('paper_trades')
      .select('*')
      .like('trade_type', '%REALTIME%')
      .order('created_at', { ascending: false })
      .limit(10);

    return new Response(JSON.stringify({
      success: true,
      isEnabled,
      mode: 'realtime',
      recentTrades: recentTrades || [],
      message: isEnabled 
        ? 'Real-time paper trading bot is active. Connect via WebSocket for live updates.'
        : 'Bot is disabled. Enable in settings to start trading.',
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
    
  } catch (error) {
    console.error('Error:', error);
    return new Response(JSON.stringify({ 
      success: false, 
      error: error instanceof Error ? error.message : 'Unknown error' 
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
}
