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
}

interface AggregatedPosition {
  market_slug: string;
  asset: string;
  upShares: number;
  upCost: number;
  downShares: number;
  downCost: number;
  eventEndTime: string;
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

    // 1. Get all paper trades that haven't been settled yet
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
      .select('market_slug');

    const settledSlugs = new Set(settledResults?.map(r => r.market_slug) || []);

    // 3. Aggregate trades by market
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

    // 4. Determine winner for each market
    const marketSlugs = Array.from(positionMap.keys());
    
    // Get market results from market_history
    const { data: marketHistory } = await supabase
      .from('market_history')
      .select('slug, result, up_price_at_close, down_price_at_close, open_price, close_price')
      .in('slug', marketSlugs);

    const marketResultMap = new Map<string, 'UP' | 'DOWN' | null>();
    if (marketHistory) {
      for (const market of marketHistory) {
        // Priority 1: Explicit result field
        if (market.result === 'UP' || market.result === 'DOWN') {
          marketResultMap.set(market.slug, market.result);
          continue;
        }
        
        // Priority 2: Derive from close prices (if one side is >= 0.90, that side won)
        if (market.up_price_at_close !== null && market.down_price_at_close !== null) {
          if (market.up_price_at_close >= 0.90) {
            marketResultMap.set(market.slug, 'UP');
            console.log(`[settle] ${market.slug}: UP wins (up_close=${market.up_price_at_close})`);
            continue;
          } else if (market.down_price_at_close >= 0.90) {
            marketResultMap.set(market.slug, 'DOWN');
            console.log(`[settle] ${market.slug}: DOWN wins (down_close=${market.down_price_at_close})`);
            continue;
          }
          // If neither side >= 0.90, compare them
          if (market.up_price_at_close > market.down_price_at_close) {
            marketResultMap.set(market.slug, 'UP');
            console.log(`[settle] ${market.slug}: UP wins by higher close price (${market.up_price_at_close} vs ${market.down_price_at_close})`);
          } else if (market.down_price_at_close > market.up_price_at_close) {
            marketResultMap.set(market.slug, 'DOWN');
            console.log(`[settle] ${market.slug}: DOWN wins by higher close price (${market.down_price_at_close} vs ${market.up_price_at_close})`);
          }
          continue;
        }
        
        // Priority 3: Derive from open/close price comparison
        if (market.open_price !== null && market.close_price !== null) {
          const result = market.close_price >= market.open_price ? 'UP' : 'DOWN';
          marketResultMap.set(market.slug, result);
          console.log(`[settle] ${market.slug}: ${result} wins (open=${market.open_price}, close=${market.close_price})`);
        }
      }
    }

    // Fallback: check real trades table for high-confidence prices
    const { data: realTrades } = await supabase
      .from('trades')
      .select('market_slug, outcome, price')
      .in('market_slug', marketSlugs)
      .order('price', { ascending: false });

    if (realTrades) {
      for (const trade of realTrades) {
        if (!marketResultMap.has(trade.market_slug) && trade.price >= 0.90) {
          marketResultMap.set(trade.market_slug, trade.outcome as 'UP' | 'DOWN');
          console.log(`[settle] ${trade.market_slug}: ${trade.outcome} wins (from trades, price=${trade.price})`);
        }
      }
    }

    // 5. Calculate results and insert
    const resultsToInsert = [];
    let settledCount = 0;

    for (const [slug, position] of positionMap) {
      const result = marketResultMap.get(slug);
      const totalInvested = position.upCost + position.downCost;

      // Calculate payout based on result
      let payout = 0;
      if (result === 'UP') {
        payout = position.upShares; // Each winning share pays $1
      } else if (result === 'DOWN') {
        payout = position.downShares;
      }

      const profitLoss = result ? payout - totalInvested : null;
      const profitLossPercent = result && totalInvested > 0 
        ? (profitLoss! / totalInvested) * 100 
        : null;

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
        result: result ?? 'PENDING',
        payout,
        profit_loss: profitLoss,
        profit_loss_percent: profitLossPercent,
        event_end_time: position.eventEndTime,
        settled_at: result ? now.toISOString() : null,
      });

      if (result) {
        settledCount++;
        console.log(`[settle-paper-trades] ${slug}: ${result} won, P/L: $${profitLoss?.toFixed(2)} (${profitLossPercent?.toFixed(1)}%)`);
      } else {
        console.log(`[settle-paper-trades] ${slug}: Result not yet determined`);
      }
    }

    // 6. Upsert results
    const { error: insertError } = await supabase
      .from('paper_trade_results')
      .upsert(resultsToInsert, { onConflict: 'market_slug' });

    if (insertError) {
      console.error('[settle-paper-trades] Error upserting results:', insertError);
      throw insertError;
    }

    console.log(`[settle-paper-trades] Processed ${resultsToInsert.length} markets, ${settledCount} fully settled`);

    return new Response(JSON.stringify({
      success: true,
      timestamp: new Date().toISOString(),
      processed: resultsToInsert.length,
      settled: settledCount,
      results: resultsToInsert.map(r => ({
        slug: r.market_slug,
        result: r.result,
        invested: r.total_invested.toFixed(2),
        payout: r.payout.toFixed(2),
        profitLoss: r.profit_loss?.toFixed(2) ?? 'pending',
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
