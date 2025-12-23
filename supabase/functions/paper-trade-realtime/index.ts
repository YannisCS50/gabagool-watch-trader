import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// GABAGOOL STRATEGY V2 - Based on ACTUAL trading pattern analysis
// Real pattern from trade data:
// 1. OPEN: Buy ONE side first (exposed) - typically cheaper side or based on crypto direction
// 2. HEDGE: 4-10 seconds later, buy OTHER side to complete the hedge pair
// 3. DCA: Continue buying the cheaper side as prices move, building position
// Key rule: combined price must be < 98¢ for any trade (2%+ guaranteed edge)

const TRADE_CONFIG = {
  // Phase 1: Opening trade (exposed position)
  opening: {
    enabled: true,
    minPrice: 0.35,            // Sweet spot starts at 35¢
    maxPrice: 0.55,            // Don't overpay for opening
    baseBudget: 20,            // Small initial position (like Gabagool's 20 shares)
    maxSlippage: 2.0,
    minLiquidity: 30,
    minRemainingSeconds: 600,  // At least 10 min to expiry for opening
  },
  
  // Phase 2: Hedge trade (complete the pair)
  hedge: {
    enabled: true,
    maxCombinedPrice: 0.98,    // MUST have edge when hedging
    maxPrice: 0.60,            // Allow slightly higher for hedge
    baseBudget: 20,            // Match opening size
    maxSlippage: 2.5,          // Allow more slippage to complete hedge
    minLiquidity: 25,
    hedgeDelayMs: 3000,        // Wait 3 sec before hedging (like Gabagool)
  },
  
  // Phase 3: DCA - accumulate on the cheaper side
  dca: {
    enabled: true,
    maxCombinedPrice: 0.97,    // Tighter requirement for DCA (3%+ edge)
    sweetSpotMin: 0.35,        // Gabagool's sweet spot
    sweetSpotMax: 0.48,        // Upper bound for DCA
    budget: 15,                // Smaller DCA buys
    maxSlippage: 2.0,
    minLiquidity: 20,
    minSecondsBetweenDCA: 10,  // Don't spam trades
    maxDCAPerSide: 5,          // Max 5 DCA trades per side per market
  },
  
  // Phase 4: Late sniper - cheap bets near expiry
  lateEntry: {
    enabled: true,
    maxRemainingSeconds: 300,  // Last 5 minutes
    minRemainingSeconds: 30,
    maxPrice: 0.25,            // Cheap shots only
    minPrice: 0.05,
    budget: 30,
    maxSlippage: 3.0,
    minLiquidity: 20,
  },
  
  // Global settings
  global: {
    minAskPrice: 0.05,
    maxAskPrice: 0.95,
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
 * Gabagool-style trading V2 - Stateful pattern
 * Phase 1: OPEN - Buy one side (exposed)
 * Phase 2: HEDGE - Buy other side to complete pair (must have edge)
 * Phase 3: DCA - Continue accumulating cheaper side
 * Phase 4: LATE - Snipe cheap positions near expiry
 */
function makeGabagoolTradeDecision(
  orderbook: MarketOrderbook,
  cryptoPrice: number | null,
  openPrice: number | null,
  remainingSeconds: number,
  existingPositions: { hasUp: boolean; hasDown: boolean; upCount: number; downCount: number; lastTradeTime: number }
): TradeDecision {
  const upBestAsk = orderbook.upAsks[0]?.price ?? 0.5;
  const downBestAsk = orderbook.downAsks[0]?.price ?? 0.5;
  const combinedPrice = upBestAsk + downBestAsk;
  const arbitrageEdge = (1 - combinedPrice) * 100;

  // Calculate price delta for bias (crypto direction)
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

  // Determine which side is favored based on crypto movement
  let favoredSide: 'UP' | 'DOWN' = 'UP';
  if (priceDeltaPercent !== null) {
    favoredSide = priceDeltaPercent > 0 ? 'UP' : 'DOWN';
  } else {
    // No crypto data - favor cheaper side
    favoredSide = upBestAsk <= downBestAsk ? 'UP' : 'DOWN';
  }

  // ============================================
  // PHASE 4: Late Arbitrage Only (last 5 min, only if combined < $1)
  // ============================================
  const lateCfg = TRADE_CONFIG.lateEntry;
  const lateCombinedPrice = upBestAsk + downBestAsk;
  
  if (lateCfg.enabled && 
      remainingSeconds <= lateCfg.maxRemainingSeconds && 
      remainingSeconds >= lateCfg.minRemainingSeconds &&
      lateCombinedPrice < 1) {  // ONLY if there's actual arbitrage
    
    const lateArbitrageEdge = 1 - lateCombinedPrice;
    const cheaperSide = upBestAsk <= downBestAsk ? 'UP' : 'DOWN';
    const cheaperPrice = Math.min(upBestAsk, downBestAsk);
    
    if (cheaperPrice <= lateCfg.maxPrice && cheaperPrice >= lateCfg.minPrice) {
      const orderbookSide = cheaperSide === 'UP' ? orderbook.upAsks : orderbook.downAsks;
      const slippage = calculateSlippage(orderbookSide, lateCfg.budget);
      
      if (slippage.slippagePercent <= lateCfg.maxSlippage && 
          slippage.availableLiquidity >= lateCfg.minLiquidity) {
        
        return {
          shouldTrade: true,
          outcome: cheaperSide,
          upShares: cheaperSide === 'UP' ? slippage.filledShares : undefined,
          downShares: cheaperSide === 'DOWN' ? slippage.filledShares : undefined,
          tradeType: `LATE_ARB_${cheaperSide}`,
          reasoning: `⏰ Late ARB ${cheaperSide} @ ${(cheaperPrice*100).toFixed(0)}¢ | edge ${(lateArbitrageEdge*100).toFixed(1)}% | ${remainingSeconds}s`,
          upSlippage: cheaperSide === 'UP' ? slippage : undefined,
          downSlippage: cheaperSide === 'DOWN' ? slippage : undefined,
        };
      }
    }
  }

  // ============================================
  // PHASE 1: Opening Trade (no position yet)
  // CRITICAL: Only open if combined < 98¢ (must have edge from start!)
  // ============================================
  const openCfg = TRADE_CONFIG.opening;
  if (openCfg.enabled && !existingPositions.hasUp && !existingPositions.hasDown) {
    // GABAGOOL RULE: Must have arbitrage edge from the start
    if (combinedPrice > 0.98) {
      return { shouldTrade: false, reasoning: `No edge for opening: ${(combinedPrice*100).toFixed(0)}¢ > 98¢` };
    }
    
    if (remainingSeconds < openCfg.minRemainingSeconds) {
      return { shouldTrade: false, reasoning: `Too late for opening: ${remainingSeconds}s < ${openCfg.minRemainingSeconds}s` };
    }
    
    const targetSide = favoredSide;
    const targetPrice = targetSide === 'UP' ? upBestAsk : downBestAsk;
    
    if (targetPrice >= openCfg.minPrice && targetPrice <= openCfg.maxPrice) {
      const orderbookSide = targetSide === 'UP' ? orderbook.upAsks : orderbook.downAsks;
      const slippage = calculateSlippage(orderbookSide, openCfg.baseBudget);
      
      if (slippage.slippagePercent <= openCfg.maxSlippage && 
          slippage.availableLiquidity >= openCfg.minLiquidity) {
        
        const directionLabel = priceDeltaPercent !== null 
          ? (priceDeltaPercent > 0 ? '📈' : '📉') 
          : '❓';
        
        return {
          shouldTrade: true,
          outcome: targetSide,
          upShares: targetSide === 'UP' ? slippage.filledShares : undefined,
          downShares: targetSide === 'DOWN' ? slippage.filledShares : undefined,
          tradeType: `OPEN_${targetSide}`,
          reasoning: `🎬 OPEN ${targetSide} @ ${(targetPrice*100).toFixed(0)}¢ | Combined=${(combinedPrice*100).toFixed(0)}¢ | Edge=${arbitrageEdge.toFixed(1)}%`,
          upSlippage: targetSide === 'UP' ? slippage : undefined,
          downSlippage: targetSide === 'DOWN' ? slippage : undefined,
        };
      }
    }
    
    return { shouldTrade: false, reasoning: `Opening price outside range: ${(targetPrice*100).toFixed(0)}¢` };
  }

  // ============================================
  // PHASE 2: Hedge Trade (have one side, need other)
  // Complete the hedge pair - MUST have edge
  // ============================================
  const hedgeCfg = TRADE_CONFIG.hedge;
  if (hedgeCfg.enabled && (existingPositions.hasUp !== existingPositions.hasDown)) {
    // Check if enough time has passed since last trade (Gabagool waits ~4 sec)
    const timeSinceLastTrade = Date.now() - existingPositions.lastTradeTime;
    if (timeSinceLastTrade < hedgeCfg.hedgeDelayMs) {
      return { shouldTrade: false, reasoning: `Waiting to hedge: ${timeSinceLastTrade}ms < ${hedgeCfg.hedgeDelayMs}ms` };
    }
    
    // CRITICAL: Check combined price has edge
    if (combinedPrice > hedgeCfg.maxCombinedPrice) {
      return { shouldTrade: false, reasoning: `No edge for hedge: ${(combinedPrice*100).toFixed(0)}¢ > ${(hedgeCfg.maxCombinedPrice*100).toFixed(0)}¢` };
    }
    
    const targetSide = existingPositions.hasUp ? 'DOWN' : 'UP';
    const targetPrice = targetSide === 'UP' ? upBestAsk : downBestAsk;
    
    if (targetPrice <= hedgeCfg.maxPrice) {
      const orderbookSide = targetSide === 'UP' ? orderbook.upAsks : orderbook.downAsks;
      const slippage = calculateSlippage(orderbookSide, hedgeCfg.baseBudget);
      
      if (slippage.slippagePercent <= hedgeCfg.maxSlippage && 
          slippage.availableLiquidity >= hedgeCfg.minLiquidity) {
        
        return {
          shouldTrade: true,
          outcome: targetSide,
          upShares: targetSide === 'UP' ? slippage.filledShares : undefined,
          downShares: targetSide === 'DOWN' ? slippage.filledShares : undefined,
          tradeType: `HEDGE_${targetSide}`,
          reasoning: `🛡️ HEDGE ${targetSide} @ ${(targetPrice*100).toFixed(0)}¢ | Combined=${(combinedPrice*100).toFixed(0)}¢ | Edge=${arbitrageEdge.toFixed(1)}%`,
          upSlippage: targetSide === 'UP' ? slippage : undefined,
          downSlippage: targetSide === 'DOWN' ? slippage : undefined,
        };
      }
    }
    
    return { shouldTrade: false, reasoning: `Hedge price too high: ${(targetPrice*100).toFixed(0)}¢ > ${(hedgeCfg.maxPrice*100).toFixed(0)}¢` };
  }

  // ============================================
  // PHASE 3: DCA - Both sides exist, accumulate cheaper side
  // ============================================
  const dcaCfg = TRADE_CONFIG.dca;
  if (dcaCfg.enabled && existingPositions.hasUp && existingPositions.hasDown) {
    // Check combined still has good edge
    if (combinedPrice > dcaCfg.maxCombinedPrice) {
      return { shouldTrade: false, reasoning: `No DCA edge: ${(combinedPrice*100).toFixed(0)}¢ > ${(dcaCfg.maxCombinedPrice*100).toFixed(0)}¢` };
    }
    
    // Rate limiting
    const timeSinceLastTrade = Date.now() - existingPositions.lastTradeTime;
    if (timeSinceLastTrade < dcaCfg.minSecondsBetweenDCA * 1000) {
      return { shouldTrade: false, reasoning: `DCA cooldown: ${(timeSinceLastTrade/1000).toFixed(0)}s < ${dcaCfg.minSecondsBetweenDCA}s` };
    }
    
    // Choose cheaper side (or favored side if prices similar)
    let targetSide: 'UP' | 'DOWN';
    const priceDiff = Math.abs(upBestAsk - downBestAsk);
    
    if (priceDiff < 0.03) {
      // Prices similar - use crypto direction
      targetSide = favoredSide;
    } else {
      // Different prices - buy cheaper
      targetSide = upBestAsk < downBestAsk ? 'UP' : 'DOWN';
    }
    
    const targetPrice = targetSide === 'UP' ? upBestAsk : downBestAsk;
    const dcaCount = targetSide === 'UP' ? existingPositions.upCount : existingPositions.downCount;
    
    // Check max DCA limit
    if (dcaCount >= dcaCfg.maxDCAPerSide) {
      return { shouldTrade: false, reasoning: `Max DCA reached for ${targetSide}: ${dcaCount} >= ${dcaCfg.maxDCAPerSide}` };
    }
    
    // Check price in sweet spot
    if (targetPrice < dcaCfg.sweetSpotMin || targetPrice > dcaCfg.sweetSpotMax) {
      return { shouldTrade: false, reasoning: `DCA price outside sweet spot: ${(targetPrice*100).toFixed(0)}¢` };
    }
    
    const orderbookSide = targetSide === 'UP' ? orderbook.upAsks : orderbook.downAsks;
    const slippage = calculateSlippage(orderbookSide, dcaCfg.budget);
    
    if (slippage.slippagePercent <= dcaCfg.maxSlippage && 
        slippage.availableLiquidity >= dcaCfg.minLiquidity) {
      
      const spotLabel = targetPrice >= dcaCfg.sweetSpotMin && targetPrice <= 0.45 ? '⭐' : '';
      
      return {
        shouldTrade: true,
        outcome: targetSide,
        upShares: targetSide === 'UP' ? slippage.filledShares : undefined,
        downShares: targetSide === 'DOWN' ? slippage.filledShares : undefined,
        tradeType: `DCA_${targetSide}`,
        reasoning: `${spotLabel} DCA ${targetSide} #${dcaCount + 1} @ ${(targetPrice*100).toFixed(0)}¢ | Edge=${arbitrageEdge.toFixed(1)}%`,
        upSlippage: targetSide === 'UP' ? slippage : undefined,
        downSlippage: targetSide === 'DOWN' ? slippage : undefined,
      };
    }
  }

  return { 
    shouldTrade: false, 
    reasoning: `No opportunity: ${(combinedPrice*100).toFixed(0)}¢ combined | ${remainingSeconds}s left` 
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
  let processingTrades: Set<string> = new Set();
  // NEW: Track position state per market for phased trading
  let marketPositions: Map<string, { 
    hasUp: boolean; 
    hasDown: boolean; 
    upCount: number; 
    downCount: number; 
    lastTradeTime: number 
  }> = new Map();
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
        .select('market_slug, outcome, created_at')
        .in('market_slug', slugs);
      
      existingTrades.clear();
      marketPositions.clear();
      
      if (data) {
        // Group by market_slug
        const byMarket = new Map<string, typeof data>();
        for (const trade of data) {
          if (!byMarket.has(trade.market_slug)) byMarket.set(trade.market_slug, []);
          byMarket.get(trade.market_slug)!.push(trade);
        }
        
        // Build position state for each market
        for (const [slug, trades] of byMarket) {
          const upTrades = trades.filter(t => t.outcome === 'UP');
          const downTrades = trades.filter(t => t.outcome === 'DOWN');
          
          // Find most recent trade time
          const allTimes = trades.map(t => new Date(t.created_at).getTime());
          const lastTradeTime = allTimes.length > 0 ? Math.max(...allTimes) : 0;
          
          marketPositions.set(slug, {
            hasUp: upTrades.length > 0,
            hasDown: downTrades.length > 0,
            upCount: upTrades.length,
            downCount: downTrades.length,
            lastTradeTime,
          });
          
          // Also mark in existingTrades set for backward compat
          for (const trade of trades) {
            existingTrades.add(`${trade.market_slug}-${trade.outcome}`);
          }
        }
      }
      log(`📋 Found ${existingTrades.size} existing trades across ${marketPositions.size} markets`);
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
    
    // Get current position state for this market
    const positionState = marketPositions.get(slug) ?? {
      hasUp: false,
      hasDown: false,
      upCount: 0,
      downCount: 0,
      lastTradeTime: 0,
    };
    
    // Check DCA limits - max 6 trades per side (1 open + 1 hedge + max 4 DCA)
    const maxTradesPerSide = TRADE_CONFIG.dca.maxDCAPerSide + 2; // +2 for open and hedge
    if (positionState.upCount >= maxTradesPerSide && positionState.downCount >= maxTradesPerSide) {
      return; // Max trades reached for both sides
    }
    
    evaluationCount++;
    
    const now = Date.now();
    const endTime = new Date(market.eventEndTime).getTime();
    const remainingSeconds = Math.floor((endTime - now) / 1000);
    
    const cryptoPrice = market.asset === 'BTC' ? cryptoPrices.btc : cryptoPrices.eth;
    
    // Use gabagool-style decision making with position state
    const decision = makeGabagoolTradeDecision(
      orderbook,
      cryptoPrice,
      market.openPrice,
      remainingSeconds,
      positionState
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
      
      // UP trade
      if ((decision.outcome === 'UP' || decision.outcome === 'BOTH') && decision.upShares && decision.upShares > 0) {
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
      
      // DOWN trade
      if ((decision.outcome === 'DOWN' || decision.outcome === 'BOTH') && decision.downShares && decision.downShares > 0) {
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
      
      if (trades.length > 0) {
        // Insert trades (allow duplicates for DCA)
        const { error } = await supabase.from('paper_trades').insert(trades);
        
        if (error) {
          log(`❌ Insert error: ${error.message}`);
        } else {
          tradeCount += trades.length;
          
          // Update local position state immediately
          const currentPos = marketPositions.get(slug) ?? {
            hasUp: false,
            hasDown: false,
            upCount: 0,
            downCount: 0,
            lastTradeTime: 0,
          };
          
          for (const trade of trades) {
            if (trade.outcome === 'UP') {
              currentPos.hasUp = true;
              currentPos.upCount++;
            } else {
              currentPos.hasDown = true;
              currentPos.downCount++;
            }
          }
          currentPos.lastTradeTime = Date.now();
          marketPositions.set(slug, currentPos);
          
          log(`🚀 TRADED #${tradeCount}: ${slug} | ${decision.tradeType} | ${trades.map(t => `${t.outcome}:${t.shares.toFixed(1)}`).join(' + ')}`);
          socket.send(JSON.stringify({ 
            type: 'trade', 
            trades: trades.map(t => ({
              slug: t.market_slug,
              outcome: t.outcome,
              price: t.price,
              shares: t.shares,
              slippage: t.estimated_slippage,
              reasoning: t.reasoning,
            })),
            timestamp: Date.now() 
          }));
        }
      }
    } finally {
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
