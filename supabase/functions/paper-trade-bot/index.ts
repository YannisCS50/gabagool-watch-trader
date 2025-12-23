import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * OPENING + HEDGE STRATEGY
 * 
 * 1. OPENING: Bij market open, koop direct 100 shares van de goedkoopste kant
 * 2. HEDGE: Zodra mogelijk, hedge met 100 shares van de andere kant
 *    - Target: combined price < 100¢ voor gegarandeerde winst
 *    - Bijv: 48¢ UP + 49¢ DOWN = 97¢ = 3% winst
 * 3. ACCUMULATE: Binnen de risk-free marge, blijf positie vergroten
 *    - Zolang combined < 100¢, blijf kopen
 */

const STRATEGY_CONFIG = {
  // Initiële opening trade
  opening: {
    shares: 100,              // 100 shares per opening
    maxPrice: 0.55,           // Alleen openen als prijs ≤ 55¢
  },
  
  // Hedge settings
  hedge: {
    shares: 100,              // 100 shares voor hedge
    maxCombined: 1.00,        // Hedge zolang combined ≤ 100¢ (break-even)
    targetCombined: 0.97,     // Ideaal: combined ≤ 97¢ (3% winst)
  },
  
  // Accumulation settings
  accumulate: {
    minShares: 20,
    maxShares: 50,
    maxCombined: 0.99,        // Alleen accumuleren als combined < 99¢
    maxPositionPerSide: 500,  // Max 500 shares per kant
  },
  
  // General settings
  minSecondsRemaining: 60,    // Stop 60s voor expiry
  minPrice: 0.02,             // Niet kopen onder 2¢
  maxPrice: 0.98,             // Niet kopen boven 98¢
};

type TradeType = 'OPENING' | 'HEDGE' | 'ACCUMULATE';

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

interface Position {
  upShares: number;
  downShares: number;
  upAvgPrice: number;
  downAvgPrice: number;
  upCost: number;
  downCost: number;
  tradeCount: number;
}

interface Trade {
  outcome: 'UP' | 'DOWN';
  shares: number;
  price: number;
  total: number;
  tradeType: TradeType;
  reasoning: string;
}

interface TradeDecision {
  shouldTrade: boolean;
  trades: Trade[];
  summaryReasoning: string;
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
  best_bid: number | null;
  best_ask: number | null;
}

