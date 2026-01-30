import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { format } from "date-fns";
import { TrendingUp, TrendingDown, Trophy, Target, DollarSign, Percent } from "lucide-react";

interface MarketPnL {
  market_slug: string;
  expiry_time: string;
  up_qty: number;
  down_qty: number;
  total_cost: number;
  predicted_winning_side: string | null;
  predicted_final_value: number;
  predicted_pnl: number;
  unpaired: number;
  was_imbalanced: boolean;
  created_at: string;
}

export function V35MarketPnLTable() {
  const { data: markets, isLoading } = useQuery({
    queryKey: ["v35-market-pnl"],
    queryFn: async () => {
      // Get from expiry snapshots - this has the accurate predicted PnL
      const { data, error } = await supabase
        .from("v35_expiry_snapshots")
        .select("market_slug, expiry_time, api_up_qty, api_down_qty, total_cost, predicted_winning_side, predicted_final_value, predicted_pnl, unpaired, was_imbalanced, created_at")
        .order("created_at", { ascending: false })
        .limit(50);

      if (error) throw error;

      return (data || []).map((row: any) => ({
        market_slug: row.market_slug,
        expiry_time: row.expiry_time,
        up_qty: row.api_up_qty || 0,
        down_qty: row.api_down_qty || 0,
        total_cost: row.total_cost || 0,
        predicted_winning_side: row.predicted_winning_side,
        predicted_final_value: row.predicted_final_value || 0,
        predicted_pnl: row.predicted_pnl || 0,
        unpaired: row.unpaired || 0,
        was_imbalanced: row.was_imbalanced || false,
        created_at: row.created_at,
      })) as MarketPnL[];
    },
    refetchInterval: 30000,
  });

  // Calculate summary stats
  const totalPnL = markets?.reduce((sum, m) => sum + m.predicted_pnl, 0) || 0;
  const winCount = markets?.filter(m => m.predicted_pnl > 0).length || 0;
  const lossCount = markets?.filter(m => m.predicted_pnl < 0).length || 0;
  const totalMarkets = markets?.length || 0;
  const winRate = totalMarkets > 0 ? (winCount / totalMarkets) * 100 : 0;
  const avgPnLPerMarket = totalMarkets > 0 ? totalPnL / totalMarkets : 0;
  const totalVolume = markets?.reduce((sum, m) => sum + m.total_cost, 0) || 0;

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Trophy className="h-5 w-5" />
            Per-Market P&L
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-muted-foreground">Loading market data...</div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {/* Summary Cards */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <DollarSign className="h-4 w-4 text-muted-foreground" />
              Total P&L
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className={`text-2xl font-bold ${totalPnL >= 0 ? 'text-primary' : 'text-destructive'}`}>
              {totalPnL >= 0 ? '+' : ''}${totalPnL.toFixed(2)}
            </div>
            <p className="text-xs text-muted-foreground">
              From {totalMarkets} markets
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Percent className="h-4 w-4 text-muted-foreground" />
              Win Rate
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {winRate.toFixed(1)}%
            </div>
            <p className="text-xs text-muted-foreground">
              {winCount}W / {lossCount}L
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Target className="h-4 w-4 text-muted-foreground" />
              Avg P&L/Market
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className={`text-2xl font-bold ${avgPnLPerMarket >= 0 ? 'text-primary' : 'text-destructive'}`}>
              {avgPnLPerMarket >= 0 ? '+' : ''}${avgPnLPerMarket.toFixed(2)}
            </div>
            <p className="text-xs text-muted-foreground">
              Per 15-min window
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-muted-foreground" />
              Total Volume
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              ${totalVolume.toFixed(0)}
            </div>
            <p className="text-xs text-muted-foreground">
              Capital deployed
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Market Table */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Trophy className="h-5 w-5" />
            15-Minute Market Results
          </CardTitle>
          <CardDescription>
            Realized P&L per market from expiry snapshots
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!markets || markets.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              No market data yet. Results will appear after markets expire.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Expiry</TableHead>
                    <TableHead className="text-right">UP</TableHead>
                    <TableHead className="text-right">DOWN</TableHead>
                    <TableHead>Winner</TableHead>
                    <TableHead className="text-right">Cost</TableHead>
                    <TableHead className="text-right">Payout</TableHead>
                    <TableHead className="text-right">P&L</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {markets.map((market) => {
                    const isProfitable = market.predicted_pnl > 0;
                    const isBreakeven = Math.abs(market.predicted_pnl) < 0.50;

                    return (
                      <TableRow key={market.market_slug}>
                        <TableCell className="font-mono text-xs">
                          {format(new Date(market.expiry_time), "MMM dd HH:mm")}
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          {market.up_qty.toFixed(0)}
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          {market.down_qty.toFixed(0)}
                        </TableCell>
                        <TableCell>
                          {market.predicted_winning_side ? (
                            <Badge 
                              variant="outline" 
                              className={market.predicted_winning_side === 'UP' 
                                ? 'bg-green-500/10 text-green-600 border-green-500/30' 
                                : 'bg-red-500/10 text-red-600 border-red-500/30'}
                            >
                              {market.predicted_winning_side === 'UP' ? (
                                <TrendingUp className="h-3 w-3 mr-1" />
                              ) : (
                                <TrendingDown className="h-3 w-3 mr-1" />
                              )}
                              {market.predicted_winning_side}
                            </Badge>
                          ) : (
                            <Badge variant="secondary">Unknown</Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          ${market.total_cost.toFixed(2)}
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          ${market.predicted_final_value.toFixed(2)}
                        </TableCell>
                        <TableCell className={`text-right font-mono font-bold ${
                          isProfitable ? 'text-primary' : isBreakeven ? 'text-muted-foreground' : 'text-destructive'
                        }`}>
                          {market.predicted_pnl >= 0 ? '+' : ''}${market.predicted_pnl.toFixed(2)}
                        </TableCell>
                        <TableCell>
                          {market.was_imbalanced ? (
                            <Badge variant="destructive" className="text-xs">
                              ⚠️ {market.unpaired.toFixed(0)} unpaired
                            </Badge>
                          ) : isProfitable ? (
                            <Badge className="bg-primary text-primary-foreground text-xs">
                              ✅ Profit
                            </Badge>
                          ) : isBreakeven ? (
                            <Badge variant="secondary" className="text-xs">
                              ≈ Even
                            </Badge>
                          ) : (
                            <Badge variant="destructive" className="text-xs">
                              ❌ Loss
                            </Badge>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
