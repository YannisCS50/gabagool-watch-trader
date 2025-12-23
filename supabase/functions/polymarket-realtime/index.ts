import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Gamma API for market metadata
const GAMMA_API_URL = 'https://gamma-api.polymarket.com';

// CLOB API for order book
const CLOB_API_URL = 'https://clob.polymarket.com';

interface Market15Min {
  id: string;
  slug: string;
  question: string;
  asset: 'BTC' | 'ETH';
  eventStartTime: Date;
  eventEndTime: Date;
  priceToBeat: number | null;
  tokens: Array<{
    token_id: string;
    outcome: string;
    price: number;
  }>;
}

interface TradingSignal {
  market: string;
  marketSlug: string;
  asset: 'BTC' | 'ETH';
  priceToBeat: number | null;
  currentPrice: number | null;
  priceDelta: number | null;
  priceDeltaPercent: number | null;
  upPrice: number;
  downPrice: number;
  combinedPrice: number;
  cheaperSide: 'Up' | 'Down';
  cheaperPrice: number;
  spread: number;
  potentialReturn: number;
  arbitrageEdge: number;
  confidence: 'high' | 'medium' | 'low';
  signalType: 'dual_side' | 'single_side' | 'arbitrage' | 'wait';
  action: string;
  eventStartTime: string;
  eventEndTime: string;
  remainingSeconds: number;
  remainingFormatted: string;
  timestamp: string;
}

