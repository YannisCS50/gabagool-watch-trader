import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { TrendingUp, TrendingDown, DollarSign } from "lucide-react";

interface TruePnLData {
  totalDeposits: number;
  clobBalance: number;
  openPositionsValue: number;
  portfolioValue: number;
  truePnL: number;
  truePnLPercent: number;
}

export function TruePnLCard() {
  const { data, isLoading } = useQuery<TruePnLData>({
    queryKey: ["true-pnl"],
    queryFn: async () => {
      // Fetch total deposits
      const { data: deposits } = await supabase
        .from("deposits")
        .select("amount_usd");

      const totalDeposits = deposits?.reduce((sum, d) => sum + Number(d.amount_usd), 0) || 0;

      // Fetch latest runner heartbeat for balance
      const { data: heartbeat } = await supabase
        .from("runner_heartbeats")
        .select("balance")
        .eq("runner_type", "v26")
        .order("last_heartbeat", { ascending: false })
        .limit(1)
        .single();

      const clobBalance = heartbeat?.balance || 0;

      // Fetch open positions value from canonical_positions
      const { data: positions } = await supabase
        .from("canonical_positions")
        .select("total_cost_usd")
        .eq("state", "open");

      const openPositionsValue = positions?.reduce((sum, p) => sum + Number(p.total_cost_usd || 0), 0) || 0;

      // Portfolio value = CLOB balance + open positions value
      const portfolioValue = clobBalance + openPositionsValue;

      // True P&L = Portfolio Value - Total Deposits
      const truePnL = portfolioValue - totalDeposits;
      const truePnLPercent = totalDeposits > 0 ? (truePnL / totalDeposits) * 100 : 0;

      return { totalDeposits, clobBalance, openPositionsValue, portfolioValue, truePnL, truePnLPercent };
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

  const clobBalance = data?.portfolioValue ?? 0;
  const openPositionsValue = data?.openPositionsValue ?? 0;
  const hasClobBalance = clobBalance > openPositionsValue; // CLOB balance should be > just positions
  
  const isPositive = (data?.truePnL ?? 0) >= 0;
  const TrendIcon = isPositive ? TrendingUp : TrendingDown;

  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2 p-3 rounded-lg bg-muted/30 text-sm">
      <div className="flex items-center gap-2">
        <DollarSign className="h-4 w-4 text-muted-foreground" />
        <span className="text-muted-foreground">Deposits:</span>
        <span className="font-medium">${data?.totalDeposits.toLocaleString()}</span>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground">Open Positions:</span>
        <span className="font-medium">${openPositionsValue.toLocaleString()}</span>
      </div>
      {hasClobBalance ? (
        <>
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">Portfolio:</span>
            <span className="font-medium">${data?.portfolioValue.toLocaleString()}</span>
          </div>
          <div className="flex items-center gap-2">
            <TrendIcon className={`h-4 w-4 ${isPositive ? 'text-green-500' : 'text-red-500'}`} />
            <span className="text-muted-foreground">True P&L:</span>
            <span className={`font-bold ${isPositive ? 'text-green-500' : 'text-red-500'}`}>
              {isPositive ? '+' : ''}${data?.truePnL.toLocaleString()} ({data?.truePnLPercent.toFixed(1)}%)
            </span>
          </div>
        </>
      ) : (
        <div className="flex items-center gap-2 text-amber-500">
          <span className="text-xs">⚠️ CLOB balance not available (runner needs to log it)</span>
        </div>
      )}
    </div>
  );
}
