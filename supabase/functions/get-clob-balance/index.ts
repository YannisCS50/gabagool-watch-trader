import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const CLOB_URL = "https://clob.polymarket.com";

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const walletAddress = Deno.env.get("POLYMARKET_WALLET_ADDRESS");
    
    if (!walletAddress) {
      return new Response(
        JSON.stringify({ success: false, error: "POLYMARKET_WALLET_ADDRESS not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Fetch balance from CLOB API
    const response = await fetch(`${CLOB_URL}/balance?address=${walletAddress}`);
    
    if (!response.ok) {
      throw new Error(`CLOB API returned ${response.status}`);
    }

    const data = await response.json();
    
    // CLOB returns balance in USDC (6 decimals)
    const balanceUsdc = parseFloat(data.balance || data.usdc || "0") / 1_000_000;

    return new Response(
      JSON.stringify({ 
        success: true, 
        balance: balanceUsdc,
        raw: data 
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Error fetching CLOB balance:", message);
    return new Response(
      JSON.stringify({ success: false, error: message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
