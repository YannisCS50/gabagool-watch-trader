import { useState, useEffect, useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Download, RefreshCw, Filter, Activity, Package, Database } from "lucide-react";
import { DownloadAllLogsButton } from "@/components/DownloadAllLogsButton";
import { DownloadEnrichedFillsButton } from "@/components/DownloadEnrichedFillsButton";
import { DownloadAuditCodeButton } from "@/components/DownloadAuditCodeButton";
import { DownloadZipButton } from "@/components/DownloadZipButton";
import { DownloadGabagoolButton } from "@/components/DownloadGabagoolButton";
import { format } from "date-fns";
import { toast } from "sonner";
import { NavLink } from "@/components/NavLink";

interface BotEvent {
  id: string;
  ts: number;
  asset: string;
  event_type: string;
  market_id: string | null;
  run_id: string | null;
  correlation_id: string | null;
  reason_code: string | null;
  data: unknown;
  created_at: string;
}

interface Order {
  id: string;
  asset: string;
  market_id: string;
  client_order_id: string;
  exchange_order_id: string | null;
  side: string;
  intent_type: string;
  status: string;
  qty: number;
  price: number;
  filled_qty: number | null;
  avg_fill_price: number | null;
  correlation_id: string | null;
  created_ts: number;
  last_update_ts: number;
  created_at: string;
}

interface InventorySnapshot {
  id: string;
  ts: number;
  asset: string;
  market_id: string;
  state: string;
  up_shares: number;
  down_shares: number;
  avg_up_cost: number | null;
  avg_down_cost: number | null;
  pair_cost: number | null;
  unpaired_shares: number | null;
  hedge_lag_ms: number | null;
  state_age_ms: number | null;
  trigger_type: string | null;
  created_at: string;
}

interface FillLog {
  id: string;
  ts: number;
  asset: string;
  market_id: string;
  side: string;
  intent: string;
  fill_qty: number;
  fill_price: number;
  fill_notional: number;
  delta: number | null;
  spot_price: number | null;
  strike_price: number | null;
  seconds_remaining: number;
  hedge_lag_ms: number | null;
  correlation_id: string | null;
  created_at: string;
}

interface SnapshotLog {
  id: string;
  ts: number;
  asset: string;
  market_id: string;
  bot_state: string;
  up_shares: number;
  down_shares: number;
  up_ask: number | null;
  down_ask: number | null;
  combined_ask: number | null;
  delta: number | null;
  spot_price: number | null;
  strike_price: number | null;
  seconds_remaining: number;
  reason_code: string | null;
  created_at: string;
}

