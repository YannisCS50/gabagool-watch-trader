import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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
    // Get wallet address from bot_config
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: config } = await supabase
      .from("bot_config")
      .select("polymarket_address")
      .limit(1)
      .single();

    const walletAddress = config?.polymarket_address;
    
    if (!walletAddress) {
      return new Response(
        JSON.stringify({ success: false, error: "No wallet address in bot_config" }),
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