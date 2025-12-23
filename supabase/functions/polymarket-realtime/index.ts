import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface TradingSignal {
  market: string;
  marketSlug: string;
  asset: 'BTC' | 'ETH';
  priceToBeat: number | null;
  priceToBeatSource: string | null;
  priceToBeatQuality: string | null;
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

interface MarketFromDB {
  market: string;
  market_slug: string;
  upPrice: number;
  downPrice: number;
  eventTimestamp: number;
}

interface StrikePriceData {
  open_price: number | null;
  strike_price: number | null;
  source: string | null;
  quality: string | null;
}

// Fetch current crypto price from CoinGecko
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

// Parse timestamp from market slug like btc-updown-15m-1766485800
function parseTimestampFromSlug(slug: string): number | null {
  const match = slug.match(/(\d{10})$/);
  if (match) {
    return parseInt(match[1], 10);
  }
  return null;
}

// In-memory cache for strike prices to avoid repeated API calls
const strikePriceCache = new Map<string, { price: number; source: string; quality: string }>();

// Fetch strike price from our cached strike_prices table (Chainlink data from RTDS)
async function fetchStrikePrice(
  supabase: any,
  marketSlug: string,
  asset: 'BTC' | 'ETH',
  eventTimestamp: number,
  currentPrice: number | null
): Promise<{ price: number | null; source: string; quality: string }> {
  try {
    // Check in-memory cache first
    if (strikePriceCache.has(marketSlug)) {
      return strikePriceCache.get(marketSlug)!;
    }
    
    // Try to get from our database cache (new schema with open_price)
    const { data, error } = await supabase
      .from('strike_prices')
      .select('open_price, strike_price, source, quality')
      .eq('market_slug', marketSlug)
      .maybeSingle();
    
    if (data && !error) {
      // Prefer open_price (new schema), fall back to strike_price (old schema)
      const price = data.open_price ?? data.strike_price;
      const source = data.source || 'chainlink_delayed';
      const quality = data.quality || 'unknown';
      
      if (price) {
        console.log(`Strike price for ${marketSlug}: $${price} (source: ${source}, quality: ${quality})`);
        const result = { price, source, quality };
        strikePriceCache.set(marketSlug, result);
        return result;
      }
    }
    
    // No cached price - market may have just started
    // For very new markets (< 2 min), trigger price collector and use current price as temp estimate
    const marketAgeMs = Date.now() - (eventTimestamp * 1000);
    if (marketAgeMs < 2 * 60 * 1000 && currentPrice) {
      console.log(`Market ${marketSlug} just started, using current price as estimate: $${currentPrice}`);
      return { price: currentPrice, source: 'current_estimate', quality: 'pending' };
    }
    
    console.log(`No strike price available for ${marketSlug}`);
    return { price: null, source: 'none', quality: 'missing' };
  } catch (error) {
    console.error('Error fetching strike price:', error);
    return { price: null, source: 'error', quality: 'missing' };
  }
}

// Get active 15-min markets from trades database
async function get15MinMarketsFromDB(): Promise<MarketFromDB[]> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, supabaseKey);
  
  // Get recent trades for 15-min markets (last 2 hours)
  const { data: trades, error } = await supabase
    .from('trades')
    .select('market, market_slug, outcome, price, timestamp')
    .or('market_slug.ilike.%15m%,market.ilike.%15%')
    .gte('timestamp', new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString())
    .order('timestamp', { ascending: false });
  
  if (error) {
    console.error('DB error:', error);
    return [];
  }
  
  if (!trades || trades.length === 0) {
    console.log('No recent 15-min trades found in DB');
    return [];
  }
  
  console.log(`Found ${trades.length} recent 15-min trades in DB`);
  
  // Group by market_slug and get latest Up/Down prices
  const marketMap = new Map<string, MarketFromDB>();
  
  for (const trade of trades) {
    const slug = trade.market_slug || '';
    if (!slug.includes('15m')) continue;
    
    const timestamp = parseTimestampFromSlug(slug);
    if (!timestamp) continue;
    
    if (!marketMap.has(slug)) {
      marketMap.set(slug, {
        market: trade.market,
        market_slug: slug,
        upPrice: 0.5,
        downPrice: 0.5,
        eventTimestamp: timestamp,
      });
    }
    
    const m = marketMap.get(slug)!;
    const outcome = (trade.outcome || '').toLowerCase();
    
    if (outcome === 'up' || outcome === 'yes') {
      m.upPrice = trade.price;
    } else if (outcome === 'down' || outcome === 'no') {
      m.downPrice = trade.price;
    }
  }
  
  return Array.from(marketMap.values());
}

