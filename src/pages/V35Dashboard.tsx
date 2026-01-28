import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useV35Realtime } from '@/hooks/useV35Realtime';
import { MainNav } from '@/components/MainNav';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { V35LogViewer, V35FillsTable, V35ExportButton, V35StrategyPDFExport, V35OpenPositions, V35LivePriceHeader } from '@/components/v35';
import { 
  Activity, 
  TrendingUp, 
  DollarSign, 
  BarChart3, 
  Clock, 
  Zap,
  Target,
  Scale,
  CircleDot,
  CheckCircle2,
  XCircle,
  ScrollText
} from 'lucide-react';

interface RunnerHeartbeat {
  id: string;
  runner_id: string;
  runner_type: string;
  last_heartbeat: string;
  status: string;
  markets_count: number;
  positions_count: number;
  trades_count?: number;
  version?: string;
  mode?: string;
  dry_run?: boolean;
  balance?: number;
  total_locked_profit?: number;
  total_unpaired?: number;
  metadata?: {
    mode?: string;
    dry_run?: boolean;
    locked_profit?: number;
  };
}

interface V35Settlement {
  id: string;
  market_slug: string;
  asset: string;
  paired: number;
  combined_cost: number;
  locked_profit: number;
  pnl: number;
  created_at: string;
}

