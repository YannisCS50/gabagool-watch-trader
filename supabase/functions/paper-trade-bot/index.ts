import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Trading decision configuration
const TRADE_CONFIG = {
  arbitrage: {
    minEdge: 2,           // Minimum 2% edge for pure arbitrage
    budget: 50,           // $50 per side
  },
  dualSide: {
    maxDeltaPercent: 0.03, // Price within 0.03% of open
    maxCombined: 1.0,
    budget: 40,
  },
  directionalHedge: {
    maxDeltaPercent: 0.5,
    maxCombined: 1.02,
    mainBudget: 30,
    hedgeBudget: 15,
  },
  lateArb: {
    maxSeconds: 60,
    maxCombined: 0.95,
    budget: 20,
  },
  openingTrade: {
    budget: 20,           // $20 for opening trades
    maxCombined: 1.0,     // Only if no guaranteed loss
  },
  minRemainingSeconds: 30, // Don't trade if less than 30 seconds remaining
};

interface MarketToken {
  slug: string;
  question: string;
  asset: string;
  upTokenId: string;
  downTokenId: string;
  eventStartTime: string;
  eventEndTime: string;
  marketType: string;
  strikePrice: number | null;
  openPrice: number | null;
}

interface TradeDecision {
  shouldTrade: boolean;
  outcome: 'UP' | 'DOWN' | 'BOTH';
  upShares: number;
  downShares: number;
  tradeType: string;
  reasoning: string;
}

interface PaperTrade {
  market_slug: string;
  asset: string;
  outcome: string;
  shares: number;
  price: number;
  total: number;
  combined_price: number;
  arbitrage_edge: number;
  crypto_price: number | null;
  open_price: number | null;
  price_delta: number | null;
  price_delta_percent: number | null;
  remaining_seconds: number;
  trade_type: string;
  reasoning: string;
  event_start_time: string;
  event_end_time: string;
}