function makeDecision(
  upPrice: number,
  downPrice: number,
  upBid: number | null,
  upAsk: number | null,
  downBid: number | null,
  downAsk: number | null,
  remainingSeconds: number,
  asset: string,
  position: Position
): TradeDecision {
  const combinedPrice = upPrice + downPrice;
  const arbitrageEdge = (1 - combinedPrice) * 100;
  
  const trades: Trade[] = [];
  
  // === REJECTION CHECKS ===
  
  // Te dicht bij expiry
  if (remainingSeconds < STRATEGY_CONFIG.minSecondsRemaining) {
    return {
      shouldTrade: false,
      trades: [],
      summaryReasoning: `⏱️ TOO_LATE: ${remainingSeconds}s < ${STRATEGY_CONFIG.minSecondsRemaining}s minimum`,
    };
  }
  
  const hasUpPosition = position.upShares > 0;
  const hasDownPosition = position.downShares > 0;
  const isHedged = hasUpPosition && hasDownPosition;
  const totalCost = position.upCost + position.downCost;
  const lockedProfit = isHedged ? (position.upShares + position.downShares) - totalCost : 0;
  
  // === PHASE 1: OPENING ===
  // Als we nog geen positie hebben, open met de goedkoopste kant
  if (!hasUpPosition && !hasDownPosition) {
    // Kies de goedkoopste kant
    const upValid = upPrice >= STRATEGY_CONFIG.minPrice && upPrice <= STRATEGY_CONFIG.opening.maxPrice;
    const downValid = downPrice >= STRATEGY_CONFIG.minPrice && downPrice <= STRATEGY_CONFIG.opening.maxPrice;
    
    if (!upValid && !downValid) {
      return {
        shouldTrade: false,
        trades: [],
        summaryReasoning: `⏳ WAITING: Geen kant goedkoop genoeg. UP=${(upPrice*100).toFixed(0)}¢ DOWN=${(downPrice*100).toFixed(0)}¢ (max ${STRATEGY_CONFIG.opening.maxPrice*100}¢)`,
      };
    }
    
    // Kies de goedkoopste kant (of de enige valide kant)
    let openOutcome: 'UP' | 'DOWN';
    let openPrice: number;
    
    if (upValid && downValid) {
      // Beide valid - kies goedkoopste
      if (upPrice <= downPrice) {
        openOutcome = 'UP';
        openPrice = upPrice;
      } else {
        openOutcome = 'DOWN';
        openPrice = downPrice;
      }
    } else if (upValid) {
      openOutcome = 'UP';
      openPrice = upPrice;
    } else {
      openOutcome = 'DOWN';
      openPrice = downPrice;
    }
    
    const openShares = STRATEGY_CONFIG.opening.shares;
    const openTotal = openShares * openPrice;
    
    trades.push({
      outcome: openOutcome,
      shares: openShares,
      price: openPrice,
      total: openTotal,
      tradeType: 'OPENING',
      reasoning: `🚀 OPENING: Start ${openOutcome} @ ${(openPrice*100).toFixed(1)}¢. ${openShares} shares = $${openTotal.toFixed(2)}`,
    });
    
    return {
      shouldTrade: true,
      trades,
      summaryReasoning: `🚀 OPENING: ${openOutcome} @ ${(openPrice*100).toFixed(0)}¢ (${openShares} shares). Wacht op hedge...`,
    };
  }
  
  // === PHASE 2: HEDGE ===
  // We hebben één kant, nu de andere kant pakken voor gegarandeerde winst
  if (!isHedged) {
    const needsUp = !hasUpPosition;
    const hedgePrice = needsUp ? upPrice : downPrice;
    const hedgeOutcome: 'UP' | 'DOWN' = needsUp ? 'UP' : 'DOWN';
    const existingPrice = needsUp ? position.downAvgPrice : position.upAvgPrice;
    const existingShares = needsUp ? position.downShares : position.upShares;
    
    // Check of hedge combined price acceptabel is
    const projectedCombined = existingPrice + hedgePrice;
    
    if (projectedCombined > STRATEGY_CONFIG.hedge.maxCombined) {
      return {
        shouldTrade: false,
        trades: [],
        summaryReasoning: `⏳ HEDGE_WAIT: ${hedgeOutcome} @ ${(hedgePrice*100).toFixed(0)}¢ te duur. Combined zou ${(projectedCombined*100).toFixed(0)}¢ zijn (max ${STRATEGY_CONFIG.hedge.maxCombined*100}¢)`,
      };
    }
    
    // Hedge met dezelfde hoeveelheid shares als opening
    const hedgeShares = Math.min(STRATEGY_CONFIG.hedge.shares, existingShares * 1.2); // Max 20% meer dan existing
    const hedgeTotal = hedgeShares * hedgePrice;
    const projectedProfit = ((1 - projectedCombined) * 100).toFixed(1);
    
    trades.push({
      outcome: hedgeOutcome,
      shares: hedgeShares,
      price: hedgePrice,
      total: hedgeTotal,
      tradeType: 'HEDGE',
      reasoning: `🛡️ HEDGE: ${hedgeOutcome} @ ${(hedgePrice*100).toFixed(1)}¢. Combined=${(projectedCombined*100).toFixed(0)}¢ = ${projectedProfit}% locked profit`,
    });
    
    return {
      shouldTrade: true,
      trades,
      summaryReasoning: `🛡️ HEDGE: ${hedgeOutcome} @ ${(hedgePrice*100).toFixed(0)}¢. Σ${(projectedCombined*100).toFixed(0)}¢ = ${projectedProfit}% winst gelockt!`,
    };
  }
  
  // === PHASE 3: ACCUMULATE ===
  // We zijn gehedged - nu positie vergroten binnen de risk-free marge
  
  // Check position limits
  if (position.upShares >= STRATEGY_CONFIG.accumulate.maxPositionPerSide &&
      position.downShares >= STRATEGY_CONFIG.accumulate.maxPositionPerSide) {
    return {
      shouldTrade: false,
      trades: [],
      summaryReasoning: `⛔ LIMIT: Max positie bereikt (${position.upShares.toFixed(0)}↑ / ${position.downShares.toFixed(0)}↓)`,
    };
  }
  
  // Alleen accumuleren als combined nog steeds < 99¢
  if (combinedPrice >= STRATEGY_CONFIG.accumulate.maxCombined) {
    return {
      shouldTrade: false,
      trades: [],
      summaryReasoning: `⏸️ HOLD: Combined ${(combinedPrice*100).toFixed(0)}¢ ≥ ${STRATEGY_CONFIG.accumulate.maxCombined*100}¢. Locked profit: ${lockedProfit.toFixed(0)} shares`,
    };
  }
  
  // Bepaal hoeveel te kopen
  const edgeMultiplier = Math.max(0.5, (1 - combinedPrice) * 20); // Meer edge = meer kopen
  const baseShares = STRATEGY_CONFIG.accumulate.minShares + 
    (STRATEGY_CONFIG.accumulate.maxShares - STRATEGY_CONFIG.accumulate.minShares) * Math.min(1, edgeMultiplier);
  
  // Koop beide kanten om gebalanceerd te blijven
  const upValid = upPrice >= STRATEGY_CONFIG.minPrice && upPrice <= STRATEGY_CONFIG.maxPrice &&
                  position.upShares < STRATEGY_CONFIG.accumulate.maxPositionPerSide;
  const downValid = downPrice >= STRATEGY_CONFIG.minPrice && downPrice <= STRATEGY_CONFIG.maxPrice &&
                    position.downShares < STRATEGY_CONFIG.accumulate.maxPositionPerSide;
  
  if (upValid) {
    const upShares = Math.min(
      baseShares,
      STRATEGY_CONFIG.accumulate.maxPositionPerSide - position.upShares
    );
    if (upShares >= STRATEGY_CONFIG.accumulate.minShares) {
      trades.push({
        outcome: 'UP',
        shares: upShares,
        price: upPrice,
        total: upShares * upPrice,
        tradeType: 'ACCUMULATE',
        reasoning: `📈 ACC UP: ${upShares.toFixed(0)} @ ${(upPrice*100).toFixed(1)}¢`,
      });
    }
  }
  
  if (downValid) {
    const downShares = Math.min(
      baseShares,
      STRATEGY_CONFIG.accumulate.maxPositionPerSide - position.downShares
    );
    if (downShares >= STRATEGY_CONFIG.accumulate.minShares) {
      trades.push({
        outcome: 'DOWN',
        shares: downShares,
        price: downPrice,
        total: downShares * downPrice,
        tradeType: 'ACCUMULATE',
        reasoning: `📉 ACC DOWN: ${downShares.toFixed(0)} @ ${(downPrice*100).toFixed(1)}¢`,
      });
    }
  }
  
  if (trades.length === 0) {
    return {
      shouldTrade: false,
      trades: [],
      summaryReasoning: `⏸️ HOLD: Geen valide accumulate trades. Pos: ${position.upShares.toFixed(0)}↑/${position.downShares.toFixed(0)}↓`,
    };
  }
  
  const totalNewShares = trades.reduce((s, t) => s + t.shares, 0);
  const totalNewCost = trades.reduce((s, t) => s + t.total, 0);
  
  return {
    shouldTrade: true,
    trades,
    summaryReasoning: `📊 ACCUMULATE: +${totalNewShares.toFixed(0)} shares ($${totalNewCost.toFixed(2)}). Σ${(combinedPrice*100).toFixed(0)}¢ = ${arbitrageEdge.toFixed(1)}% edge. Total: ${(position.upShares + position.downShares + totalNewShares).toFixed(0)} shares`,
  };
}

