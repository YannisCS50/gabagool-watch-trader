import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.4";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Supabase setup
const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

interface PriceLog {
  source: string;
  asset: string;
  price: number;
  raw_timestamp: number | null;
}

// Fetch prices from Polymarket RTDS REST endpoint
async function fetchPolymarketPrices(): Promise<PriceLog[]> {
  const logs: PriceLog[] = [];
  
  try {
    // Polymarket data API for crypto prices
    const response = await fetch('https://data-api.polymarket.com/prices?assets=btc,eth,sol,xrp');
    if (response.ok) {
      const data = await response.json();
      const timestamp = Date.now();
      
      for (const [asset, price] of Object.entries(data)) {
        if (typeof price === 'number' && price > 0) {
          logs.push({
            source: 'polymarket_api',
            asset: asset.toUpperCase(),
            price,
            raw_timestamp: timestamp
          });
        }
      }
    }
  } catch (e) {
    console.error('[PriceFeedLogger] Polymarket fetch error:', e);
  }
  
  return logs;
}

// Fetch prices from Chainlink via Polymarket's RTDS REST
async function fetchChainlinkPrices(): Promise<PriceLog[]> {
  const logs: PriceLog[] = [];
  
  try {
    // Try the gamma-api for market data which includes oracle prices
    const response = await fetch('https://clob.polymarket.com/prices', {
      headers: { 'Accept': 'application/json' }
    });
    
    if (response.ok) {
      const data = await response.json();
      const timestamp = Date.now();
      
      // Parse chainlink prices if available
      if (data.chainlink) {
        for (const [asset, price] of Object.entries(data.chainlink)) {
          if (typeof price === 'number' && price > 0) {
            logs.push({
              source: 'chainlink_api',
              asset: asset.toUpperCase(),
              price,
              raw_timestamp: timestamp
            });
          }
        }
      }
    }
  } catch (e) {
    console.error('[PriceFeedLogger] Chainlink fetch error:', e);
  }
  
  // Fallback: Try Alchemy for Chainlink prices
  if (logs.length === 0) {
    const alchemyKey = Deno.env.get('ALCHEMY_POLYGON_API_KEY');
    if (alchemyKey) {
      const chainlinkFeeds: Record<string, string> = {
        'BTC': '0xc907E116054Ad103354f2D350FD2514433D57F6f',
        'ETH': '0xF9680D99D6C9589e2a93a78A04A279e509205945',
        'SOL': '0x10C8264C0935b3B9870013e057f330Ff3e9C56dC',
        'XRP': '0x785ba89291f676b5386652eB12b30cF361020694'
      };
      
      for (const [asset, address] of Object.entries(chainlinkFeeds)) {
        try {
          const response = await fetch(`https://polygon-mainnet.g.alchemy.com/v2/${alchemyKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'eth_call',
              params: [{
                to: address,
                data: '0x50d25bcd' // latestAnswer()
              }, 'latest']
            })
          });
          
          if (response.ok) {
            const result = await response.json();
            if (result.result && result.result !== '0x') {
              const rawPrice = BigInt(result.result);
              const price = Number(rawPrice) / 1e8;
              
              if (price > 0) {
                logs.push({
                  source: 'chainlink_alchemy',
                  asset,
                  price,
                  raw_timestamp: Date.now()
                });
              }
            }
          }
        } catch (e) {
          console.error(`[PriceFeedLogger] Alchemy ${asset} error:`, e);
        }
      }
    }
  }
  
  return logs;
}

async function saveLogs(logs: PriceLog[]) {
  if (logs.length === 0) return { success: true, count: 0 };
  
  const supabase = createClient(supabaseUrl, supabaseServiceKey);
  
  const { error, count } = await supabase
    .from('realtime_price_logs')
    .insert(logs.map(log => ({
      source: log.source,
      asset: log.asset,
      price: log.price,
      raw_timestamp: log.raw_timestamp,
      received_at: new Date().toISOString()
    })));
  
  if (error) {
    console.error('[PriceFeedLogger] Insert error:', error.message);
    return { success: false, error: error.message };
  }
  
  return { success: true, count: logs.length };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }
  
  const url = new URL(req.url);
  const action = url.searchParams.get('action') || 'collect';
  
  try {
    switch (action) {
      case 'collect': {
        // Collect from both sources and save
        const [polymarketLogs, chainlinkLogs] = await Promise.all([
          fetchPolymarketPrices(),
          fetchChainlinkPrices()
        ]);
        
        const allLogs = [...polymarketLogs, ...chainlinkLogs];
        const result = await saveLogs(allLogs);
        
        console.log(`[PriceFeedLogger] Collected ${allLogs.length} price logs`);
        
        return new Response(JSON.stringify({
          success: true,
          collected: allLogs.length,
          polymarket: polymarketLogs.length,
          chainlink: chainlinkLogs.length,
          saved: result.success,
          logs: allLogs.map(l => ({ source: l.source, asset: l.asset, price: l.price }))
        }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
      
      case 'status': {
        const supabase = createClient(supabaseUrl, supabaseServiceKey);
        
        // Get recent log counts
        const now = new Date();
        const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
        
        const { count: totalCount } = await supabase
          .from('realtime_price_logs')
          .select('*', { count: 'exact', head: true });
        
        const { count: lastHourCount } = await supabase
          .from('realtime_price_logs')
          .select('*', { count: 'exact', head: true })
          .gte('created_at', oneHourAgo.toISOString());
        
        const { data: latestLogs } = await supabase
          .from('realtime_price_logs')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(10);
        
        return new Response(JSON.stringify({
          success: true,
          totalLogs: totalCount || 0,
          lastHourLogs: lastHourCount || 0,
          latestLogs: latestLogs || []
        }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
      
      default:
        return new Response(JSON.stringify({
          success: false,
          error: 'Unknown action. Use ?action=collect or ?action=status'
        }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    }
  } catch (error) {
    console.error('[PriceFeedLogger] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});
