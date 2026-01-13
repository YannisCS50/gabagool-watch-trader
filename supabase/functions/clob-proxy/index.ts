import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const CLOB_MARKET_WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const upgradeHeader = req.headers.get("upgrade") || "";
  if (upgradeHeader.toLowerCase() !== "websocket") {
    return new Response(
      JSON.stringify({
        success: false,
        error: "This endpoint is WebSocket-only",
      }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const { socket: clientSocket, response } = Deno.upgradeWebSocket(req);

  let clobSocket: WebSocket | null = null;
  let clobPingInterval: number | null = null;
  let clientPingInterval: number | null = null;

  clientSocket.onopen = () => {
    console.log("[CLOB Proxy] Client connected, connecting to CLOB market WS...");

    clobSocket = new WebSocket(CLOB_MARKET_WS_URL);

    clobSocket.onopen = () => {
      console.log("[CLOB Proxy] Connected to CLOB market WS");
      clientSocket.send(JSON.stringify({ type: "proxy_connected" }));

      // Keep-alive ping to CLOB (expects plain "PING")
      clobPingInterval = setInterval(() => {
        try {
          if (clobSocket?.readyState === WebSocket.OPEN) {
            clobSocket.send("PING");
          }
        } catch {
          // ignore
        }
      }, 10000);
      
      // Keep-alive ping to client (prevents edge function timeout)
      clientPingInterval = setInterval(() => {
        try {
          if (clientSocket.readyState === WebSocket.OPEN) {
            clientSocket.send(JSON.stringify({ type: "ping", ts: Date.now() }));
          }
        } catch {
          // ignore
        }
      }, 5000);
    };

    clobSocket.onmessage = (event) => {
      if (clientSocket.readyState !== WebSocket.OPEN) return;
      
      const data = event.data;
      if (typeof data === 'string') {
        // Skip PONG messages
        if (data === 'PONG') {
          console.log("[CLOB Proxy] Received PONG");
          return;
        }
        
        try {
          const msg = JSON.parse(data);
          
          // Log orderbook updates with prices
          if (msg.event_type === 'book') {
            const bestAsk = msg.asks?.[0]?.[0] || 'none';
            const bestBid = msg.bids?.[0]?.[0] || 'none';
            console.log(`[CLOB Proxy] Book: asset=${msg.asset_id?.slice(0, 16)}... ask=${bestAsk} bid=${bestBid}`);
          } else if (msg.event_type === 'price_change') {
            console.log(`[CLOB Proxy] Price changes: ${msg.price_changes?.length || 0}`);
            for (const pc of (msg.price_changes || [])) {
              console.log(`  - ${pc.asset_id?.slice(0, 16)}... price=${pc.price}`);
            }
          } else if (msg.event_type) {
            console.log(`[CLOB Proxy] Event: ${msg.event_type}`);
          }
        } catch {
          console.log(`[CLOB Proxy] Non-JSON message: ${data.slice(0, 50)}`);
        }
      }
      
      clientSocket.send(data);
    };

    clobSocket.onerror = (error) => {
      console.error("[CLOB Proxy] CLOB error:", error);
      if (clientSocket.readyState === WebSocket.OPEN) {
        clientSocket.send(JSON.stringify({ type: "proxy_error", error: "CLOB connection failed" }));
      }
    };

    clobSocket.onclose = (event) => {
      console.log("[CLOB Proxy] CLOB disconnected:", event.code, event.reason);
      if (clobPingInterval) clearInterval(clobPingInterval);
      if (clientPingInterval) clearInterval(clientPingInterval);
      if (clientSocket.readyState === WebSocket.OPEN) {
        clientSocket.send(JSON.stringify({ type: "proxy_disconnected", code: event.code }));
        clientSocket.close();
      }
    };
  };

  clientSocket.onmessage = (event) => {
    // Log client subscribe messages
    try {
      const msg = JSON.parse(event.data);
      if (msg.type || msg.assets_ids) {
        console.log(`[CLOB Proxy] Client subscribe:`, 
          msg.type || 'market', 
          `tokens: ${msg.assets_ids?.length || 0}`);
      }
    } catch {
      // Non-JSON
    }
    
    // Forward client messages to CLOB
    if (clobSocket?.readyState === WebSocket.OPEN) {
      clobSocket.send(event.data);
    }
  };

  clientSocket.onclose = () => {
    console.log("[CLOB Proxy] Client disconnected");
    if (clobPingInterval) clearInterval(clobPingInterval);
    if (clientPingInterval) clearInterval(clientPingInterval);
    if (clobSocket?.readyState === WebSocket.OPEN) {
      clobSocket.close();
    }
  };

  clientSocket.onerror = (error) => {
    console.error("[CLOB Proxy] Client error:", error);
  };

  return response;
});
