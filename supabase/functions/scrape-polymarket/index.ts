import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Polymarket API endpoints based on official documentation
const POLYMARKET_DATA_API = 'https://data-api.polymarket.com';
const POLYMARKET_GAMMA_API = 'https://gamma-api.polymarket.com';
const POLYMARKET_CLOB_API = 'https://clob.polymarket.com';

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
    
    // Method 1: Paginate through /trades endpoint with timestamp-based pagination
    // First, try to get trades going back in time
    let oldestTimestamp: number | null = null;
    
    while (hasMore && attempts < maxAttempts) {
      let tradesUrl = `${POLYMARKET_DATA_API}/trades?user=${username}&limit=${limit}&offset=${offset}`;
      
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
            
            // Track oldest timestamp for potential further historical fetching
            const timestamps = data.map((t: any) => t.timestamp).filter(Boolean);
            if (timestamps.length > 0) {
              const minTs = Math.min(...timestamps);
              if (!oldestTimestamp || minTs < oldestTimestamp) {
                oldestTimestamp = minTs;
              }
            }
            
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
        await new Promise(resolve => setTimeout(resolve, 150));
      }
    }

    console.log(`Total trades from /trades endpoint: ${trades.length}`);
    if (oldestTimestamp) {
      console.log(`Oldest trade timestamp: ${new Date(oldestTimestamp * 1000).toISOString()}`);
    }

    // Method 1b: Try fetching historical trades using 'before' timestamp parameter
    if (oldestTimestamp && trades.length >= 100) {
      console.log('Attempting to fetch older historical trades...');
      let historicalAttempts = 0;
      let beforeTimestamp = oldestTimestamp;
      
      while (historicalAttempts < 50) {
        const historyUrl = `${POLYMARKET_DATA_API}/trades?user=${username}&limit=${limit}&before=${beforeTimestamp}`;
        console.log(`Fetching historical trades before ${new Date(beforeTimestamp * 1000).toISOString()}`);
        
        try {
          const histResponse = await fetch(historyUrl, {
            headers: {
              'Accept': 'application/json',
              'User-Agent': 'PolyTracker/1.0',
            },
          });

          if (histResponse.ok) {
            const histData = await histResponse.json();
            if (Array.isArray(histData) && histData.length > 0) {
              const existingHashes = new Set(trades.map(t => t.transactionHash));
              const newTrades = histData.filter((t: any) => !existingHashes.has(t.transactionHash));
              
              if (newTrades.length === 0) {
                console.log('No new historical trades found');
                break;
              }
              
              trades = [...trades, ...newTrades];
              console.log(`Got ${newTrades.length} historical trades (total: ${trades.length})`);
              
              // Update beforeTimestamp to oldest in this batch
              const timestamps = histData.map((t: any) => t.timestamp).filter(Boolean);
              if (timestamps.length > 0) {
                beforeTimestamp = Math.min(...timestamps);
              } else {
                break;
              }
              
              historicalAttempts++;
            } else {
              console.log('No more historical trades available');
              break;
            }
          } else {
            console.log('Historical trades endpoint failed:', histResponse.status);
            break;
          }
        } catch (e) {
          console.error('Error fetching historical trades:', e);
          break;
        }
        
        await new Promise(resolve => setTimeout(resolve, 150));
      }
    }

    console.log(`Total trades after historical fetch: ${trades.length}`);

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

    // Method 4: CLOB API - The official REST API for ALL historical trades
    // Per Polymarket docs: "All historical trades can be fetched via the Polymarket CLOB REST API"
    try {
      console.log('Fetching ALL historical trades via CLOB API...');
      let clobCursor: string | null = null;
      let clobAttempts = 0;
      const clobMaxAttempts = 200; // Up to 100,000 trades
      
      // First, we need the maker_address or taker_address - get from Gamma API
      const gammaUserUrl = `${POLYMARKET_GAMMA_API}/users?username=${username}`;
      const gammaUserResponse = await fetch(gammaUserUrl, {
        headers: { 'Accept': 'application/json', 'User-Agent': 'PolyTracker/1.0' },
      });
      
      let userAddress: string | null = null;
      if (gammaUserResponse.ok) {
        const userData = await gammaUserResponse.json();
        userAddress = userData?.proxyWallet || userData?.address || null;
        console.log('Got user address for CLOB API:', userAddress);
      }
      
      if (userAddress) {
        while (clobAttempts < clobMaxAttempts) {
          // CLOB API uses maker or taker address
          let clobUrl = `${POLYMARKET_CLOB_API}/trades?maker_address=${userAddress}&limit=500`;
          if (clobCursor) {
            clobUrl += `&next_cursor=${clobCursor}`;
          }
          
          console.log(`CLOB API page ${clobAttempts + 1}${clobCursor ? ` (cursor: ${clobCursor.slice(0, 20)}...)` : ''}`);
          
          const clobResponse = await fetch(clobUrl, {
            headers: {
              'Accept': 'application/json',
              'User-Agent': 'PolyTracker/1.0',
            },
          });
          
          if (clobResponse.ok) {
            const clobData = await clobResponse.json();
            
            // CLOB API returns { data: [...trades], next_cursor: "..." }
            const clobTrades = clobData.data || clobData;
            
            if (Array.isArray(clobTrades) && clobTrades.length > 0) {
              const existingHashes = new Set(trades.map(t => t.transactionHash || t.id));
              const newTrades = clobTrades.filter((t: any) => 
                !existingHashes.has(t.id) && !existingHashes.has(t.transaction_hash)
              );
              
              // Map CLOB format to our format
              const mappedTrades = newTrades.map((t: any) => ({
                transactionHash: t.id || t.transaction_hash,
                side: t.side,
                size: parseFloat(t.size || t.amount || '0'),
                price: parseFloat(t.price || '0'),
                timestamp: t.created_at ? new Date(t.created_at).getTime() / 1000 : (t.match_time || Date.now() / 1000),
                title: t.market || t.condition_id || 'CLOB Trade',
                slug: t.market_slug || '',
                outcome: t.outcome || (t.asset_id?.includes('YES') ? 'Yes' : 'No'),
                conditionId: t.condition_id || t.asset_id,
                pseudonym: username,
                usdcSize: parseFloat(t.size || '0') * parseFloat(t.price || '0'),
              }));
              
              trades = [...trades, ...mappedTrades];
              console.log(`CLOB API: Got ${newTrades.length} new trades (total: ${trades.length})`);
              
              // Check for next page
              clobCursor = clobData.next_cursor || null;
              if (!clobCursor || clobTrades.length < 500) {
                console.log('CLOB API: No more pages as maker');
                break;
              }
              
              clobAttempts++;
              await new Promise(resolve => setTimeout(resolve, 100));
            } else {
              console.log('CLOB API: No more trades as maker');
              break;
            }
          } else {
            console.log('CLOB API failed:', clobResponse.status, await clobResponse.text());
            break;
          }
        }
        
        // Also try as taker
        clobCursor = null;
        clobAttempts = 0;
        
        while (clobAttempts < clobMaxAttempts) {
          let clobUrl = `${POLYMARKET_CLOB_API}/trades?taker_address=${userAddress}&limit=500`;
          if (clobCursor) {
            clobUrl += `&next_cursor=${clobCursor}`;
          }
          
          console.log(`CLOB API (taker) page ${clobAttempts + 1}`);
          
          const clobResponse = await fetch(clobUrl, {
            headers: {
              'Accept': 'application/json',
              'User-Agent': 'PolyTracker/1.0',
            },
          });
          
          if (clobResponse.ok) {
            const clobData = await clobResponse.json();
            const clobTrades = clobData.data || clobData;
            
            if (Array.isArray(clobTrades) && clobTrades.length > 0) {
              const existingHashes = new Set(trades.map(t => t.transactionHash || t.id));
              const newTrades = clobTrades.filter((t: any) => 
                !existingHashes.has(t.id) && !existingHashes.has(t.transaction_hash)
              );
              
              const mappedTrades = newTrades.map((t: any) => ({
                transactionHash: t.id || t.transaction_hash,
                side: t.side,
                size: parseFloat(t.size || t.amount || '0'),
                price: parseFloat(t.price || '0'),
                timestamp: t.created_at ? new Date(t.created_at).getTime() / 1000 : (t.match_time || Date.now() / 1000),
                title: t.market || t.condition_id || 'CLOB Trade',
                slug: t.market_slug || '',
                outcome: t.outcome || (t.asset_id?.includes('YES') ? 'Yes' : 'No'),
                conditionId: t.condition_id || t.asset_id,
                pseudonym: username,
                usdcSize: parseFloat(t.size || '0') * parseFloat(t.price || '0'),
              }));
              
              trades = [...trades, ...mappedTrades];
              console.log(`CLOB API (taker): Got ${newTrades.length} new trades (total: ${trades.length})`);
              
              clobCursor = clobData.next_cursor || null;
              if (!clobCursor || clobTrades.length < 500) {
                break;
              }
              
              clobAttempts++;
              await new Promise(resolve => setTimeout(resolve, 100));
            } else {
              break;
            }
          } else {
            break;
          }
        }
      }
      
      console.log(`Total trades after CLOB API: ${trades.length}`);
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
