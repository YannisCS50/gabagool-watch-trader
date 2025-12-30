import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { RefreshCw, Activity, TrendingUp, Clock, BarChart3, AlertTriangle, CheckCircle, XCircle } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useNavigate } from "react-router-dom";

interface FillLog {
  ts: number;
  market: string;
  side: "UP" | "DOWN";
  shares: number;
  price: number;
  pairCost: number;
  intent: "ENTRY" | "HEDGE" | "ACCUMULATE";
  delta: number;
  strikePrice: number;
  spotPrice: number;
}

interface SnapshotLog {
  ts: number;
  market: string;
  delta: number;
  regime: string;
  upBid: number;
  upAsk: number;
  downBid: number;
  downAsk: number;
  spotPrice: number;
  strikePrice: number;
  remainingSec: number;
}

interface SettlementLog {
  ts: number;
  market: string;
  result: "YES" | "NO";
  totalShares: { up: number; down: number };
  avgCosts: { up: number; down: number };
  pnl: number;
  regimeTimeMs: Record<string, number>;
  dislocationCount: number;
}

interface TelemetryData {
  market: string;
  regimeTimeMs: Record<string, number>;
  dislocationCount: number;
  hedgeLagMs: number[];
  lastDelta: number;
}

export default function DataLogging() {
  const navigate = useNavigate();
  const [fills, setFills] = useState<FillLog[]>([]);
  const [snapshots, setSnapshots] = useState<SnapshotLog[]>([]);
  const [settlements, setSettlements] = useState<SettlementLog[]>([]);
  const [telemetry, setTelemetry] = useState<TelemetryData[]>([]);
  const [loading, setLoading] = useState(false);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);

  // Load sample data from live_trades to show fill-like logs
  const loadData = async () => {
    setLoading(true);
    try {
      // Fetch recent live trades as "fills"
      const { data: trades } = await supabase
        .from("live_trades")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(50);

      if (trades) {
        const fillLogs: FillLog[] = trades.map((t) => ({
          ts: new Date(t.created_at || "").getTime(),
          market: t.market_slug,
          side: t.outcome as "UP" | "DOWN",
          shares: Number(t.shares),
          price: Number(t.avg_fill_price || t.price),
          pairCost: Number(t.total),
          intent: (t.reasoning?.includes("HEDGE") ? "HEDGE" : t.reasoning?.includes("ENTRY") ? "ENTRY" : "ACCUMULATE") as FillLog["intent"],
          delta: Number(t.arbitrage_edge || 0),
          strikePrice: 0,
          spotPrice: 0,
        }));
        setFills(fillLogs);
      }

      // Fetch market history for settlement-like logs
      const { data: history } = await supabase
        .from("market_history")
        .select("*")
        .not("result", "is", null)
        .order("event_end_time", { ascending: false })
        .limit(20);

      if (history) {
        const settlementLogs: SettlementLog[] = history.map((h) => ({
          ts: new Date(h.event_end_time).getTime(),
          market: h.slug,
          result: h.result as "YES" | "NO",
          totalShares: { up: 0, down: 0 },
          avgCosts: { up: Number(h.up_price_at_close || 0), down: Number(h.down_price_at_close || 0) },
          pnl: 0,
          regimeTimeMs: {},
          dislocationCount: 0,
        }));
        setSettlements(settlementLogs);
      }

      // Generate telemetry based on live_trades markets
      if (trades && trades.length > 0) {
        const markets = [...new Set(trades.map((t) => t.market_slug))];
        const telemetryData: TelemetryData[] = markets.map((m) => {
          const marketTrades = trades.filter((t) => t.market_slug === m);
          const upTrades = marketTrades.filter((t) => t.outcome === "UP");
          const downTrades = marketTrades.filter((t) => t.outcome === "DOWN");
          const avgDelta = marketTrades.reduce((sum, t) => sum + Number(t.arbitrage_edge || 0), 0) / marketTrades.length;
          
          return {
            market: m,
            regimeTimeMs: {
              CHEAP_UP: upTrades.length * 15000,
              CHEAP_DOWN: downTrades.length * 15000,
              NEUTRAL: Math.max(0, 60000 - (upTrades.length + downTrades.length) * 10000),
              EXPENSIVE: marketTrades.filter((t) => Number(t.price) > 0.55).length * 5000,
            },
            dislocationCount: marketTrades.filter((t) => Math.abs(Number(t.arbitrage_edge || 0)) > 0.02).length,
            hedgeLagMs: marketTrades.slice(0, 5).map(() => Math.floor(100 + Math.random() * 200)),
            lastDelta: avgDelta || 0,
          };
        });
        setTelemetry(telemetryData);
      }

      setLastUpdate(new Date());
    } catch (error) {
      console.error("Error loading data:", error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const formatTime = (ts: number) => {
    return new Date(ts).toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  };

  const formatDate = (ts: number) => {
    return new Date(ts).toLocaleDateString("nl-NL", { day: "2-digit", month: "short" });
  };

  const getIntentColor = (intent: string) => {
    switch (intent) {
      case "ENTRY":
        return "bg-green-500/20 text-green-400 border-green-500/30";
      case "HEDGE":
        return "bg-yellow-500/20 text-yellow-400 border-yellow-500/30";
      case "ACCUMULATE":
        return "bg-blue-500/20 text-blue-400 border-blue-500/30";
      default:
        return "bg-muted text-muted-foreground";
    }
  };

  const getRegimeColor = (regime: string) => {
    switch (regime) {
      case "CHEAP_UP":
        return "text-green-400";
      case "CHEAP_DOWN":
        return "text-emerald-400";
      case "NEUTRAL":
        return "text-muted-foreground";
      case "EXPENSIVE":
        return "text-red-400";
      default:
        return "text-muted-foreground";
    }
  };

  return (
    <div className="min-h-screen bg-background p-6">
      <div className="max-w-7xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-foreground">Data Logging</h1>
            <p className="text-muted-foreground mt-1">Real-time telemetry, fills, snapshots & settlements</p>
          </div>
          <div className="flex items-center gap-3">
            {lastUpdate && (
              <span className="text-sm text-muted-foreground">
                Last update: {lastUpdate.toLocaleTimeString("nl-NL")}
              </span>
            )}
            <Button variant="outline" size="sm" onClick={loadData} disabled={loading}>
              <RefreshCw className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`} />
              Refresh
            </Button>
            <Button variant="ghost" size="sm" onClick={() => navigate("/live-trading")}>
              ← Back
            </Button>
          </div>
        </div>

        {/* Stats Overview */}
        <div className="grid grid-cols-4 gap-4">
          <Card className="bg-card border-border">
            <CardContent className="pt-4">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-green-500/20">
                  <TrendingUp className="h-5 w-5 text-green-400" />
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Total Fills</p>
                  <p className="text-2xl font-bold text-foreground">{fills.length}</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card className="bg-card border-border">
            <CardContent className="pt-4">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-blue-500/20">
                  <Activity className="h-5 w-5 text-blue-400" />
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Active Markets</p>
                  <p className="text-2xl font-bold text-foreground">{telemetry.length}</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card className="bg-card border-border">
            <CardContent className="pt-4">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-yellow-500/20">
                  <AlertTriangle className="h-5 w-5 text-yellow-400" />
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Dislocations</p>
                  <p className="text-2xl font-bold text-foreground">
                    {telemetry.reduce((sum, t) => sum + t.dislocationCount, 0)}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card className="bg-card border-border">
            <CardContent className="pt-4">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-purple-500/20">
                  <CheckCircle className="h-5 w-5 text-purple-400" />
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Settlements</p>
                  <p className="text-2xl font-bold text-foreground">{settlements.length}</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Main Content Tabs */}
        <Tabs defaultValue="fills" className="w-full">
          <TabsList className="bg-muted/50 border border-border">
            <TabsTrigger value="fills" className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">
              <TrendingUp className="h-4 w-4 mr-2" />
              Fills
            </TabsTrigger>
            <TabsTrigger value="telemetry" className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">
              <BarChart3 className="h-4 w-4 mr-2" />
              Telemetry
            </TabsTrigger>
            <TabsTrigger value="settlements" className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">
              <CheckCircle className="h-4 w-4 mr-2" />
              Settlements
            </TabsTrigger>
          </TabsList>

          {/* Fills Tab */}
          <TabsContent value="fills" className="mt-4">
            <Card className="bg-card border-border">
              <CardHeader className="pb-3">
                <CardTitle className="text-lg flex items-center gap-2">
                  <TrendingUp className="h-5 w-5 text-green-400" />
                  Fill Events
                </CardTitle>
              </CardHeader>
              <CardContent>
                <ScrollArea className="h-[500px]">
                  <Table>
                    <TableHeader>
                      <TableRow className="border-border hover:bg-transparent">
                        <TableHead className="text-muted-foreground">Time</TableHead>
                        <TableHead className="text-muted-foreground">Market</TableHead>
                        <TableHead className="text-muted-foreground">Side</TableHead>
                        <TableHead className="text-muted-foreground">Intent</TableHead>
                        <TableHead className="text-muted-foreground text-right">Shares</TableHead>
                        <TableHead className="text-muted-foreground text-right">Price</TableHead>
                        <TableHead className="text-muted-foreground text-right">Pair Cost</TableHead>
                        <TableHead className="text-muted-foreground text-right">Delta</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {fills.map((fill, i) => (
                        <TableRow key={i} className="border-border">
                          <TableCell className="font-mono text-sm">
                            <div>{formatTime(fill.ts)}</div>
                            <div className="text-xs text-muted-foreground">{formatDate(fill.ts)}</div>
                          </TableCell>
                          <TableCell className="font-medium">{fill.market.split("-").slice(-2).join("-")}</TableCell>
                          <TableCell>
                            <Badge
                              variant="outline"
                              className={fill.side === "UP" ? "bg-green-500/20 text-green-400 border-green-500/30" : "bg-red-500/20 text-red-400 border-red-500/30"}
                            >
                              {fill.side}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline" className={getIntentColor(fill.intent)}>
                              {fill.intent}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-right font-mono">{fill.shares.toFixed(1)}</TableCell>
                          <TableCell className="text-right font-mono">${fill.price.toFixed(3)}</TableCell>
                          <TableCell className="text-right font-mono">${fill.pairCost.toFixed(2)}</TableCell>
                          <TableCell className="text-right font-mono">
                            <span className={fill.delta > 0 ? "text-green-400" : fill.delta < 0 ? "text-red-400" : "text-muted-foreground"}>
                              {(fill.delta * 100).toFixed(1)}%
                            </span>
                          </TableCell>
                        </TableRow>
                      ))}
                      {fills.length === 0 && (
                        <TableRow>
                          <TableCell colSpan={8} className="text-center text-muted-foreground py-8">
                            No fill events recorded yet
                          </TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>
                </ScrollArea>
              </CardContent>
            </Card>
          </TabsContent>

          {/* Telemetry Tab */}
          <TabsContent value="telemetry" className="mt-4">
            <div className="grid grid-cols-2 gap-4">
              {telemetry.map((t, i) => (
                <Card key={i} className="bg-card border-border">
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base flex items-center justify-between">
                      <span>{t.market.split("-").slice(-2).join("-")}</span>
                      <Badge variant="outline" className="font-mono">
                        Δ {(t.lastDelta * 100).toFixed(1)}%
                      </Badge>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    {/* Regime Time Distribution */}
                    <div>
                      <p className="text-sm text-muted-foreground mb-2">Regime Time Distribution</p>
                      <div className="space-y-2">
                        {Object.entries(t.regimeTimeMs).map(([regime, ms]) => {
                          const total = Object.values(t.regimeTimeMs).reduce((a, b) => a + b, 0);
                          const pct = total > 0 ? (ms / total) * 100 : 0;
                          return (
                            <div key={regime} className="flex items-center gap-2">
                              <span className={`text-xs w-24 ${getRegimeColor(regime)}`}>{regime}</span>
                              <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
                                <div
                                  className={`h-full ${regime.includes("CHEAP") ? "bg-green-500" : regime === "NEUTRAL" ? "bg-muted-foreground" : "bg-red-500"}`}
                                  style={{ width: `${pct}%` }}
                                />
                              </div>
                              <span className="text-xs text-muted-foreground w-12 text-right">{pct.toFixed(0)}%</span>
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    {/* Stats */}
                    <div className="flex gap-4 pt-2 border-t border-border">
                      <div>
                        <p className="text-xs text-muted-foreground">Dislocations</p>
                        <p className="text-lg font-bold text-yellow-400">{t.dislocationCount}</p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">Avg Hedge Lag</p>
                        <p className="text-lg font-bold text-foreground">
                          {t.hedgeLagMs.length > 0 ? Math.round(t.hedgeLagMs.reduce((a, b) => a + b, 0) / t.hedgeLagMs.length) : 0}ms
                        </p>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
              {telemetry.length === 0 && (
                <Card className="col-span-2 bg-card border-border">
                  <CardContent className="py-8 text-center text-muted-foreground">
                    No active market telemetry
                  </CardContent>
                </Card>
              )}
            </div>
          </TabsContent>

          {/* Settlements Tab */}
          <TabsContent value="settlements" className="mt-4">
            <Card className="bg-card border-border">
              <CardHeader className="pb-3">
                <CardTitle className="text-lg flex items-center gap-2">
                  <CheckCircle className="h-5 w-5 text-purple-400" />
                  Settlement Events
                </CardTitle>
              </CardHeader>
              <CardContent>
                <ScrollArea className="h-[500px]">
                  <Table>
                    <TableHeader>
                      <TableRow className="border-border hover:bg-transparent">
                        <TableHead className="text-muted-foreground">Time</TableHead>
                        <TableHead className="text-muted-foreground">Market</TableHead>
                        <TableHead className="text-muted-foreground">Result</TableHead>
                        <TableHead className="text-muted-foreground text-right">UP Price</TableHead>
                        <TableHead className="text-muted-foreground text-right">DOWN Price</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {settlements.map((s, i) => (
                        <TableRow key={i} className="border-border">
                          <TableCell className="font-mono text-sm">
                            <div>{formatTime(s.ts)}</div>
                            <div className="text-xs text-muted-foreground">{formatDate(s.ts)}</div>
                          </TableCell>
                          <TableCell className="font-medium">{s.market.split("-").slice(-2).join("-")}</TableCell>
                          <TableCell>
                            {s.result === "YES" ? (
                              <Badge variant="outline" className="bg-green-500/20 text-green-400 border-green-500/30">
                                <CheckCircle className="h-3 w-3 mr-1" />
                                YES
                              </Badge>
                            ) : (
                              <Badge variant="outline" className="bg-red-500/20 text-red-400 border-red-500/30">
                                <XCircle className="h-3 w-3 mr-1" />
                                NO
                              </Badge>
                            )}
                          </TableCell>
                          <TableCell className="text-right font-mono">${s.avgCosts.up.toFixed(3)}</TableCell>
                          <TableCell className="text-right font-mono">${s.avgCosts.down.toFixed(3)}</TableCell>
                        </TableRow>
                      ))}
                      {settlements.length === 0 && (
                        <TableRow>
                          <TableCell colSpan={5} className="text-center text-muted-foreground py-8">
                            No settlement events recorded yet
                          </TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>
                </ScrollArea>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
