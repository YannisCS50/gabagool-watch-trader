import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TrendingUp, TrendingDown, Wallet, PiggyBank, DollarSign } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";

interface TruePnLData {
  totalDeposits: number;
  portfolioValue: number;
  truePnL: number;
  truePnLPercent: number;
}

export function TruePnLCard() {
  const { data, isLoading, error } = useQuery<TruePnLData>({
    queryKey: ["true-pnl"],
    queryFn: async () => {
      // Fetch total deposits
      const { data: deposits, error: depositsError } = await supabase
        .from("deposits")
        .select("amount_usd");

      if (depositsError) throw depositsError;

      const totalDeposits = deposits?.reduce((sum, d) => sum + Number(d.amount_usd), 0) || 0;

      // Fetch latest funding snapshot for wallet balance
      const { data: funding, error: fundingError } = await supabase
        .from("funding_snapshots")
        .select("balance_total")
        .order("ts", { ascending: false })
        .limit(1);

      if (fundingError) throw fundingError;

      const walletBalance = funding?.[0]?.balance_total || 0;

      // Fetch open positions value from canonical_positions
      const { data: positions, error: positionsError } = await supabase
        .from("canonical_positions")
        .select("total_cost_usd, shares_held")
        .eq("state", "open");

      if (positionsError) throw positionsError;

      // Estimate open positions value (shares at current cost basis)
      const openPositionsValue = positions?.reduce((sum, p) => sum + Number(p.total_cost_usd || 0), 0) || 0;

      // Portfolio value = wallet balance + open positions value
      const portfolioValue = walletBalance + openPositionsValue;

      // True P&L = Portfolio Value - Total Deposits
      const truePnL = portfolioValue - totalDeposits;
      const truePnLPercent = totalDeposits > 0 ? (truePnL / totalDeposits) * 100 : 0;

      return {
        totalDeposits,
        portfolioValue,
        truePnL,
        truePnLPercent,
      };
    },
    refetchInterval: 30000, // Refresh every 30 seconds
  });

  if (isLoading) {
    return (
      <Card className="col-span-full">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <DollarSign className="h-5 w-5" />
            True P&L
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {[...Array(4)].map((_, i) => (
              <Skeleton key={i} className="h-20" />
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card className="col-span-full border-destructive">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-destructive">
            <DollarSign className="h-5 w-5" />
            True P&L Error
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">Failed to load P&L data</p>
        </CardContent>
      </Card>
    );
  }

  const isPositive = (data?.truePnL ?? 0) >= 0;
  const TrendIcon = isPositive ? TrendingUp : TrendingDown;

  return (
    <Card className="col-span-full">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <DollarSign className="h-5 w-5" />
          True P&L
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {/* Total Deposits */}
          <div className="p-4 rounded-lg bg-muted/50">
            <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
              <PiggyBank className="h-4 w-4" />
              Total Deposits
            </div>
            <div className="text-2xl font-bold">
              ${data?.totalDeposits.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </div>
          </div>

          {/* Portfolio Value */}
          <div className="p-4 rounded-lg bg-muted/50">
            <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
              <Wallet className="h-4 w-4" />
              Portfolio Value
            </div>
            <div className="text-2xl font-bold">
              ${data?.portfolioValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </div>
          </div>

          {/* True P&L */}
          <div className={`p-4 rounded-lg ${isPositive ? 'bg-green-500/10' : 'bg-red-500/10'}`}>
            <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
              <TrendIcon className={`h-4 w-4 ${isPositive ? 'text-green-500' : 'text-red-500'}`} />
              True P&L
            </div>
            <div className={`text-2xl font-bold ${isPositive ? 'text-green-500' : 'text-red-500'}`}>
              {isPositive ? '+' : ''}${data?.truePnL.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </div>
          </div>

          {/* True P&L % */}
          <div className={`p-4 rounded-lg ${isPositive ? 'bg-green-500/10' : 'bg-red-500/10'}`}>
            <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
              <TrendIcon className={`h-4 w-4 ${isPositive ? 'text-green-500' : 'text-red-500'}`} />
              Return %
            </div>
            <div className={`text-2xl font-bold ${isPositive ? 'text-green-500' : 'text-red-500'}`}>
              {isPositive ? '+' : ''}{data?.truePnLPercent.toFixed(2)}%
            </div>
          </div>
        </div>

        <p className="text-xs text-muted-foreground mt-4">
          Portfolio Value = Wallet Balance + Open Positions Cost Basis
        </p>
      </CardContent>
    </Card>
  );
}
