import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Polymarket Data API - no authentication required for read-only data
const POLYMARKET_DATA_API = 'https://data-api.polymarket.com';
const POLYMARKET_GAMMA_API = 'https://gamma-api.polymarket.com';

interface PolymarketActivity {
  proxyWallet: string;
  side: string;
  asset: string;
  conditionId: string;
  size: number;
  price: number;
  timestamp: number;
  title: string;
  slug: string;
  eventSlug: string;
  outcome: string;
  outcomeIndex: number;
  transactionHash: string;
  usdcSize: number;
  type: string;
}

// Known wallet addresses for usernames
const KNOWN_WALLETS: Record<string, string> = {
  'gabagool22': '0x6031b6eed1c97e853c6e0f03ad3ce3529351f96d',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { username = 'gabagool22', walletAddress } = await req.json().catch(() => ({}));
    
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

    // Use provided wallet, known wallet mapping, or try to resolve via Gamma API
    let proxyWallet = walletAddress || KNOWN_WALLETS[username];
    
    if (!proxyWallet) {
      // Try to get wallet from Gamma API
      console.log(`Looking up wallet for @${username} via Gamma API...`);
      try {
        const gammaUrl = `${POLYMARKET_GAMMA_API}/users?username=${username}`;
        const gammaResp = await fetch(gammaUrl, {
          headers: { 'Accept': 'application/json', 'User-Agent': 'PolyTracker/1.0' },
        });
        if (gammaResp.ok) {
          const userData = await gammaResp.json();
          proxyWallet = userData?.proxyWallet || userData?.address;
        }
      } catch (e) {
        console.error('Gamma API lookup failed:', e);
      }
    }

    if (!proxyWallet) {
      return new Response(
        JSON.stringify({ success: false, error: `Could not find wallet for @${username}. Please provide walletAddress.` }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`Fetching Polymarket data for @${username} (wallet: ${proxyWallet})...`);

    // ========== FETCH ACTIVITY (TRADES) ==========
    // Use Data API /activity endpoint with 'user' parameter (NOT proxyWallet)
    let allActivities: PolymarketActivity[] = [];
    
    try {
      // Try multiple endpoints and parameters
      const endpoints = [
        `${POLYMARKET_DATA_API}/activity?user=${proxyWallet}&limit=500`,
        `${POLYMARKET_DATA_API}/activity?proxyWallet=${proxyWallet}&limit=500`,
        `${POLYMARKET_DATA_API}/trades?user=${proxyWallet}&limit=500`,
      ];

      for (const url of endpoints) {
        console.log(`Trying: ${url}`);
        const resp = await fetch(url, {
          headers: { 'Accept': 'application/json', 'User-Agent': 'PolyTracker/1.0' },
        });
        
        console.log(`Response status: ${resp.status}`);
        
        if (resp.ok) {
          const data = await resp.json();
          console.log(`Response data type: ${Array.isArray(data) ? 'array' : typeof data}, length: ${Array.isArray(data) ? data.length : 'N/A'}`);
          
          if (Array.isArray(data) && data.length > 0) {
            // Filter to only trades for this wallet
            const walletActivities = data.filter((item: any) => 
              item.proxyWallet?.toLowerCase() === proxyWallet.toLowerCase() ||
              item.user?.toLowerCase() === proxyWallet.toLowerCase()
            );
            
            console.log(`Found ${walletActivities.length} activities for wallet`);
            
            if (walletActivities.length > 0) {
              allActivities = walletActivities;
              break;
            }
          }
        } else {
          const errorText = await resp.text();
          console.log(`Error response: ${errorText.slice(0, 200)}`);
        }
      }

      // Paginate if we got results
      if (allActivities.length === 500) {
        let offset = 500;
        while (offset < 10000) { // Safety limit
          const url = `${POLYMARKET_DATA_API}/activity?user=${proxyWallet}&limit=500&offset=${offset}`;
          console.log(`Fetching page at offset ${offset}...`);
          
          const resp = await fetch(url, {
            headers: { 'Accept': 'application/json', 'User-Agent': 'PolyTracker/1.0' },
          });
          
          if (resp.ok) {
            const data = await resp.json();
            if (Array.isArray(data) && data.length > 0) {
              const filtered = data.filter((item: any) => 
                item.proxyWallet?.toLowerCase() === proxyWallet.toLowerCase()
              );
              allActivities = [...allActivities, ...filtered];
              if (data.length < 500) break;
              offset += 500;
            } else {
              break;
            }
          } else {
            break;
          }
        }
      }
      
      console.log(`Total activities fetched: ${allActivities.length}`);
    } catch (e) {
      console.error('Activity fetch error:', e);
    }

    // Process activities into trades
    const processedTrades: any[] = [];
    
    for (const activity of allActivities) {
      // Only include BUY/SELL activities (not deposits, withdrawals, etc.)
      const activityType = activity.type?.toLowerCase() || '';
      const side = activity.side?.toUpperCase() || '';
      
      if (side !== 'BUY' && side !== 'SELL') {
        continue;
      }
      
      const usdcSize = activity.usdcSize || (activity.size * activity.price);
      const timestamp = typeof activity.timestamp === 'number' 
        ? (activity.timestamp > 1e12 ? activity.timestamp : activity.timestamp * 1000)
        : new Date(activity.timestamp).getTime();
      
      processedTrades.push({
        external_id: activity.transactionHash || `${activity.conditionId}-${timestamp}-${Math.random().toString(36).substr(2, 9)}`,
        trader_username: username,
        timestamp: new Date(timestamp).toISOString(),
        market: activity.title || 'Unknown Market',
        market_slug: activity.slug || activity.eventSlug || '',
        outcome: activity.outcome || (activity.outcomeIndex === 0 ? 'Yes' : 'No'),
        side: side.toLowerCase(),
        shares: activity.size || 0,
        price: activity.price || 0,
        total: usdcSize,
        status: 'filled',
      });
    }

    console.log(`Processed ${processedTrades.length} trades for storage`);

    // Deduplicate by external_id
    const uniqueTrades = Array.from(
      new Map(processedTrades.map(t => [t.external_id, t])).values()
    );
    console.log(`After deduplication: ${uniqueTrades.length} trades`);

    if (uniqueTrades.length > 0) {
      // Insert trades into database (upsert to avoid duplicates)
      const { error: insertError } = await supabase
        .from('trades')
        .upsert(uniqueTrades, { 
          onConflict: 'external_id',
          ignoreDuplicates: true 
        });
      
      if (insertError) {
        console.error('Error inserting trades:', insertError);
      } else {
        console.log(`Successfully stored trades`);
      }

      // Update trader stats
      let allTrades: any[] = [];
      let offset = 0;
      const batchSize = 1000;
      let hasMore = true;
      
      while (hasMore) {
        const { data: batch } = await supabase
          .from('trades')
          .select('*')
          .eq('trader_username', username)
          .range(offset, offset + batchSize - 1);
        
        if (batch && batch.length > 0) {
          allTrades = [...allTrades, ...batch];
          offset += batchSize;
          if (batch.length < batchSize) hasMore = false;
        } else {
          hasMore = false;
        }
      }
      
      console.log(`Fetched ${allTrades.length} trades for stats calculation`);

      if (allTrades.length > 0) {
        const totalTrades = allTrades.length;
        const totalVolume = allTrades.reduce((sum: number, t: any) => sum + Number(t.total), 0);
        const avgTradeSize = totalVolume / totalTrades;
        
        const buys = allTrades.filter((t: any) => t.side === 'buy');
        const sells = allTrades.filter((t: any) => t.side === 'sell');
        
        const estimatedWinRate = sells.length > 0 
          ? Math.min(95, 50 + (sells.length / Math.max(buys.length, 1)) * 20) 
          : 50;

        const latestTrade = allTrades.reduce((latest: number, t: any) => {
          const tTime = new Date(t.timestamp).getTime();
          return tTime > latest ? tTime : latest;
        }, 0);

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

    // ========== FETCH POSITIONS ==========
    let positionsFound = 0;
    try {
      console.log(`Fetching positions for wallet ${proxyWallet}...`);
      
      // Use 'user' parameter as per documentation
      const positionsUrl = `${POLYMARKET_DATA_API}/positions?user=${proxyWallet}&sizeThreshold=0.01&limit=500`;
      console.log('Fetching positions:', positionsUrl);
      
      const posResp = await fetch(positionsUrl, {
        headers: { 'Accept': 'application/json', 'User-Agent': 'PolyTracker/1.0' },
      });
      
      console.log('Positions response status:', posResp.status);
      
      if (posResp.ok) {
        const positionsData = await posResp.json();
        console.log(`Received ${Array.isArray(positionsData) ? positionsData.length : 0} positions`);
        
        if (Array.isArray(positionsData) && positionsData.length > 0) {
          // First, clear old positions for this user
          await supabase
            .from('positions')
            .delete()
            .eq('trader_username', username);
          
          // Process and store new positions
          const processedPositions = positionsData.map((pos: any) => ({
            trader_username: username,
            market: pos.title || pos.market || 'Unknown',
            market_slug: pos.slug || pos.eventSlug || '',
            outcome: pos.outcome || (pos.outcomeIndex === 0 ? 'Yes' : 'No'),
            shares: parseFloat(pos.size || pos.shares || '0'),
            avg_price: parseFloat(pos.avgPrice || pos.averagePrice || pos.price || '0'),
            current_price: parseFloat(pos.curPrice || pos.currentPrice || pos.price || '0'),
            pnl: parseFloat(pos.cashPnl || pos.pnl || pos.unrealizedPnl || '0'),
            pnl_percent: parseFloat(pos.percentPnl || pos.pnlPercent || '0'),
            updated_at: new Date().toISOString(),
          })).filter((p: any) => p.shares > 0.001);
          
          if (processedPositions.length > 0) {
            const { error: posError } = await supabase
              .from('positions')
              .insert(processedPositions);
              
            if (posError) {
              console.error('Error inserting positions:', posError);
            } else {
              positionsFound = processedPositions.length;
              console.log(`Stored ${positionsFound} positions`);
            }
          }
        }
      } else {
        const errorText = await posResp.text();
        console.log('Positions endpoint error:', errorText.slice(0, 200));
      }
    } catch (e) {
      console.error('Error fetching positions:', e);
    }

    return new Response(
      JSON.stringify({ 
        success: true, 
        tradesFound: uniqueTrades.length,
        positionsFound,
        sample: uniqueTrades.slice(0, 3),
        walletUsed: proxyWallet
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error: unknown) {
    console.error('Scraper error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ success: false, error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
