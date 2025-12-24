import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface PaperTrade {
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

// Parse timestamp from slug (e.g., btc-updown-15m-1766485800 -> 1766485800)
function parseTimestampFromSlug(slug: string): number | null {
  const match = slug.match(/(\d{10})$/);
  return match ? parseInt(match[1], 10) : null;
}

// Fetch market result from Polymarket Gamma API
async function fetchMarketResult(slug: string): Promise<'UP' | 'DOWN' | null> {
  try {
    console.log(`[settle] Fetching Polymarket result for ${slug}...`);
    
    // Get market data from Gamma API
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
    
    // Find UP and DOWN markets
    for (const market of markets) {
      const outcome = market.outcome?.toUpperCase() || '';
      const groupItemTitle = market.groupItemTitle?.toUpperCase() || '';
      
      // Check if this is an UP market
      const isUp = outcome === 'UP' || outcome.includes('UP') || 
                   groupItemTitle === 'UP' || groupItemTitle.includes('UP');
      
      // Check if market is resolved
      if (market.closed && market.resolutionPrice !== undefined) {
        const resPrice = parseFloat(market.resolutionPrice);
        
        if (isUp) {
          // UP market: if resolution price is 1, UP won; if 0, DOWN won
          if (resPrice >= 0.99) {
            console.log(`[settle] ${slug}: UP market resolved YES (price=${resPrice})`);
            return 'UP';
          } else if (resPrice <= 0.01) {
            console.log(`[settle] ${slug}: UP market resolved NO (price=${resPrice})`);
            return 'DOWN';
          }
        }
      }
      
      // Also check winningOutcome if available
      if (market.winningOutcome) {
        const winner = market.winningOutcome.toUpperCase();
        console.log(`[settle] ${slug}: winningOutcome = ${winner}`);
        if (winner === 'YES' && isUp) return 'UP';
        if (winner === 'NO' && isUp) return 'DOWN';
      }
    }
    
    // Also check event-level resolution
    if (event.outcome || event.winningOutcome) {
      const winner = (event.outcome || event.winningOutcome).toUpperCase();
      console.log(`[settle] ${slug}: Event outcome = ${winner}`);
      if (winner === 'UP' || winner.includes('UP')) return 'UP';
      if (winner === 'DOWN' || winner.includes('DOWN')) return 'DOWN';
    }
    
    console.log(`[settle] ${slug}: Market not yet resolved on Polymarket`);
    return null;
    
  } catch (e) {
    console.error(`[settle] Error fetching Polymarket result for ${slug}:`, e);
    return null;
  }
}

// Fetch final token prices from CLOB (for markets that have ended)
async function fetchFinalClobPrices(slug: string): Promise<{ upPrice: number | null; downPrice: number | null }> {
  try {
    // Get token IDs from market history or Gamma API
    const response = await fetch(
      `https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(slug)}`,
      { headers: { 'Accept': 'application/json' } }
    );
    
    if (!response.ok) return { upPrice: null, downPrice: null };
    
    const events = await response.json();
    if (!events || events.length === 0) return { upPrice: null, downPrice: null };
    
    const markets = events[0].markets || [];
    let upPrice: number | null = null;
    let downPrice: number | null = null;
    
    for (const market of markets) {
      const outcome = market.outcome?.toUpperCase() || '';
      const groupItemTitle = market.groupItemTitle?.toUpperCase() || '';
      const isUp = outcome === 'UP' || outcome.includes('UP') || 
                   groupItemTitle === 'UP' || groupItemTitle.includes('UP');
      
      // Use outcomePrices or lastTradePrice
      const price = market.outcomePrices ? 
        parseFloat(JSON.parse(market.outcomePrices)[0]) :
        market.lastTradePrice ? parseFloat(market.lastTradePrice) : null;
      
      if (price !== null) {
        if (isUp) upPrice = price;
        else downPrice = price;
      }
    }
    
    return { upPrice, downPrice };
  } catch (e) {
    console.error(`[settle] Error fetching CLOB prices for ${slug}:`, e);
    return { upPrice: null, downPrice: null };
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
    console.log('[settle-paper-trades] Starting settlement cycle...');

    const now = new Date();

    // 1. Get all paper trades where event has ended
    const { data: unsettledTrades, error: tradesError } = await supabase
      .from('paper_trades')
      .select('*')
      .lt('event_end_time', now.toISOString());

    if (tradesError) {
      throw tradesError;
    }

    if (!unsettledTrades || unsettledTrades.length === 0) {
      console.log('[settle-paper-trades] No expired trades to settle');
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
      .from('paper_trade_results')
      .select('market_slug, settled_at')
      .not('settled_at', 'is', null);

    const settledSlugs = new Set(settledResults?.map(r => r.market_slug) || []);

    // 3. Aggregate trades by market (only unsettled ones)
    const positionMap = new Map<string, AggregatedPosition>();

    for (const trade of unsettledTrades as PaperTrade[]) {
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
      console.log('[settle-paper-trades] All expired trades already settled');
      return new Response(JSON.stringify({
        success: true,
        message: 'All expired trades already settled',
        settled: 0,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const marketSlugs = Array.from(positionMap.keys());
    console.log(`[settle-paper-trades] Processing ${marketSlugs.length} unsettled markets`);

    // 4. Calculate results and settle - using Polymarket data ONLY
    const resultsToInsert = [];
    let settledCount = 0;
    let pendingCount = 0;

    for (const [slug, position] of positionMap) {
      const totalInvested = position.upCost + position.downCost;

      // Try to get result from Polymarket API
      let result: 'UP' | 'DOWN' | null = await fetchMarketResult(slug);
      
      // If Polymarket hasn't resolved yet, check CLOB prices as indicator
      if (result === null) {
        const clobPrices = await fetchFinalClobPrices(slug);
        
        // If one side is trading near 0 or 1, we can infer the result
        if (clobPrices.upPrice !== null && clobPrices.downPrice !== null) {
          if (clobPrices.upPrice >= 0.95) {
            result = 'UP';
            console.log(`[settle] ${slug}: CLOB indicates UP won (upPrice=${clobPrices.upPrice.toFixed(3)})`);
          } else if (clobPrices.downPrice >= 0.95) {
            result = 'DOWN';
            console.log(`[settle] ${slug}: CLOB indicates DOWN won (downPrice=${clobPrices.downPrice.toFixed(3)})`);
          } else if (clobPrices.upPrice <= 0.05) {
            result = 'DOWN';
            console.log(`[settle] ${slug}: CLOB indicates DOWN won (upPrice=${clobPrices.upPrice.toFixed(3)})`);
          } else if (clobPrices.downPrice <= 0.05) {
            result = 'UP';
            console.log(`[settle] ${slug}: CLOB indicates UP won (downPrice=${clobPrices.downPrice.toFixed(3)})`);
          }
        }
      }
      
      if (result === null) {
        // Still no result - skip this market
        console.log(`[settle] ${slug}: ⏳ WAITING for Polymarket resolution`);
        pendingCount++;
        continue;
      }

      // Calculate payout based on result
      // If UP wins: UP shares pay $1 each
      // If DOWN wins: DOWN shares pay $1 each
      let payout = 0;
      if (result === 'UP') {
        payout = position.upShares; // Each UP share pays $1
      } else if (result === 'DOWN') {
        payout = position.downShares; // Each DOWN share pays $1
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
    }

    // 7. Upsert results
    if (resultsToInsert.length > 0) {
      const { error: insertError } = await supabase
        .from('paper_trade_results')
        .upsert(resultsToInsert, { onConflict: 'market_slug' });

      if (insertError) {
        console.error('[settle-paper-trades] Error upserting results:', insertError);
        throw insertError;
      }
    }

    console.log(`[settle-paper-trades] ✅ Settled: ${settledCount}, ⏳ Pending: ${pendingCount}`);

    return new Response(JSON.stringify({
      success: true,
      timestamp: new Date().toISOString(),
      settled: settledCount,
      pending: pendingCount,
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
    console.error('[settle-paper-trades] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
