import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Trading decision configuration (same as Rust bot)
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
  remainingSeconds: number
): TradeDecision {
  const combinedPrice = upPrice + downPrice;
  const arbitrageEdge = (1 - combinedPrice) * 100;
  
  let priceDelta = null;
  let priceDeltaPercent = null;
  if (currentCryptoPrice && openPrice) {
    priceDelta = currentCryptoPrice - openPrice;
    priceDeltaPercent = Math.abs((priceDelta / openPrice) * 100);
  }

  // Don't trade if too close to expiry
  if (remainingSeconds < TRADE_CONFIG.minRemainingSeconds) {
    return {
      shouldTrade: false,
      outcome: 'UP',
      upShares: 0,
      downShares: 0,
      tradeType: 'SKIP',
      reasoning: `Too close to expiry: ${remainingSeconds}s remaining`,
    };
  }

  // RULE 1: Pure Arbitrage (combined < 0.98 = guaranteed profit)
  if (combinedPrice < 0.98 && remainingSeconds > 60) {
    const budget = TRADE_CONFIG.arbitrage.budget;
    return {
      shouldTrade: true,
      outcome: 'BOTH',
      upShares: budget / upPrice,
      downShares: budget / downPrice,
      tradeType: 'ARBITRAGE',
      reasoning: `Pure arbitrage: ${arbitrageEdge.toFixed(1)}% edge, combined=${combinedPrice.toFixed(3)}`,
    };
  }

  // RULE 2: Dual-Side Hedge (very small delta + combined < 1.0)
  if (priceDeltaPercent !== null && priceDeltaPercent < TRADE_CONFIG.dualSide.maxDeltaPercent 
      && combinedPrice < TRADE_CONFIG.dualSide.maxCombined && remainingSeconds > 120) {
    const budget = TRADE_CONFIG.dualSide.budget;
    return {
      shouldTrade: true,
      outcome: 'BOTH',
      upShares: budget / upPrice,
      downShares: budget / downPrice,
      tradeType: 'DUAL_SIDE',
      reasoning: `Dual-side hedge: delta=${priceDeltaPercent.toFixed(3)}%, combined=${combinedPrice.toFixed(3)}`,
    };
  }

  // RULE 3: Directional + Hedge (clear direction but hedge)
  if (priceDeltaPercent !== null && priceDelta !== null 
      && priceDeltaPercent < TRADE_CONFIG.directionalHedge.maxDeltaPercent 
      && combinedPrice < TRADE_CONFIG.directionalHedge.maxCombined && remainingSeconds > 60) {
    const favoredSide = priceDelta > 0 ? 'UP' : 'DOWN';
    const mainBudget = TRADE_CONFIG.directionalHedge.mainBudget;
    const hedgeBudget = TRADE_CONFIG.directionalHedge.hedgeBudget;

    return {
      shouldTrade: true,
      outcome: 'BOTH',
      upShares: favoredSide === 'UP' ? mainBudget / upPrice : hedgeBudget / upPrice,
      downShares: favoredSide === 'DOWN' ? mainBudget / downPrice : hedgeBudget / downPrice,
      tradeType: 'DIRECTIONAL_HEDGE',
      reasoning: `Directional hedge: ${favoredSide} favored by ${priceDeltaPercent.toFixed(2)}%`,
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
      reasoning: `Late arbitrage: ${remainingSeconds}s left, ${arbitrageEdge.toFixed(1)}% edge`,
    };
  }

  // NO TRADE
  return {
    shouldTrade: false,
    outcome: 'UP',
    upShares: 0,
    downShares: 0,
    tradeType: 'SKIP',
    reasoning: `No opportunity: delta=${priceDeltaPercent?.toFixed(2) ?? 'N/A'}%, combined=${combinedPrice.toFixed(3)}, edge=${arbitrageEdge.toFixed(1)}%`,
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
      console.error('Failed to fetch CLOB prices:', response.status);
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
    console.error('Error fetching CLOB prices:', error);
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
      console.error('Failed to fetch Chainlink prices:', response.status);
      return { btc: null, eth: null };
    }
    
    const data = await response.json();
    return {
      btc: data.btc?.price ?? null,
      eth: data.eth?.price ?? null,
    };
  } catch (error) {
    console.error('Error fetching Chainlink prices:', error);
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

    for (const market of markets) {
      const eventEndTime = new Date(market.eventEndTime);
      const remainingSeconds = Math.floor((eventEndTime.getTime() - now) / 1000);

      if (remainingSeconds <= 0) continue;

      const upPrice = clobPrices.get(market.upTokenId) ?? 0.5;
      const downPrice = clobPrices.get(market.downTokenId) ?? 0.5;

      const cryptoPrice = market.asset === 'BTC' ? chainlinkPrices.btc : 
                          market.asset === 'ETH' ? chainlinkPrices.eth : null;
      const openPrice = market.openPrice ?? market.strikePrice;

      const decision = makeTradeDecision(upPrice, downPrice, cryptoPrice, openPrice, remainingSeconds);

      if (!decision.shouldTrade) {
        console.log(`[paper-trade-bot] ${market.slug}: ${decision.reasoning}`);
        continue;
      }

      const combinedPrice = upPrice + downPrice;
      const arbitrageEdge = (1 - combinedPrice) * 100;
      const priceDelta = cryptoPrice && openPrice ? cryptoPrice - openPrice : null;
      const priceDeltaPercent = priceDelta && openPrice ? Math.abs((priceDelta / openPrice) * 100) : null;

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
      trades: paperTrades.map(t => ({
        slug: t.market_slug,
        outcome: t.outcome,
        type: t.trade_type,
        shares: t.shares.toFixed(2),
        price: t.price.toFixed(3),
      })),
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
