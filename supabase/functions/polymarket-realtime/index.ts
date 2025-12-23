import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Gamma API for market metadata
const GAMMA_API_URL = 'https://gamma-api.polymarket.com';

// CLOB API for order book
const CLOB_API_URL = 'https://clob.polymarket.com';

interface MarketData {
  conditionId: string;
  slug: string;
  question: string;
  tokens: Array<{
    token_id: string;
    outcome: string;
    price: number;
  }>;
  priceToBeat: number | null;
  currentCryptoPrice: number | null;
  endDate: string;
}

interface TradingSignal {
  market: string;
  marketSlug: string;
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
  signalType: string;
  timestamp: string;
}

// Extract strike price from market question
function extractPriceToBeat(question: string): number | null {
  // Patterns like "above $97,000" or "below $96,500"
  const priceMatch = question.match(/\$?([\d,]+(?:\.\d+)?)/);
  if (priceMatch) {
    return parseFloat(priceMatch[1].replace(/,/g, ''));
  }
  return null;
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

// Fetch active crypto markets from Gamma API
async function fetchActiveCryptoMarkets(): Promise<MarketData[]> {
  try {
    // Get active markets with crypto in the question
    const response = await fetch(
      `${GAMMA_API_URL}/markets?active=true&limit=50`
    );
    
    if (!response.ok) {
      console.error('Gamma API error:', response.status);
      return [];
    }
    
    const markets = await response.json();
    
    // Filter for BTC/ETH price prediction markets
    const cryptoMarkets = markets.filter((m: any) => {
      const q = m.question?.toLowerCase() || '';
      return (q.includes('bitcoin') || q.includes('btc') || 
              q.includes('ethereum') || q.includes('eth')) &&
             (q.includes('above') || q.includes('below') || q.includes('price'));
    });
    
    return cryptoMarkets.map((m: any) => ({
      conditionId: m.conditionId,
      slug: m.slug,
      question: m.question,
      tokens: m.tokens?.map((t: any) => ({
        token_id: t.token_id,
        outcome: t.outcome,
        price: parseFloat(t.price) || 0
      })) || [],
      priceToBeat: extractPriceToBeat(m.question),
      currentCryptoPrice: null,
      endDate: m.endDate
    }));
  } catch (error) {
    console.error('Error fetching markets:', error);
    return [];
  }
}

// Fetch order book prices from CLOB
async function fetchOrderBookPrices(tokenId: string): Promise<{ bestBid: number; bestAsk: number } | null> {
  try {
    const response = await fetch(`${CLOB_API_URL}/book?token_id=${tokenId}`);
    
    if (!response.ok) {
      return null;
    }
    
    const book = await response.json();
    
    const bestBid = book.bids?.[0]?.price ? parseFloat(book.bids[0].price) : 0;
    const bestAsk = book.asks?.[0]?.price ? parseFloat(book.asks[0].price) : 1;
    
    return { bestBid, bestAsk };
  } catch (error) {
    return null;
  }
}

// Calculate trading signal based on market data
function calculateSignal(market: MarketData, cryptoPrice: number | null): TradingSignal {
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
  
  // Calculate price delta if we have both prices
  let priceDelta: number | null = null;
  let priceDeltaPercent: number | null = null;
  
  if (market.priceToBeat && cryptoPrice) {
    priceDelta = cryptoPrice - market.priceToBeat;
    priceDeltaPercent = (priceDelta / market.priceToBeat) * 100;
  }
  
  // Arbitrage edge: how much under 1.0 is the combined price
  const arbitrageEdge = (1 - combinedPrice) * 100;
  
  // Potential return if buying cheaper side and it wins
  const potentialReturn = cheaperPrice > 0 ? ((1 / cheaperPrice) - 1) * 100 : 0;
  
  // Determine confidence based on price delta
  let confidence: 'high' | 'medium' | 'low' = 'low';
  let signalType = 'none';
  
  if (priceDeltaPercent !== null) {
    const absDelta = Math.abs(priceDeltaPercent);
    
    if (absDelta < 0.05) {
      confidence = 'high';
      signalType = 'uncertainty_high';
    } else if (absDelta < 0.2) {
      confidence = 'medium';
      signalType = 'close_to_strike';
    } else {
      confidence = 'low';
      signalType = 'directional';
    }
  }
  
  // Also consider combined price for arbitrage
  if (combinedPrice < 0.98) {
    signalType = 'arbitrage_opportunity';
    if (confidence === 'low') confidence = 'medium';
  }
  
  return {
    market: market.question,
    marketSlug: market.slug,
    priceToBeat: market.priceToBeat,
    currentPrice: cryptoPrice,
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
    timestamp: new Date().toISOString()
  };
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    console.log('Fetching real-time Polymarket data...');
    
    // Fetch current crypto prices in parallel
    const [btcPrice, ethPrice] = await Promise.all([
      fetchCryptoPrice('BTC'),
      fetchCryptoPrice('ETH')
    ]);
    
    console.log('Crypto prices:', { btcPrice, ethPrice });
    
    // Fetch active crypto markets
    const markets = await fetchActiveCryptoMarkets();
    console.log(`Found ${markets.length} active crypto markets`);
    
    // Calculate signals for each market
    const signals: TradingSignal[] = [];
    
    for (const market of markets) {
      // Determine which crypto price to use
      const q = market.question.toLowerCase();
      const cryptoPrice = (q.includes('bitcoin') || q.includes('btc')) ? btcPrice : ethPrice;
      
      const signal = calculateSignal(market, cryptoPrice);
      signals.push(signal);
    }
    
    // Sort by confidence and arbitrage edge
    signals.sort((a, b) => {
      const confOrder = { high: 0, medium: 1, low: 2 };
      if (confOrder[a.confidence] !== confOrder[b.confidence]) {
        return confOrder[a.confidence] - confOrder[b.confidence];
      }
      return b.arbitrageEdge - a.arbitrageEdge;
    });
    
    // Get high confidence opportunities
    const highConfidence = signals.filter(s => s.confidence === 'high');
    const arbitrageOpportunities = signals.filter(s => s.arbitrageEdge > 2);
    
    return new Response(JSON.stringify({
      success: true,
      timestamp: new Date().toISOString(),
      cryptoPrices: {
        BTC: btcPrice,
        ETH: ethPrice
      },
      marketsAnalyzed: markets.length,
      signals,
      summary: {
        highConfidenceCount: highConfidence.length,
        arbitrageOpportunityCount: arbitrageOpportunities.length,
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
