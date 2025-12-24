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

// Fetch current Chainlink prices from RTDS WebSocket
async function fetchCurrentChainlinkPrices(): Promise<{ btc: number | null; eth: number | null }> {
  return new Promise((resolve) => {
    const prices = { btc: null as number | null, eth: null as number | null };
    let ws: WebSocket | null = null;
    
    const timeout = setTimeout(() => {
      console.log('[settle] RTDS timeout - using available prices');
      if (ws) ws.close();
      resolve(prices);
    }, 8000); // 8 second timeout
    
    try {
      ws = new WebSocket('wss://rtds.polymarket.com');
    } catch (e) {
      console.error('[settle] Failed to connect to RTDS:', e);
      clearTimeout(timeout);
      resolve(prices);
      return;
    }
    
    ws.onopen = () => {
      console.log('[settle] Connected to RTDS for price fetch');
      ws!.send(JSON.stringify({
        action: 'subscribe',
        subscriptions: [{
          topic: 'crypto_prices_chainlink',
          type: '*',
          filters: ''
        }]
      }));
    };
    
    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.topic === 'crypto_prices_chainlink' && data.payload) {
          const symbol = data.payload.symbol?.toUpperCase().replace('/USD', '') || '';
          const value = data.payload.value;
          
          if (symbol === 'BTC' && value) {
            prices.btc = value;
            console.log(`[settle] BTC price: $${value}`);
          } else if (symbol === 'ETH' && value) {
            prices.eth = value;
            console.log(`[settle] ETH price: $${value}`);
          }
          
          // If we have both prices, we're done
          if (prices.btc !== null && prices.eth !== null) {
            clearTimeout(timeout);
            ws!.close();
            resolve(prices);
          }
        }
      } catch (e) {
        // Ignore parse errors
      }
    };
    
    ws.onerror = () => {
      clearTimeout(timeout);
      resolve(prices);
    };
    
    ws.onclose = () => {
      clearTimeout(timeout);
      resolve(prices);
    };
  });
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

    // 4. Get existing oracle prices from strike_prices table
    const { data: oracleData } = await supabase
      .from('strike_prices')
      .select('market_slug, open_price, close_price, strike_price')
      .in('market_slug', marketSlugs);

    const oracleMap = new Map<string, { openPrice: number | null; closePrice: number | null }>();
    if (oracleData) {
      for (const oracle of oracleData) {
        oracleMap.set(oracle.market_slug, {
          openPrice: oracle.open_price ?? oracle.strike_price,
          closePrice: oracle.close_price,
        });
      }
    }

    // 5. Check which markets need close prices - fetch from RTDS if needed
    const marketsNeedingClosePrice = marketSlugs.filter(slug => {
      const oracle = oracleMap.get(slug);
      return !oracle || oracle.closePrice === null;
    });

    if (marketsNeedingClosePrice.length > 0) {
      console.log(`[settle] ${marketsNeedingClosePrice.length} markets need close prices - fetching from RTDS...`);
      
      const currentPrices = await fetchCurrentChainlinkPrices();
      
      // Store close prices for markets that need them
      for (const slug of marketsNeedingClosePrice) {
        const position = positionMap.get(slug)!;
        const asset = position.asset.toUpperCase();
        const closePrice = asset === 'BTC' ? currentPrices.btc : 
                           asset === 'ETH' ? currentPrices.eth : null;
        
        if (closePrice !== null) {
          const eventStartTime = parseTimestampFromSlug(slug);
          
          // Get or create oracle entry
          let oracle = oracleMap.get(slug);
          if (!oracle) {
            oracle = { openPrice: null, closePrice: null };
            oracleMap.set(slug, oracle);
          }
          oracle.closePrice = closePrice;
          
          // Upsert to strike_prices for future reference
          const upsertData: Record<string, unknown> = {
            market_slug: slug,
            asset: asset,
            close_price: closePrice,
            close_timestamp: Date.now(),
          };
          
          if (eventStartTime) {
            upsertData.event_start_time = new Date(eventStartTime * 1000).toISOString();
            // If no open price, estimate it (close price is current, open was ~15 min ago)
            if (!oracle.openPrice) {
              upsertData.strike_price = closePrice; // Use current as fallback
              upsertData.open_price = closePrice;
              upsertData.chainlink_timestamp = eventStartTime * 1000;
              oracle.openPrice = closePrice;
              console.log(`[settle] ${slug}: No open price, using current $${closePrice} as estimate`);
            }
          }
          
          await supabase.from('strike_prices').upsert(upsertData, { onConflict: 'market_slug' });
          console.log(`[settle] ${slug}: Stored close price $${closePrice}`);
        }
      }
    }

    // 6. Calculate results and settle
    const resultsToInsert = [];
    let settledCount = 0;
    let pendingCount = 0;

    for (const [slug, position] of positionMap) {
      const oracle = oracleMap.get(slug);
      const totalInvested = position.upCost + position.downCost;

      // Determine result from oracle prices
      let result: 'UP' | 'DOWN' | null = null;
      
      if (oracle && oracle.openPrice !== null && oracle.closePrice !== null) {
        // We have both prices - can determine result
        // UP wins if close >= open (price went up or stayed same)
        result = oracle.closePrice >= oracle.openPrice ? 'UP' : 'DOWN';
        console.log(`[settle] ${slug}: open=$${oracle.openPrice.toFixed(2)}, close=$${oracle.closePrice.toFixed(2)} => ${result}`);
      } else {
        // Still no oracle data - skip this market
        console.log(`[settle] ${slug}: ⏳ WAITING for prices (open=${oracle?.openPrice ?? 'missing'}, close=${oracle?.closePrice ?? 'missing'})`);
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
