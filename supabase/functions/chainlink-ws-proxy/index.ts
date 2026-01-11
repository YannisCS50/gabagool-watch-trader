import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

// Chainlink price feed addresses on Polygon
const CHAINLINK_FEEDS: Record<string, string> = {
  BTC: '0xc907E116054Ad103354f2D350FD2514433D57F6f',
  ETH: '0xF9680D99D6C9589e2a93a78A04A279e509205945',
  SOL: '0x10C8264C0935b3B9870013e057f330Ff3e9C56dC',
  XRP: '0x785ba89291f676b5386652eB12b30cF361020694',
};

// AnswerUpdated event signature: keccak256("AnswerUpdated(int256,uint256,uint256)")
const ANSWER_UPDATED_TOPIC = '0x0559884fd3a460db3073b7fc896cc77986f16e378210ded43186175bf646fc5f';

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const alchemyKey = Deno.env.get('ALCHEMY_POLYGON_API_KEY');
  if (!alchemyKey) {
    return new Response(JSON.stringify({ error: 'ALCHEMY_POLYGON_API_KEY not configured' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // Return configuration for client-side WebSocket
  // Since edge functions can't maintain persistent connections, we return the WSS URL for client use
  const wssUrl = `wss://polygon-mainnet.g.alchemy.com/v2/${alchemyKey}`;
  
  // Also return the subscription payload
  const subscriptionPayload = {
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_subscribe',
    params: [
      'logs',
      {
        address: Object.values(CHAINLINK_FEEDS),
        topics: [ANSWER_UPDATED_TOPIC],
      },
    ],
  };

  return new Response(JSON.stringify({
    success: true,
    wssUrl,
    subscriptionPayload,
    feeds: CHAINLINK_FEEDS,
    eventTopic: ANSWER_UPDATED_TOPIC,
  }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});