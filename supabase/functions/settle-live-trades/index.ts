import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface LiveTrade {
  id: string;
  market_slug: string;
  asset: string;
  outcome: string;
  shares: number;
  price: number;
  total: number;
  event_end_time: string;
  event_start_time: string;
}

interface AggregatedPosition {
  market_slug: string;
  asset: string;
  upShares: number;
  upCost: number;
  downShares: number;
  downCost: number;
  eventEndTime: string;
  eventStartTime: string;
}

// Chainlink feed IDs for Polygon
const CHAINLINK_FEEDS: Record<string, string> = {
  'BTC': '0xc907E116054Ad103354f2D350FD2514433D57F6f', // BTC/USD on Polygon
  'ETH': '0xF9680D99D6C9589e2a93a78A04A279e509205945', // ETH/USD on Polygon
  'SOL': '0x4ffcB8A5e03D303C90f8878fA85EBA22F4603c69', // SOL/USD on Polygon
  'XRP': '0x4046332373C24Aed1dC8bAd489A04E187833B28d', // XRP/USD on Polygon
};

// Fetch current price from Chainlink via public RPC
async function fetchChainlinkPrice(asset: string): Promise<number | null> {
  const feedAddress = CHAINLINK_FEEDS[asset];
  if (!feedAddress) {
    console.log(`[chainlink] No feed for ${asset}`);
    return null;
  }

  try {
    const data = '0xfeaf968c'; // function signature for latestRoundData()
    
    const response = await fetch('https://polygon-rpc.com', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'eth_call',
        params: [{
          to: feedAddress,
          data: data
        }, 'latest'],
        id: 1
      })
    });

    if (!response.ok) {
      console.log(`[chainlink] RPC error: ${response.status}`);
      return null;
    }

    const result = await response.json();
    if (result.error) {
      console.log(`[chainlink] RPC error:`, result.error);
      return null;
    }

    const hex = result.result.slice(2);
    const answerHex = hex.slice(64, 128);
    const answer = BigInt('0x' + answerHex);
    const price = Number(answer) / 1e8;
    
    console.log(`[chainlink] ${asset} price: $${price.toFixed(2)}`);
    return price;
  } catch (e) {
    console.error(`[chainlink] Error fetching ${asset}:`, e);
    return null;
  }
}

