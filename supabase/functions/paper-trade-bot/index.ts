import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * GABAGOOL-STYLE TRADING STRATEGY
 * 
 * Based on analysis of Gabagool's actual trades:
 * 1. DCA (Dollar Cost Averaging) - Multiple trades at different price points
 * 2. Dual-side hedging - Buy BOTH UP and DOWN in same market
 * 3. High volume - $500-3000+ per market across 100-400 trades
 * 4. Aggressive buying - Trades throughout the entire market duration
 * 5. Combined entry targeting - Aims for combined < $1.00 for arbitrage
 * 
 * Key insight: Gabagool makes money by:
 * - Buying both sides when combined price < $1.00 (guaranteed profit)
 * - Using DCA to get better average prices as odds fluctuate
 * - Heavy position building ensures significant absolute profit
 */

const STRATEGY_CONFIG = {
  // Per-trade sizing (simulates DCA with multiple smaller trades)
  tradeSize: {
    min: 5,           // Minimum $5 per trade
    max: 25,          // Maximum $25 per trade
    target: 15,       // Target trade size
  },
  
  // Position limits per market
  positionLimits: {
    maxPerSide: 200,      // Max $200 per side (UP or DOWN)
    maxTotal: 350,        // Max $350 total per market
    minCombinedEntry: 0.92, // Only trade if combined <= 1.08 (some room for error)
    maxCombinedEntry: 1.08,
  },
  
  // Entry conditions
  entryConditions: {
    minSecondsRemaining: 60,      // At least 1 minute remaining
    optimalSecondsRemaining: 300, // 5+ minutes = optimal for DCA
    
    // Price thresholds
    maxSingleSidePrice: 0.92,     // Don't pay more than 92¢ for one side
    minSingleSidePrice: 0.03,     // Don't buy below 3¢ (too risky)
    
    // Arbitrage thresholds
    arbitrageThreshold: 0.98,     // Combined < 98¢ = arbitrage opportunity
    strongArbitrageThreshold: 0.95, // Combined < 95¢ = strong arbitrage
  },
  
  // DCA behavior - buy more when prices are favorable
  dcaMultipliers: {
    veryFavorable: 2.0,   // 2x size when combined < 0.95
    favorable: 1.5,       // 1.5x size when combined < 0.98
    neutral: 1.0,         // 1x size when combined < 1.02
    unfavorable: 0.5,     // 0.5x size when combined >= 1.02
  },
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

interface ExistingPosition {
  upInvested: number;
  downInvested: number;
  upShares: number;
  downShares: number;
}

interface TradeDecision {
  shouldTrade: boolean;
  trades: Array<{
    outcome: 'UP' | 'DOWN';
    shares: number;
    price: number;
    total: number;
  }>;
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

function calculateTradeSize(
  combinedPrice: number,
  remainingSeconds: number,
  existingPosition: ExistingPosition
): number {
  let baseSize = STRATEGY_CONFIG.tradeSize.target;
  
  // Apply DCA multiplier based on combined price
  let multiplier = STRATEGY_CONFIG.dcaMultipliers.neutral;
  if (combinedPrice < STRATEGY_CONFIG.entryConditions.strongArbitrageThreshold) {
    multiplier = STRATEGY_CONFIG.dcaMultipliers.veryFavorable;
  } else if (combinedPrice < STRATEGY_CONFIG.entryConditions.arbitrageThreshold) {
    multiplier = STRATEGY_CONFIG.dcaMultipliers.favorable;
  } else if (combinedPrice >= 1.02) {
    multiplier = STRATEGY_CONFIG.dcaMultipliers.unfavorable;
  }
  
  // Scale down if close to position limits
  const totalExisting = existingPosition.upInvested + existingPosition.downInvested;
  const remainingBudget = STRATEGY_CONFIG.positionLimits.maxTotal - totalExisting;
  
  if (remainingBudget < baseSize * multiplier) {
    return Math.max(0, remainingBudget / 2); // Split remaining between UP and DOWN
  }
  
  // Scale down if close to expiry
  if (remainingSeconds < 120) {
    multiplier *= 0.5;
  }
  
  const size = Math.min(
    baseSize * multiplier,
    STRATEGY_CONFIG.tradeSize.max
  );
  
  return Math.max(size, STRATEGY_CONFIG.tradeSize.min);
}

function makeGabagoolStyleDecision(
  upPrice: number,
  downPrice: number,
  currentCryptoPrice: number | null,
  openPrice: number | null,
  remainingSeconds: number,
  asset: string,
  existingPosition: ExistingPosition
): TradeDecision {
  const combinedPrice = upPrice + downPrice;
  const arbitrageEdge = (1 - combinedPrice) * 100;
  
  let priceDelta: number | null = null;
  let priceDeltaPercent: number | null = null;
  
  if (currentCryptoPrice && openPrice) {
    priceDelta = currentCryptoPrice - openPrice;
    priceDeltaPercent = (priceDelta / openPrice) * 100;
  }

  const totalExisting = existingPosition.upInvested + existingPosition.downInvested;

  // Check position limits
  if (totalExisting >= STRATEGY_CONFIG.positionLimits.maxTotal) {
    return {
      shouldTrade: false,
      trades: [],
      tradeType: 'LIMIT_REACHED',
      reasoning: `📊 Positielimiet bereikt: $${totalExisting.toFixed(2)} / $${STRATEGY_CONFIG.positionLimits.maxTotal}`,
    };
  }

  // Check time constraint
  if (remainingSeconds < STRATEGY_CONFIG.entryConditions.minSecondsRemaining) {
    return {
      shouldTrade: false,
      trades: [],
      tradeType: 'TOO_LATE',
      reasoning: `⏱️ Te weinig tijd: ${remainingSeconds}s < ${STRATEGY_CONFIG.entryConditions.minSecondsRemaining}s minimum`,
    };
  }

  // Check price validity
  if (upPrice < STRATEGY_CONFIG.entryConditions.minSingleSidePrice || 
      downPrice < STRATEGY_CONFIG.entryConditions.minSingleSidePrice) {
    return {
      shouldTrade: false,
      trades: [],
      tradeType: 'PRICE_TOO_LOW',
      reasoning: `⚠️ Prijs te laag: UP=${(upPrice*100).toFixed(1)}¢ DOWN=${(downPrice*100).toFixed(1)}¢ (min ${STRATEGY_CONFIG.entryConditions.minSingleSidePrice*100}¢)`,
    };
  }

  if (upPrice > STRATEGY_CONFIG.entryConditions.maxSingleSidePrice && 
      downPrice > STRATEGY_CONFIG.entryConditions.maxSingleSidePrice) {
    return {
      shouldTrade: false,
      trades: [],
      tradeType: 'PRICES_TOO_HIGH',
      reasoning: `⚠️ Beide prijzen te hoog: UP=${(upPrice*100).toFixed(1)}¢ DOWN=${(downPrice*100).toFixed(1)}¢ (max ${STRATEGY_CONFIG.entryConditions.maxSingleSidePrice*100}¢)`,
    };
  }

  // Check combined price - core of the strategy
  if (combinedPrice > STRATEGY_CONFIG.positionLimits.maxCombinedEntry) {
    return {
      shouldTrade: false,
      trades: [],
      tradeType: 'COMBINED_TOO_HIGH',
      reasoning: `❌ Combined te hoog: ${(combinedPrice*100).toFixed(1)}¢ > ${STRATEGY_CONFIG.positionLimits.maxCombinedEntry*100}¢ (negatieve edge)`,
    };
  }

  // Calculate trade size
  const tradeSize = calculateTradeSize(combinedPrice, remainingSeconds, existingPosition);
  
  if (tradeSize < STRATEGY_CONFIG.tradeSize.min) {
    return {
      shouldTrade: false,
      trades: [],
      tradeType: 'BUDGET_EXHAUSTED',
      reasoning: `💰 Budget uitgeput: trade size ${tradeSize.toFixed(2)} < min ${STRATEGY_CONFIG.tradeSize.min}`,
    };
  }

  // GABAGOOL STRATEGY: Always buy BOTH sides for dual-side hedging
  const trades: Array<{ outcome: 'UP' | 'DOWN'; shares: number; price: number; total: number }> = [];
  
  // Determine how to split the budget between UP and DOWN
  // If we have price direction info, lean towards the favored side
  let upBudget = tradeSize;
  let downBudget = tradeSize;
  
  if (priceDeltaPercent !== null) {
    // Crypto price is above open = favor UP, below = favor DOWN
    if (priceDeltaPercent > 0.1) {
      // Price trending UP - buy more UP
      upBudget = tradeSize * 1.3;
      downBudget = tradeSize * 0.7;
    } else if (priceDeltaPercent < -0.1) {
      // Price trending DOWN - buy more DOWN
      upBudget = tradeSize * 0.7;
      downBudget = tradeSize * 1.3;
    }
  }
  
  // Check individual position limits
  if (existingPosition.upInvested + upBudget > STRATEGY_CONFIG.positionLimits.maxPerSide) {
    upBudget = Math.max(0, STRATEGY_CONFIG.positionLimits.maxPerSide - existingPosition.upInvested);
  }
  if (existingPosition.downInvested + downBudget > STRATEGY_CONFIG.positionLimits.maxPerSide) {
    downBudget = Math.max(0, STRATEGY_CONFIG.positionLimits.maxPerSide - existingPosition.downInvested);
  }
  
  // Only add trades that have budget
  if (upBudget >= 1 && upPrice <= STRATEGY_CONFIG.entryConditions.maxSingleSidePrice) {
    trades.push({
      outcome: 'UP',
      shares: upBudget / upPrice,
      price: upPrice,
      total: upBudget,
    });
  }
  
  if (downBudget >= 1 && downPrice <= STRATEGY_CONFIG.entryConditions.maxSingleSidePrice) {
    trades.push({
      outcome: 'DOWN',
      shares: downBudget / downPrice,
      price: downPrice,
      total: downBudget,
    });
  }
  
  if (trades.length === 0) {
    return {
      shouldTrade: false,
      trades: [],
      tradeType: 'NO_VALID_TRADES',
      reasoning: `⚠️ Geen geldige trades: UP limiet=${existingPosition.upInvested >= STRATEGY_CONFIG.positionLimits.maxPerSide} DOWN limiet=${existingPosition.downInvested >= STRATEGY_CONFIG.positionLimits.maxPerSide}`,
    };
  }

  // Determine trade type based on conditions
  let tradeType: string;
  let emoji: string;
  
  if (combinedPrice < STRATEGY_CONFIG.entryConditions.strongArbitrageThreshold) {
    tradeType = 'STRONG_ARB';
    emoji = '🎯';
  } else if (combinedPrice < STRATEGY_CONFIG.entryConditions.arbitrageThreshold) {
    tradeType = 'ARBITRAGE';
    emoji = '💎';
  } else if (trades.length === 2) {
    tradeType = 'DUAL_SIDE_DCA';
    emoji = '🔄';
  } else {
    tradeType = 'SINGLE_SIDE_DCA';
    emoji = '📈';
  }

  // Build reasoning
  const directionInfo = priceDeltaPercent !== null 
    ? `${asset} ${priceDeltaPercent >= 0 ? '📈' : '📉'} ${Math.abs(priceDeltaPercent).toFixed(2)}% ($${currentCryptoPrice?.toFixed(2)} vs open $${openPrice?.toFixed(2)})`
    : `${asset} (geen Chainlink data)`;
  
  const positionInfo = `Positie: UP $${(existingPosition.upInvested + (upBudget || 0)).toFixed(0)} / DOWN $${(existingPosition.downInvested + (downBudget || 0)).toFixed(0)}`;
  
  const edgeInfo = `Combined ${(combinedPrice*100).toFixed(1)}¢ = ${arbitrageEdge >= 0 ? '+' : ''}${arbitrageEdge.toFixed(1)}% edge`;
  
  const tradesInfo = trades.map(t => `${t.outcome}@${(t.price*100).toFixed(1)}¢ x${t.shares.toFixed(1)}`).join(' + ');

  return {
    shouldTrade: true,
    trades,
    tradeType,
    reasoning: `${emoji} ${tradeType}: ${tradesInfo}. ${edgeInfo}. ${directionInfo}. ${positionInfo}. ${remainingSeconds}s remaining.`,
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
    console.log('[paper-trade-bot] Chainlink prices:', JSON.stringify(data));
    return {
      btc: data.btc?.price ?? null,
      eth: data.eth?.price ?? null,
    };
  } catch (error) {
    console.error('[paper-trade-bot] Error fetching Chainlink prices:', error);
    return { btc: null, eth: null };
  }
}

async function getExistingPositions(supabase: any, marketSlugs: string[]): Promise<Map<string, ExistingPosition>> {
  const positions = new Map<string, ExistingPosition>();
  
  // Initialize all markets with zero positions
  for (const slug of marketSlugs) {
    positions.set(slug, { upInvested: 0, downInvested: 0, upShares: 0, downShares: 0 });
  }
  
  const { data: existingTrades } = await supabase
    .from('paper_trades')
    .select('market_slug, outcome, shares, total')
    .in('market_slug', marketSlugs);
  
  if (existingTrades) {
    for (const trade of existingTrades) {
      const existing = positions.get(trade.market_slug) || { upInvested: 0, downInvested: 0, upShares: 0, downShares: 0 };
      if (trade.outcome === 'UP') {
        existing.upInvested += Number(trade.total);
        existing.upShares += Number(trade.shares);
      } else {
        existing.downInvested += Number(trade.total);
        existing.downShares += Number(trade.shares);
      }
      positions.set(trade.market_slug, existing);
    }
  }
  
  return positions;
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
    console.log('[paper-trade-bot] Starting Gabagool-style paper trade cycle...');

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

    const [clobPrices, chainlinkPrices, existingPositions] = await Promise.all([
      fetchClobPrices(supabaseUrl, supabaseAnonKey, tokenIds),
      fetchChainlinkPrices(supabaseUrl, supabaseAnonKey),
      getExistingPositions(supabase, markets.map(m => m.slug)),
    ]);

    console.log(`[paper-trade-bot] CLOB prices: ${clobPrices.size}, BTC=$${chainlinkPrices.btc}, ETH=$${chainlinkPrices.eth}`);

    // 3. Make trading decisions for each market
    const now = Date.now();
    const paperTrades: PaperTrade[] = [];
    const decisions: Array<{ slug: string; decision: string }> = [];

    for (const market of markets) {
      const eventEndTime = new Date(market.eventEndTime);
      const remainingSeconds = Math.floor((eventEndTime.getTime() - now) / 1000);

      if (remainingSeconds <= 0) continue;

      const upPrice = clobPrices.get(market.upTokenId) ?? 0.5;
      const downPrice = clobPrices.get(market.downTokenId) ?? 0.5;

      const cryptoPrice = market.asset === 'BTC' ? chainlinkPrices.btc : 
                          market.asset === 'ETH' ? chainlinkPrices.eth : null;
      const openPrice = market.openPrice ?? market.strikePrice;
      
      const existingPosition = existingPositions.get(market.slug) || 
        { upInvested: 0, downInvested: 0, upShares: 0, downShares: 0 };

      const decision = makeGabagoolStyleDecision(
        upPrice, 
        downPrice, 
        cryptoPrice, 
        openPrice, 
        remainingSeconds, 
        market.asset,
        existingPosition
      );

      decisions.push({ slug: market.slug, decision: decision.reasoning });
      console.log(`[paper-trade-bot] ${market.slug}: ${decision.reasoning}`);

      if (!decision.shouldTrade) continue;

      const combinedPrice = upPrice + downPrice;
      const arbitrageEdge = (1 - combinedPrice) * 100;
      const priceDelta = cryptoPrice && openPrice ? cryptoPrice - openPrice : null;
      const priceDeltaPercent = priceDelta && openPrice ? (priceDelta / openPrice) * 100 : null;

      // Create paper trades for each trade in the decision
      for (const trade of decision.trades) {
        paperTrades.push({
          market_slug: market.slug,
          asset: market.asset,
          outcome: trade.outcome,
          shares: trade.shares,
          price: trade.price,
          total: trade.total,
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

    // 4. Insert paper trades
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
      strategy: 'GABAGOOL_STYLE_DCA',
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
        total: t.total.toFixed(2),
      })),
      decisions,
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
