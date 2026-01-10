import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { TrendingUp, TrendingDown, DollarSign, BarChart3 } from "lucide-react";
import { TruePnLModal } from "./TruePnLModal";

interface TruePnLData {
  totalDeposits: number;
  clobBalance: number;
  openOrdersValue: number;
  openPositionsValue: number;
  portfolioValue: number;
  truePnL: number;
  truePnLPercent: number;
}

export function TruePnLCard() {
  const [modalOpen, setModalOpen] = useState(false);
  
  const { data, isLoading } = useQuery<TruePnLData>({
    queryKey: ["true-pnl"],
    queryFn: async () => {
      // Fetch total deposits
      const { data: deposits } = await supabase
        .from("deposits")
        .select("amount_usd");

      const totalDeposits = deposits?.reduce((sum, d) => sum + Number(d.amount_usd), 0) || 0;

      // Fetch latest runner heartbeat for CLOB cash balance
      const { data: heartbeat } = await supabase
        .from("runner_heartbeats")
        .select("balance")
        .eq("runner_type", "v26")
        .order("last_heartbeat", { ascending: false })
        .limit(1)
        .maybeSingle();

      const clobBalance = heartbeat?.balance || 0;

      // Fetch open orders value from v26_trades (status = 'placed')
      const { data: placedOrders } = await supabase
        .from("v26_trades")
        .select("notional")
        .eq("status", "placed");

      const openOrdersValue = placedOrders?.reduce((sum, o) => sum + Number(o.notional || 0), 0) || 0;

      // Fetch running bets value from v26_trades (status = 'filled' and not yet settled)
      const { data: runningBets } = await supabase
        .from("v26_trades")
        .select("filled_shares, avg_fill_price, notional")
        .eq("status", "filled")
        .is("settled_at", null);

      const openPositionsValue = runningBets?.reduce((sum, t) => {
        // Use actual fill cost if available, otherwise use notional
        const cost = t.filled_shares && t.avg_fill_price 
          ? Number(t.filled_shares) * Number(t.avg_fill_price)
          : Number(t.notional || 0);
        return sum + cost;
      }, 0) || 0;

      // Portfolio value = CLOB balance + open orders + open positions
      const portfolioValue = clobBalance + openOrdersValue + openPositionsValue;

      // True P&L = Portfolio Value - Total Deposits
      const truePnL = portfolioValue - totalDeposits;
      const truePnLPercent = totalDeposits > 0 ? (truePnL / totalDeposits) * 100 : 0;

      return { totalDeposits, clobBalance, openOrdersValue, openPositionsValue, portfolioValue, truePnL, truePnLPercent };
    },
    refetchInterval: 30000,
  });

  if (isLoading) {
    return (
      <div className="flex items-center gap-6 p-3 rounded-lg bg-muted/30 text-sm">
        <span className="text-muted-foreground">Loading True P&L...</span>
      </div>
    );
  }

  const clobBalance = data?.clobBalance ?? 0;
  const openOrdersValue = data?.openOrdersValue ?? 0;
  const openPositionsValue = data?.openPositionsValue ?? 0;
  const hasClobBalance = clobBalance > 0;
  
  const isPositive = (data?.truePnL ?? 0) >= 0;
  const TrendIcon = isPositive ? TrendingUp : TrendingDown;

  return (
    <>
      <div 
        className="flex flex-wrap items-center gap-x-6 gap-y-2 p-3 rounded-lg bg-muted/30 text-sm cursor-pointer hover:bg-muted/50 transition-colors"
        onClick={() => setModalOpen(true)}
      >
        <div className="flex items-center gap-2">
          <DollarSign className="h-4 w-4 text-muted-foreground" />
          <span className="text-muted-foreground">Deposits:</span>
          <span className="font-medium">${data?.totalDeposits.toLocaleString()}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">CLOB Cash:</span>
          <span className="font-medium">${clobBalance.toLocaleString()}</span>
        </div>
        {openOrdersValue > 0 && (
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">Open Orders:</span>
            <span className="font-medium">${openOrdersValue.toLocaleString()}</span>
          </div>
        )}
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">Running Bets:</span>
          <span className="font-medium">${openPositionsValue.toLocaleString()}</span>
        </div>
        {hasClobBalance ? (
          <>
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">Portfolio:</span>
              <span className="font-bold">${data?.portfolioValue.toLocaleString()}</span>
            </div>
            <div className="flex items-center gap-2">
              <TrendIcon className={`h-4 w-4 ${isPositive ? 'text-green-500' : 'text-red-500'}`} />
              <span className="text-muted-foreground">True P&L:</span>
              <span className={`font-bold ${isPositive ? 'text-green-500' : 'text-red-500'}`}>
                {isPositive ? '+' : ''}${data?.truePnL.toLocaleString()} ({data?.truePnLPercent.toFixed(1)}%)
              </span>
            </div>
            <div className="flex items-center gap-1 text-muted-foreground ml-auto">
              <BarChart3 className="h-4 w-4" />
              <span className="text-xs">Click for hourly</span>
            </div>
          </>
        ) : (
          <div className="flex items-center gap-2 text-amber-500">
            <span className="text-xs">⚠️ CLOB balance not available (restart runner)</span>
          </div>
        )}
      </div>
      <TruePnLModal open={modalOpen} onOpenChange={setModalOpen} />
    </>
  );
}
