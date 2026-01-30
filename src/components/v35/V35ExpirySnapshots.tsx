import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { format } from "date-fns";
import { Camera, TrendingUp, AlertTriangle } from "lucide-react";

interface ExpirySnapshot {
  id: string;
  market_slug: string;
  asset: string;
  expiry_time: string;
  snapshot_time: string;
  seconds_before_expiry: number;
  api_up_qty: number;
  api_down_qty: number;
  paired: number;
  unpaired: number;
  combined_cost: number;
  locked_profit: number;
  was_imbalanced: boolean;
  imbalance_ratio: number | null;
  created_at: string;
}

export function V35ExpirySnapshots() {
  const { data: snapshots, isLoading, error } = useQuery({
    queryKey: ["v35-expiry-snapshots"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("v35_expiry_snapshots")
        .select("*")
        .order("expiry_time", { ascending: false })
        .limit(50);

      if (error) throw error;
      return data as ExpirySnapshot[];
    },
    refetchInterval: 30000, // Refresh every 30 seconds
  });

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Camera className="h-5 w-5" />
            Market Expiry Snapshots
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-muted-foreground">Loading snapshots...</div>
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Camera className="h-5 w-5" />
            Market Expiry Snapshots
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-destructive">Error loading snapshots: {String(error)}</div>
        </CardContent>
      </Card>
    );
  }

  // Calculate summary stats
  const totalSnapshots = snapshots?.length || 0;
  const totalLockedProfit = snapshots?.reduce((sum, s) => sum + (s.locked_profit || 0), 0) || 0;
  const imbalancedCount = snapshots?.filter(s => s.was_imbalanced).length || 0;
  const avgCPP = snapshots && snapshots.length > 0
    ? snapshots.reduce((sum, s) => sum + (s.combined_cost || 0), 0) / snapshots.length
    : 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Camera className="h-5 w-5" />
          Market Expiry Snapshots
        </CardTitle>
        <div className="flex gap-4 text-sm text-muted-foreground">
          <span>📊 {totalSnapshots} snapshots</span>
          <span>💰 ${totalLockedProfit.toFixed(2)} locked profit</span>
          <span>📈 Avg CPP: ${avgCPP.toFixed(4)}</span>
          <span className={imbalancedCount > 0 ? "text-yellow-500" : ""}>
            ⚠️ {imbalancedCount} imbalanced
          </span>
        </div>
      </CardHeader>
      <CardContent>
        {!snapshots || snapshots.length === 0 ? (
          <div className="text-muted-foreground text-center py-8">
            No expiry snapshots yet. Snapshots are captured 1 second before each market expires.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Expiry Time</TableHead>
                  <TableHead>Market</TableHead>
                  <TableHead>Asset</TableHead>
                  <TableHead className="text-right">UP</TableHead>
                  <TableHead className="text-right">DOWN</TableHead>
                  <TableHead className="text-right">Paired</TableHead>
                  <TableHead className="text-right">CPP</TableHead>
                  <TableHead className="text-right">Locked</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {snapshots.map((snapshot) => {
                  const isProfitable = snapshot.combined_cost > 0 && snapshot.combined_cost < 1.0;
                  const profitPct = isProfitable ? ((1 - snapshot.combined_cost) * 100).toFixed(1) : "0";

                  return (
                    <TableRow key={snapshot.id}>
                      <TableCell className="font-mono text-xs">
                        {format(new Date(snapshot.expiry_time), "MMM dd HH:mm")}
                      </TableCell>
                      <TableCell className="font-mono text-xs max-w-[150px] truncate">
                        {snapshot.market_slug.slice(-25)}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">{snapshot.asset}</Badge>
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {snapshot.api_up_qty.toFixed(1)}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {snapshot.api_down_qty.toFixed(1)}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {snapshot.paired.toFixed(0)}
                      </TableCell>
                      <TableCell className={`text-right font-mono ${isProfitable ? "text-green-500" : "text-red-500"}`}>
                        ${snapshot.combined_cost.toFixed(4)}
                      </TableCell>
                      <TableCell className="text-right font-mono text-green-500">
                        ${snapshot.locked_profit.toFixed(2)}
                      </TableCell>
                      <TableCell>
                        {snapshot.was_imbalanced ? (
                          <Badge variant="destructive" className="flex items-center gap-1 w-fit">
                            <AlertTriangle className="h-3 w-3" />
                            {snapshot.unpaired.toFixed(0)} unpaired
                          </Badge>
                        ) : isProfitable ? (
                          <Badge className="flex items-center gap-1 w-fit bg-primary text-primary-foreground">
                            <TrendingUp className="h-3 w-3" />
                            +{profitPct}%
                          </Badge>
                        ) : (
                          <Badge variant="secondary">Break-even</Badge>
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
  );
}