async function fetchClobPrices(
  supabaseUrl: string, 
  anonKey: string, 
  tokenIds: string[]
): Promise<Map<string, { price: number; bid: number | null; ask: number | null }>> {
  const prices = new Map<string, { price: number; bid: number | null; ask: number | null }>();
  
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
      console.error('[PaperBot] Failed to fetch CLOB prices:', response.status);
      return prices;
    }
    
    const data = await response.json();
    if (data.success && data.prices) {
      for (const [tokenId, priceData] of Object.entries(data.prices)) {
        const p = priceData as { mid?: number; bestAsk?: number; bestBid?: number; price?: number };
        // Prefer mid, then price, then bestAsk
        const price = p.mid ?? p.price ?? p.bestAsk ?? null;
        if (price !== null) {
          prices.set(tokenId, {
            price,
            bid: p.bestBid ?? null,
            ask: p.bestAsk ?? null,
          });
        }
      }
    }
    console.log(`[PaperBot] CLOB prices: ${prices.size} tokens fetched`);
  } catch (error) {
    console.error('[PaperBot] Error fetching CLOB prices:', error);
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
      return { btc: null, eth: null };
    }
    
    const data = await response.json();
    return {
      btc: data.btc?.price ?? null,
      eth: data.eth?.price ?? null,
    };
  } catch {
    return { btc: null, eth: null };
  }
}

