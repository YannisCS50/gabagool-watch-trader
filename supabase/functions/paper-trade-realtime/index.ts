import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// GABAGOOL STRATEGY - Based on deep-dive analysis of real trading patterns
// Key insights:
// 1. Arbitrage requires combined < 98¢ (2%+ edge) - from hedge pair analysis
// 2. Sweet spot is 35-45¢ price range - from DCA bucket analysis
// 3. Late entry 0-5 min before expiry at cheap prices - from expiry analysis
// 4. More neutral/DCA trades than pure arb - 60%+ are neutral hedges

const TRADE_CONFIG = {
  // Strategy 1: Pure Arbitrage - combined < 98¢ = guaranteed profit
  arbitrage: {
    enabled: true,
    minEdge: 2.0,             // 2%+ edge = combined < 98¢ (from deep-dive: "arbitrage" category)
    maxCombinedPrice: 0.98,   // Must be < 98¢ for true arbitrage
    budget: 100,              // Full budget for arb opportunities
    maxSlippage: 1.5,         // Tight slippage for guaranteed fills
    minLiquidity: 80,         // Need good liquidity
  },
  
  // Strategy 2: DCA Hedge - accumulate in sweet spot price range
  dcaHedge: {
    enabled: true,
    baseBudget: 60,           // Conservative budget per side
    maxCombinedPrice: 1.00,   // Allow breakeven trades (DCA now, arb later)
    minCombinedPrice: 0.95,   // Don't overpay
    sweetSpotMin: 0.35,       // From deep-dive: 35-45¢ is the sweet spot
    sweetSpotMax: 0.45,       // Gabagool buys most in this range
    outsideSpotMin: 0.20,     // Also buys outside but less
    outsideSpotMax: 0.55,     // Upper bound for entries
    biasMultiplier: 1.2,      // 20% more shares on favored side (crypto direction)
    minPriceMove: 0.03,       // 0.03% crypto move to trigger bias
    maxSlippage: 2.0,
    minLiquidity: 40,
    minRemainingSeconds: 120, // Need some time to let prices develop
  },
  
  // Strategy 3: Late Entry Sniper - cheap shots near expiry
  // From deep-dive: 50%+ trades happen in last 5 minutes
  lateEntry: {
    enabled: true,
    maxRemainingSeconds: 300, // 5 min window (from expiry analysis)
    minRemainingSeconds: 30,  // Not too close to prevent fills
    sweetSpotPrice: 0.15,     // Sweet spot for late entries
    maxPrice: 0.25,           // Don't pay more than 25¢
    minPrice: 0.05,           // Need realistic fills
    budget: 50,
    maxSlippage: 3.0,         // Allow more slippage near expiry
    minLiquidity: 30,
  },
  
  // Global settings
  global: {
    minAskPrice: 0.05,        // Absolute minimum (avoid penny stocks)
    maxAskPrice: 0.95,        // Absolute maximum (avoid expensive fills)
  }
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
 * Gabagool-style trading based on deep-dive analysis
 * Priority: 1) Arbitrage (<98¢), 2) DCA in sweet spot, 3) Late entry sniper
 */
