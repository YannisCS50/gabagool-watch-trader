import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const RTDS_URL = 'wss://rtds.polymarket.com';

interface Subscription {
  topic: string;
  type: string;
  filters?: string;
}

interface SubscribeRequest {
  subscriptions: Subscription[];
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  // Check for WebSocket upgrade
  const upgradeHeader = req.headers.get('upgrade') || '';
  
  if (upgradeHeader.toLowerCase() === 'websocket') {
    // WebSocket proxy mode
    const { socket: clientSocket, response } = Deno.upgradeWebSocket(req);
    
    let rtdsSocket: WebSocket | null = null;
    let pingInterval: number | null = null;
    
    clientSocket.onopen = () => {
      console.log('[RTDS Proxy] Client connected, connecting to Polymarket RTDS...');
      
      rtdsSocket = new WebSocket(RTDS_URL);
      
      rtdsSocket.onopen = () => {
        console.log('[RTDS Proxy] Connected to Polymarket RTDS');
        clientSocket.send(JSON.stringify({ type: 'proxy_connected' }));
        
        // Keep-alive ping to RTDS
        pingInterval = setInterval(() => {
          if (rtdsSocket?.readyState === WebSocket.OPEN) {
            rtdsSocket.send(JSON.stringify({ action: 'ping' }));
          }
        }, 30000);
      };
      
      rtdsSocket.onmessage = (event) => {
        // Forward RTDS messages to client
        if (clientSocket.readyState === WebSocket.OPEN) {
          clientSocket.send(event.data);
        }
      };
      
      rtdsSocket.onerror = (error) => {
        console.error('[RTDS Proxy] RTDS error:', error);
        if (clientSocket.readyState === WebSocket.OPEN) {
          clientSocket.send(JSON.stringify({ type: 'proxy_error', error: 'RTDS connection failed' }));
        }
      };
      
      rtdsSocket.onclose = (event) => {
        console.log('[RTDS Proxy] RTDS disconnected:', event.code, event.reason);
        if (pingInterval) clearInterval(pingInterval);
        if (clientSocket.readyState === WebSocket.OPEN) {
          clientSocket.send(JSON.stringify({ type: 'proxy_disconnected', code: event.code }));
          clientSocket.close();
        }
      };
    };
    
    clientSocket.onmessage = (event) => {
      // Forward client messages to RTDS
      if (rtdsSocket?.readyState === WebSocket.OPEN) {
        console.log('[RTDS Proxy] Forwarding to RTDS:', event.data);
        rtdsSocket.send(event.data);
      }
    };
    
    clientSocket.onclose = () => {
      console.log('[RTDS Proxy] Client disconnected');
      if (pingInterval) clearInterval(pingInterval);
      if (rtdsSocket?.readyState === WebSocket.OPEN) {
        rtdsSocket.close();
      }
    };
    
    clientSocket.onerror = (error) => {
      console.error('[RTDS Proxy] Client error:', error);
    };
    
    return response;
  }
  
  // Non-WebSocket: REST API mode - fetch current prices from Polymarket APIs
  try {
    const body = await req.json().catch(() => ({}));
    const marketSlugs = body.market_slugs || [];
    
    console.log('[RTDS Proxy] REST mode - fetching prices for', marketSlugs.length, 'markets');
    
    // Fetch crypto prices from Polymarket data API
    const cryptoPricesPromise = fetch('https://data-api.polymarket.com/prices?assets=btc,eth')
      .then(r => r.ok ? r.json() : null)
      .catch(() => null);
    
    // Fetch market prices if slugs provided
    let marketPrices: Record<string, { up: number; down: number }> = {};
    
    if (marketSlugs.length > 0) {
      // Try to get prices from gamma API for each slug
      const pricePromises = marketSlugs.map(async (slug: string) => {
        try {
          const response = await fetch(`https://gamma-api.polymarket.com/markets?slug=${slug}`);
          if (response.ok) {
            const markets = await response.json();
            if (markets.length > 0) {
              const market = markets[0];
              // outcomePrices is usually [yesPrice, noPrice]
              const prices = market.outcomePrices || [0.5, 0.5];
              return { slug, up: parseFloat(prices[0]) || 0.5, down: parseFloat(prices[1]) || 0.5 };
            }
          }
        } catch (e) {
          console.error('[RTDS Proxy] Error fetching', slug, e);
        }
        return { slug, up: 0.5, down: 0.5 };
      });
      
      const results = await Promise.all(pricePromises);
      for (const r of results) {
        marketPrices[r.slug] = { up: r.up, down: r.down };
      }
    }
    
    const cryptoPrices = await cryptoPricesPromise;
    
    return new Response(JSON.stringify({
      success: true,
      timestamp: new Date().toISOString(),
      crypto: {
        btc: cryptoPrices?.btc || null,
        eth: cryptoPrices?.eth || null
      },
      markets: marketPrices
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
    
  } catch (error) {
    console.error('[RTDS Proxy] Error:', error);
    return new Response(JSON.stringify({ 
      success: false, 
      error: error instanceof Error ? error.message : 'Unknown error' 
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});
