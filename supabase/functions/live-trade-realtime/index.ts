// ============================================================================
// LIVE TRADING BOT - DISABLED (V29 runner is now the only active bot)
// This edge function is kept for reference but does nothing
// ============================================================================

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  // WebSocket upgrade - just close immediately
  const upgrade = req.headers.get('upgrade') || '';
  if (upgrade.toLowerCase() === 'websocket') {
    const { socket, response } = Deno.upgradeWebSocket(req);
    socket.onopen = () => {
      socket.send(JSON.stringify({ 
        type: 'status', 
        message: 'DISABLED - V29 runner is the only active bot',
        enabled: false 
      }));
      socket.close(1000, 'Bot disabled - use V29 runner');
    };
    return response;
  }

  // Regular HTTP - return disabled status
  return new Response(
    JSON.stringify({ 
      success: true, 
      message: 'live-trade-realtime is DISABLED. V29 runner is now the only active bot.',
      enabled: false
    }),
    { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  );
});