function makeGabagoolTradeDecision(
  orderbook: MarketOrderbook,
  cryptoPrice: number | null,
  openPrice: number | null,
  remainingSeconds: number
): TradeDecision {
  const upBestAsk = orderbook.upAsks[0]?.price ?? 0.5;
  const downBestAsk = orderbook.downAsks[0]?.price ?? 0.5;
  const combinedPrice = upBestAsk + downBestAsk;
  const arbitrageEdge = (1 - combinedPrice) * 100;

  // Calculate price delta for bias
  const priceDelta = cryptoPrice && openPrice ? cryptoPrice - openPrice : null;
  const priceDeltaPercent = priceDelta && openPrice ? (priceDelta / openPrice) * 100 : null;

  // Global price filters
  const globalCfg = TRADE_CONFIG.global;
  if (upBestAsk < globalCfg.minAskPrice || downBestAsk < globalCfg.minAskPrice) {
    return { shouldTrade: false, reasoning: `Price too low: UP=${(upBestAsk*100).toFixed(0)}¢ DOWN=${(downBestAsk*100).toFixed(0)}¢` };
  }
  if (upBestAsk > globalCfg.maxAskPrice || downBestAsk > globalCfg.maxAskPrice) {
    return { shouldTrade: false, reasoning: `Price too high: UP=${(upBestAsk*100).toFixed(0)}¢ DOWN=${(downBestAsk*100).toFixed(0)}¢` };
  }

  // ============================================
  // STRATEGY 1: Pure Arbitrage (highest priority)
  // Combined price < 98¢ = guaranteed 2%+ profit
  // ============================================
  const arbCfg = TRADE_CONFIG.arbitrage;
  if (arbCfg.enabled && combinedPrice <= arbCfg.maxCombinedPrice) {
    const halfBudget = arbCfg.budget / 2;
    const upSlippage = calculateSlippage(orderbook.upAsks, halfBudget);
    const downSlippage = calculateSlippage(orderbook.downAsks, halfBudget);

    if (upSlippage.slippagePercent <= arbCfg.maxSlippage &&
        downSlippage.slippagePercent <= arbCfg.maxSlippage &&
        upSlippage.availableLiquidity >= arbCfg.minLiquidity &&
        downSlippage.availableLiquidity >= arbCfg.minLiquidity) {
      
      const totalCost = (upSlippage.filledShares * upSlippage.avgFillPrice) + 
                        (downSlippage.filledShares * downSlippage.avgFillPrice);
      const minPayout = Math.min(upSlippage.filledShares, downSlippage.filledShares);
      const guaranteedProfit = minPayout - totalCost;
      
      return {
        shouldTrade: true,
        outcome: 'BOTH',
        upShares: upSlippage.filledShares,
        downShares: downSlippage.filledShares,
        tradeType: 'ARBITRAGE',
        reasoning: `🎯 ARB ${arbitrageEdge.toFixed(1)}% | ${(upBestAsk*100).toFixed(0)}¢+${(downBestAsk*100).toFixed(0)}¢=${(combinedPrice*100).toFixed(0)}¢ | +$${guaranteedProfit.toFixed(2)}`,
        upSlippage,
        downSlippage,
      };
    }
  }

  // ============================================
  // STRATEGY 2: Late Entry Sniper (before DCA)
  // Last 5 minutes, cheap single-side bets
  // ============================================
  const lateCfg = TRADE_CONFIG.lateEntry;
  if (lateCfg.enabled && 
      remainingSeconds <= lateCfg.maxRemainingSeconds && 
      remainingSeconds >= lateCfg.minRemainingSeconds) {
    
    // Prefer the cheaper side
    const cheaperSide = upBestAsk <= downBestAsk ? 'UP' : 'DOWN';
    const cheaperPrice = Math.min(upBestAsk, downBestAsk);
    
    if (cheaperPrice <= lateCfg.maxPrice && cheaperPrice >= lateCfg.minPrice) {
      const orderbook_side = cheaperSide === 'UP' ? orderbook.upAsks : orderbook.downAsks;
      const slippage = calculateSlippage(orderbook_side, lateCfg.budget);
      
      if (slippage.slippagePercent <= lateCfg.maxSlippage && 
          slippage.availableLiquidity >= lateCfg.minLiquidity) {
        
        // Check if crypto price direction supports the bet
        let directionBonus = '';
        if (priceDeltaPercent !== null) {
          if (cheaperSide === 'UP' && priceDeltaPercent > 0) directionBonus = '📈';
          if (cheaperSide === 'DOWN' && priceDeltaPercent < 0) directionBonus = '📉';
        }
        
        return {
          shouldTrade: true,
          outcome: cheaperSide,
          upShares: cheaperSide === 'UP' ? slippage.filledShares : undefined,
          downShares: cheaperSide === 'DOWN' ? slippage.filledShares : undefined,
          tradeType: `LATE_${cheaperSide}`,
          reasoning: `⏰ Late ${cheaperSide} @ ${(cheaperPrice*100).toFixed(0)}¢ | ${remainingSeconds}s left ${directionBonus}`,
          upSlippage: cheaperSide === 'UP' ? slippage : undefined,
          downSlippage: cheaperSide === 'DOWN' ? slippage : undefined,
        };
      }
    }
  }

  // ============================================
  // STRATEGY 3: DCA Hedge in Sweet Spot
  // Accumulate positions in 35-45¢ range
  // ============================================
  const dcaCfg = TRADE_CONFIG.dcaHedge;
  if (dcaCfg.enabled && remainingSeconds >= dcaCfg.minRemainingSeconds) {
    // Check if combined price is acceptable
    if (combinedPrice > dcaCfg.maxCombinedPrice || combinedPrice < dcaCfg.minCombinedPrice) {
      return { shouldTrade: false, reasoning: `Combined ${(combinedPrice*100).toFixed(0)}¢ outside DCA range` };
    }
    
    // Check if at least one side is in sweet spot range
    const upInSweetSpot = upBestAsk >= dcaCfg.sweetSpotMin && upBestAsk <= dcaCfg.sweetSpotMax;
    const downInSweetSpot = downBestAsk >= dcaCfg.sweetSpotMin && downBestAsk <= dcaCfg.sweetSpotMax;
    const upInRange = upBestAsk >= dcaCfg.outsideSpotMin && upBestAsk <= dcaCfg.outsideSpotMax;
    const downInRange = downBestAsk >= dcaCfg.outsideSpotMin && downBestAsk <= dcaCfg.outsideSpotMax;
    
    // Prefer when at least one side is in sweet spot
    if (!upInSweetSpot && !downInSweetSpot && !upInRange && !downInRange) {
      return { shouldTrade: false, reasoning: `Prices outside DCA range: UP=${(upBestAsk*100).toFixed(0)}¢ DOWN=${(downBestAsk*100).toFixed(0)}¢` };
    }
    
    // Determine bias direction based on crypto price movement
    let upBudgetMultiplier = 1.0;
    let downBudgetMultiplier = 1.0;
    let biasDirection = 'NEUTRAL';
    
    if (priceDeltaPercent !== null) {
      if (priceDeltaPercent > dcaCfg.minPriceMove) {
        upBudgetMultiplier = dcaCfg.biasMultiplier;
        biasDirection = 'UP';
      } else if (priceDeltaPercent < -dcaCfg.minPriceMove) {
        downBudgetMultiplier = dcaCfg.biasMultiplier;
        biasDirection = 'DOWN';
      }
    }
    
    // Bonus multiplier for sweet spot prices
    if (upInSweetSpot) upBudgetMultiplier *= 1.1;
    if (downInSweetSpot) downBudgetMultiplier *= 1.1;
    
    // Calculate budget split
    const totalMultiplier = upBudgetMultiplier + downBudgetMultiplier;
    const upBudget = (dcaCfg.baseBudget * upBudgetMultiplier) / totalMultiplier;
    const downBudget = (dcaCfg.baseBudget * downBudgetMultiplier) / totalMultiplier;
    
    const upSlippage = calculateSlippage(orderbook.upAsks, upBudget);
    const downSlippage = calculateSlippage(orderbook.downAsks, downBudget);
    
    // Check slippage and liquidity
    const avgSlippage = (upSlippage.slippagePercent + downSlippage.slippagePercent) / 2;
    if (avgSlippage > dcaCfg.maxSlippage) {
      return { shouldTrade: false, reasoning: `Slippage too high: ${avgSlippage.toFixed(1)}%` };
    }
    
    if (upSlippage.availableLiquidity < dcaCfg.minLiquidity || 
        downSlippage.availableLiquidity < dcaCfg.minLiquidity) {
      return { shouldTrade: false, reasoning: `Low liquidity` };
    }
    
    // Calculate expected outcome
    const totalCost = (upSlippage.filledShares * upSlippage.avgFillPrice) + 
                      (downSlippage.filledShares * downSlippage.avgFillPrice);
    const profitIfUp = upSlippage.filledShares - totalCost;
    const profitIfDown = downSlippage.filledShares - totalCost;
    const minProfit = Math.min(profitIfUp, profitIfDown);
    
    const spotLabel = (upInSweetSpot || downInSweetSpot) ? '⭐' : '';
    
    return {
      shouldTrade: true,
      outcome: 'BOTH',
      upShares: upSlippage.filledShares,
      downShares: downSlippage.filledShares,
      tradeType: `DCA_${biasDirection}`,
      reasoning: `${spotLabel} DCA(${biasDirection}) | ${(upBestAsk*100).toFixed(0)}¢+${(downBestAsk*100).toFixed(0)}¢ | Δ=${priceDeltaPercent?.toFixed(2) ?? '0'}% | P/L: $${minProfit.toFixed(2)}`,
      upSlippage,
      downSlippage,
    };
  }

  return { 
    shouldTrade: false, 
    reasoning: `No opportunity: ${(combinedPrice*100).toFixed(0)}¢ combined | ${remainingSeconds}s left | Δ=${priceDeltaPercent?.toFixed(2) ?? 'N/A'}%` 
  };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const { headers } = req;
  const upgradeHeader = headers.get("upgrade") || "";

  if (upgradeHeader.toLowerCase() === "websocket") {
    return handleWebSocket(req);
  }

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
  let processingTrades: Set<string> = new Set(); // NEW: Lock to prevent race conditions
  let isEnabled = false;
  let statusLogInterval: ReturnType<typeof setInterval> | null = null;
  let evaluationCount = 0;
  let tradeCount = 0;

  const log = (msg: string) => {
    console.log(`[PaperBot] ${msg}`);
    try {
      socket.send(JSON.stringify({ type: 'log', message: msg, timestamp: Date.now() }));
    } catch {}
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
            
            orderbooks.set(market.slug, {
              upAsks: [],
              upBids: [],
              downAsks: [],
              downBids: [],
              lastUpdate: 0,
            });
          }
        }
        log(`📊 Loaded ${markets.size} markets`);
      }
    } catch (error) {
      log(`❌ Error fetching markets: ${error}`);
    }
  };

  const fetchExistingTrades = async () => {
    try {
      const slugs = Array.from(markets.keys());
      if (slugs.length === 0) return;
      
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
      log(`📋 Found ${existingTrades.size} existing trades`);
    } catch (error) {
      log(`❌ Error fetching trades: ${error}`);
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
      log('⚠️ No tokens to subscribe');
      return;
    }

    log(`🔌 Connecting to CLOB...`);
    clobSocket = new WebSocket('wss://ws-subscriptions-clob.polymarket.com/ws/market');
    
    clobSocket.onopen = () => {
      log('✅ Connected to Polymarket CLOB');
      clobSocket!.send(JSON.stringify({ type: 'market', assets_ids: tokenIds }));
      socket.send(JSON.stringify({ type: 'connected', markets: markets.size, tokens: tokenIds.length }));
    };

    clobSocket.onmessage = async (event) => {
      try {
        const data = JSON.parse(event.data.toString());
        await processMarketEvent(data);
      } catch {}
    };

    clobSocket.onerror = (error) => log(`❌ CLOB error: ${error}`);

    clobSocket.onclose = () => {
      log('🔌 CLOB disconnected');
      socket.send(JSON.stringify({ type: 'disconnected' }));
      setTimeout(() => { if (isEnabled) connectToClob(); }, 5000);
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
          await evaluateTradeOpportunity(marketInfo.slug);
        }
      }
    } else if (eventType === 'price_change') {
      const changes = data.changes || data.price_changes || [];
      const affectedSlugs = new Set<string>();
      
      for (const change of changes) {
        const assetId = change.asset_id;
        const marketInfo = tokenToMarket.get(assetId);
        if (marketInfo) {
          const orderbook = orderbooks.get(marketInfo.slug);
          if (orderbook) {
            const price = parseFloat(change.price);
            if (marketInfo.side === 'up') {
              if (orderbook.upAsks.length > 0) orderbook.upAsks[0].price = price;
              else orderbook.upAsks = [{ price, size: 100 }];
            } else {
              if (orderbook.downAsks.length > 0) orderbook.downAsks[0].price = price;
              else orderbook.downAsks = [{ price, size: 100 }];
            }
            orderbook.lastUpdate = Date.now();
            affectedSlugs.add(marketInfo.slug);
          }
        }
      }
      
      for (const slug of affectedSlugs) {
        await evaluateTradeOpportunity(slug);
      }
    }
  };

  const evaluateTradeOpportunity = async (slug: string) => {
    if (!isEnabled) return;
    
    // RACE CONDITION FIX: Check if we're already processing this market
    if (processingTrades.has(slug)) {
      return; // Already evaluating, skip
    }
    
    const market = markets.get(slug);
    const orderbook = orderbooks.get(slug);
    
    if (!market || !orderbook) return;
    if (orderbook.upAsks.length === 0 && orderbook.downAsks.length === 0) return;
    
    // RACE CONDITION FIX: Check existing trades BEFORE making decision
    const upKey = `${slug}-UP`;
    const downKey = `${slug}-DOWN`;
    const hasUpTrade = existingTrades.has(upKey);
    const hasDownTrade = existingTrades.has(downKey);
    
    // If we already have both trades for this market, skip
    if (hasUpTrade && hasDownTrade) {
      return;
    }
    
    evaluationCount++;
    
    const now = Date.now();
    const endTime = new Date(market.eventEndTime).getTime();
    const remainingSeconds = Math.floor((endTime - now) / 1000);
    
    const cryptoPrice = market.asset === 'BTC' ? cryptoPrices.btc : cryptoPrices.eth;
    
    // Use gabagool-style decision making
    const decision = makeGabagoolTradeDecision(
      orderbook,
      cryptoPrice,
      market.openPrice,
      remainingSeconds
    );
    
    // Log every 50th evaluation or when trading
    if (evaluationCount % 50 === 0 || decision.shouldTrade) {
      const upBestAsk = orderbook.upAsks[0]?.price ?? 0.5;
      const downBestAsk = orderbook.downAsks[0]?.price ?? 0.5;
      log(`📊 ${slug.slice(-20)}: ${(upBestAsk*100).toFixed(0)}¢+${(downBestAsk*100).toFixed(0)}¢=${((upBestAsk+downBestAsk)*100).toFixed(0)}¢ | ${decision.shouldTrade ? '🚀' : '⏸️'} ${decision.reasoning.slice(0, 60)}`);
    }
    
    if (!decision.shouldTrade) return;
    
    // RACE CONDITION FIX: Lock this market before creating trades
    processingTrades.add(slug);
    
    try {
      // Create trades
      const trades: PaperTrade[] = [];
      const upBestAsk = orderbook.upAsks[0]?.price ?? 0.5;
      const downBestAsk = orderbook.downAsks[0]?.price ?? 0.5;
      const combinedPrice = upBestAsk + downBestAsk;
      const arbitrageEdge = (1 - combinedPrice) * 100;
      
      const priceDelta = cryptoPrice && market.openPrice ? cryptoPrice - market.openPrice : null;
      const priceDeltaPercent = priceDelta && market.openPrice ? (priceDelta / market.openPrice) * 100 : null;
      
      // UP trade - check existing again to be safe
      if ((decision.outcome === 'UP' || decision.outcome === 'BOTH') && decision.upShares && decision.upShares > 0) {
        if (!existingTrades.has(upKey)) {
          existingTrades.add(upKey); // Mark as existing BEFORE insert
          trades.push({
            market_slug: slug,
            asset: market.asset,
            outcome: 'UP',
            price: decision.upSlippage?.avgFillPrice ?? upBestAsk,
            shares: decision.upShares,
            total: decision.upShares * (decision.upSlippage?.avgFillPrice ?? upBestAsk),
            trade_type: decision.tradeType ?? 'UNKNOWN',
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
          });
        }
      }
      
      // DOWN trade - check existing again to be safe
      if ((decision.outcome === 'DOWN' || decision.outcome === 'BOTH') && decision.downShares && decision.downShares > 0) {
        if (!existingTrades.has(downKey)) {
          existingTrades.add(downKey); // Mark as existing BEFORE insert
          trades.push({
            market_slug: slug,
            asset: market.asset,
            outcome: 'DOWN',
            price: decision.downSlippage?.avgFillPrice ?? downBestAsk,
            shares: decision.downShares,
            total: decision.downShares * (decision.downSlippage?.avgFillPrice ?? downBestAsk),
            trade_type: decision.tradeType ?? 'UNKNOWN',
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
          });
        }
      }
      
      if (trades.length > 0) {
        // Use upsert with onConflict to handle race conditions at database level
        const { error } = await supabase.from('paper_trades').upsert(trades, {
          onConflict: 'market_slug,outcome',
          ignoreDuplicates: true,
        });
        
        if (error) {
          // Ignore duplicate key errors (23505) - means another process already inserted
          if (!error.message?.includes('duplicate') && !error.code?.includes('23505')) {
            log(`❌ Insert error: ${error.message}`);
            // Remove from existingTrades on error so we can retry
            if (trades.some(t => t.outcome === 'UP')) existingTrades.delete(upKey);
            if (trades.some(t => t.outcome === 'DOWN')) existingTrades.delete(downKey);
          }
        } else {
          tradeCount += trades.length;
          log(`🚀 TRADED #${tradeCount}: ${slug} | ${decision.tradeType} | ${trades.map(t => `${t.outcome}:${t.shares.toFixed(1)}`).join(' + ')}`);
          socket.send(JSON.stringify({ 
            type: 'trade', 
            trades: trades.map(t => ({
              slug: t.market_slug,
              outcome: t.outcome,
              price: t.price,
              shares: t.shares,
              reasoning: t.reasoning,
            }))
          }));
        }
      }
    } finally {
      // RACE CONDITION FIX: Always release lock
      processingTrades.delete(slug);
    }
  };

  const connectToRtds = () => {
    const rtdsSocket = new WebSocket(`${supabaseUrl.replace('https', 'wss')}/functions/v1/rtds-proxy`);
    
    rtdsSocket.onopen = () => {
      log('✅ Connected to Chainlink RTDS');
      rtdsSocket.send(JSON.stringify({
        action: 'subscribe',
        subscriptions: [{ topic: 'crypto_prices_chainlink', type: '*', filters: '' }]
      }));
    };
    
    rtdsSocket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data.toString());
        if (data.payload?.symbol === 'btc/usd') cryptoPrices.btc = data.payload.value;
        else if (data.payload?.symbol === 'eth/usd') cryptoPrices.eth = data.payload.value;
      } catch {}
    };
    
    rtdsSocket.onerror = () => log('⚠️ RTDS error');
    rtdsSocket.onclose = () => {
      log('🔌 RTDS disconnected');
      setTimeout(connectToRtds, 5000);
    };
  };

  const startStatusLogging = () => {
    statusLogInterval = setInterval(() => {
      const orderbooksWithData = [...orderbooks.values()].filter(
        ob => ob.upAsks.length > 0 || ob.downAsks.length > 0
      ).length;
      log(`📈 Status: ${orderbooksWithData}/${markets.size} markets | BTC:$${cryptoPrices.btc?.toFixed(0) ?? 'N/A'} ETH:$${cryptoPrices.eth?.toFixed(0) ?? 'N/A'} | Evals:${evaluationCount} Trades:${tradeCount}`);
    }, 30000);
  };

  socket.onopen = async () => {
    log('👋 Client connected');
    
    isEnabled = await checkBotEnabled();
    if (!isEnabled) {
      log('⚠️ Bot is disabled');
      socket.send(JSON.stringify({ type: 'disabled' }));
      return;
    }
    
    log('🟢 Bot ENABLED - Gabagool-style trading active');
    socket.send(JSON.stringify({ type: 'enabled' }));
    
    await fetchMarkets();
    await fetchExistingTrades();
    
    connectToClob();
    connectToRtds();
    startStatusLogging();
    
    const refreshInterval = setInterval(async () => {
      isEnabled = await checkBotEnabled();
      if (!isEnabled) {
        log('🔴 Bot disabled, stopping');
        clobSocket?.close();
        clearInterval(refreshInterval);
        if (statusLogInterval) clearInterval(statusLogInterval);
        return;
      }
      await fetchMarkets();
      await fetchExistingTrades();
    }, 60000);
  };

  socket.onmessage = async (event) => {
    try {
      const msg = JSON.parse(event.data.toString());
      if (msg.type === 'ping') socket.send(JSON.stringify({ type: 'pong' }));
    } catch {}
  };

  socket.onclose = () => {
    log('👋 Client disconnected');
    clobSocket?.close();
    if (statusLogInterval) clearInterval(statusLogInterval);
  };

  return response;
}

async function handleHttpRequest(req: Request): Promise<Response> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    const { data: settings } = await supabase
      .from('paper_bot_settings')
      .select('is_enabled')
      .limit(1)
      .maybeSingle();

    const isEnabled = settings?.is_enabled ?? false;

    const { data: recentTrades } = await supabase
      .from('paper_trades')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(20);

    return new Response(JSON.stringify({
      success: true,
      isEnabled,
      strategy: 'GABAGOOL_STYLE',
      config: TRADE_CONFIG,
      recentTrades: recentTrades || [],
      message: isEnabled 
        ? '🟢 Gabagool-style paper trading bot is ACTIVE'
        : '🔴 Bot is disabled',
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