function makeTradeDecision(
  upPrice: number,
  downPrice: number,
  currentCryptoPrice: number | null,
  openPrice: number | null,
  remainingSeconds: number,
  asset: string
): TradeDecision {
  const combinedPrice = upPrice + downPrice;
  const arbitrageEdge = (1 - combinedPrice) * 100;
  
  let priceDelta: number | null = null;
  let priceDeltaPercent: number | null = null;
  
  if (currentCryptoPrice && openPrice) {
    priceDelta = currentCryptoPrice - openPrice;
    priceDeltaPercent = (priceDelta / openPrice) * 100;
  }

  // Don't trade if too close to expiry
  if (remainingSeconds < TRADE_CONFIG.minRemainingSeconds) {
    return {
      shouldTrade: false,
      outcome: 'UP',
      upShares: 0,
      downShares: 0,
      tradeType: 'SKIP',
      reasoning: `⏱️ Te dicht bij expiry (${remainingSeconds}s < ${TRADE_CONFIG.minRemainingSeconds}s minimum)`,
    };
  }

  // RULE 1: Pure Arbitrage (combined < 0.98 = guaranteed profit)
  if (combinedPrice < 0.98 && remainingSeconds > 60) {
    const budget = TRADE_CONFIG.arbitrage.budget;
    const guaranteedProfit = ((1 - combinedPrice) * budget * 2).toFixed(2);
    return {
      shouldTrade: true,
      outcome: 'BOTH',
      upShares: budget / upPrice,
      downShares: budget / downPrice,
      tradeType: 'ARBITRAGE',
      reasoning: `🎯 ARBITRAGE: Koop UP@${(upPrice*100).toFixed(1)}¢ + DOWN@${(downPrice*100).toFixed(1)}¢ = ${(combinedPrice*100).toFixed(1)}¢ < $1. Gegarandeerde winst ~$${guaranteedProfit} (${arbitrageEdge.toFixed(1)}% edge)`,
    };
  }

  // RULE 2: Dual-Side Hedge (very small delta + combined <= 1.0)
  if (priceDeltaPercent !== null && Math.abs(priceDeltaPercent) < TRADE_CONFIG.dualSide.maxDeltaPercent 
      && combinedPrice <= TRADE_CONFIG.dualSide.maxCombined && remainingSeconds > 120) {
    const budget = TRADE_CONFIG.dualSide.budget;
    const direction = priceDeltaPercent >= 0 ? '📈' : '📉';
    return {
      shouldTrade: true,
      outcome: 'BOTH',
      upShares: budget / upPrice,
      downShares: budget / downPrice,
      tradeType: 'DUAL_SIDE',
      reasoning: `🔄 DUAL-SIDE: ${asset} ${direction} ${Math.abs(priceDeltaPercent).toFixed(3)}% vs open ($${currentCryptoPrice?.toFixed(2)} vs $${openPrice?.toFixed(2)}). Prijs te dicht bij strike voor richting. Hedge beide kanten @ combined ${(combinedPrice*100).toFixed(1)}¢`,
    };
  }

  // RULE 3: Directional + Hedge (clear direction but hedge)
  if (priceDeltaPercent !== null && priceDelta !== null 
      && Math.abs(priceDeltaPercent) < TRADE_CONFIG.directionalHedge.maxDeltaPercent 
      && combinedPrice <= TRADE_CONFIG.directionalHedge.maxCombined && remainingSeconds > 60) {
    const favoredSide = priceDelta > 0 ? 'UP' : 'DOWN';
    const mainBudget = TRADE_CONFIG.directionalHedge.mainBudget;
    const hedgeBudget = TRADE_CONFIG.directionalHedge.hedgeBudget;
    const direction = priceDelta > 0 ? '📈' : '📉';

    return {
      shouldTrade: true,
      outcome: 'BOTH',
      upShares: favoredSide === 'UP' ? mainBudget / upPrice : hedgeBudget / upPrice,
      downShares: favoredSide === 'DOWN' ? mainBudget / downPrice : hedgeBudget / downPrice,
      tradeType: 'DIRECTIONAL_HEDGE',
      reasoning: `🎲 DIRECTIONAL: ${asset} ${direction} ${Math.abs(priceDeltaPercent).toFixed(2)}% ($${currentCryptoPrice?.toFixed(2)} vs open $${openPrice?.toFixed(2)}). Favoriet: ${favoredSide} ($${mainBudget}) + hedge ${favoredSide === 'UP' ? 'DOWN' : 'UP'} ($${hedgeBudget})`,
    };
  }

  // RULE 4: Late entry (only if combined < 0.95)
  if (remainingSeconds < TRADE_CONFIG.lateArb.maxSeconds && combinedPrice < TRADE_CONFIG.lateArb.maxCombined) {
    const budget = TRADE_CONFIG.lateArb.budget;
    return {
      shouldTrade: true,
      outcome: 'BOTH',
      upShares: budget / upPrice,
      downShares: budget / downPrice,
      tradeType: 'LATE_ARB',
      reasoning: `⚡ LATE ARB: Nog ${remainingSeconds}s, combined ${(combinedPrice*100).toFixed(1)}¢ = ${arbitrageEdge.toFixed(1)}% edge. Snelle arbitrage voor expiry.`,
    };
  }

  // RULE 5: Opening trade when no Chainlink data but combined <= 1.0
  // This is a fallback for when we can't determine direction
  if (currentCryptoPrice === null && combinedPrice <= TRADE_CONFIG.openingTrade.maxCombined && remainingSeconds > 300) {
    const budget = TRADE_CONFIG.openingTrade.budget;
    // Pick the cheaper side as slight favorite
    const cheaperSide = upPrice <= downPrice ? 'UP' : 'DOWN';
    const cheaperPrice = Math.min(upPrice, downPrice);
    
    return {
      shouldTrade: true,
      outcome: cheaperSide as 'UP' | 'DOWN',
      upShares: cheaperSide === 'UP' ? budget / upPrice : 0,
      downShares: cheaperSide === 'DOWN' ? budget / downPrice : 0,
      tradeType: 'OPENING',
      reasoning: `🎬 OPENING: Geen Chainlink data beschikbaar. ${cheaperSide}@${(cheaperPrice*100).toFixed(1)}¢ is goedkoper. Combined=${(combinedPrice*100).toFixed(1)}¢. Speculatieve positie.`,
    };
  }

  // NO TRADE - provide detailed reason
  const reasons: string[] = [];
  
  if (priceDeltaPercent === null) {
    reasons.push('geen Chainlink data');
  } else if (Math.abs(priceDeltaPercent) >= TRADE_CONFIG.directionalHedge.maxDeltaPercent) {
    reasons.push(`delta te groot (${Math.abs(priceDeltaPercent).toFixed(2)}% > ${TRADE_CONFIG.directionalHedge.maxDeltaPercent}%)`);
  }
  
  if (combinedPrice > TRADE_CONFIG.directionalHedge.maxCombined) {
    reasons.push(`combined te hoog (${(combinedPrice*100).toFixed(1)}¢ > ${TRADE_CONFIG.directionalHedge.maxCombined * 100}¢)`);
  }
  
  if (arbitrageEdge < 0) {
    reasons.push(`negatieve edge (${arbitrageEdge.toFixed(1)}%)`);
  }

  return {
    shouldTrade: false,
    outcome: 'UP',
    upShares: 0,
    downShares: 0,
    tradeType: 'SKIP',
    reasoning: `⏸️ SKIP: ${reasons.join(', ')}. UP@${(upPrice*100).toFixed(1)}¢ + DOWN@${(downPrice*100).toFixed(1)}¢ = ${(combinedPrice*100).toFixed(1)}¢`,
  };
}

