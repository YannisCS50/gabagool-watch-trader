import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface PolymarketActivity {
  proxyWallet: string;
  timestamp: number;
  conditionId: string;
  type: string;
  size: number;
  usdcSize: number;
  transactionHash: string;
  price: number;
  asset: string;
  side: string;
  outcomeIndex: number;
  title: string;
  slug: string;
  icon: string;
  eventSlug: string;
  outcome: string;
  name: string;
  pseudonym: string;
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

    console.log(`Fetching Polymarket activity for @${username}...`);

    // Step 1: Fetch user activity from Polymarket Data API
    // The API supports filtering by pseudonym (username)
    const activityUrl = `https://data-api.polymarket.com/activity?user=${username}&limit=100&sortBy=TIMESTAMP&sortDirection=DESC`;
    
    console.log('Fetching from:', activityUrl);
    
    const activityResponse = await fetch(activityUrl, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'PolyTracker/1.0',
      },
    });

    if (!activityResponse.ok) {
      const errorText = await activityResponse.text();
      console.error('Polymarket API error:', activityResponse.status, errorText);
      
      // Try alternative endpoint with trades
      const tradesUrl = `https://data-api.polymarket.com/trades?user=${username}&limit=100`;
      console.log('Trying trades endpoint:', tradesUrl);
      
      const tradesResponse = await fetch(tradesUrl, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'PolyTracker/1.0',
        },
      });
      
      if (!tradesResponse.ok) {
        const tradesError = await tradesResponse.text();
        console.error('Trades API error:', tradesResponse.status, tradesError);
        return new Response(
          JSON.stringify({ 
            success: false, 
            error: 'Failed to fetch from Polymarket API',
            details: { activityError: errorText, tradesError }
          }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      
      const tradesData = await tradesResponse.json();
      return await processAndStoreTrades(tradesData, username, supabase);
    }

    const activityData: PolymarketActivity[] = await activityResponse.json();
    console.log(`Received ${activityData.length} activity entries from Polymarket`);

    return await processAndStoreTrades(activityData, username, supabase);

  } catch (error) {
    console.error('Error in scrape-polymarket:', error);
    return new Response(
      JSON.stringify({ success: false, error: error instanceof Error ? error.message : 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});

async function processAndStoreTrades(activities: any[], username: string, supabase: any) {
  const trades = [];
  
  for (const activity of activities) {
    // Only process TRADE type activities
    if (activity.type && activity.type !== 'TRADE') continue;
    
    const trade = {
      external_id: activity.transactionHash || `${activity.conditionId}-${activity.timestamp}`,
      trader_username: activity.pseudonym || username,
      timestamp: new Date(activity.timestamp * 1000).toISOString(),
      market: activity.title || 'Unknown Market',
      market_slug: activity.slug || activity.eventSlug || '',
      outcome: activity.outcome || (activity.outcomeIndex === 0 ? 'Yes' : 'No'),
      side: (activity.side || 'BUY').toLowerCase(),
      shares: activity.size || 0,
      price: activity.price || 0,
      total: activity.usdcSize || (activity.size * activity.price) || 0,
      status: 'filled',
    };
    
    trades.push(trade);
  }

  console.log(`Processed ${trades.length} trades for storage`);

  if (trades.length > 0) {
    // Insert trades into database (upsert to avoid duplicates)
    const { error: insertError } = await supabase
      .from('trades')
      .upsert(trades, { 
        onConflict: 'external_id',
        ignoreDuplicates: true 
      });
    
    if (insertError) {
      console.error('Error inserting trades:', insertError);
    } else {
      console.log(`Successfully stored ${trades.length} trades`);
    }

    // Update trader stats
    const { data: allTrades } = await supabase
      .from('trades')
      .select('*')
      .eq('trader_username', username);

    const totalTrades = allTrades?.length || 0;
    const totalVolume = allTrades?.reduce((sum: number, t: any) => sum + Number(t.total), 0) || 0;
    const avgTradeSize = totalTrades > 0 ? totalVolume / totalTrades : 0;

    // Get the latest trade timestamp
    const latestTrade = trades.reduce((latest, t) => {
      const tTime = new Date(t.timestamp).getTime();
      return tTime > latest ? tTime : latest;
    }, 0);

    await supabase
      .from('trader_stats')
      .upsert({
        trader_username: username,
        total_trades: totalTrades,
        total_volume: totalVolume,
        avg_trade_size: avgTradeSize,
        last_active: latestTrade ? new Date(latestTrade).toISOString() : new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }, { onConflict: 'trader_username' });
  }

  return new Response(
    JSON.stringify({ 
      success: true, 
      tradesFound: trades.length,
      sample: trades.slice(0, 3),
    }),
    { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  );
}
