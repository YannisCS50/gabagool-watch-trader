import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Polymarket API endpoints based on official documentation
const POLYMARKET_DATA_API = 'https://data-api.polymarket.com';
const POLYMARKET_GAMMA_API = 'https://gamma-api.polymarket.com';

interface PolymarketTrade {
  proxyWallet: string;
  side: 'BUY' | 'SELL';
  asset: string;
  conditionId: string;
  size: number;
  price: number;
  timestamp: number;
  title: string;
  slug: string;
  icon: string;
  eventSlug: string;
  outcome: string;
  outcomeIndex: number;
  name: string;
  pseudonym: string;
  transactionHash: string;
  usdcSize?: number;
}

interface PolymarketPosition {
  proxyWallet: string;
  conditionId: string;
  size: number;
  avgPrice: number;
  currentPrice: number;
  title: string;
  slug: string;
  outcome: string;
  pnl: number;
  pnlPercent: number;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { username = 'gabagool22' } = await req.json().catch(() => ({}));
    
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      console.error('Supabase credentials not configured');
      return new Response(
        JSON.stringify({ success: false, error: 'Database not configured' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    console.log(`Fetching Polymarket trades for @${username}...`);

    // Try multiple API endpoints to get user trades
    let trades: PolymarketTrade[] = [];
    
    // Method 1: Try the /trades endpoint with pseudonym filter
    const tradesUrl = `${POLYMARKET_DATA_API}/trades?user=${username}&limit=100`;
    console.log('Fetching from:', tradesUrl);
    
    const tradesResponse = await fetch(tradesUrl, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'PolyTracker/1.0',
      },
    });

    if (tradesResponse.ok) {
      const data = await tradesResponse.json();
      if (Array.isArray(data) && data.length > 0) {
        trades = data;
        console.log(`Got ${trades.length} trades from /trades endpoint`);
      }
    } else {
      console.log('Trades endpoint failed:', tradesResponse.status);
    }

    // Method 2: If no trades, try activity endpoint
    if (trades.length === 0) {
      const activityUrl = `${POLYMARKET_DATA_API}/activity?user=${username}&limit=100&sortBy=TIMESTAMP&sortDirection=DESC`;
      console.log('Trying activity endpoint:', activityUrl);
      
      const activityResponse = await fetch(activityUrl, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'PolyTracker/1.0',
        },
      });

      if (activityResponse.ok) {
        const activityData = await activityResponse.json();
        if (Array.isArray(activityData)) {
          trades = activityData.filter((a: any) => a.type === 'TRADE' || !a.type);
          console.log(`Got ${trades.length} activities from /activity endpoint`);
        }
      } else {
        console.log('Activity endpoint failed:', activityResponse.status);
      }
    }

    // Method 3: Try with proxyWallet if we have it stored
    if (trades.length === 0) {
      // Check if we have a cached wallet address
      const { data: existingTrades } = await supabase
        .from('trades')
        .select('external_id')
        .eq('trader_username', username)
        .limit(1);
      
      if (existingTrades && existingTrades.length > 0) {
        // Extract wallet from previous trade's transactionHash if available
        console.log('Checking for cached wallet address from previous trades...');
      }
    }

    // Process and store trades
    const processedTrades = [];
    
    for (const trade of trades) {
      // Calculate USDC size if not provided
      const usdcSize = trade.usdcSize || (trade.size * trade.price);
      
      const processedTrade = {
        external_id: trade.transactionHash || `${trade.conditionId}-${trade.timestamp}-${Math.random().toString(36).substr(2, 9)}`,
        trader_username: trade.pseudonym || username,
        timestamp: new Date(trade.timestamp * 1000).toISOString(),
        market: trade.title || 'Unknown Market',
        market_slug: trade.slug || trade.eventSlug || '',
        outcome: trade.outcome || (trade.outcomeIndex === 0 ? 'Yes' : 'No'),
        side: (trade.side || 'BUY').toLowerCase(),
        shares: trade.size || 0,
        price: trade.price || 0,
        total: usdcSize,
        status: 'filled',
        // Additional fields for analysis
      };
      
      processedTrades.push(processedTrade);
    }

    console.log(`Processed ${processedTrades.length} trades for storage`);

    if (processedTrades.length > 0) {
      // Insert trades into database (upsert to avoid duplicates)
      const { error: insertError } = await supabase
        .from('trades')
        .upsert(processedTrades, { 
          onConflict: 'external_id',
          ignoreDuplicates: true 
        });
      
      if (insertError) {
        console.error('Error inserting trades:', insertError);
      } else {
        console.log(`Successfully stored trades`);
      }

      // Update trader stats with analytics
      const { data: allTrades } = await supabase
        .from('trades')
        .select('*')
        .eq('trader_username', username);

      if (allTrades && allTrades.length > 0) {
        const totalTrades = allTrades.length;
        const totalVolume = allTrades.reduce((sum: number, t: any) => sum + Number(t.total), 0);
        const avgTradeSize = totalVolume / totalTrades;
        
        // Calculate win rate based on sell trades (simplified)
        const buys = allTrades.filter((t: any) => t.side === 'buy');
        const sells = allTrades.filter((t: any) => t.side === 'sell');
        
        // Estimate win rate: if more sells than buys, trader is taking profits
        const estimatedWinRate = sells.length > 0 
          ? Math.min(95, 50 + (sells.length / buys.length) * 20) 
          : 50;

        // Get latest trade timestamp
        const latestTrade = allTrades.reduce((latest: number, t: any) => {
          const tTime = new Date(t.timestamp).getTime();
          return tTime > latest ? tTime : latest;
        }, 0);

        // Get earliest trade for active_since
        const earliestTrade = allTrades.reduce((earliest: number, t: any) => {
          const tTime = new Date(t.timestamp).getTime();
          return earliest === 0 || tTime < earliest ? tTime : earliest;
        }, 0);

        await supabase
          .from('trader_stats')
          .upsert({
            trader_username: username,
            total_trades: totalTrades,
            total_volume: totalVolume,
            avg_trade_size: avgTradeSize,
            win_rate: estimatedWinRate,
            active_since: earliestTrade ? new Date(earliestTrade).toISOString() : null,
            last_active: latestTrade ? new Date(latestTrade).toISOString() : new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }, { onConflict: 'trader_username' });
      }
    }

    // Return response with sample data for debugging
    return new Response(
      JSON.stringify({ 
        success: true, 
        tradesFound: processedTrades.length,
        sample: processedTrades.slice(0, 3),
        apiEndpointsTried: [
          `${POLYMARKET_DATA_API}/trades?user=${username}`,
          `${POLYMARKET_DATA_API}/activity?user=${username}`
        ]
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Error in scrape-polymarket:', error);
    return new Response(
      JSON.stringify({ success: false, error: error instanceof Error ? error.message : 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