async function fetchClobPrices(supabaseUrl: string, anonKey: string, tokenIds: string[]): Promise<Map<string, number>> {
  const prices = new Map<string, number>();
  
  if (tokenIds.length === 0) return prices;
  
  try {
    const response = await fetch(`${supabaseUrl}/functions/v1/clob-prices`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${anonKey}`,
      },
      body: JSON.stringify({ tokenIds }),
    });
    
    if (!response.ok) {
      console.error('[paper-trade-bot] Failed to fetch CLOB prices:', response.status);
      return prices;
    }
    
    const data = await response.json();
    if (data.success && data.prices) {
      for (const [tokenId, priceData] of Object.entries(data.prices)) {
        const p = priceData as { bestAsk?: number; price?: number };
        const price = p.bestAsk ?? p.price;
        if (price !== undefined) {
          prices.set(tokenId, price);
        }
      }
    }
  } catch (error) {
    console.error('[paper-trade-bot] Error fetching CLOB prices:', error);
  }
  
  return prices;
}

async function fetchChainlinkPrices(supabaseUrl: string, anonKey: string): Promise<{ btc: number | null; eth: number | null }> {
  try {
    const response = await fetch(`${supabaseUrl}/functions/v1/chainlink-price-collector`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${anonKey}`,
      },
    });
    
    if (!response.ok) {
      console.error('[paper-trade-bot] Failed to fetch Chainlink prices:', response.status);
      return { btc: null, eth: null };
    }
    
    const data = await response.json();
    console.log('[paper-trade-bot] Chainlink prices:', data);
    return {
      btc: data.btc?.price ?? null,
      eth: data.eth?.price ?? null,
    };
  } catch (error) {
    console.error('[paper-trade-bot] Error fetching Chainlink prices:', error);
    return { btc: null, eth: null };
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')!;

  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    console.log('[paper-trade-bot] Starting paper trade cycle...');

    // Check if bot is enabled
    const { data: settings } = await supabase
      .from('paper_bot_settings')
      .select('is_enabled')
      .limit(1)
      .maybeSingle();

    if (!settings?.is_enabled) {
      console.log('[paper-trade-bot] Bot is disabled, skipping...');
      return new Response(JSON.stringify({
        success: true,
        message: 'Bot is disabled',
        tradesPlaced: 0,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // 1. Fetch active markets
    const marketsResponse = await fetch(`${supabaseUrl}/functions/v1/get-market-tokens`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${supabaseAnonKey}`,
      },
      body: JSON.stringify({}),
    });

    if (!marketsResponse.ok) {
      throw new Error(`Failed to fetch markets: ${marketsResponse.status}`);
    }

    const marketsData = await marketsResponse.json();
    const markets: MarketToken[] = marketsData.markets || [];
    
    console.log(`[paper-trade-bot] Found ${markets.length} active markets`);

    if (markets.length === 0) {
      return new Response(JSON.stringify({ 
        success: true, 
        message: 'No active markets found',
        tradesPlaced: 0,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // 2. Collect all token IDs and fetch prices
    const tokenIds: string[] = [];
    for (const market of markets) {
      if (market.upTokenId) tokenIds.push(market.upTokenId);
      if (market.downTokenId) tokenIds.push(market.downTokenId);
    }

    const [clobPrices, chainlinkPrices] = await Promise.all([
      fetchClobPrices(supabaseUrl, supabaseAnonKey, tokenIds),
      fetchChainlinkPrices(supabaseUrl, supabaseAnonKey),
    ]);

    console.log(`[paper-trade-bot] Fetched ${clobPrices.size} CLOB prices, BTC=$${chainlinkPrices.btc}, ETH=$${chainlinkPrices.eth}`);

    // 3. Check existing paper trades to avoid duplicates
    const marketSlugs = markets.map(m => m.slug);
    const { data: existingTrades } = await supabase
      .from('paper_trades')
      .select('market_slug, outcome')
      .in('market_slug', marketSlugs);

    const existingTradeMap = new Set<string>();
    if (existingTrades) {
      for (const trade of existingTrades) {
        existingTradeMap.add(`${trade.market_slug}-${trade.outcome}`);
      }
    }

    // 4. Make trading decisions
    const now = Date.now();
    const paperTrades: PaperTrade[] = [];
    const skippedMarkets: { slug: string; reason: string }[] = [];

    for (const market of markets) {
      const eventEndTime = new Date(market.eventEndTime);
      const remainingSeconds = Math.floor((eventEndTime.getTime() - now) / 1000);

      if (remainingSeconds <= 0) continue;

      const upPrice = clobPrices.get(market.upTokenId) ?? 0.5;
      const downPrice = clobPrices.get(market.downTokenId) ?? 0.5;

      const cryptoPrice = market.asset === 'BTC' ? chainlinkPrices.btc : 
                          market.asset === 'ETH' ? chainlinkPrices.eth : null;
      const openPrice = market.openPrice ?? market.strikePrice;

      const decision = makeTradeDecision(upPrice, downPrice, cryptoPrice, openPrice, remainingSeconds, market.asset);

      if (!decision.shouldTrade) {
        console.log(`[paper-trade-bot] ${market.slug}: ${decision.reasoning}`);
        skippedMarkets.push({ slug: market.slug, reason: decision.reasoning });
        continue;
      }

      const combinedPrice = upPrice + downPrice;
      const arbitrageEdge = (1 - combinedPrice) * 100;
      const priceDelta = cryptoPrice && openPrice ? cryptoPrice - openPrice : null;
      const priceDeltaPercent = priceDelta && openPrice ? (priceDelta / openPrice) * 100 : null;

      console.log(`[paper-trade-bot] ${market.slug}: ${decision.reasoning}`);

      // Create UP trade if shares > 0 and not already exists
      if (decision.upShares > 0 && !existingTradeMap.has(`${market.slug}-UP`)) {
        paperTrades.push({
          market_slug: market.slug,
          asset: market.asset,
          outcome: 'UP',
          shares: decision.upShares,
          price: upPrice,
          total: decision.upShares * upPrice,
          combined_price: combinedPrice,
          arbitrage_edge: arbitrageEdge,
          crypto_price: cryptoPrice,
          open_price: openPrice,
          price_delta: priceDelta,
          price_delta_percent: priceDeltaPercent,
          remaining_seconds: remainingSeconds,
          trade_type: decision.tradeType,
          reasoning: decision.reasoning,
          event_start_time: market.eventStartTime,
          event_end_time: market.eventEndTime,
        });
      }

      // Create DOWN trade if shares > 0 and not already exists
      if (decision.downShares > 0 && !existingTradeMap.has(`${market.slug}-DOWN`)) {
        paperTrades.push({
          market_slug: market.slug,
          asset: market.asset,
          outcome: 'DOWN',
          shares: decision.downShares,
          price: downPrice,
          total: decision.downShares * downPrice,
          combined_price: combinedPrice,
          arbitrage_edge: arbitrageEdge,
          crypto_price: cryptoPrice,
          open_price: openPrice,
          price_delta: priceDelta,
          price_delta_percent: priceDeltaPercent,
          remaining_seconds: remainingSeconds,
          trade_type: decision.tradeType,
          reasoning: decision.reasoning,
          event_start_time: market.eventStartTime,
          event_end_time: market.eventEndTime,
        });
      }
    }

    // 5. Insert paper trades
    if (paperTrades.length > 0) {
      const { error } = await supabase.from('paper_trades').insert(paperTrades);
      if (error) {
        console.error('[paper-trade-bot] Error inserting trades:', error);
        throw error;
      }
      console.log(`[paper-trade-bot] Placed ${paperTrades.length} paper trades`);
    } else {
      console.log('[paper-trade-bot] No new trades to place');
    }

    return new Response(JSON.stringify({
      success: true,
      timestamp: new Date().toISOString(),
      marketsAnalyzed: markets.length,
      tradesPlaced: paperTrades.length,
      chainlinkPrices: {
        btc: chainlinkPrices.btc,
        eth: chainlinkPrices.eth,
      },
      trades: paperTrades.map(t => ({
        slug: t.market_slug,
        outcome: t.outcome,
        type: t.trade_type,
        shares: t.shares.toFixed(2),
        price: t.price.toFixed(3),
        reasoning: t.reasoning,
      })),
      skipped: skippedMarkets,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('[paper-trade-bot] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