// Calculate Gabagool-style trading signal
function calculateGabagoolSignal(
  market: MarketFromDB,
  currentCryptoPrice: number | null,
  asset: 'BTC' | 'ETH',
  strikeData: { price: number | null; source: string; quality: string }
): TradingSignal {
  const now = Date.now();
  const eventStart = market.eventTimestamp * 1000;
  const eventEnd = eventStart + 15 * 60 * 1000; // 15 minutes after start
  
  const remainingMs = eventEnd - now;
  const remainingSeconds = Math.max(0, Math.floor(remainingMs / 1000));
  const minutes = Math.floor(remainingSeconds / 60);
  const seconds = remainingSeconds % 60;
  const remainingFormatted = `${minutes}:${seconds.toString().padStart(2, '0')}`;
  
  const upPrice = market.upPrice;
  const downPrice = market.downPrice;
  const combinedPrice = upPrice + downPrice;
  const spread = Math.abs(upPrice - downPrice);
  
  const cheaperSide = upPrice < downPrice ? 'Up' : 'Down';
  const cheaperPrice = Math.min(upPrice, downPrice);
  
  const priceToBeat = strikeData.price;
  
  // Calculate price delta
  let priceDelta: number | null = null;
  let priceDeltaPercent: number | null = null;
  
  if (priceToBeat && currentCryptoPrice) {
    priceDelta = currentCryptoPrice - priceToBeat;
    priceDeltaPercent = (priceDelta / priceToBeat) * 100;
  }
  
  // Arbitrage edge
  const arbitrageEdge = (1 - combinedPrice) * 100;
  
  // Potential return
  const potentialReturn = cheaperPrice > 0 ? ((1 / cheaperPrice) - 1) * 100 : 0;
  
  // GABAGOOL SIGNAL LOGIC
  let confidence: 'high' | 'medium' | 'low' = 'low';
  let signalType: 'dual_side' | 'single_side' | 'arbitrage' | 'wait' = 'wait';
  let action = 'No signal - waiting';
  
  const absDeltaPercent = priceDeltaPercent !== null ? Math.abs(priceDeltaPercent) : 100;
  
  // HIGH CONFIDENCE: Very small delta + arbitrage
  if (absDeltaPercent < 0.03 && combinedPrice < 1.0) {
    confidence = 'high';
    signalType = 'dual_side';
    action = `BUY BOTH @ ${(combinedPrice * 100).toFixed(1)}¢ combined - Dual-side hedge`;
  }
  // HIGH CONFIDENCE: Pure arbitrage
  else if (combinedPrice < 0.98) {
    confidence = 'high';
    signalType = 'arbitrage';
    action = `ARBITRAGE: Buy both @ ${(combinedPrice * 100).toFixed(1)}¢ = ${arbitrageEdge.toFixed(1)}% edge`;
  }
  // MEDIUM: Small delta, market uncertain
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
    market: market.market,
    marketSlug: market.market_slug,
    asset,
    priceToBeat,
    priceToBeatSource: strikeData.source,
    priceToBeatQuality: strikeData.quality,
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
    eventStartTime: new Date(market.eventTimestamp * 1000).toISOString(),
    eventEndTime: new Date((market.eventTimestamp + 900) * 1000).toISOString(),
    remainingSeconds,
    remainingFormatted,
    timestamp: new Date().toISOString()
  };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    console.log('Fetching real-time 15-min data from trades DB...');
    
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);
    
    // Fetch crypto prices and DB markets in parallel
    const [btcPrice, ethPrice, marketsFromDB] = await Promise.all([
      fetchCryptoPrice('BTC'),
      fetchCryptoPrice('ETH'),
      get15MinMarketsFromDB()
    ]);
    
    console.log('Crypto prices:', { btcPrice, ethPrice });
    console.log(`Found ${marketsFromDB.length} 15-min markets in DB`);
    
    const now = Date.now();
    const signals: TradingSignal[] = [];
    
    // Fetch strike prices from Chainlink cache (with source/quality info)
    const strikePricePromises = marketsFromDB.map(m => {
      const slug = m.market_slug.toLowerCase();
      const asset: 'BTC' | 'ETH' = slug.includes('btc') ? 'BTC' : 'ETH';
      const currentPrice = asset === 'BTC' ? btcPrice : ethPrice;
      return fetchStrikePrice(supabase, m.market_slug, asset, m.eventTimestamp, currentPrice);
    });
    const strikePrices = await Promise.all(strikePricePromises);
    
    for (let i = 0; i < marketsFromDB.length; i++) {
      const market = marketsFromDB[i];
      const slug = market.market_slug.toLowerCase();
      const asset: 'BTC' | 'ETH' = slug.includes('btc') ? 'BTC' : 'ETH';
      const cryptoPrice = asset === 'BTC' ? btcPrice : ethPrice;
      const strikeData = strikePrices[i];
      
      console.log(`Market ${slug}: priceToBeat=$${strikeData.price} (${strikeData.source}/${strikeData.quality}), current=$${cryptoPrice}`);
      
      const signal = calculateGabagoolSignal(market, cryptoPrice, asset, strikeData);
      signals.push(signal);
    }
    
    // Sort by remaining time (live first)
    signals.sort((a, b) => a.remainingSeconds - b.remainingSeconds);
    
    // LIVE = market is active (0 < remaining <= 900 seconds)
    const liveMarkets = signals.filter(s => s.remainingSeconds > 0 && s.remainingSeconds <= 900);
    
    // SOON = starts within 30 min (900 < remaining <= 2700)
    const soonUpcoming = signals.filter(s => s.remainingSeconds > 900 && s.remainingSeconds <= 2700);
    
    // LATER = more than 30 min
    const laterMarkets = signals.filter(s => s.remainingSeconds > 2700);
    
    // EXPIRED = already ended (remaining <= 0)
    const expiredMarkets = signals.filter(s => s.remainingSeconds <= 0);
    
    console.log(`Live: ${liveMarkets.length}, Soon: ${soonUpcoming.length}, Later: ${laterMarkets.length}, Expired: ${expiredMarkets.length}`);
    
    // Stats
    const activeSignals = signals.filter(s => s.remainingSeconds > 0);
    const highConfidence = activeSignals.filter(s => s.confidence === 'high');
    const arbitrageOpportunities = activeSignals.filter(s => s.signalType === 'arbitrage');
    
    return new Response(JSON.stringify({
      success: true,
      timestamp: new Date().toISOString(),
      cryptoPrices: {
        BTC: btcPrice,
        ETH: ethPrice
      },
      marketsAnalyzed: marketsFromDB.length,
      liveMarkets,
      soonUpcoming,
      laterMarkets,
      signals: activeSignals,
      summary: {
        highConfidenceCount: highConfidence.length,
        arbitrageOpportunityCount: arbitrageOpportunities.length,
        liveCount: liveMarkets.length,
        soonCount: soonUpcoming.length,
        laterCount: laterMarkets.length,
        avgCombinedPrice: activeSignals.length > 0 
          ? activeSignals.reduce((sum, s) => sum + s.combinedPrice, 0) / activeSignals.length 
          : 0,
        avgArbitrageEdge: activeSignals.length > 0
          ? activeSignals.reduce((sum, s) => sum + s.arbitrageEdge, 0) / activeSignals.length
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