export default function V35Dashboard() {
  const [isOnline, setIsOnline] = useState(false);
  const [lastSeen, setLastSeen] = useState<Date | null>(null);

  // Enable realtime subscriptions
  useV35Realtime();

  // Fetch runner heartbeat
  const { data: heartbeat } = useQuery({
    queryKey: ['v35-heartbeat'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('runner_heartbeats')
        .select('*')
        .eq('runner_type', 'v35')
        .order('last_heartbeat', { ascending: false })
        .limit(1)
        .single();
      
      if (error) return null;
      return data as unknown as RunnerHeartbeat;
    },
    refetchInterval: 5000,
  });

  // Fetch recent settlements
  const { data: settlements } = useQuery({
    queryKey: ['v35-settlements'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('v35_settlements')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(20);
      
      if (error) return [];
      return data as V35Settlement[];
    },
    refetchInterval: 30000,
  });

  // Check if runner is online
  useEffect(() => {
    if (heartbeat?.last_heartbeat) {
      const lastHb = new Date(heartbeat.last_heartbeat);
      setLastSeen(lastHb);
      const diffMs = Date.now() - lastHb.getTime();
      setIsOnline(diffMs < 30000); // Online if heartbeat < 30s ago
    }
  }, [heartbeat]);

  const totalPnL = settlements?.reduce((sum, s) => sum + (s.pnl || 0), 0) || 0;
  const totalPaired = settlements?.reduce((sum, s) => sum + (s.paired || 0), 0) || 0;
  const avgCombinedCost = settlements?.length 
    ? settlements.reduce((sum, s) => sum + (s.combined_cost || 0), 0) / settlements.length 
    : 0;

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border/50 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container flex h-14 items-center">
          <MainNav />
        </div>
      </header>

      <main className="container py-6 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">V35 Market Maker</h1>
            <p className="text-muted-foreground">
              Passive Dual-Outcome Strategy for 15-min Options
            </p>
          </div>
          <div className="flex items-center gap-2">
            <V35StrategyPDFExport />
            <V35ExportButton />
            {heartbeat?.dry_run && (
              <Badge variant="outline" className="bg-warning/10 text-warning border-warning/30">
                DRY RUN
              </Badge>
            )}
            <Badge 
              variant={isOnline ? "default" : "secondary"}
              className={isOnline ? "bg-primary" : "bg-muted"}
            >
              {isOnline ? (
                <>
                  <Activity className="w-3 h-3 mr-1 animate-pulse" />
                  Online
                </>
              ) : (
                <>
                  <XCircle className="w-3 h-3 mr-1" />
                  Offline
                </>
              )}
            </Badge>
          </div>
        </div>

        {/* Live Price Header */}
        <V35LivePriceHeader />

        {/* Status Cards */}
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Active Markets</CardTitle>
              <Target className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{heartbeat?.markets_count || 0}</div>
              <p className="text-xs text-muted-foreground">
                Mode: {heartbeat?.mode || 'unknown'}
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Paired Shares</CardTitle>
              <Scale className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{heartbeat?.positions_count?.toLocaleString() || 0}</div>
              <p className="text-xs text-muted-foreground">
                Unpaired: {heartbeat?.total_unpaired?.toLocaleString() || 0}
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Locked Profit</CardTitle>
              <DollarSign className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-primary">
                ${(heartbeat?.metadata?.locked_profit ?? heartbeat?.total_locked_profit ?? 0).toFixed(2)}
              </div>
              <p className="text-xs text-muted-foreground">
                Pre-settlement guaranteed
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Balance</CardTitle>
              <BarChart3 className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                ${(heartbeat?.balance || 0).toFixed(2)}
              </div>
              <p className="text-xs text-muted-foreground">
                Available USDC
              </p>
            </CardContent>
          </Card>
        </div>

        {/* Strategy Explanation */}
        <Card className="border-primary/20 bg-gradient-to-br from-primary/5 to-background">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Zap className="h-5 w-5 text-primary" />
              How V35 Works
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-3">
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm font-medium">
                <CircleDot className="h-4 w-4 text-primary" />
                1. Place Grid Orders
              </div>
              <p className="text-xs text-muted-foreground">
                Post BUY limit orders on both UP and DOWN outcomes at prices from $0.35 to $0.50
              </p>
            </div>
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Scale className="h-4 w-4 text-primary" />
                2. Accumulate Both Sides
              </div>
              <p className="text-xs text-muted-foreground">
                When retail traders hit our orders, we accumulate shares on both UP and DOWN
              </p>
            </div>
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm font-medium">
                <CheckCircle2 className="h-4 w-4 text-primary" />
                3. Settlement Profit
              </div>
              <p className="text-xs text-muted-foreground">
                At expiry: one side = $1.00, other = $0.00. If combined cost &lt; $1.00 → profit!
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Tabs for Positions, Settlements, Logs, Fills */}
        <Tabs defaultValue="positions" className="space-y-4">
          <TabsList>
            <TabsTrigger value="positions">
              <Scale className="h-4 w-4 mr-2" />
              Positions
            </TabsTrigger>
            <TabsTrigger value="overview">
              <BarChart3 className="h-4 w-4 mr-2" />
              Overview
            </TabsTrigger>
            <TabsTrigger value="logs">
              <ScrollText className="h-4 w-4 mr-2" />
              Event Log
            </TabsTrigger>
            <TabsTrigger value="fills">
              <Zap className="h-4 w-4 mr-2" />
              Fills
            </TabsTrigger>
          </TabsList>

          <TabsContent value="positions">
            <V35OpenPositions />
          </TabsContent>

          <TabsContent value="overview">
            <div className="grid gap-6 lg:grid-cols-2">
              {/* Recent Settlements */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <TrendingUp className="h-5 w-5" />
                    Recent Settlements
                  </CardTitle>
                  <CardDescription>
                    Completed markets and their P&L
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {settlements && settlements.length > 0 ? (
                    <div className="space-y-3">
                      {settlements.slice(0, 8).map((s) => (
                        <div key={s.id} className="flex items-center justify-between py-2 border-b border-border/50 last:border-0">
                          <div className="flex items-center gap-3">
                            <Badge variant="outline">{s.asset}</Badge>
                            <div>
                              <p className="text-sm font-medium truncate max-w-[200px]">
                                {s.market_slug?.slice(-30) || 'Unknown'}
                              </p>
                              <p className="text-xs text-muted-foreground">
                                Paired: {s.paired} | Cost: ${s.combined_cost?.toFixed(3)}
                              </p>
                            </div>
                          </div>
                          <div className={`text-sm font-bold ${s.pnl >= 0 ? 'text-primary' : 'text-destructive'}`}>
                            {s.pnl >= 0 ? '+' : ''}${s.pnl?.toFixed(2)}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-center py-8 text-muted-foreground">
                      <Clock className="h-8 w-8 mx-auto mb-2 opacity-50" />
                      <p>No settlements yet</p>
                      <p className="text-xs">Markets will appear here after expiry</p>
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Performance Summary */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <BarChart3 className="h-5 w-5" />
                    Performance Summary
                  </CardTitle>
                  <CardDescription>
                    Aggregate statistics from settlements
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                  <div className="space-y-2">
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">Total Realized P&L</span>
                      <span className={`font-bold ${totalPnL >= 0 ? 'text-primary' : 'text-destructive'}`}>
                        {totalPnL >= 0 ? '+' : ''}${totalPnL.toFixed(2)}
                      </span>
                    </div>
                    <Separator />
                  </div>

                  <div className="space-y-2">
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">Total Paired Shares</span>
                      <span className="font-medium">{totalPaired.toLocaleString()}</span>
                    </div>
                    <Separator />
                  </div>

                  <div className="space-y-2">
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">Avg Combined Cost</span>
                      <span className="font-medium">${avgCombinedCost.toFixed(3)}</span>
                    </div>
                    <Progress 
                      value={avgCombinedCost * 100} 
                      className="h-2"
                    />
                    <p className="text-xs text-muted-foreground text-right">
                      Target: &lt; $1.00 (currently {avgCombinedCost < 1 ? '✅' : '⚠️'})
                    </p>
                  </div>

                  <div className="space-y-2">
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">Settlements Count</span>
                      <span className="font-medium">{settlements?.length || 0}</span>
                    </div>
                    <Separator />
                  </div>

                  <div className="pt-2 text-center">
                    <p className="text-xs text-muted-foreground">
                      Last heartbeat: {lastSeen ? lastSeen.toLocaleTimeString() : 'Never'}
                    </p>
                  </div>
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          <TabsContent value="logs">
            <V35LogViewer />
          </TabsContent>

          <TabsContent value="fills">
            <V35FillsTable />
          </TabsContent>
        </Tabs>
      </main>
    </div>
  );
}