async function getExistingPositions(supabase: any, marketSlugs: string[]): Promise<Map<string, Position>> {
  const positions = new Map<string, Position>();
  
  // Initialize all markets with zero positions
  for (const slug of marketSlugs) {
    positions.set(slug, { 
      upShares: 0, downShares: 0, 
      upAvgPrice: 0, downAvgPrice: 0,
      upCost: 0, downCost: 0,
      tradeCount: 0 
    });
  }
  
  const { data: existingTrades } = await supabase
    .from('paper_trades')
    .select('market_slug, outcome, shares, price, total')
    .in('market_slug', marketSlugs);
  
  if (existingTrades) {
    for (const trade of existingTrades) {
      const existing = positions.get(trade.market_slug)!;
      existing.tradeCount++;
      
      const shares = Number(trade.shares);
      const price = Number(trade.price);
      const total = Number(trade.total);
      
      if (trade.outcome === 'UP') {
        // Calculate weighted average price
        const newTotalShares = existing.upShares + shares;
        if (newTotalShares > 0) {
          existing.upAvgPrice = (existing.upCost + total) / newTotalShares;
        }
        existing.upShares = newTotalShares;
        existing.upCost += total;
      } else {
        const newTotalShares = existing.downShares + shares;
        if (newTotalShares > 0) {
          existing.downAvgPrice = (existing.downCost + total) / newTotalShares;
        }
        existing.downShares = newTotalShares;
        existing.downCost += total;
      }
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
    console.log('[PaperBot] 🎯 Opening + Hedge Strategy cycle...');

    // Check if bot is enabled
    const { data: settings } = await supabase
      .from('paper_bot_settings')
      .select('is_enabled')
      .limit(1)
      .maybeSingle();

    if (!settings?.is_enabled) {
      console.log('[PaperBot] ⏸️ Bot is disabled');
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
    
    console.log(`[PaperBot] 📊 Found ${markets.length} active markets`);

    if (markets.length === 0) {
      return new Response(JSON.stringify({ 
        success: true, 
        message: 'No active markets found',
        tradesPlaced: 0,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // 2. Collect all token IDs and fetch prices in parallel
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

    console.log(`[PaperBot] 💹 Prices: ${clobPrices.size} tokens`);

    // 3. Make trading decisions for each market
    const now = Date.now();
    const paperTrades: PaperTrade[] = [];
    const decisions: Array<{ slug: string; decision: string }> = [];

    for (const market of markets) {
      const eventEndTime = new Date(market.eventEndTime);
      const remainingSeconds = Math.floor((eventEndTime.getTime() - now) / 1000);

      if (remainingSeconds <= 0) continue;

      const upData = clobPrices.get(market.upTokenId);
      const downData = clobPrices.get(market.downTokenId);
      
      const upPrice = upData?.price ?? 0.5;
      const downPrice = downData?.price ?? 0.5;
      
      const cryptoPrice = market.asset === 'BTC' ? chainlinkPrices.btc : 
                          market.asset === 'ETH' ? chainlinkPrices.eth : null;
      const openPrice = market.openPrice ?? market.strikePrice;
      
      const position = existingPositions.get(market.slug)!;

      const decision = makeDecision(
        upPrice, 
        downPrice,
        upData?.bid ?? null,
        upData?.ask ?? null,
        downData?.bid ?? null,
        downData?.ask ?? null,
        remainingSeconds, 
        market.asset,
        position
      );

      decisions.push({ slug: market.slug, decision: decision.summaryReasoning });
      
      console.log(`[PaperBot] ${market.slug}: ${decision.summaryReasoning}`);

      if (!decision.shouldTrade) continue;

      const combinedPrice = upPrice + downPrice;
      const arbitrageEdge = (1 - combinedPrice) * 100;
      const priceDelta = cryptoPrice && openPrice ? cryptoPrice - openPrice : null;
      const priceDeltaPercent = priceDelta && openPrice ? (priceDelta / openPrice) * 100 : null;

      // Create paper trades for each trade in the decision
      for (const trade of decision.trades) {
        const tradeData = trade.outcome === 'UP' ? upData : downData;
        
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
          trade_type: trade.tradeType,
          reasoning: trade.reasoning,
          event_start_time: market.eventStartTime,
          event_end_time: market.eventEndTime,
          best_bid: tradeData?.bid ?? null,
          best_ask: tradeData?.ask ?? null,
        });
      }
    }

    // 4. Insert paper trades
    if (paperTrades.length > 0) {
      const { error } = await supabase.from('paper_trades').insert(paperTrades);
      if (error) {
        console.error('[PaperBot] ❌ Error inserting trades:', error);
        throw error;
      }
      console.log(`[PaperBot] ✅ Placed ${paperTrades.length} trades`);
    } else {
      console.log('[PaperBot] 💤 No trades this cycle');
    }

    return new Response(JSON.stringify({
      success: true,
      timestamp: new Date().toISOString(),
      strategy: 'OPENING_HEDGE',
      marketsAnalyzed: markets.length,
      tradesPlaced: paperTrades.length,
      trades: paperTrades.map(t => ({
        slug: t.market_slug,
        outcome: t.outcome,
        type: t.trade_type,
        shares: t.shares.toFixed(0),
        price: (t.price * 100).toFixed(1) + '¢',
        total: '$' + t.total.toFixed(2),
        reasoning: t.reasoning,
      })),
      decisions,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('[PaperBot] ❌ Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