export default function Observability() {
  const [botEvents, setBotEvents] = useState<BotEvent[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [inventorySnapshots, setInventorySnapshots] = useState<InventorySnapshot[]>([]);
  const [fillLogs, setFillLogs] = useState<FillLog[]>([]);
  const [snapshotLogs, setSnapshotLogs] = useState<SnapshotLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [isDownloading, setIsDownloading] = useState(false);

  // Filters
  const [runIdFilter, setRunIdFilter] = useState("");
  const [correlationIdFilter, setCorrelationIdFilter] = useState("");
  const [assetFilter, setAssetFilter] = useState<string>("all");

  const loadData = async () => {
    setLoading(true);
    try {
      const [eventsRes, ordersRes, inventoryRes, fillsRes, snapshotsRes] = await Promise.all([
        supabase.from("bot_events").select("*").order("ts", { ascending: false }).limit(500),
        supabase.from("orders").select("*").order("created_ts", { ascending: false }).limit(500),
        supabase.from("inventory_snapshots").select("*").order("ts", { ascending: false }).limit(500),
        supabase.from("fill_logs").select("*").order("ts", { ascending: false }).limit(500),
        supabase.from("snapshot_logs").select("*").order("ts", { ascending: false }).limit(500),
      ]);

      if (eventsRes.data) setBotEvents(eventsRes.data);
      if (ordersRes.data) setOrders(ordersRes.data);
      if (inventoryRes.data) setInventorySnapshots(inventoryRes.data);
      if (fillsRes.data) setFillLogs(fillsRes.data);
      if (snapshotsRes.data) setSnapshotLogs(snapshotsRes.data);
    } catch (error) {
      console.error("Error loading data:", error);
      toast.error("Failed to load observability data");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  // Get unique run_ids, correlation_ids, and assets
  const uniqueRunIds = useMemo(() => {
    const ids = new Set<string>();
    botEvents.forEach(e => e.run_id && ids.add(e.run_id));
    orders.forEach(o => o.correlation_id && ids.add(o.correlation_id));
    inventorySnapshots.forEach(i => i.trigger_type && ids.add(i.trigger_type));
    return Array.from(ids).slice(0, 20);
  }, [botEvents, orders, inventorySnapshots]);

  const uniqueAssets = useMemo(() => {
    const assets = new Set<string>();
    botEvents.forEach(e => assets.add(e.asset));
    orders.forEach(o => assets.add(o.asset));
    inventorySnapshots.forEach(i => assets.add(i.asset));
    fillLogs.forEach(f => assets.add(f.asset));
    snapshotLogs.forEach(s => assets.add(s.asset));
    return Array.from(assets);
  }, [botEvents, orders, inventorySnapshots, fillLogs, snapshotLogs]);

  // Filtered data
  const filteredEvents = useMemo(() => {
    return botEvents.filter(e => {
      if (runIdFilter && e.run_id !== runIdFilter) return false;
      if (correlationIdFilter && e.correlation_id !== correlationIdFilter) return false;
      if (assetFilter !== "all" && e.asset !== assetFilter) return false;
      return true;
    });
  }, [botEvents, runIdFilter, correlationIdFilter, assetFilter]);

  const filteredOrders = useMemo(() => {
    return orders.filter(o => {
      if (correlationIdFilter && o.correlation_id !== correlationIdFilter) return false;
      if (assetFilter !== "all" && o.asset !== assetFilter) return false;
      return true;
    });
  }, [orders, correlationIdFilter, assetFilter]);

  const filteredInventory = useMemo(() => {
    return inventorySnapshots.filter(i => {
      if (assetFilter !== "all" && i.asset !== assetFilter) return false;
      return true;
    });
  }, [inventorySnapshots, assetFilter]);

  const filteredFills = useMemo(() => {
    return fillLogs.filter(f => {
      if (correlationIdFilter && f.correlation_id !== correlationIdFilter) return false;
      if (assetFilter !== "all" && f.asset !== assetFilter) return false;
      return true;
    });
  }, [fillLogs, correlationIdFilter, assetFilter]);

  const filteredSnapshots = useMemo(() => {
    return snapshotLogs.filter(s => {
      if (assetFilter !== "all" && s.asset !== assetFilter) return false;
      return true;
    });
  }, [snapshotLogs, assetFilter]);

  const formatTs = (ts: number) => {
    try {
      return format(new Date(ts), "HH:mm:ss.SSS");
    } catch {
      return "-";
    }
  };

  const getEventTypeColor = (type: string) => {
    switch (type) {
      case "FILL": return "bg-green-500/20 text-green-400";
      case "ORDER_PLACED": return "bg-blue-500/20 text-blue-400";
      case "ORDER_CANCELLED": return "bg-yellow-500/20 text-yellow-400";
      case "ERROR": return "bg-red-500/20 text-red-400";
      case "CYCLE_START": return "bg-purple-500/20 text-purple-400";
      case "CYCLE_END": return "bg-purple-500/20 text-purple-400";
      default: return "bg-muted text-muted-foreground";
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case "FILLED": return "bg-green-500/20 text-green-400";
      case "PARTIALLY_FILLED": return "bg-yellow-500/20 text-yellow-400";
      case "NEW": return "bg-blue-500/20 text-blue-400";
      case "CANCELLED": return "bg-red-500/20 text-red-400";
      default: return "bg-muted text-muted-foreground";
    }
  };

  const getStateColor = (state: string) => {
    switch (state) {
      case "HEDGED": return "bg-green-500/20 text-green-400";
      case "OPENING": return "bg-blue-500/20 text-blue-400";
      case "HEDGING": return "bg-yellow-500/20 text-yellow-400";
      case "UNHEDGED": return "bg-red-500/20 text-red-400";
      case "IDLE": return "bg-muted text-muted-foreground";
      case "ACCUMULATING": return "bg-purple-500/20 text-purple-400";
      default: return "bg-muted text-muted-foreground";
    }
  };

  const getIntentColor = (intent: string) => {
    switch (intent) {
      case "OPENING": return "bg-blue-500/20 text-blue-400";
      case "HEDGE": return "bg-yellow-500/20 text-yellow-400";
      case "ACCUMULATE": return "bg-purple-500/20 text-purple-400";
      case "FORCE_HEDGE": return "bg-red-500/20 text-red-400";
      default: return "bg-muted text-muted-foreground";
    }
  };

  const downloadAllLogs = async () => {
    setIsDownloading(true);
    try {
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      const cutoff = thirtyDaysAgo.toISOString();

      const [
        eventsRes,
        ordersRes,
        inventoryRes,
        fillsRes,
        snapshotRes,
        settlementRes,
        fundingRes,
      ] = await Promise.all([
        supabase.from("bot_events").select("*").gte("created_at", cutoff).order("ts", { ascending: false }),
        supabase.from("orders").select("*").gte("created_at", cutoff).order("created_ts", { ascending: false }),
        supabase.from("inventory_snapshots").select("*").gte("created_at", cutoff).order("ts", { ascending: false }),
        supabase.from("fill_logs").select("*").gte("created_at", cutoff).order("ts", { ascending: false }),
        supabase.from("snapshot_logs").select("*").gte("created_at", cutoff).order("ts", { ascending: false }),
        supabase.from("settlement_logs").select("*").gte("created_at", cutoff).order("ts", { ascending: false }),
        supabase.from("funding_snapshots").select("*").gte("created_at", cutoff).order("ts", { ascending: false }),
      ]);

      const allData = {
        bot_events: eventsRes.data || [],
        orders: ordersRes.data || [],
        inventory_snapshots: inventoryRes.data || [],
        fill_logs: fillsRes.data || [],
        snapshot_logs: snapshotRes.data || [],
        settlement_logs: settlementRes.data || [],
        funding_snapshots: fundingRes.data || [],
        exported_at: new Date().toISOString(),
      };

      const blob = new Blob([JSON.stringify(allData, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `observability-logs-${format(new Date(), "yyyy-MM-dd-HHmmss")}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      toast.success(`Downloaded ${Object.values(allData).reduce((sum, arr) => sum + (Array.isArray(arr) ? arr.length : 0), 0)} records`);
    } catch (error) {
      console.error("Download error:", error);
      toast.error("Failed to download logs");
    } finally {
      setIsDownloading(false);
    }
  };

  const downloadTable = (data: unknown[], tableName: string) => {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${tableName}-${format(new Date(), "yyyy-MM-dd-HHmmss")}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast.success(`Downloaded ${data.length} ${tableName} records`);
  };

  const clearFilters = () => {
    setRunIdFilter("");
    setCorrelationIdFilter("");
    setAssetFilter("all");
  };

  return (
    <div className="min-h-screen bg-background p-6">
      <div className="max-w-7xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-foreground">Observability Dashboard</h1>
            <p className="text-muted-foreground">Bot events, orders & inventory tracking</p>
          </div>
          <div className="flex gap-2">
            <NavLink to="/">← Home</NavLink>
            <Button variant="outline" onClick={loadData} disabled={loading}>
              <RefreshCw className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`} />
              Refresh
            </Button>
            <DownloadGabagoolButton />
            <DownloadZipButton />
            <DownloadAllLogsButton />
            <DownloadEnrichedFillsButton />
            <DownloadAuditCodeButton />
          </div>
        </div>

        {/* Stats Cards */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <Activity className="h-4 w-4" />
                Bot Events
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{filteredEvents.length}</div>
              <p className="text-xs text-muted-foreground">of {botEvents.length}</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <Package className="h-4 w-4" />
                Orders
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{filteredOrders.length}</div>
              <p className="text-xs text-muted-foreground">of {orders.length}</p>
            </CardContent>
          </Card>
          <Card className="bg-green-500/10 border-green-500/30">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium flex items-center gap-2 text-green-400">
                <Activity className="h-4 w-4" />
                Fills
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-green-400">{filteredFills.length}</div>
              <p className="text-xs text-muted-foreground">of {fillLogs.length}</p>
            </CardContent>
          </Card>
          <Card className="bg-blue-500/10 border-blue-500/30">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium flex items-center gap-2 text-blue-400">
                <Database className="h-4 w-4" />
                Snapshots
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-blue-400">{filteredSnapshots.length}</div>
              <p className="text-xs text-muted-foreground">of {snapshotLogs.length}</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <Database className="h-4 w-4" />
                Inventory
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{filteredInventory.length}</div>
              <p className="text-xs text-muted-foreground">of {inventorySnapshots.length}</p>
            </CardContent>
          </Card>
        </div>

        {/* Filters */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Filter className="h-4 w-4" />
              Filters
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">Run ID</label>
                <Input
                  placeholder="Enter run_id..."
                  value={runIdFilter}
                  onChange={(e) => setRunIdFilter(e.target.value)}
                  className="font-mono text-xs"
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">Correlation ID</label>
                <Input
                  placeholder="Enter correlation_id..."
                  value={correlationIdFilter}
                  onChange={(e) => setCorrelationIdFilter(e.target.value)}
                  className="font-mono text-xs"
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">Asset</label>
                <Select value={assetFilter} onValueChange={setAssetFilter}>
                  <SelectTrigger>
                    <SelectValue placeholder="All assets" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Assets</SelectItem>
                    {uniqueAssets.map(asset => (
                      <SelectItem key={asset} value={asset}>{asset}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-end">
                <Button variant="outline" onClick={clearFilters} className="w-full">
                  Clear Filters
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Data Tables */}
        <Tabs defaultValue="fills" className="space-y-4">
          <TabsList className="flex-wrap h-auto">
            <TabsTrigger value="fills">Fills ({filteredFills.length})</TabsTrigger>
            <TabsTrigger value="snapshots">Snapshots ({filteredSnapshots.length})</TabsTrigger>
            <TabsTrigger value="events">Bot Events ({filteredEvents.length})</TabsTrigger>
            <TabsTrigger value="orders">Orders ({filteredOrders.length})</TabsTrigger>
            <TabsTrigger value="inventory">Inventory ({filteredInventory.length})</TabsTrigger>
          </TabsList>

          {/* Fills Tab */}
          <TabsContent value="fills">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle>Fill Logs</CardTitle>
                <Button variant="outline" size="sm" onClick={() => downloadTable(filteredFills, "fill_logs")}>
                  <Download className="h-4 w-4 mr-2" />
                  Export
                </Button>
              </CardHeader>
              <CardContent>
                <ScrollArea className="h-[500px]">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Time</TableHead>
                        <TableHead>Asset</TableHead>
                        <TableHead>Side</TableHead>
                        <TableHead>Intent</TableHead>
                        <TableHead>Qty</TableHead>
                        <TableHead>Price</TableHead>
                        <TableHead>Notional</TableHead>
                        <TableHead>Delta</TableHead>
                        <TableHead>Secs Left</TableHead>
                        <TableHead>Hedge Lag</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredFills.map((fill) => (
                        <TableRow key={fill.id}>
                          <TableCell className="font-mono text-xs">{formatTs(fill.ts)}</TableCell>
                          <TableCell>
                            <Badge variant="outline">{fill.asset}</Badge>
                          </TableCell>
                          <TableCell>
                            <Badge className={fill.side === "UP" ? "bg-green-500/20 text-green-400" : "bg-red-500/20 text-red-400"}>
                              {fill.side}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <Badge className={getIntentColor(fill.intent)}>{fill.intent}</Badge>
                          </TableCell>
                          <TableCell className="font-mono">{fill.fill_qty.toFixed(2)}</TableCell>
                          <TableCell className="font-mono">${fill.fill_price.toFixed(4)}</TableCell>
                          <TableCell className="font-mono">${fill.fill_notional.toFixed(2)}</TableCell>
                          <TableCell className="font-mono">
                            {fill.delta != null ? `${(fill.delta * 100).toFixed(1)}%` : "-"}
                          </TableCell>
                          <TableCell className="font-mono">{fill.seconds_remaining}s</TableCell>
                          <TableCell className="font-mono">
                            {fill.hedge_lag_ms ? `${fill.hedge_lag_ms}ms` : "-"}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </ScrollArea>
              </CardContent>
            </Card>
          </TabsContent>

          {/* Snapshots Tab */}
          <TabsContent value="snapshots">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle>Snapshot Logs</CardTitle>
                <Button variant="outline" size="sm" onClick={() => downloadTable(filteredSnapshots, "snapshot_logs")}>
                  <Download className="h-4 w-4 mr-2" />
                  Export
                </Button>
              </CardHeader>
              <CardContent>
                <ScrollArea className="h-[500px]">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Time</TableHead>
                        <TableHead>Asset</TableHead>
                        <TableHead>State</TableHead>
                        <TableHead>Up/Down</TableHead>
                        <TableHead>Combined Ask</TableHead>
                        <TableHead>Delta</TableHead>
                        <TableHead>Secs Left</TableHead>
                        <TableHead>Reason</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredSnapshots.map((snap) => (
                        <TableRow key={snap.id}>
                          <TableCell className="font-mono text-xs">{formatTs(snap.ts)}</TableCell>
                          <TableCell>
                            <Badge variant="outline">{snap.asset}</Badge>
                          </TableCell>
                          <TableCell>
                            <Badge className={getStateColor(snap.bot_state)}>{snap.bot_state}</Badge>
                          </TableCell>
                          <TableCell className="font-mono text-xs">
                            {snap.up_shares.toFixed(1)} / {snap.down_shares.toFixed(1)}
                          </TableCell>
                          <TableCell className="font-mono">
                            {snap.combined_ask != null ? `$${snap.combined_ask.toFixed(4)}` : "-"}
                          </TableCell>
                          <TableCell className="font-mono">
                            {snap.delta != null ? `${(snap.delta * 100).toFixed(1)}%` : "-"}
                          </TableCell>
                          <TableCell className="font-mono">{snap.seconds_remaining}s</TableCell>
                          <TableCell className="text-xs max-w-[150px] truncate">{snap.reason_code || "-"}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </ScrollArea>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="events">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle>Bot Events</CardTitle>
                <Button variant="outline" size="sm" onClick={() => downloadTable(filteredEvents, "bot_events")}>
                  <Download className="h-4 w-4 mr-2" />
                  Export
                </Button>
              </CardHeader>
              <CardContent>
                <ScrollArea className="h-[500px]">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Time</TableHead>
                        <TableHead>Asset</TableHead>
                        <TableHead>Event Type</TableHead>
                        <TableHead>Market</TableHead>
                        <TableHead>Reason</TableHead>
                        <TableHead>Run ID</TableHead>
                        <TableHead>Data</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredEvents.map((event) => (
                        <TableRow key={event.id}>
                          <TableCell className="font-mono text-xs">{formatTs(event.ts)}</TableCell>
                          <TableCell>
                            <Badge variant="outline">{event.asset}</Badge>
                          </TableCell>
                          <TableCell>
                            <Badge className={getEventTypeColor(event.event_type)}>{event.event_type}</Badge>
                          </TableCell>
                          <TableCell className="font-mono text-xs max-w-[150px] truncate">
                            {event.market_id?.slice(0, 20) || "-"}
                          </TableCell>
                          <TableCell className="text-xs">{event.reason_code || "-"}</TableCell>
                          <TableCell className="font-mono text-xs max-w-[100px] truncate">
                            {event.run_id?.slice(0, 8) || "-"}
                          </TableCell>
                          <TableCell className="font-mono text-xs max-w-[200px] truncate">
                            {event.data ? JSON.stringify(event.data).slice(0, 50) : "-"}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </ScrollArea>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="orders">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle>Orders</CardTitle>
                <Button variant="outline" size="sm" onClick={() => downloadTable(filteredOrders, "orders")}>
                  <Download className="h-4 w-4 mr-2" />
                  Export
                </Button>
              </CardHeader>
              <CardContent>
                <ScrollArea className="h-[500px]">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Time</TableHead>
                        <TableHead>Asset</TableHead>
                        <TableHead>Side</TableHead>
                        <TableHead>Intent</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Qty</TableHead>
                        <TableHead>Price</TableHead>
                        <TableHead>Filled</TableHead>
                        <TableHead>Avg Fill</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredOrders.map((order) => (
                        <TableRow key={order.id}>
                          <TableCell className="font-mono text-xs">{formatTs(order.created_ts)}</TableCell>
                          <TableCell>
                            <Badge variant="outline">{order.asset}</Badge>
                          </TableCell>
                          <TableCell>
                            <Badge className={order.side === "BUY" ? "bg-green-500/20 text-green-400" : "bg-red-500/20 text-red-400"}>
                              {order.side}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-xs">{order.intent_type}</TableCell>
                          <TableCell>
                            <Badge className={getStatusColor(order.status)}>{order.status}</Badge>
                          </TableCell>
                          <TableCell className="font-mono">{order.qty.toFixed(2)}</TableCell>
                          <TableCell className="font-mono">${order.price.toFixed(4)}</TableCell>
                          <TableCell className="font-mono">{order.filled_qty?.toFixed(2) || "-"}</TableCell>
                          <TableCell className="font-mono">
                            {order.avg_fill_price ? `$${order.avg_fill_price.toFixed(4)}` : "-"}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </ScrollArea>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="inventory">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle>Inventory Snapshots</CardTitle>
                <Button variant="outline" size="sm" onClick={() => downloadTable(filteredInventory, "inventory_snapshots")}>
                  <Download className="h-4 w-4 mr-2" />
                  Export
                </Button>
              </CardHeader>
              <CardContent>
                <ScrollArea className="h-[500px]">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Time</TableHead>
                        <TableHead>Asset</TableHead>
                        <TableHead>State</TableHead>
                        <TableHead>Up Shares</TableHead>
                        <TableHead>Down Shares</TableHead>
                        <TableHead>Pair Cost</TableHead>
                        <TableHead>Unpaired</TableHead>
                        <TableHead>Hedge Lag</TableHead>
                        <TableHead>Trigger</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredInventory.map((inv) => (
                        <TableRow key={inv.id}>
                          <TableCell className="font-mono text-xs">{formatTs(inv.ts)}</TableCell>
                          <TableCell>
                            <Badge variant="outline">{inv.asset}</Badge>
                          </TableCell>
                          <TableCell>
                            <Badge className={getStateColor(inv.state)}>{inv.state}</Badge>
                          </TableCell>
                          <TableCell className="font-mono">{inv.up_shares.toFixed(2)}</TableCell>
                          <TableCell className="font-mono">{inv.down_shares.toFixed(2)}</TableCell>
                          <TableCell className="font-mono">
                            {inv.pair_cost ? `$${inv.pair_cost.toFixed(4)}` : "-"}
                          </TableCell>
                          <TableCell className="font-mono">{inv.unpaired_shares?.toFixed(2) || "-"}</TableCell>
                          <TableCell className="font-mono">
                            {inv.hedge_lag_ms ? `${inv.hedge_lag_ms}ms` : "-"}
                          </TableCell>
                          <TableCell className="text-xs">{inv.trigger_type || "-"}</TableCell>
                        </TableRow>
                      ))}
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