// Fetch current crypto price from CoinGecko (free, no auth needed)
async function fetchCryptoPrice(asset: 'BTC' | 'ETH'): Promise<number | null> {
  try {
    const coinId = asset === 'BTC' ? 'bitcoin' : 'ethereum';
    const response = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=usd`
    );
    
    if (!response.ok) {
      console.error('CoinGecko API error:', response.status);
      return null;
    }
    
    const data = await response.json();
    return data[coinId]?.usd || null;
  } catch (error) {
    console.error('Error fetching crypto price:', error);
    return null;
  }
}

// Extract strike price from market question for 15-min markets
function extractStrikePrice(question: string): number | null {
  // Patterns like "above $97,000.50" or "below $96,500"
  const priceMatch = question.match(/\$?([\d,]+(?:\.\d+)?)/);
  if (priceMatch) {
    return parseFloat(priceMatch[1].replace(/,/g, ''));
  }
  return null;
}

// Fetch 15-minute crypto markets from Gamma API
async function fetch15MinMarkets(): Promise<Market15Min[]> {
  try {
    // Fetch both BTC and ETH 15-min series
    const [btcResponse, ethResponse] = await Promise.all([
      fetch(`${GAMMA_API_URL}/events?series_slug=btc-up-or-down-15m&active=true&closed=false&limit=5`),
      fetch(`${GAMMA_API_URL}/events?series_slug=eth-up-or-down-15m&active=true&closed=false&limit=5`)
    ]);
    
    const btcEvents = btcResponse.ok ? await btcResponse.json() : [];
    const ethEvents = ethResponse.ok ? await ethResponse.json() : [];
    
    console.log(`Found ${btcEvents.length} BTC and ${ethEvents.length} ETH 15-min events`);
    
    const markets: Market15Min[] = [];
    
    // Process BTC events
    for (const event of btcEvents) {
      if (event.markets && event.markets.length > 0) {
        for (const market of event.markets) {
          if (!market.active || market.closed) continue;
          
          const eventStartTime = new Date(event.startDate || market.startDate);
          const eventEndTime = new Date(market.endDate);
          
          // Only include markets that haven't ended
          if (eventEndTime > new Date()) {
            markets.push({
              id: market.conditionId,
              slug: market.slug,
              question: market.question,
              asset: 'BTC',
              eventStartTime,
              eventEndTime,
              priceToBeat: extractStrikePrice(market.question),
              tokens: market.tokens?.map((t: any) => ({
                token_id: t.token_id,
                outcome: t.outcome,
                price: parseFloat(t.price) || 0
              })) || []
            });
          }
        }
      }
    }
    
    // Process ETH events
    for (const event of ethEvents) {
      if (event.markets && event.markets.length > 0) {
        for (const market of event.markets) {
          if (!market.active || market.closed) continue;
          
          const eventStartTime = new Date(event.startDate || market.startDate);
          const eventEndTime = new Date(market.endDate);
          
          if (eventEndTime > new Date()) {
            markets.push({
              id: market.conditionId,
              slug: market.slug,
              question: market.question,
              asset: 'ETH',
              eventStartTime,
              eventEndTime,
              priceToBeat: extractStrikePrice(market.question),
              tokens: market.tokens?.map((t: any) => ({
                token_id: t.token_id,
                outcome: t.outcome,
                price: parseFloat(t.price) || 0
              })) || []
            });
          }
        }
      }
    }
    
    // Sort by end time (soonest first)
    markets.sort((a, b) => a.eventEndTime.getTime() - b.eventEndTime.getTime());
    
    return markets;
  } catch (error) {
    console.error('Error fetching 15-min markets:', error);
    return [];
  }
}

// Calculate Gabagool-style trading signal
function calculateGabagoolSignal(
  market: Market15Min,
  currentCryptoPrice: number | null
): TradingSignal {
  const now = new Date();
  const remainingMs = market.eventEndTime.getTime() - now.getTime();
  const remainingSeconds = Math.max(0, Math.floor(remainingMs / 1000));
  const minutes = Math.floor(remainingSeconds / 60);
  const seconds = remainingSeconds % 60;
  const remainingFormatted = `${minutes}:${seconds.toString().padStart(2, '0')}`;
  
  // Find Up and Down tokens
  const upToken = market.tokens.find(t => 
    t.outcome.toLowerCase().includes('yes') || 
    t.outcome.toLowerCase().includes('up') ||
    t.outcome.toLowerCase().includes('above')
  );
  const downToken = market.tokens.find(t => 
    t.outcome.toLowerCase().includes('no') || 
    t.outcome.toLowerCase().includes('down') ||
    t.outcome.toLowerCase().includes('below')
  );
  
  const upPrice = upToken?.price || 0.5;
  const downPrice = downToken?.price || 0.5;
  const combinedPrice = upPrice + downPrice;
  const spread = Math.abs(upPrice - downPrice);
  
  const cheaperSide = upPrice < downPrice ? 'Up' : 'Down';
  const cheaperPrice = Math.min(upPrice, downPrice);
  
  // Calculate price delta
  let priceDelta: number | null = null;
  let priceDeltaPercent: number | null = null;
  
  if (market.priceToBeat && currentCryptoPrice) {
    priceDelta = currentCryptoPrice - market.priceToBeat;
    priceDeltaPercent = (priceDelta / market.priceToBeat) * 100;
  }
  
  // Arbitrage edge: how much under 1.0 is the combined price
  const arbitrageEdge = (1 - combinedPrice) * 100;
  
  // Potential return if buying cheaper side and it wins
  const potentialReturn = cheaperPrice > 0 ? ((1 / cheaperPrice) - 1) * 100 : 0;
  
  // GABAGOOL SIGNAL LOGIC
  let confidence: 'high' | 'medium' | 'low' = 'low';
  let signalType: 'dual_side' | 'single_side' | 'arbitrage' | 'wait' = 'wait';
  let action = 'No signal - waiting';
  
  const absDeltaPercent = priceDeltaPercent !== null ? Math.abs(priceDeltaPercent) : 100;
  
  // HIGH CONFIDENCE: Very small delta (<0.03%) + arbitrage opportunity
  if (absDeltaPercent < 0.03 && combinedPrice < 1.0) {
    confidence = 'high';
    signalType = 'dual_side';
    action = `BUY BOTH @ ${(combinedPrice * 100).toFixed(1)}¢ combined - Dual-side hedge`;
  }
  // HIGH CONFIDENCE: Pure arbitrage (combined < 0.98)
  else if (combinedPrice < 0.98) {
    confidence = 'high';
    signalType = 'arbitrage';
    action = `ARBITRAGE: Buy both @ ${(combinedPrice * 100).toFixed(1)}¢ = ${arbitrageEdge.toFixed(1)}% edge`;
  }
  // MEDIUM: Small delta (<0.1%), market still uncertain
  else if (absDeltaPercent < 0.1) {
    confidence = 'medium';
    signalType = 'dual_side';
    action = `Buy ${cheaperSide} @ ${(cheaperPrice * 100).toFixed(1)}¢ - Near strike uncertainty`;
  }
  // MEDIUM: Combined < 1.0 but larger delta
  else if (combinedPrice < 1.0 && absDeltaPercent < 0.5) {
    confidence = 'medium';
    signalType = 'single_side';
    const expectedSide = priceDelta !== null && priceDelta > 0 ? 'Up' : 'Down';
    const sidePrice = expectedSide === 'Up' ? upPrice : downPrice;
    action = `Buy ${expectedSide} @ ${(sidePrice * 100).toFixed(1)}¢ - Trend + edge`;
  }
  // LOW: Clear directional signal
  else if (absDeltaPercent < 1.0) {
    confidence = 'low';
    signalType = 'single_side';
    const expectedSide = priceDelta !== null && priceDelta > 0 ? 'Up' : 'Down';
    const sidePrice = expectedSide === 'Up' ? upPrice : downPrice;
    action = `Consider ${expectedSide} @ ${(sidePrice * 100).toFixed(1)}¢ - Directional`;
  }
  
  return {
    market: market.question,
    marketSlug: market.slug,
    asset: market.asset,
    priceToBeat: market.priceToBeat,
    currentPrice: currentCryptoPrice,
    priceDelta,
    priceDeltaPercent,
    upPrice,
    downPrice,
    combinedPrice,
    cheaperSide,
    cheaperPrice,
    spread,
    potentialReturn,
    arbitrageEdge,
    confidence,
    signalType,
    action,
    eventStartTime: market.eventStartTime.toISOString(),
    eventEndTime: market.eventEndTime.toISOString(),
    remainingSeconds,
    remainingFormatted,
    timestamp: new Date().toISOString()
  };
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    console.log('Fetching real-time 15-min Polymarket data...');
    
    // Fetch current crypto prices in parallel
    const [btcPrice, ethPrice] = await Promise.all([
      fetchCryptoPrice('BTC'),
      fetchCryptoPrice('ETH')
    ]);
    
    console.log('Crypto prices:', { btcPrice, ethPrice });
    
    // Fetch active 15-minute markets
    const markets = await fetch15MinMarkets();
    console.log(`Found ${markets.length} active 15-min markets`);
    
    // Calculate signals for each market
    const signals: TradingSignal[] = [];
    
    for (const market of markets) {
      const cryptoPrice = market.asset === 'BTC' ? btcPrice : ethPrice;
      const signal = calculateGabagoolSignal(market, cryptoPrice);
      signals.push(signal);
    }
    
    // Sort by confidence (high first), then by remaining time (soonest first)
    signals.sort((a, b) => {
      const confOrder = { high: 0, medium: 1, low: 2 };
      if (confOrder[a.confidence] !== confOrder[b.confidence]) {
        return confOrder[a.confidence] - confOrder[b.confidence];
      }
      return a.remainingSeconds - b.remainingSeconds;
    });
    
    // Get statistics
    const highConfidence = signals.filter(s => s.confidence === 'high');
    const arbitrageOpportunities = signals.filter(s => s.signalType === 'arbitrage');
    const dualSideSignals = signals.filter(s => s.signalType === 'dual_side');
    
    // Separate current (ending soon) vs upcoming markets
    const currentMarkets = signals.filter(s => s.remainingSeconds < 900); // < 15 min
    const upcomingMarkets = signals.filter(s => s.remainingSeconds >= 900);
    
    return new Response(JSON.stringify({
      success: true,
      timestamp: new Date().toISOString(),
      cryptoPrices: {
        BTC: btcPrice,
        ETH: ethPrice
      },
      marketsAnalyzed: markets.length,
      currentMarkets,
      upcomingMarkets,
      signals,
      summary: {
        highConfidenceCount: highConfidence.length,
        arbitrageOpportunityCount: arbitrageOpportunities.length,
        dualSideSignalCount: dualSideSignals.length,
        avgCombinedPrice: signals.length > 0 
          ? signals.reduce((sum, s) => sum + s.combinedPrice, 0) / signals.length 
          : 0,
        avgArbitrageEdge: signals.length > 0
          ? signals.reduce((sum, s) => sum + s.arbitrageEdge, 0) / signals.length
          : 0
      }
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
    
  } catch (error) {
    console.error('Error in polymarket-realtime:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(JSON.stringify({ 
      success: false, 
      error: errorMessage 
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