// Fetch market result from Polymarket Gamma API
async function fetchMarketResult(slug: string): Promise<'UP' | 'DOWN' | null> {
  try {
    console.log(`[settle] Fetching Polymarket result for ${slug}...`);
    
    const response = await fetch(
      `https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(slug)}`,
      { headers: { 'Accept': 'application/json' } }
    );
    
    if (!response.ok) {
      console.log(`[settle] Gamma API returned ${response.status} for ${slug}`);
      return null;
    }
    
    const events = await response.json();
    
    if (!events || events.length === 0) {
      console.log(`[settle] No event found for slug ${slug}`);
      return null;
    }
    
    const event = events[0];
    const markets = event.markets || [];
    
    for (const market of markets) {
      const outcome = market.outcome?.toUpperCase() || '';
      const groupItemTitle = market.groupItemTitle?.toUpperCase() || '';
      
      const isUp = outcome === 'UP' || outcome.includes('UP') || 
                   groupItemTitle === 'UP' || groupItemTitle.includes('UP');
      
      if (market.closed && market.resolutionPrice !== undefined) {
        const resPrice = parseFloat(market.resolutionPrice);
        
        if (isUp) {
          if (resPrice >= 0.99) {
            console.log(`[settle] ${slug}: UP market resolved YES (price=${resPrice})`);
            return 'UP';
          } else if (resPrice <= 0.01) {
            console.log(`[settle] ${slug}: UP market resolved NO (price=${resPrice})`);
            return 'DOWN';
          }
        }
      }
      
      if (market.winningOutcome) {
        const winner = market.winningOutcome.toUpperCase();
        console.log(`[settle] ${slug}: winningOutcome = ${winner}`);
        if (winner === 'YES' && isUp) return 'UP';
        if (winner === 'NO' && isUp) return 'DOWN';
      }
    }
    
    if (event.outcome || event.winningOutcome) {
      const winner = (event.outcome || event.winningOutcome).toUpperCase();
      console.log(`[settle] ${slug}: Event outcome = ${winner}`);
      if (winner === 'UP' || winner.includes('UP')) return 'UP';
      if (winner === 'DOWN' || winner.includes('DOWN')) return 'DOWN';
    }
    
    return null;
    
  } catch (e) {
    console.error(`[settle] Error fetching Polymarket result for ${slug}:`, e);
    return null;
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    console.log('[settle-live-trades] Starting settlement cycle...');

    const now = new Date();
    // Only settle markets that ended at least 2 minutes ago
    const settleThreshold = new Date(now.getTime() - 2 * 60 * 1000);

    // 1. Get all live trades where event has ended
    const { data: unsettledTrades, error: tradesError } = await supabase
      .from('live_trades')
      .select('*')
      .lt('event_end_time', settleThreshold.toISOString());

    if (tradesError) {
      throw tradesError;
    }

    if (!unsettledTrades || unsettledTrades.length === 0) {
      console.log('[settle-live-trades] No expired trades to settle');
      return new Response(JSON.stringify({
        success: true,
        message: 'No expired trades to settle',
        settled: 0,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // 2. Get already settled markets
    const { data: settledResults } = await supabase
      .from('live_trade_results')
      .select('market_slug, settled_at')
      .not('settled_at', 'is', null);

    const settledSlugs = new Set(settledResults?.map(r => r.market_slug) || []);

    // 3. Aggregate trades by market (only unsettled ones)
    const positionMap = new Map<string, AggregatedPosition>();

    for (const trade of unsettledTrades as LiveTrade[]) {
      if (settledSlugs.has(trade.market_slug)) continue;

      if (!positionMap.has(trade.market_slug)) {
        positionMap.set(trade.market_slug, {
          market_slug: trade.market_slug,
          asset: trade.asset,
          upShares: 0,
          upCost: 0,
          downShares: 0,
          downCost: 0,
          eventEndTime: trade.event_end_time,
          eventStartTime: trade.event_start_time,
        });
      }

      const position = positionMap.get(trade.market_slug)!;
      if (trade.outcome === 'UP') {
        position.upShares += trade.shares;
        position.upCost += trade.total;
      } else if (trade.outcome === 'DOWN') {
        position.downShares += trade.shares;
        position.downCost += trade.total;
      }
    }

    if (positionMap.size === 0) {
      console.log('[settle-live-trades] All expired trades already settled');
      return new Response(JSON.stringify({
        success: true,
        message: 'All expired trades already settled',
        settled: 0,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const marketSlugs = Array.from(positionMap.keys());
    console.log(`[settle-live-trades] Processing ${marketSlugs.length} unsettled markets`);

    // 4. Get strike prices from our database
    const { data: strikePriceData } = await supabase
      .from('strike_prices')
      .select('market_slug, strike_price, open_price, close_price')
      .in('market_slug', marketSlugs);

    const strikePriceMap = new Map(
      (strikePriceData || []).map(sp => [sp.market_slug, sp])
    );

    // 5. Fetch current Chainlink prices for assets we need
    const assetsNeeded = new Set<string>();
    for (const [slug, position] of positionMap) {
      const sp = strikePriceMap.get(slug);
      if (!sp?.close_price) {
        assetsNeeded.add(position.asset);
      }
    }

    const currentPrices: Record<string, number> = {};
    for (const asset of assetsNeeded) {
      const price = await fetchChainlinkPrice(asset);
      if (price) {
        currentPrices[asset] = price;
      }
    }

    // 6. Calculate results and settle
    const resultsToInsert = [];
    let settledCount = 0;
    let pendingCount = 0;

    for (const [slug, position] of positionMap) {
      const totalInvested = position.upCost + position.downCost;
      const sp = strikePriceMap.get(slug);
      
      let result: 'UP' | 'DOWN' | null = null;
      let openPrice = sp?.open_price || sp?.strike_price || null;
      let closePrice = sp?.close_price || null;

      // Strategy 1: Use our own strike_prices data
      if (openPrice !== null && closePrice !== null) {
        result = closePrice > openPrice ? 'UP' : 'DOWN';
        console.log(`[settle] ${slug}: DB prices - Open: $${openPrice}, Close: $${closePrice} => ${result}`);
      }
      
      // Strategy 2: Use current Chainlink price as close price if market ended
      if (result === null && openPrice !== null) {
        const eventEnd = new Date(position.eventEndTime);
        if (eventEnd < now && currentPrices[position.asset]) {
          closePrice = currentPrices[position.asset];
          result = closePrice > openPrice ? 'UP' : 'DOWN';
          console.log(`[settle] ${slug}: Live Chainlink - Open: $${openPrice}, Close: $${closePrice} => ${result}`);
          
          // Save the close price to strike_prices for future reference
          await supabase
            .from('strike_prices')
            .upsert({
              market_slug: slug,
              asset: position.asset,
              event_start_time: position.eventStartTime,
              strike_price: openPrice,
              open_price: openPrice,
              close_price: closePrice,
              chainlink_timestamp: Math.floor(now.getTime() / 1000),
              source: 'chainlink_settle',
              quality: 'live'
            }, { onConflict: 'market_slug' });
        }
      }

      // Strategy 3: Try Polymarket API as last resort
      if (result === null) {
        result = await fetchMarketResult(slug);
      }
      
      if (result === null) {
        console.log(`[settle] ${slug}: ⏳ WAITING for data (no open/close prices available)`);
        pendingCount++;
        continue;
      }

      // Calculate payout based on result
      let payout = 0;
      if (result === 'UP') {
        payout = position.upShares;
      } else if (result === 'DOWN') {
        payout = position.downShares;
      }

      const profitLoss = payout - totalInvested;
      const profitLossPercent = totalInvested > 0 
        ? (profitLoss / totalInvested) * 100 
        : 0;

      resultsToInsert.push({
        market_slug: slug,
        asset: position.asset,
        up_shares: position.upShares,
        up_cost: position.upCost,
        up_avg_price: position.upShares > 0 ? position.upCost / position.upShares : 0,
        down_shares: position.downShares,
        down_cost: position.downCost,
        down_avg_price: position.downShares > 0 ? position.downCost / position.downShares : 0,
        total_invested: totalInvested,
        result,
        payout,
        profit_loss: profitLoss,
        profit_loss_percent: profitLossPercent,
        event_end_time: position.eventEndTime,
        settled_at: now.toISOString(),
      });

      settledCount++;
      const emoji = profitLoss >= 0 ? '✅' : '❌';
      console.log(`[settle] ${slug}: ${emoji} ${result} won | Invested: $${totalInvested.toFixed(2)} | Payout: $${payout.toFixed(2)} | P/L: $${profitLoss.toFixed(2)} (${profitLossPercent.toFixed(1)}%)`);
      
      // Also update market_history with the result
      await supabase
        .from('market_history')
        .upsert({
          slug,
          asset: position.asset,
          event_start_time: position.eventStartTime,
          event_end_time: position.eventEndTime,
          open_price: openPrice,
          strike_price: openPrice,
          close_price: closePrice,
          result,
          updated_at: now.toISOString()
        }, { onConflict: 'slug' });
    }

    // 7. Insert results (delete existing first to handle re-runs)
    if (resultsToInsert.length > 0) {
      // Delete any existing results for these slugs (in case of re-run)
      const slugsToInsert = resultsToInsert.map(r => r.market_slug);
      await supabase
        .from('live_trade_results')
        .delete()
        .in('market_slug', slugsToInsert);
      
      const { error: insertError } = await supabase
        .from('live_trade_results')
        .insert(resultsToInsert);

      if (insertError) {
        console.error('[settle-live-trades] Error inserting results:', insertError);
        throw insertError;
      }
    }

    console.log(`[settle-live-trades] ✅ Settled: ${settledCount}, ⏳ Pending: ${pendingCount}`);

    return new Response(JSON.stringify({
      success: true,
      timestamp: new Date().toISOString(),
      settled: settledCount,
      pending: pendingCount,
      currentPrices,
      results: resultsToInsert.map(r => ({
        slug: r.market_slug,
        result: r.result,
        invested: r.total_invested.toFixed(2),
        payout: r.payout.toFixed(2),
        profitLoss: r.profit_loss.toFixed(2),
        profitLossPercent: r.profit_loss_percent.toFixed(1) + '%',
      })),
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('[settle-live-trades] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
