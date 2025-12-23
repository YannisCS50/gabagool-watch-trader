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
  let pingInterval: number | null = null;

  clientSocket.onopen = () => {
    console.log("[CLOB Proxy] Client connected, connecting to CLOB market WS...");

    clobSocket = new WebSocket(CLOB_MARKET_WS_URL);

    clobSocket.onopen = () => {
      console.log("[CLOB Proxy] Connected to CLOB market WS");
      clientSocket.send(JSON.stringify({ type: "proxy_connected" }));

      // Keep-alive ping (CLOB expects plain "PING")
      pingInterval = setInterval(() => {
        try {
          if (clobSocket?.readyState === WebSocket.OPEN) {
            clobSocket.send("PING");
          }
        } catch {
          // ignore
        }
      }, 10000);
    };

    clobSocket.onmessage = (event) => {
      if (clientSocket.readyState !== WebSocket.OPEN) return;
      
      // Log incoming messages for debugging
      const data = event.data;
      if (typeof data === 'string' && data !== 'PONG') {
        try {
          const msg = JSON.parse(data);
          if (msg.event_type) {
            console.log(`[CLOB Proxy] Event: ${msg.event_type}`, 
              msg.event_type === 'price_change' ? `changes: ${msg.price_changes?.length || 0}` :
              msg.event_type === 'book' ? `asset: ${msg.asset_id?.slice(0, 20)}...` : '');
          }
        } catch {
          // Non-JSON message
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
      if (pingInterval) clearInterval(pingInterval);
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
    if (pingInterval) clearInterval(pingInterval);
    if (clobSocket?.readyState === WebSocket.OPEN) {
      clobSocket.close();
    }
  };

  clientSocket.onerror = (error) => {
    console.error("[CLOB Proxy] Client error:", error);
  };

  return response;
});
