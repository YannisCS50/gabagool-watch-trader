import React, { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { toast } from "sonner";
import { format } from "date-fns";
import {
  Download,
  Loader2,
  Database,
  ChevronDown,
  ChevronRight,
  BarChart3,
  Activity,
  Settings,
  Clock,
  TrendingUp,
  Shield,
  FileText,
  Zap,
  Users,
  Target,
  ArrowLeft,
  Info,
  AlertTriangle,
  CheckCircle2,
} from "lucide-react";

// Table definitions with descriptions and categories
interface TableDef {
  name: string;
  description: string;
  category: string;
  priority: "high" | "medium" | "low";
  rowEstimate?: string;
  mergesWith?: string[];
  orderBy?: string;
}

const TABLE_DEFINITIONS: TableDef[] = [
  // === V29 Response (Current Strategy) ===
  { name: "v29_signals_response", description: "Alle trade signals met entry/exit, PnL, latency. PRIMAIRE data voor analyse.", category: "V29 Response (Actief)", priority: "high", orderBy: "created_at" },
  { name: "v29_ticks_response", description: "Tick-by-tick prijsdata met Binance/Polymarket spreads.", category: "V29 Response (Actief)", priority: "medium", orderBy: "ts" },
  { name: "v29_logs_response", description: "Debug logs van de V29R runner.", category: "V29 Response (Actief)", priority: "low", orderBy: "created_at" },
  { name: "v29_config_response", description: "Huidige configuratie van V29R strategie.", category: "V29 Response (Actief)", priority: "medium" },
  
  // === Runner & System ===
  { name: "runner_heartbeats", description: "Status en health van de trading bot. Bevat balance, markets, positions count.", category: "Runner & System", priority: "high", orderBy: "last_heartbeat" },
  { name: "runner_leases", description: "Lock mechanisme om te voorkomen dat meerdere runners tegelijk draaien.", category: "Runner & System", priority: "medium" },
  
  // === Accounting & PnL ===
  { name: "daily_pnl", description: "Dagelijkse PnL samenvatting per wallet. Realized + unrealized.", category: "Accounting & PnL", priority: "high", orderBy: "date" },
  { name: "pnl_snapshots", description: "Historische snapshots van totale account PnL.", category: "Accounting & PnL", priority: "high", orderBy: "ts" },
  { name: "true_pnl_snapshots", description: "True PnL berekend met CLOB balance + portfolio value.", category: "Accounting & PnL", priority: "high", orderBy: "hour" },
  { name: "deposits", description: "Gestorte bedragen voor ROI berekening.", category: "Accounting & PnL", priority: "medium", orderBy: "deposited_at" },
  { name: "claim_logs", description: "On-chain USDC claims van gewonnen posities.", category: "Accounting & PnL", priority: "medium", orderBy: "created_at" },
  
  // === Positions & Orders ===
  { name: "bot_positions", description: "Huidige posities gesynchroniseerd vanuit Polymarket.", category: "Positions & Orders", priority: "high", orderBy: "synced_at" },
  { name: "canonical_positions", description: "Canonieke state van posities met realized/unrealized PnL.", category: "Positions & Orders", priority: "high", orderBy: "updated_at" },
  { name: "order_queue", description: "Order queue voor pending/filled/failed orders.", category: "Positions & Orders", priority: "medium", orderBy: "created_at" },
  { name: "order_queue_archive", description: "Gearchiveerde oude orders.", category: "Positions & Orders", priority: "low", orderBy: "archived_at" },
  
  // === Market Data ===
  { name: "market_history", description: "Historische markt data met strike prices en resultaten.", category: "Market Data", priority: "high", orderBy: "event_end_time" },
  { name: "market_lifecycle", description: "Lifecycle tracking per markt (open/settled/claimed).", category: "Market Data", priority: "medium", orderBy: "updated_at" },
  { name: "market_config", description: "Configuratie per asset (enabled, thresholds, etc).", category: "Market Data", priority: "medium" },
  
  // === V29 Original ===
  { name: "v29_signals", description: "Signals van originele V29 strategie.", category: "V29 Original", priority: "medium", orderBy: "created_at", mergesWith: ["v29_signals_response"] },
  { name: "v29_ticks", description: "Tick data van originele V29.", category: "V29 Original", priority: "low", orderBy: "ts", mergesWith: ["v29_ticks_response"] },
  { name: "v29_logs", description: "Logs van originele V29.", category: "V29 Original", priority: "low", orderBy: "created_at", mergesWith: ["v29_logs_response"] },
  { name: "v29_config", description: "Config van originele V29.", category: "V29 Original", priority: "low" },
  { name: "v29_bets", description: "Bet aggregaties per markt window.", category: "V29 Original", priority: "medium", orderBy: "created_at" },
  { name: "v29_fills", description: "Fill events van V29.", category: "V29 Original", priority: "medium", orderBy: "created_at" },
  { name: "v29_orders", description: "Order records van V29.", category: "V29 Original", priority: "medium", orderBy: "created_at" },
  { name: "v29_positions", description: "Positie tracking van V29.", category: "V29 Original", priority: "medium", orderBy: "updated_at" },
  { name: "v29_aggregate_positions", description: "Geaggregeerde posities per market/side.", category: "V29 Original", priority: "medium", orderBy: "updated_at" },
  
  // === V30 Market Maker ===
  { name: "v30_config", description: "V30 market maker configuratie.", category: "V30 Market Maker", priority: "medium" },
  { name: "v30_logs", description: "V30 runner logs.", category: "V30 Market Maker", priority: "low", orderBy: "created_at" },
  
  // === V26/V27 Legacy ===
  { name: "v26_config", description: "V26 pre-market strategie config.", category: "Legacy (V26/V27)", priority: "low" },
  { name: "v26_trades", description: "V26 trade records.", category: "Legacy (V26/V27)", priority: "low", orderBy: "created_at" },
  { name: "v27_config", description: "V27 mispricing strategie config.", category: "Legacy (V26/V27)", priority: "low" },
  { name: "v27_entries", description: "V27 entry records.", category: "Legacy (V26/V27)", priority: "low", orderBy: "created_at" },
  { name: "v27_evaluations", description: "V27 signal evaluaties.", category: "Legacy (V26/V27)", priority: "low", orderBy: "created_at" },
  { name: "v27_signals", description: "V27 detected signals.", category: "Legacy (V26/V27)", priority: "low", orderBy: "created_at" },
  
  // === Observability & Logs ===
  { name: "bot_events", description: "Interne bot events (state changes, errors).", category: "Observability", priority: "medium", orderBy: "created_at" },
  { name: "fill_logs", description: "Gedetailleerde fill events met delta/intent.", category: "Observability", priority: "medium", orderBy: "created_at" },
  { name: "snapshot_logs", description: "Periodieke state snapshots van de bot.", category: "Observability", priority: "medium", orderBy: "created_at" },
  { name: "inventory_snapshots", description: "Inventory state per market.", category: "Observability", priority: "low", orderBy: "created_at" },
  { name: "funding_snapshots", description: "Funding/balance snapshots.", category: "Observability", priority: "low", orderBy: "created_at" },
  { name: "decision_snapshots", description: "Beslissings-context voor elke trade.", category: "Observability", priority: "medium", orderBy: "created_at" },
  { name: "hedge_intents", description: "Hedge intent tracking.", category: "Observability", priority: "low", orderBy: "created_at" },
  { name: "settlement_logs", description: "Settlement resultaten per markt.", category: "Observability", priority: "medium", orderBy: "created_at" },
  
  // === Analysis & Quality ===
  { name: "signal_quality_analysis", description: "Signal kwaliteits analyse met edge/spread metrics.", category: "Analysis", priority: "high", orderBy: "created_at" },
  { name: "bucket_statistics", description: "Performance statistieken per delta bucket.", category: "Analysis", priority: "medium" },
  { name: "toxicity_features", description: "Market toxicity analysis.", category: "Analysis", priority: "medium", orderBy: "created_at" },
  
  // === Shadow Trading ===
  { name: "shadow_positions", description: "Paper trade posities in shadow mode.", category: "Shadow Trading", priority: "low", orderBy: "created_at" },
  { name: "shadow_accounting", description: "Shadow mode accounting.", category: "Shadow Trading", priority: "low", orderBy: "created_at" },
  { name: "shadow_hedge_attempts", description: "Hedge pogingen in shadow mode.", category: "Shadow Trading", priority: "low", orderBy: "created_at" },
  
  // === External Data ===
  { name: "chainlink_prices", description: "Chainlink oracle prijzen.", category: "External Data", priority: "low", orderBy: "created_at" },
  { name: "price_ticks", description: "Prijsticks van diverse bronnen.", category: "External Data", priority: "low", orderBy: "created_at" },
  { name: "realtime_price_logs", description: "Realtime price feed logs.", category: "External Data", priority: "low", orderBy: "created_at" },
  
  // === Gabagool Benchmark ===
  { name: "trades", description: "Gabagool trades voor benchmarking (3M+ rijen!).", category: "Gabagool Benchmark", priority: "low", orderBy: "timestamp" },
  { name: "positions", description: "Gabagool posities.", category: "Gabagool Benchmark", priority: "low", orderBy: "created_at" },
  { name: "position_snapshots", description: "Gabagool positie snapshots.", category: "Gabagool Benchmark", priority: "low", orderBy: "snapshot_at" },
  { name: "gabagool_metrics", description: "Gabagool strategy metrics (CPP, fills, etc).", category: "Gabagool Benchmark", priority: "medium", orderBy: "ts" },
  { name: "tracked_wallet_trades", description: "Trades van tracked wallets.", category: "Gabagool Benchmark", priority: "medium", orderBy: "created_at" },
  
  // === Subgraph & On-chain ===
  { name: "raw_subgraph_events", description: "Raw events van Polymarket subgraph.", category: "On-chain Data", priority: "medium", orderBy: "timestamp" },
  { name: "cashflow_ledger", description: "Cashflow ledger van subgraph events.", category: "On-chain Data", priority: "medium", orderBy: "timestamp" },
  { name: "polymarket_cashflows", description: "Polymarket cashflow events.", category: "On-chain Data", priority: "low", orderBy: "ts" },
  { name: "subgraph_fills", description: "Parsed fills van subgraph.", category: "On-chain Data", priority: "medium", orderBy: "created_at" },
  { name: "subgraph_positions", description: "Subgraph positie data.", category: "On-chain Data", priority: "low", orderBy: "updated_at" },
  { name: "subgraph_pnl_markets", description: "PnL per market van subgraph.", category: "On-chain Data", priority: "medium" },
  { name: "subgraph_pnl_summary", description: "Totale PnL summary van subgraph.", category: "On-chain Data", priority: "medium" },
  
  // === Strike Prices ===
  { name: "strike_prices", description: "Strike prices per market/asset.", category: "Market Data", priority: "high", orderBy: "created_at" },
  
  // === Misc ===
  { name: "live_trades", description: "Live trade records.", category: "Trades", priority: "medium", orderBy: "created_at" },
  { name: "live_trades_archive", description: "Gearchiveerde live trades.", category: "Trades", priority: "low", orderBy: "archived_at" },
  { name: "live_trade_results", description: "Trade resultaten met settlement info.", category: "Trades", priority: "medium", orderBy: "settled_at" },
  { name: "arbitrage_paper_trades", description: "Paper trade resultaten.", category: "Trades", priority: "low", orderBy: "created_at" },
  { name: "paper_trades", description: "Paper trading records.", category: "Trades", priority: "low", orderBy: "created_at" },
  { name: "bot_config", description: "Bot configuratie.", category: "Config", priority: "medium" },
  { name: "paper_trading_config", description: "Paper trading configuratie.", category: "Config", priority: "low" },
];

const CATEGORY_ICONS: Record<string, React.ElementType> = {
  "V29 Response (Actief)": Zap,
  "Runner & System": Activity,
  "Accounting & PnL": TrendingUp,
  "Positions & Orders": Target,
  "Market Data": BarChart3,
  "V29 Original": Database,
  "V30 Market Maker": Shield,
  "Legacy (V26/V27)": Clock,
  "Observability": FileText,
  "Analysis": BarChart3,
  "Shadow Trading": Users,
  "External Data": Database,
  "Gabagool Benchmark": Users,
  "On-chain Data": Shield,
  "Trades": TrendingUp,
  "Config": Settings,
};

function DatabaseExport() {
  const [selectedTables, setSelectedTables] = useState<Set<string>>(
    new Set(TABLE_DEFINITIONS.filter(t => t.priority === "high").map(t => t.name))
  );
  const [isExporting, setIsExporting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [currentTable, setCurrentTable] = useState("");
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(
    new Set(["V29 Response (Actief)", "Accounting & PnL", "Positions & Orders"])
  );
  const [tableCounts, setTableCounts] = useState<Record<string, number>>({});

  const triggerDownload = (blob: Blob, fileName: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    a.rel = "noopener";
    // Some browsers are picky; keep it in DOM.
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Don't revoke immediately; some browsers will abort or truncate the download.
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };

  // Group tables by category
  const tablesByCategory = useMemo(() => {
    const grouped: Record<string, TableDef[]> = {};
    TABLE_DEFINITIONS.forEach(table => {
      if (!grouped[table.category]) {
        grouped[table.category] = [];
      }
      grouped[table.category].push(table);
    });
    return grouped;
  }, []);

  const categories = Object.keys(tablesByCategory);

  const toggleCategory = (category: string) => {
    setExpandedCategories(prev => {
      const next = new Set(prev);
      if (next.has(category)) {
        next.delete(category);
      } else {
        next.add(category);
      }
      return next;
    });
  };

  const toggleTable = (tableName: string) => {
    setSelectedTables(prev => {
      const next = new Set(prev);
      if (next.has(tableName)) {
        next.delete(tableName);
      } else {
        next.add(tableName);
      }
      return next;
    });
  };

  const selectAll = () => {
    setSelectedTables(new Set(TABLE_DEFINITIONS.map(t => t.name)));
  };

  const selectNone = () => {
    setSelectedTables(new Set());
  };

  const selectHighPriority = () => {
    setSelectedTables(new Set(TABLE_DEFINITIONS.filter(t => t.priority === "high").map(t => t.name)));
  };

  // Gabagool Reverse Engineering preset - all tables needed to analyze gabagool22 strategy
  const selectGabagoolReverseEngineering = () => {
    const gabagoolTables = [
      // Gabagool's actual trades and positions (trades has 3M+ rows!)
      "trades",
      "positions", 
      "position_snapshots",
      // Price data (ticks, chainlink, realtime)
      "price_ticks",
      "chainlink_prices",
      "realtime_price_logs",
      // V29 tick data (Binance + Polymarket spreads)
      "v29_ticks_response",
      "v29_ticks",
      // Market data with strike prices
      "market_history",
      "market_lifecycle",
      "strike_prices",
      // Our own signals for comparison
      "v29_signals_response",
      "v29_signals",
      // Fill/trade events
      "fill_logs",
      "live_trades",
      "live_trade_results",
      // Subgraph/on-chain data
      "raw_subgraph_events",
      "cashflow_ledger",
      "polymarket_cashflows",
      "subgraph_fills",
      // Bot positions for comparison
      "bot_positions",
      "canonical_positions",
      // Analysis data
      "signal_quality_analysis",
      "bucket_statistics",
      "gabagool_metrics",
      // Tracked wallet data
      "tracked_wallet_trades",
    ];
    
    // Filter only existing tables from definitions
    const validTables = gabagoolTables.filter(t => 
      TABLE_DEFINITIONS.some(def => def.name === t)
    );
    
    // Log which tables were NOT found for debugging
    const missingTables = gabagoolTables.filter(t => 
      !TABLE_DEFINITIONS.some(def => def.name === t)
    );
    if (missingTables.length > 0) {
      console.warn("Gabagool preset: these tables are not in TABLE_DEFINITIONS:", missingTables);
    }
    
    setSelectedTables(new Set(validTables));
    
    // Start export directly
    toast.info(`Gabagool export start: ${validTables.length} tabellen...`, {
      description: `Let op: trades tabel heeft 3M+ rijen, dit kan even duren`
    });
    
    // Use setTimeout to allow state to update, then export
    setTimeout(() => {
      exportDatabaseWithTables(validTables);
    }, 100);
  };

  // Fetch row counts for selected tables
  const fetchRowCounts = async () => {
    const counts: Record<string, number> = {};
    for (const tableName of selectedTables) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { count, error } = await (supabase as any)
          .from(tableName)
          .select("*", { count: "exact", head: true });
        if (!error && count !== null) {
          counts[tableName] = count;
        }
      } catch {
        counts[tableName] = -1;
      }
    }
    setTableCounts(counts);
  };

  // Export tables using Edge Function (server-side, faster)
  const exportDatabaseWithTables = async (tablesToExport: string[]) => {
    if (tablesToExport.length === 0) {
      toast.error("Geen tabellen om te exporteren");
      return;
    }

    setIsExporting(true);
    setProgress(10);

    const fileName = `polytracker-db-export-${format(new Date(), "yyyy-MM-dd-HHmmss")}.zip`;

    // Prepare minimal meta mapping for README/manifest
    const tableMeta: Record<string, { category: string; description: string }> = {};
    for (const t of TABLE_DEFINITIONS) {
      tableMeta[t.name] = { category: t.category, description: t.description };
    }

    try {
      toast.info(`Server-side export gestart: ${tablesToExport.length} tabellen...`, {
        description: "Dit is 5-10x sneller dan client-side",
        duration: 5000,
      });

      setProgress(20);
      setCurrentTable("Fetching via Edge Function...");

      const { data, error } = await supabase.functions.invoke("database-export", {
        body: { tables: tablesToExport, tableMeta },
      });

      if (error) {
        throw new Error(error.message || "Edge function error");
      }

      setProgress(80);

      // Check if we got a blob/arraybuffer back
      if (data instanceof ArrayBuffer || data instanceof Blob) {
        const blob = data instanceof Blob ? data : new Blob([data], { type: "application/zip" });
        triggerDownload(blob, fileName);
        toast.success(`Export voltooid: ${tablesToExport.length} tabellen`, {
          description: "Server-side export succesvol",
        });
      } else if (data?.error) {
        throw new Error(data.error);
      } else {
        // If data is returned as JSON with error info
        console.error("[Export] Unexpected response:", data);
        throw new Error("Onverwacht response formaat");
      }

      setProgress(100);
    } catch (err) {
      console.error("[Export Error]", err);
      toast.error(`Export mislukt: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsExporting(false);
      setCurrentTable("");
      setProgress(0);
    }
  };

  // Wrapper that uses selected tables
  const exportDatabase = () => {
    if (selectedTables.size === 0) {
      toast.error("Selecteer minstens één tabel");
      return;
    }
    exportDatabaseWithTables(Array.from(selectedTables));
  };

  const generateReadme = (manifest: Record<string, { rows: number; description: string; category: string }>) => {
    let readme = `# PolyTracker Database Export\n\n`;
    readme += `**Exported at:** ${new Date().toISOString()}\n\n`;
    readme += `## Contents\n\n`;

    // Group by category
    const byCategory: Record<string, string[]> = {};
    Object.entries(manifest).forEach(([table, info]) => {
      if (!byCategory[info.category]) {
        byCategory[info.category] = [];
      }
      byCategory[info.category].push(`- **${table}** (${info.rows} rows): ${info.description}`);
    });

    Object.entries(byCategory).forEach(([category, tables]) => {
      readme += `### ${category}\n\n`;
      tables.forEach(t => {
        readme += `${t}\n`;
      });
      readme += `\n`;
    });

    readme += `## Data Dictionary\n\n`;
    readme += `### Key Tables\n\n`;
    readme += `#### v29_signals_response\n`;
    readme += `De **primaire tabel** voor trade analyse. Elke rij is één trade poging.\n\n`;
    readme += `| Column | Description |\n`;
    readme += `|--------|-------------|\n`;
    readme += `| id | Unieke signal ID |\n`;
    readme += `| asset | BTC of ETH |\n`;
    readme += `| direction | UP of DOWN |\n`;
    readme += `| entry_price | Entry prijs in cents |\n`;
    readme += `| exit_price | Exit prijs in cents |\n`;
    readme += `| net_pnl | Netto PnL in USD |\n`;
    readme += `| exit_reason | profit/adverse/timeout/stoploss |\n`;
    readme += `| spread_t0 | Spread bij entry |\n`;
    readme += `| binance_delta | Binance prijs vs strike |\n\n`;

    readme += `#### daily_pnl\n`;
    readme += `Dagelijkse PnL samenvatting.\n\n`;
    readme += `| Column | Description |\n`;
    readme += `|--------|-------------|\n`;
    readme += `| date | Datum |\n`;
    readme += `| realized_pnl | Gerealiseerde winst/verlies |\n`;
    readme += `| unrealized_pnl | Ongerealiseerde winst/verlies |\n`;
    readme += `| volume_traded | Totaal verhandeld volume |\n\n`;

    readme += `## Notes\n\n`;
    readme += `- Alle timestamps zijn in UTC\n`;
    readme += `- Prijzen zijn in cents (0.50 = $0.50)\n`;
    readme += `- PnL is in USD\n`;
    readme += `- Sommige tabellen hebben overlappende data (bijv. v29_signals en v29_signals_response)\n`;

    return readme;
  };

  const getPriorityBadge = (priority: "high" | "medium" | "low") => {
    const variants = {
      high: "default",
      medium: "secondary",
      low: "outline",
    } as const;
    const labels = {
      high: "Belangrijk",
      medium: "Medium",
      low: "Archief",
    };
    return <Badge variant={variants[priority]} className="text-xs">{labels[priority]}</Badge>;
  };

  return (
    <div className="min-h-screen bg-background">
      <div className="container max-w-6xl mx-auto py-8 px-4">
        {/* Header */}
        <div className="flex items-center gap-4 mb-8">
          <Link to="/">
            <Button variant="ghost" size="icon">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div>
            <h1 className="text-3xl font-bold flex items-center gap-2">
              <Database className="h-8 w-8" />
              Database Export
            </h1>
            <p className="text-muted-foreground mt-1">
              Download de volledige database als ZIP met JSON bestanden
            </p>
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
          <Card>
            <CardContent className="pt-6">
              <div className="text-2xl font-bold">{TABLE_DEFINITIONS.length}</div>
              <div className="text-sm text-muted-foreground">Totaal tabellen</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="text-2xl font-bold text-primary">{selectedTables.size}</div>
              <div className="text-sm text-muted-foreground">Geselecteerd</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="text-2xl font-bold text-primary">
                {TABLE_DEFINITIONS.filter(t => t.priority === "high").length}
              </div>
              <div className="text-sm text-muted-foreground">Belangrijke tabellen</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="text-2xl font-bold">{categories.length}</div>
              <div className="text-sm text-muted-foreground">Categorieën</div>
            </CardContent>
          </Card>
        </div>

        {/* Actions */}
        <Card className="mb-8">
          <CardHeader>
            <CardTitle>Export Opties</CardTitle>
            <CardDescription>
              Selecteer de tabellen die je wilt exporteren
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2 mb-4">
              <Button variant="outline" size="sm" onClick={selectAll}>
                Alles selecteren
              </Button>
              <Button variant="outline" size="sm" onClick={selectNone}>
                Niets selecteren
              </Button>
              <Button variant="outline" size="sm" onClick={selectHighPriority}>
                Alleen belangrijk
              </Button>
              <Button 
                variant="default" 
                size="sm" 
                onClick={selectGabagoolReverseEngineering}
                className="bg-primary hover:bg-primary/90"
              >
                🍝 Gabagool Reverse Engineering
              </Button>
              <Button variant="outline" size="sm" onClick={fetchRowCounts}>
                Tel rijen
              </Button>
            </div>

            {isExporting ? (
              <div className="space-y-4">
                <div className="flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>Exporteren: {currentTable}</span>
                </div>
                <Progress value={progress} />
                <p className="text-sm text-muted-foreground">{progress}% voltooid</p>
              </div>
            ) : (
              <Button onClick={exportDatabase} disabled={selectedTables.size === 0} size="lg">
                <Download className="h-4 w-4 mr-2" />
                Download {selectedTables.size} tabellen als ZIP
              </Button>
            )}
          </CardContent>
        </Card>

        {/* Table Selection */}
        <Card>
          <CardHeader>
            <CardTitle>Beschikbare Tabellen</CardTitle>
            <CardDescription>
              Klik op een categorie om tabellen te zien. Vink aan welke je wilt exporteren.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ScrollArea className="h-[600px] pr-4">
              <div className="space-y-2">
                {categories.map(category => {
                  const tables = tablesByCategory[category];
                  const selectedInCategory = tables.filter(t => selectedTables.has(t.name)).length;
                  const isExpanded = expandedCategories.has(category);
                  const Icon = CATEGORY_ICONS[category] || Database;

                  return (
                    <Collapsible
                      key={category}
                      open={isExpanded}
                      onOpenChange={() => toggleCategory(category)}
                    >
                      <CollapsibleTrigger asChild>
                        <div className="flex items-center justify-between p-3 bg-muted/50 rounded-lg cursor-pointer hover:bg-muted transition-colors">
                          <div className="flex items-center gap-3">
                            {isExpanded ? (
                              <ChevronDown className="h-4 w-4" />
                            ) : (
                              <ChevronRight className="h-4 w-4" />
                            )}
                            <Icon className="h-4 w-4 text-muted-foreground" />
                            <span className="font-medium">{category}</span>
                            <Badge variant="secondary" className="text-xs">
                              {tables.length} tabellen
                            </Badge>
                          </div>
                          <div className="flex items-center gap-2">
                            {selectedInCategory > 0 && (
                              <Badge variant="default" className="text-xs">
                                {selectedInCategory} geselecteerd
                              </Badge>
                            )}
                          </div>
                        </div>
                      </CollapsibleTrigger>
                      <CollapsibleContent>
                        <div className="pl-8 py-2 space-y-1">
                          {tables.map(table => (
                            <div
                              key={table.name}
                              className="flex items-start gap-3 p-3 rounded-md hover:bg-muted/30 transition-colors"
                            >
                              <Checkbox
                                checked={selectedTables.has(table.name)}
                                onCheckedChange={() => toggleTable(table.name)}
                                className="mt-0.5"
                              />
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <code className="text-sm font-mono bg-muted px-1.5 py-0.5 rounded">
                                    {table.name}
                                  </code>
                                  {getPriorityBadge(table.priority)}
                                  {tableCounts[table.name] !== undefined && (
                                    <Badge variant="outline" className="text-xs">
                                      {tableCounts[table.name] === -1 ? "error" : `${tableCounts[table.name]} rows`}
                                    </Badge>
                                  )}
                                  {table.mergesWith && (
                                    <Badge variant="outline" className="text-xs text-destructive">
                                      <AlertTriangle className="h-3 w-3 mr-1" />
                                      Overlap: {table.mergesWith.join(", ")}
                                    </Badge>
                                  )}
                                </div>
                                <p className="text-sm text-muted-foreground mt-1">
                                  {table.description}
                                </p>
                              </div>
                            </div>
                          ))}
                        </div>
                      </CollapsibleContent>
                    </Collapsible>
                  );
                })}
              </div>
            </ScrollArea>
          </CardContent>
        </Card>

        {/* Info Box */}
        <Card className="mt-8 border-primary/20 bg-primary/5">
          <CardContent className="pt-6">
            <div className="flex gap-3">
              <Info className="h-5 w-5 text-primary shrink-0 mt-0.5" />
              <div className="space-y-2 text-sm">
                <p className="font-medium">Tips voor analyse</p>
                <ul className="list-disc list-inside text-muted-foreground space-y-1">
                  <li><strong>v29_signals_response</strong> is de belangrijkste tabel voor trade analyse</li>
                  <li><strong>daily_pnl</strong> geeft dagelijkse PnL overzichten</li>
                  <li>Tabellen met "response" suffix zijn van de nieuwste strategie</li>
                  <li>Oranje "Overlap" badges geven aan dat data ook in andere tabellen zit</li>
                  <li>De ZIP bevat een README.md met data dictionary</li>
                </ul>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

export default DatabaseExport;
