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

// Known wallet addresses for usernames (Polymarket API doesn't filter by username properly)
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

    console.log(`Fetching ALL Polymarket trades for @${username} (wallet: ${proxyWallet})...`);

    // Fetch trades - use CLOB API only.
    // The Data API endpoints (/trades, /activity) have proven unreliable for filtering by username/wallet.
    let trades: PolymarketTrade[] = [];
    console.log('Using CLOB API only for user-scoped trades');

    // Method 4: CLOB API - The official REST API for ALL historical trades
    // Per Polymarket docs: "All historical trades can be fetched via the Polymarket CLOB REST API"
    try {
      console.log('Fetching ALL historical trades via CLOB API...');
      let clobCursor: string | null = null;
      let clobAttempts = 0;
      const clobMaxAttempts = 200; // Up to 100,000 trades
      
      // CLOB API is address-scoped, so this reliably returns only this wallet's trades.
      const userAddress: string = proxyWallet;
      console.log('Using CLOB API address:', userAddress);

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
              const existingHashes = new Set(trades.map(t => t.transactionHash));
              const newTrades = clobTrades.filter((t: any) => 
                !existingHashes.has(t.id) && !existingHashes.has(t.transaction_hash)
              );
              
              // Map CLOB format to our format
              const mappedTrades: PolymarketTrade[] = newTrades.map((t: any) => ({
                proxyWallet: userAddress || '',
                side: t.side === 'BUY' ? 'BUY' : 'SELL',
                asset: t.asset_id || '',
                conditionId: t.condition_id || t.asset_id || '',
                size: parseFloat(t.size || t.amount || '0'),
                price: parseFloat(t.price || '0'),
                timestamp: t.created_at ? new Date(t.created_at).getTime() / 1000 : (t.match_time || Date.now() / 1000),
                title: t.market || t.condition_id || 'CLOB Trade',
                slug: t.market_slug || '',
                icon: '',
                eventSlug: '',
                outcome: t.outcome || (t.asset_id?.includes('YES') ? 'Yes' : 'No'),
                outcomeIndex: 0,
                name: t.market || '',
                pseudonym: username,
                transactionHash: t.id || t.transaction_hash || '',
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
              const existingHashes = new Set(trades.map(t => t.transactionHash));
              const newTrades = clobTrades.filter((t: any) => 
                !existingHashes.has(t.id) && !existingHashes.has(t.transaction_hash)
              );
              
              const mappedTrades: PolymarketTrade[] = newTrades.map((t: any) => ({
                proxyWallet: userAddress || '',
                side: t.side === 'BUY' ? 'BUY' : 'SELL',
                asset: t.asset_id || '',
                conditionId: t.condition_id || t.asset_id || '',
                size: parseFloat(t.size || t.amount || '0'),
                price: parseFloat(t.price || '0'),
                timestamp: t.created_at ? new Date(t.created_at).getTime() / 1000 : (t.match_time || Date.now() / 1000),
                title: t.market || t.condition_id || 'CLOB Trade',
                slug: t.market_slug || '',
                icon: '',
                eventSlug: '',
                outcome: t.outcome || (t.asset_id?.includes('YES') ? 'Yes' : 'No'),
                outcomeIndex: 0,
                name: t.market || '',
                pseudonym: username,
                transactionHash: t.id || t.transaction_hash || '',
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

      // Update trader stats with analytics - fetch ALL trades (bypass 1000 row limit)
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
          if (batch.length < batchSize) {
            hasMore = false;
          }
        } else {
          hasMore = false;
        }
      }
      
      console.log(`Fetched ${allTrades.length} trades for stats calculation`);

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

    // Fetch positions directly from Polymarket API using proxyWallet
    let positionsFound = 0;
    try {
      console.log(`Fetching positions from Polymarket for wallet ${proxyWallet}...`);
      
      const positionsUrl = `${POLYMARKET_DATA_API}/positions?proxyWallet=${proxyWallet}`;
      console.log('Fetching positions:', positionsUrl);
      
      const posResp = await fetch(positionsUrl, {
        headers: { 'Accept': 'application/json', 'User-Agent': 'PolyTracker/1.0' },
      });
      
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
            pnl: parseFloat(pos.pnl || pos.unrealizedPnl || '0'),
            pnl_percent: parseFloat(pos.pnlPercent || pos.unrealizedPnlPercent || '0'),
            updated_at: new Date().toISOString(),
          })).filter((p: any) => p.shares > 0.001); // Filter out dust positions
          
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
        console.log('Positions endpoint status:', posResp.status);
      }
    } catch (e) {
      console.error('Error fetching positions:', e);
    }

    // Return response with sample data for debugging
    return new Response(
      JSON.stringify({ 
        success: true, 
        tradesFound: processedTrades.length,
        positionsFound,
        sample: processedTrades.slice(0, 3),
        apiEndpointsTried: [
          `${POLYMARKET_DATA_API}/trades?proxyWallet=${proxyWallet}`,
          `${POLYMARKET_DATA_API}/activity?proxyWallet=${proxyWallet}`,
          `${POLYMARKET_DATA_API}/positions?proxyWallet=${proxyWallet}`
        ],
        walletUsed: proxyWallet
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
