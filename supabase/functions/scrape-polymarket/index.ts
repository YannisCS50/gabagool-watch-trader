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

    console.log(`Fetching ALL Polymarket trades for @${username}...`);

    // Fetch trades with pagination to get ALL historical data
    let trades: PolymarketTrade[] = [];
    let offset = 0;
    const limit = 100;
    let hasMore = true;
    let attempts = 0;
    const maxAttempts = 100; // Max 10,000 trades
    
    // Method 1: Paginate through /trades endpoint
    while (hasMore && attempts < maxAttempts) {
      const tradesUrl = `${POLYMARKET_DATA_API}/trades?user=${username}&limit=${limit}&offset=${offset}`;
      console.log(`Fetching page ${attempts + 1}: offset=${offset}`);
      
      try {
        const tradesResponse = await fetch(tradesUrl, {
          headers: {
            'Accept': 'application/json',
            'User-Agent': 'PolyTracker/1.0',
          },
        });

        if (tradesResponse.ok) {
          const data = await tradesResponse.json();
          if (Array.isArray(data) && data.length > 0) {
            trades = [...trades, ...data];
            console.log(`Got ${data.length} trades (total: ${trades.length})`);
            offset += limit;
            attempts++;
            
            // If we got fewer than limit, we've reached the end
            if (data.length < limit) {
              hasMore = false;
            }
          } else {
            hasMore = false;
          }
        } else {
          console.log('Trades endpoint failed:', tradesResponse.status);
          hasMore = false;
        }
      } catch (e) {
        console.error('Error fetching trades page:', e);
        hasMore = false;
      }
      
      // Small delay to avoid rate limiting
      if (hasMore) {
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }

    console.log(`Total trades from /trades endpoint: ${trades.length}`);

    // Method 2: If no trades from /trades, try activity endpoint with pagination
    if (trades.length === 0) {
      offset = 0;
      hasMore = true;
      attempts = 0;
      
      while (hasMore && attempts < maxAttempts) {
        const activityUrl = `${POLYMARKET_DATA_API}/activity?user=${username}&limit=${limit}&offset=${offset}&sortBy=TIMESTAMP&sortDirection=DESC`;
        console.log(`Fetching activity page ${attempts + 1}: offset=${offset}`);
        
        try {
          const activityResponse = await fetch(activityUrl, {
            headers: {
              'Accept': 'application/json',
              'User-Agent': 'PolyTracker/1.0',
            },
          });

          if (activityResponse.ok) {
            const activityData = await activityResponse.json();
            if (Array.isArray(activityData) && activityData.length > 0) {
              const tradesToAdd = activityData.filter((a: any) => a.type === 'TRADE' || !a.type);
              trades = [...trades, ...tradesToAdd];
              console.log(`Got ${tradesToAdd.length} activities (total: ${trades.length})`);
              offset += limit;
              attempts++;
              
              if (activityData.length < limit) {
                hasMore = false;
              }
            } else {
              hasMore = false;
            }
          } else {
            console.log('Activity endpoint failed:', activityResponse.status);
            hasMore = false;
          }
        } catch (e) {
          console.error('Error fetching activity page:', e);
          hasMore = false;
        }
        
        if (hasMore) {
          await new Promise(resolve => setTimeout(resolve, 200));
        }
      }
      
      console.log(`Total trades from /activity endpoint: ${trades.length}`);
    }

    // Method 3: Try the Gamma API for additional trades via wallet address
    try {
      const gammaUrl = `${POLYMARKET_GAMMA_API}/users?username=${username}`;
      console.log('Trying Gamma API for user data:', gammaUrl);
      
      const gammaResponse = await fetch(gammaUrl, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'PolyTracker/1.0',
        },
      });
      
      if (gammaResponse.ok) {
        const userData = await gammaResponse.json();
        console.log('Gamma API user data:', JSON.stringify(userData).slice(0, 200));
        
        // If we get a proxyWallet, try fetching ALL trades by wallet with pagination
        if (userData && userData.proxyWallet) {
          let walletOffset = 0;
          let walletHasMore = true;
          let walletAttempts = 0;
          
          while (walletHasMore && walletAttempts < maxAttempts) {
            const walletTradesUrl = `${POLYMARKET_DATA_API}/trades?proxyWallet=${userData.proxyWallet}&limit=${limit}&offset=${walletOffset}`;
            console.log(`Fetching wallet trades page ${walletAttempts + 1}: offset=${walletOffset}`);
            
            const walletResponse = await fetch(walletTradesUrl, {
              headers: {
                'Accept': 'application/json',
                'User-Agent': 'PolyTracker/1.0',
              },
            });
            
            if (walletResponse.ok) {
              const walletTrades = await walletResponse.json();
              if (Array.isArray(walletTrades) && walletTrades.length > 0) {
                // Merge with existing trades, avoiding duplicates
                const existingHashes = new Set(trades.map(t => t.transactionHash));
                const newTrades = walletTrades.filter((t: any) => !existingHashes.has(t.transactionHash));
                trades = [...trades, ...newTrades];
                console.log(`Got ${newTrades.length} new wallet trades (total: ${trades.length})`);
                
                walletOffset += limit;
                walletAttempts++;
                
                if (walletTrades.length < limit) {
                  walletHasMore = false;
                }
              } else {
                walletHasMore = false;
              }
            } else {
              console.log('Wallet trades endpoint failed:', walletResponse.status);
              walletHasMore = false;
            }
            
            if (walletHasMore) {
              await new Promise(resolve => setTimeout(resolve, 200));
            }
          }
          console.log(`Total trades after wallet lookup: ${trades.length}`);
        }
      }
    } catch (e) {
      console.error('Gamma API error:', e);
    }

    // Method 4: Try CLOB API for even more historical data
    try {
      const clobUrl = `https://clob.polymarket.com/trades?username=${username}&limit=500`;
      console.log('Trying CLOB API:', clobUrl);
      
      const clobResponse = await fetch(clobUrl, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'PolyTracker/1.0',
        },
      });
      
      if (clobResponse.ok) {
        const clobData = await clobResponse.json();
        if (Array.isArray(clobData)) {
          const existingHashes = new Set(trades.map(t => t.transactionHash));
          const newTrades = clobData.filter((t: any) => !existingHashes.has(t.transactionHash));
          trades = [...trades, ...newTrades];
          console.log(`Got ${newTrades.length} trades from CLOB API (total: ${trades.length})`);
        }
      }
    } catch (e) {
      console.error('CLOB API error:', e);
    }

    console.log(`Final total: ${trades.length} unique trades`);

    // Deduplicate trades by transactionHash
    const uniqueTrades = Array.from(
      new Map(trades.map(t => [t.transactionHash || `${t.conditionId}-${t.timestamp}`, t])).values()
    );
    console.log(`After deduplication: ${uniqueTrades.length} trades`);
    trades = uniqueTrades as PolymarketTrade[];

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
