import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Chainlink price feed addresses on Polygon
const CHAINLINK_FEEDS: Record<string, string> = {
  BTC: '0xc907E116054Ad103354f2D350FD2514433D57F6f',
  ETH: '0xF9680D99D6C9589e2a93a78A04A279e509205945',
  SOL: '0x10C8264C0935b3B9870013e057f330Ff3e9C56dC',
  XRP: '0x785ba89291f676b5386652eB12b30cF361020694',
};

const RPC_URL = 'https://polygon-rpc.com';

// Fetch price from Chainlink via RPC
async function fetchChainlinkPrice(asset: string): Promise<{ price: number; timestamp: number } | null> {
  const feedAddress = CHAINLINK_FEEDS[asset];
  if (!feedAddress) return null;

  try {
    // latestRoundData() selector: 0xfeaf968c
    const response = await fetch(RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_call',
        params: [{ to: feedAddress, data: '0xfeaf968c' }, 'latest'],
      }),
    });

    if (!response.ok) return null;

    const json = await response.json();
    if (!json.result || json.result === '0x') return null;

    const data = json.result.slice(2);
    // Decode: roundId (32), answer (32), startedAt (32), updatedAt (32), answeredInRound (32)
    const answerHex = data.slice(64, 128);
    const updatedAtHex = data.slice(128, 192);

    const answer = BigInt('0x' + answerHex);
    const updatedAt = BigInt('0x' + updatedAtHex);

    // Chainlink uses 8 decimals for USD pairs
    const price = Number(answer) / 1e8;
    const timestamp = Number(updatedAt) * 1000; // Convert to ms

    return { price, timestamp };
  } catch (e) {
    console.error(`Chainlink fetch error for ${asset}:`, e);
    return null;
  }
}

// Fetch price from Binance API
async function fetchBinancePrice(symbol: string): Promise<{ price: number; timestamp: number } | null> {
  try {
    const response = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`);
    if (!response.ok) return null;
    
    const data = await response.json();
    return {
      price: parseFloat(data.price),
      timestamp: Date.now(), // Binance ticker doesn't include timestamp, use current
    };
  } catch (e) {
    console.error(`Binance fetch error for ${symbol}:`, e);
    return null;
  }
}

const ASSET_SYMBOLS: Record<string, string> = {
  BTC: 'BTCUSDT',
  ETH: 'ETHUSDT',
  SOL: 'SOLUSDT',
  XRP: 'XRPUSDT',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const assets: string[] = body.assets || ['BTC', 'ETH', 'SOL', 'XRP'];
    const chainlinkOnly: boolean = body.chainlinkOnly || false;

    console.log(`[price-feeds] Fetching ${chainlinkOnly ? 'Chainlink only' : 'all'} prices for: ${assets.join(', ')}`);

    const results: Record<string, {
      binance?: number;
      chainlink?: number;
      binance_ts?: number;
      chainlink_ts?: number;
    }> = {};

    // Fetch all prices in parallel
    const promises = assets.map(async (asset) => {
      const symbol = ASSET_SYMBOLS[asset];
      if (!symbol) return;

      if (chainlinkOnly) {
        // Only fetch Chainlink
        const chainlinkData = await fetchChainlinkPrice(asset);
        results[asset] = {
          chainlink: chainlinkData?.price,
          chainlink_ts: chainlinkData?.timestamp,
        };
      } else {
        // Fetch both
        const [binanceData, chainlinkData] = await Promise.all([
          fetchBinancePrice(symbol),
          fetchChainlinkPrice(asset),
        ]);

        results[asset] = {
          binance: binanceData?.price,
          binance_ts: binanceData?.timestamp,
          chainlink: chainlinkData?.price,
          chainlink_ts: chainlinkData?.timestamp,
        };
      }
    });

    await Promise.all(promises);

    return new Response(JSON.stringify({
      success: true,
      timestamp: Date.now(),
      prices: results,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('[price-feeds] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
