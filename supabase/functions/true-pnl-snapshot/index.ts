import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Calculate current hour (truncated to the hour)
    const now = new Date();
    const currentHour = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), 0, 0, 0);

    // Fetch total deposits
    const { data: deposits } = await supabase
      .from("deposits")
      .select("amount_usd");

    const totalDeposits = deposits?.reduce((sum: number, d: any) => sum + Number(d.amount_usd), 0) || 0;

    // Fetch latest runner heartbeat for CLOB cash balance
    const { data: heartbeat } = await supabase
      .from("runner_heartbeats")
      .select("balance")
      .eq("runner_type", "v26")
      .order("last_heartbeat", { ascending: false })
      .limit(1)
      .maybeSingle();

    const clobBalance = Number(heartbeat?.balance) || 0;

    // Fetch open orders value from v26_trades (status = 'placed')
    const { data: placedOrders } = await supabase
      .from("v26_trades")
      .select("notional")
      .eq("status", "placed");

    const openOrdersValue = placedOrders?.reduce((sum: number, o: any) => sum + Number(o.notional || 0), 0) || 0;

    // Fetch running bets value from v26_trades (status = 'filled' and not yet settled)
    const { data: runningBets } = await supabase
      .from("v26_trades")
      .select("filled_shares, avg_fill_price, notional")
      .eq("status", "filled")
      .is("settled_at", null);

    const runningBetsValue = runningBets?.reduce((sum: number, t: any) => {
      const cost = t.filled_shares && t.avg_fill_price 
        ? Number(t.filled_shares) * Number(t.avg_fill_price)
        : Number(t.notional || 0);
      return sum + cost;
    }, 0) || 0;

    // Calculate portfolio value and True P&L
    const portfolioValue = clobBalance + openOrdersValue + runningBetsValue;
    const truePnL = portfolioValue - totalDeposits;
    const truePnLPercent = totalDeposits > 0 ? (truePnL / totalDeposits) * 100 : 0;

    // Upsert snapshot for current hour
    const { data: snapshot, error } = await supabase
      .from("true_pnl_snapshots")
      .upsert({
        hour: currentHour.toISOString(),
        total_deposits: totalDeposits,
        clob_balance: clobBalance,
        open_orders_value: openOrdersValue,
        running_bets_value: runningBetsValue,
        portfolio_value: portfolioValue,
        true_pnl: truePnL,
        true_pnl_percent: truePnLPercent,
      }, {
        onConflict: "hour",
      })
      .select()
      .single();

    if (error) {
      console.error("Error saving snapshot:", error);
      return new Response(
        JSON.stringify({ success: false, error: error.message }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500 }
      );
    }

    console.log(`Saved True P&L snapshot for ${currentHour.toISOString()}:`, {
      totalDeposits,
      clobBalance,
      openOrdersValue,
      runningBetsValue,
      portfolioValue,
      truePnL,
      truePnLPercent,
    });

    return new Response(
      JSON.stringify({
        success: true,
        hour: currentHour.toISOString(),
        snapshot: {
          totalDeposits,
          clobBalance,
          openOrdersValue,
          runningBetsValue,
          portfolioValue,
          truePnL,
          truePnLPercent,
        },
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("Error in true-pnl-snapshot:", err);
    return new Response(
      JSON.stringify({ success: false, error: String(err) }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500 }
    );
  }
});
