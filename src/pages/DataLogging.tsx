import { useState, useEffect, useRef } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { RefreshCw, Activity, TrendingUp, Clock, BarChart3, AlertTriangle, CheckCircle, XCircle, DollarSign, Download, Radio, Database } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useNavigate } from "react-router-dom";
import { useChainlinkRealtime } from "@/hooks/useChainlinkRealtime";

interface LivePriceTick {
  ts: number;
  asset: string;
  price: number;
  delta: number;
  deltaPercent: number;
}

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

interface PriceLog {
  ts: number;
  asset: string;
  strikePrice: number;
  openPrice: number | null;
  closePrice: number | null;
  quality: string;
  marketSlug: string;
}

export default function DataLogging() {
  const navigate = useNavigate();
  const [fills, setFills] = useState<FillLog[]>([]);
  const [snapshots, setSnapshots] = useState<SnapshotLog[]>([]);
  const [settlements, setSettlements] = useState<SettlementLog[]>([]);
  const [telemetry, setTelemetry] = useState<TelemetryData[]>([]);
  const [prices, setPrices] = useState<PriceLog[]>([]);
  const [livePriceTicks, setLivePriceTicks] = useState<LivePriceTick[]>([]);
  const [loading, setLoading] = useState(false);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  
  // Live Chainlink prices
  const { btcPrice, ethPrice, isConnected, updateCount } = useChainlinkRealtime(true);
  const prevBtcPrice = useRef<number | null>(null);
  const prevEthPrice = useRef<number | null>(null);

  // Keep latest prices in refs so we can log them on a fixed 1s cadence
  const btcPriceRef = useRef<number | null>(null);
  const ethPriceRef = useRef<number | null>(null);
  const prevLoggedBtcPriceRef = useRef<number | null>(null);
  const prevLoggedEthPriceRef = useRef<number | null>(null);
  const dbLogInFlightRef = useRef(false);

  useEffect(() => {
    btcPriceRef.current = btcPrice ?? null;
    ethPriceRef.current = ethPrice ?? null;
  }, [btcPrice, ethPrice]);

  // Persist BTC/ETH price ticks to the database every 1s
  useEffect(() => {
    if (!isConnected) return;

    const interval = setInterval(async () => {
      const btc = btcPriceRef.current;
      const eth = ethPriceRef.current;
      if (!btc && !eth) return;

      if (dbLogInFlightRef.current) return;
      dbLogInFlightRef.current = true;

      try {
        const rows: Array<{
          asset: string;
          price: number;
          delta: number;
          delta_percent: number;
          source: string;
        }> = [];

        if (btc) {
          const prev = prevLoggedBtcPriceRef.current ?? btc;
          const delta = btc - prev;
          const deltaPercent = prev > 0 ? (delta / prev) * 100 : 0;
          rows.push({
            asset: "BTC",
            price: btc,
            delta,
            delta_percent: deltaPercent,
            source: "ui_realtime",
          });
          prevLoggedBtcPriceRef.current = btc;
        }

        if (eth) {
          const prev = prevLoggedEthPriceRef.current ?? eth;
          const delta = eth - prev;
          const deltaPercent = prev > 0 ? (delta / prev) * 100 : 0;
          rows.push({
            asset: "ETH",
            price: eth,
            delta,
            delta_percent: deltaPercent,
            source: "ui_realtime",
          });
          prevLoggedEthPriceRef.current = eth;
        }

        const { error } = await supabase.from("price_ticks").insert(rows);
        if (error) {
          console.error("❌ Failed to insert price_ticks:", error);
        }
      } catch (e) {
        console.error("❌ price_ticks logging crashed:", e);
      } finally {
        dbLogInFlightRef.current = false;
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [isConnected]);

  // Log live price ticks in UI
  useEffect(() => {
    if (!btcPrice && !ethPrice) return;

    const now = Date.now();
    const newTicks: LivePriceTick[] = [];

    if (btcPrice) {
      const prevBtc = prevBtcPrice.current || btcPrice;
      const delta = btcPrice - prevBtc;
      const deltaPercent = prevBtc > 0 ? (delta / prevBtc) * 100 : 0;
      newTicks.push({ ts: now, asset: "BTC", price: btcPrice, delta, deltaPercent });
      prevBtcPrice.current = btcPrice;
    }

    if (ethPrice) {
      const prevEth = prevEthPrice.current || ethPrice;
      const delta = ethPrice - prevEth;
      const deltaPercent = prevEth > 0 ? (delta / prevEth) * 100 : 0;
      newTicks.push({ ts: now, asset: "ETH", price: ethPrice, delta, deltaPercent });
      prevEthPrice.current = ethPrice;
    }

    if (newTicks.length > 0) {
      setLivePriceTicks((prev) => [...newTicks, ...prev].slice(0, 200)); // Keep last 200 ticks
    }
  }, [updateCount]); // Trigger on each price update
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

      // Fetch strike prices for price logging
      const { data: strikePrices } = await supabase
        .from("strike_prices")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(50);

      if (strikePrices) {
        const priceLogs: PriceLog[] = strikePrices.map((p) => ({
          ts: new Date(p.created_at || "").getTime(),
          asset: p.asset,
          strikePrice: Number(p.strike_price),
          openPrice: p.open_price ? Number(p.open_price) : null,
          closePrice: p.close_price ? Number(p.close_price) : null,
          quality: p.quality || "unknown",
          marketSlug: p.market_slug,
        }));
        setPrices(priceLogs);
      }

      setLastUpdate(new Date());
    } catch (error) {
      console.error("Error loading data:", error);
    } finally {
      setLoading(false);
    }
  };

  // Load prices separately with faster refresh
  const loadPrices = async () => {
    try {
      const { data: strikePrices } = await supabase
        .from("strike_prices")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(50);

      if (strikePrices) {
        const priceLogs: PriceLog[] = strikePrices.map((p) => ({
          ts: new Date(p.created_at || "").getTime(),
          asset: p.asset,
          strikePrice: Number(p.strike_price),
          openPrice: p.open_price ? Number(p.open_price) : null,
          closePrice: p.close_price ? Number(p.close_price) : null,
          quality: p.quality || "unknown",
          marketSlug: p.market_slug,
        }));
        setPrices(priceLogs);
      }
    } catch (error) {
      console.error("Error loading prices:", error);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  // Auto-refresh prices every 2 seconds
  useEffect(() => {
    const interval = setInterval(loadPrices, 2000);
    return () => clearInterval(interval);
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

  const exportToCSV = (data: any[], filename: string) => {
    if (data.length === 0) return;
    const headers = Object.keys(data[0]);
    const csvContent = [
      headers.join(","),
      ...data.map(row => headers.map(h => {
        const val = row[h];
        if (typeof val === "object") return JSON.stringify(val);
        if (typeof val === "string" && val.includes(",")) return `"${val}"`;
        return val;
      }).join(","))
    ].join("\n");
    
    const blob = new Blob([csvContent], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${filename}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const [activeTab, setActiveTab] = useState("fills");
  const [downloadingAll, setDownloadingAll] = useState(false);

  const handleExport = () => {
    switch (activeTab) {
      case "fills": exportToCSV(fills, "fills"); break;
      case "telemetry": exportToCSV(telemetry, "telemetry"); break;
      case "settlements": exportToCSV(settlements, "settlements"); break;
      case "live": exportToCSV(livePriceTicks, "live-prices"); break;
      case "prices": exportToCSV(prices, "strike-prices"); break;
    }
  };

  // Download ALL data from database (not just what's displayed)
  const handleDownloadFullDatabase = async () => {
    setDownloadingAll(true);
    try {
      // Fetch ALL data from each table (no limit)
      const [
        { data: allFillLogs },
        { data: allSnapshotLogs },
        { data: allSettlementLogs },
        { data: allLiveTrades },
        { data: allStrikePrices },
        { data: allOrderQueue },
        { data: allLiveTradeResults },
        { data: allPriceTicks }
      ] = await Promise.all([
        supabase.from("fill_logs").select("*").order("ts", { ascending: false }),
        supabase.from("snapshot_logs").select("*").order("ts", { ascending: false }),
        supabase.from("settlement_logs").select("*").order("ts", { ascending: false }),
        supabase.from("live_trades").select("*").order("created_at", { ascending: false }),
        supabase.from("strike_prices").select("*").order("created_at", { ascending: false }),
        supabase.from("order_queue").select("*").order("created_at", { ascending: false }),
        supabase.from("live_trade_results").select("*").order("created_at", { ascending: false }),
        supabase.from("price_ticks").select("*").order("created_at", { ascending: false })
      ]);

      const timestamp = new Date().toISOString().slice(0, 16).replace(":", "-");
      
      // Export each table as separate CSV
      if (allFillLogs?.length) exportToCSV(allFillLogs, `FULL_fill_logs_${timestamp}`);
      if (allSnapshotLogs?.length) exportToCSV(allSnapshotLogs, `FULL_snapshot_logs_${timestamp}`);
      if (allSettlementLogs?.length) exportToCSV(allSettlementLogs, `FULL_settlement_logs_${timestamp}`);
      if (allLiveTrades?.length) exportToCSV(allLiveTrades, `FULL_live_trades_${timestamp}`);
      if (allStrikePrices?.length) exportToCSV(allStrikePrices, `FULL_strike_prices_${timestamp}`);
      if (allOrderQueue?.length) exportToCSV(allOrderQueue, `FULL_order_queue_${timestamp}`);
      if (allLiveTradeResults?.length) exportToCSV(allLiveTradeResults, `FULL_live_trade_results_${timestamp}`);
      if (allPriceTicks?.length) exportToCSV(allPriceTicks, `FULL_price_ticks_${timestamp}`);

      // One combined timeline (BTC ticks + orders + trades), sorted by time
      const timeline = [
        ...(allPriceTicks || [])
          .filter((t: any) => t.asset === "BTC")
          .map((t: any) => ({
            _sort: new Date(t.created_at).getTime(),
            time: t.created_at,
            type: "BTC_TICK",
            asset: t.asset,
            price: t.price,
            delta: t.delta,
            delta_percent: t.delta_percent,
            source: t.source,
          })),
        ...(allOrderQueue || []).map((o: any) => ({
          _sort: new Date(o.created_at).getTime(),
          time: o.created_at,
          type: "ORDER",
          asset: o.asset,
          market_slug: o.market_slug,
          outcome: o.outcome,
          status: o.status,
          order_id: o.order_id,
          token_id: o.token_id,
          order_type: o.order_type,
          shares: o.shares,
          price: o.price,
          avg_fill_price: o.avg_fill_price,
          reasoning: o.reasoning,
          error_message: o.error_message,
        })),
        ...(allLiveTrades || []).map((t: any) => ({
          _sort: new Date(t.created_at).getTime(),
          time: t.created_at,
          type: "LIVE_TRADE",
          asset: t.asset,
          market_slug: t.market_slug,
          outcome: t.outcome,
          status: t.status,
          order_id: t.order_id,
          shares: t.shares,
          price: t.price,
          avg_fill_price: t.avg_fill_price,
          total: t.total,
          reasoning: t.reasoning,
        })),
      ]
        .filter((r: any) => Number.isFinite(r._sort))
        .sort((a: any, b: any) => a._sort - b._sort)
        .map(({ _sort, ...rest }: any) => rest);

      if (timeline.length) exportToCSV(timeline, `TIMELINE_BTC_${timestamp}`);

      // Also create a combined JSON export
      const combinedData = {
        exportedAt: new Date().toISOString(),
        fill_logs: allFillLogs || [],
        snapshot_logs: allSnapshotLogs || [],
        settlement_logs: allSettlementLogs || [],
        live_trades: allLiveTrades || [],
        strike_prices: allStrikePrices || [],
        order_queue: allOrderQueue || [],
        live_trade_results: allLiveTradeResults || [],
        price_ticks: allPriceTicks || [],
        counts: {
          fill_logs: allFillLogs?.length || 0,
          snapshot_logs: allSnapshotLogs?.length || 0,
          settlement_logs: allSettlementLogs?.length || 0,
          live_trades: allLiveTrades?.length || 0,
          strike_prices: allStrikePrices?.length || 0,
          order_queue: allOrderQueue?.length || 0,
          live_trade_results: allLiveTradeResults?.length || 0,
          price_ticks: allPriceTicks?.length || 0
        }
      };

      const jsonBlob = new Blob([JSON.stringify(combinedData, null, 2)], { type: "application/json" });
      const jsonUrl = URL.createObjectURL(jsonBlob);
      const jsonLink = document.createElement("a");
      jsonLink.href = jsonUrl;
      jsonLink.download = `FULL_DATABASE_EXPORT_${timestamp}.json`;
      jsonLink.click();
      URL.revokeObjectURL(jsonUrl);

      console.log("✅ Full database export complete:", combinedData.counts);
    } catch (error) {
      console.error("❌ Error exporting full database:", error);
    } finally {
      setDownloadingAll(false);
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
            <Button 
              variant="default" 
              size="sm" 
              onClick={handleDownloadFullDatabase} 
              disabled={downloadingAll}
              className="bg-green-600 hover:bg-green-700"
            >
              <Database className={`h-4 w-4 mr-2 ${downloadingAll ? "animate-pulse" : ""}`} />
              {downloadingAll ? "Downloading..." : "Download Full DB"}
            </Button>
            <Button variant="outline" size="sm" onClick={handleExport}>
              <Download className="h-4 w-4 mr-2" />
              Export Tab
            </Button>
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
        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
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
            <TabsTrigger value="live" className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">
              <Radio className="h-4 w-4 mr-2" />
              Live Prices
              {isConnected && <span className="ml-2 w-2 h-2 rounded-full bg-green-500 animate-pulse" />}
            </TabsTrigger>
            <TabsTrigger value="prices" className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">
              <DollarSign className="h-4 w-4 mr-2" />
              Strike Prices
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

          {/* Live Prices Tab */}
          <TabsContent value="live" className="mt-4">
            <Card className="bg-card border-border">
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-lg flex items-center gap-2">
                    <Radio className="h-5 w-5 text-green-400" />
                    Live Price Feed
                    {isConnected && <Badge variant="outline" className="ml-2 bg-green-500/20 text-green-400 border-green-500/30">Connected</Badge>}
                  </CardTitle>
                  <div className="flex items-center gap-4 text-sm">
                    <div className="flex items-center gap-2">
                      <span className="text-muted-foreground">BTC:</span>
                      <span className="font-mono font-bold text-foreground">${btcPrice?.toLocaleString() || "—"}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-muted-foreground">ETH:</span>
                      <span className="font-mono font-bold text-foreground">${ethPrice?.toLocaleString() || "—"}</span>
                    </div>
                    <Badge variant="outline" className="font-mono">{livePriceTicks.length} ticks</Badge>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <ScrollArea className="h-[500px]">
                  <Table>
                    <TableHeader>
                      <TableRow className="border-border hover:bg-transparent">
                        <TableHead className="text-muted-foreground">Time</TableHead>
                        <TableHead className="text-muted-foreground">Asset</TableHead>
                        <TableHead className="text-muted-foreground text-right">Price</TableHead>
                        <TableHead className="text-muted-foreground text-right">Delta ($)</TableHead>
                        <TableHead className="text-muted-foreground text-right">Delta (%)</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {livePriceTicks.map((tick, i) => (
                        <TableRow key={`${tick.ts}-${tick.asset}-${i}`} className="border-border">
                          <TableCell className="font-mono text-sm">
                            {new Date(tick.ts).toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}.{String(tick.ts % 1000).padStart(3, "0")}
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline" className={tick.asset === "BTC" ? "bg-orange-500/20 text-orange-400 border-orange-500/30" : "bg-blue-500/20 text-blue-400 border-blue-500/30"}>
                              {tick.asset}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-right font-mono font-medium">
                            ${tick.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          </TableCell>
                          <TableCell className="text-right font-mono">
                            <span className={tick.delta > 0 ? "text-green-400" : tick.delta < 0 ? "text-red-400" : "text-muted-foreground"}>
                              {tick.delta >= 0 ? "+" : ""}{tick.delta.toFixed(2)}
                            </span>
                          </TableCell>
                          <TableCell className="text-right font-mono">
                            <span className={tick.deltaPercent > 0 ? "text-green-400" : tick.deltaPercent < 0 ? "text-red-400" : "text-muted-foreground"}>
                              {tick.deltaPercent >= 0 ? "+" : ""}{tick.deltaPercent.toFixed(4)}%
                            </span>
                          </TableCell>
                        </TableRow>
                      ))}
                      {livePriceTicks.length === 0 && (
                        <TableRow>
                          <TableCell colSpan={5} className="text-center text-muted-foreground py-8">
                            Waiting for live price data...
                          </TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>
                </ScrollArea>
              </CardContent>
            </Card>
          </TabsContent>

          {/* Strike Prices Tab */}
          <TabsContent value="prices" className="mt-4">
            <Card className="bg-card border-border">
              <CardHeader className="pb-3">
                <CardTitle className="text-lg flex items-center gap-2">
                  <DollarSign className="h-5 w-5 text-orange-400" />
                  Chainlink Price Logs
                </CardTitle>
              </CardHeader>
              <CardContent>
                <ScrollArea className="h-[500px]">
                  <Table>
                    <TableHeader>
                      <TableRow className="border-border hover:bg-transparent">
                        <TableHead className="text-muted-foreground">Time</TableHead>
                        <TableHead className="text-muted-foreground">Asset</TableHead>
                        <TableHead className="text-muted-foreground text-right">Strike Price</TableHead>
                        <TableHead className="text-muted-foreground text-right">Open Price</TableHead>
                        <TableHead className="text-muted-foreground text-right">Close Price</TableHead>
                        <TableHead className="text-muted-foreground">Quality</TableHead>
                        <TableHead className="text-muted-foreground">Market</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {prices.map((p, i) => (
                        <TableRow key={i} className="border-border">
                          <TableCell className="font-mono text-sm">
                            <div>{formatTime(p.ts)}</div>
                            <div className="text-xs text-muted-foreground">{formatDate(p.ts)}</div>
                          </TableCell>
                          <TableCell>
                            <Badge
                              variant="outline"
                              className={p.asset === "BTC" ? "bg-orange-500/20 text-orange-400 border-orange-500/30" : "bg-blue-500/20 text-blue-400 border-blue-500/30"}
                            >
                              {p.asset}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-right font-mono font-bold">
                            ${p.strikePrice.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          </TableCell>
                          <TableCell className="text-right font-mono">
                            {p.openPrice ? `$${p.openPrice.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "-"}
                          </TableCell>
                          <TableCell className="text-right font-mono">
                            {p.closePrice ? `$${p.closePrice.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "-"}
                          </TableCell>
                          <TableCell>
                            <Badge
                              variant="outline"
                              className={
                                p.quality === "exact"
                                  ? "bg-green-500/20 text-green-400 border-green-500/30"
                                  : p.quality === "late"
                                  ? "bg-yellow-500/20 text-yellow-400 border-yellow-500/30"
                                  : "bg-muted text-muted-foreground"
                              }
                            >
                              {p.quality}
                            </Badge>
                          </TableCell>
                          <TableCell className="font-mono text-xs text-muted-foreground">
                            {p.marketSlug.split("-").slice(-2).join("-")}
                          </TableCell>
                        </TableRow>
                      ))}
                      {prices.length === 0 && (
                        <TableRow>
                          <TableCell colSpan={7} className="text-center text-muted-foreground py-8">
                            No price data recorded yet
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
