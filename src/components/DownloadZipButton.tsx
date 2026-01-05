import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Archive, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { format } from "date-fns";
import JSZip from "jszip";

type TableName = "live_trades" | "order_queue" | "bot_events" | "orders" | "fill_logs" | 
  "snapshot_logs" | "settlement_logs" | "funding_snapshots" | "hedge_intents" | 
  "inventory_snapshots" | "price_ticks" | "runner_heartbeats" | "bot_positions" | 
  "strike_prices" | "hedge_feasibility" | "settlement_failures" | "live_trade_results" |
  "trades" | "position_snapshots" | "positions" | "market_history" | "bot_config" | 
  "claim_logs" | "live_bot_settings" | "paper_bot_settings";

// Helper to fetch ALL records with pagination (Supabase default limit is 1000)
async function fetchAllRecords(
  tableName: TableName,
  orderBy: string,
  cutoffDate?: string,
  maxRecords: number = 100000,
  dateColumn: string = "created_at"
): Promise<Record<string, unknown>[]> {
  const allRecords: Record<string, unknown>[] = [];
  const pageSize = 1000;
  let offset = 0;
  
  while (allRecords.length < maxRecords) {
    let query = supabase
      .from(tableName)
      .select("*")
      .order(orderBy, { ascending: false })
      .range(offset, offset + pageSize - 1);
    
    if (cutoffDate) {
      query = query.gte(dateColumn, cutoffDate);
    }
    
    const { data, error } = await query;
    
    if (error) {
      console.error(`Error fetching ${tableName}:`, error);
      break;
    }
    
    if (!data || data.length === 0) break;
    
    allRecords.push(...data);
    
    if (data.length < pageSize) break; // Last page
    offset += pageSize;
  }
  
  return allRecords;
}

// Filter gabagool trades for 15m BTC/ETH markets only
function is15mCryptoMarket(marketSlug: string | null): boolean {
  if (!marketSlug) return false;
  const slug = marketSlug.toLowerCase();
  return (slug.includes('btc') || slug.includes('eth') || slug.includes('bitcoin') || slug.includes('ethereum')) &&
         (slug.includes('15') || slug.includes('fifteen'));
}

// Create unified trade format
interface UnifiedTrade {
  source: 'BOT' | 'GABAGOOL';
  ts: number;
  market_id: string;
  asset: string;
  side: string;
  outcome: string;
  price: number;
  shares: number;
  notional: number;
  market_end_ts?: number;
  avg_fill_price?: number;
}

function createUnifiedTrades(
  botTrades: Record<string, unknown>[],
  gabagoolTrades: Record<string, unknown>[]
): UnifiedTrade[] {
  const unified: UnifiedTrade[] = [];
  
  // Process bot trades (from live_trades and fill_logs)
  for (const trade of botTrades) {
    unified.push({
      source: 'BOT',
      ts: trade.created_at ? new Date(trade.created_at as string).getTime() : 0,
      market_id: (trade.market_slug as string) || '',
      asset: (trade.asset as string) || '',
      side: 'BUY', // live_trades are buys
      outcome: (trade.outcome as string) || '',
      price: Number(trade.price) || 0,
      shares: Number(trade.shares) || 0,
      notional: Number(trade.total) || 0,
      market_end_ts: trade.event_end_time ? new Date(trade.event_end_time as string).getTime() : undefined,
      avg_fill_price: trade.avg_fill_price ? Number(trade.avg_fill_price) : undefined,
    });
  }
  
  // Process gabagool trades
  for (const trade of gabagoolTrades) {
    const marketSlug = trade.market_slug as string || trade.market as string || '';
    if (!is15mCryptoMarket(marketSlug)) continue;
    
    // Determine asset from market slug
    let asset = 'UNKNOWN';
    const slug = marketSlug.toLowerCase();
    if (slug.includes('btc') || slug.includes('bitcoin')) asset = 'BTC';
    else if (slug.includes('eth') || slug.includes('ethereum')) asset = 'ETH';
    
    unified.push({
      source: 'GABAGOOL',
      ts: trade.timestamp ? new Date(trade.timestamp as string).getTime() : 
          (trade.created_at ? new Date(trade.created_at as string).getTime() : 0),
      market_id: marketSlug,
      asset,
      side: (trade.side as string) || 'BUY',
      outcome: (trade.outcome as string) || '',
      price: Number(trade.price) || 0,
      shares: Number(trade.shares) || 0,
      notional: Number(trade.total) || 0,
    });
  }
  
  // Sort by timestamp
  unified.sort((a, b) => b.ts - a.ts);
  
  return unified;
}

// Aggregate trades per market for comparison
interface MarketAggregation {
  source: 'BOT' | 'GABAGOOL';
  market_id: string;
  asset: string;
  total_up_shares: number;
  total_down_shares: number;
  up_cost: number;
  down_cost: number;
  avg_up_cost: number;
  avg_down_cost: number;
  pair_cost: number;
  trade_count: number;
}

function aggregateByMarket(trades: UnifiedTrade[]): MarketAggregation[] {
  const marketMap = new Map<string, MarketAggregation>();
  
  for (const trade of trades) {
    const key = `${trade.source}-${trade.market_id}`;
    
    if (!marketMap.has(key)) {
      marketMap.set(key, {
        source: trade.source,
        market_id: trade.market_id,
        asset: trade.asset,
        total_up_shares: 0,
        total_down_shares: 0,
        up_cost: 0,
        down_cost: 0,
        avg_up_cost: 0,
        avg_down_cost: 0,
        pair_cost: 0,
        trade_count: 0,
      });
    }
    
    const agg = marketMap.get(key)!;
    agg.trade_count++;
    
    const isUp = trade.outcome.toLowerCase().includes('up') || trade.outcome.toLowerCase().includes('yes');
    if (isUp) {
      agg.total_up_shares += trade.shares;
      agg.up_cost += trade.notional;
    } else {
      agg.total_down_shares += trade.shares;
      agg.down_cost += trade.notional;
    }
  }
  
  // Calculate averages and pair cost
  for (const agg of marketMap.values()) {
    agg.avg_up_cost = agg.total_up_shares > 0 ? agg.up_cost / agg.total_up_shares : 0;
    agg.avg_down_cost = agg.total_down_shares > 0 ? agg.down_cost / agg.total_down_shares : 0;
    const paired = Math.min(agg.total_up_shares, agg.total_down_shares);
    agg.pair_cost = paired > 0 ? (agg.avg_up_cost + agg.avg_down_cost) : 0;
  }
  
  return Array.from(marketMap.values());
}

export function DownloadZipButton() {
  const [isDownloading, setIsDownloading] = useState(false);
  const [progress, setProgress] = useState("");

  const downloadAllAsZip = async () => {
    setIsDownloading(true);
    setProgress("Starting...");

    try {
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      const cutoff = thirtyDaysAgo.toISOString();

      const tables: Record<string, Record<string, unknown>[]> = {};

      // Fetch tables one by one with progress updates
      const tableConfigs: { name: TableName; orderBy: string; cutoff: boolean; maxRecords?: number; dateColumn?: string }[] = [
        // Bot trading data
        { name: "live_trades", orderBy: "created_at", cutoff: true },
        { name: "order_queue", orderBy: "created_at", cutoff: true },
        { name: "orders", orderBy: "created_at", cutoff: true },
        { name: "fill_logs", orderBy: "created_at", cutoff: true },
        { name: "live_trade_results", orderBy: "created_at", cutoff: true },
        
        // Settlement & inventory (CRITICAL for analysis)
        { name: "settlement_logs", orderBy: "created_at", cutoff: true },
        { name: "settlement_failures", orderBy: "created_at", cutoff: true },
        { name: "inventory_snapshots", orderBy: "created_at", cutoff: true },
        
        // Funding & hedge data
        { name: "funding_snapshots", orderBy: "created_at", cutoff: true },
        { name: "hedge_intents", orderBy: "created_at", cutoff: true },
        { name: "hedge_feasibility", orderBy: "created_at", cutoff: true },
        
        // Market snapshots
        { name: "snapshot_logs", orderBy: "created_at", cutoff: true, maxRecords: 50000 },
        { name: "bot_events", orderBy: "created_at", cutoff: true },
        
        // Reference data
        { name: "price_ticks", orderBy: "created_at", cutoff: true, maxRecords: 10000 },
        { name: "runner_heartbeats", orderBy: "last_heartbeat", cutoff: false, maxRecords: 500, dateColumn: "last_heartbeat" },
        { name: "bot_positions", orderBy: "synced_at", cutoff: false, dateColumn: "synced_at" },
        { name: "strike_prices", orderBy: "created_at", cutoff: false },
        { name: "market_history", orderBy: "created_at", cutoff: true },
        
        // Gabagool benchmark data
        { name: "trades", orderBy: "created_at", cutoff: true },
        { name: "positions", orderBy: "created_at", cutoff: false },
        { name: "position_snapshots", orderBy: "created_at", cutoff: true },
        
        // Config & settings
        { name: "bot_config", orderBy: "updated_at", cutoff: false, maxRecords: 10, dateColumn: "updated_at" },
        { name: "claim_logs", orderBy: "created_at", cutoff: true },
        { name: "live_bot_settings", orderBy: "updated_at", cutoff: false, maxRecords: 10, dateColumn: "updated_at" },
        { name: "paper_bot_settings", orderBy: "updated_at", cutoff: false, maxRecords: 10, dateColumn: "updated_at" },
      ];

      for (let i = 0; i < tableConfigs.length; i++) {
        const config = tableConfigs[i];
        setProgress(`Fetching ${config.name}... (${i + 1}/${tableConfigs.length})`);
        
        try {
          const data = await fetchAllRecords(
            config.name,
            config.orderBy,
            config.cutoff ? cutoff : undefined,
            config.maxRecords,
            config.dateColumn
          );
          tables[config.name] = data;
        } catch (err) {
          console.error(`Failed to fetch ${config.name}:`, err);
          tables[config.name] = [];
        }
      }

      setProgress("Creating unified exports...");

      // Create unified trades (bot + gabagool)
      const unifiedTrades = createUnifiedTrades(
        tables.live_trades || [],
        tables.trades || []
      );
      
      // Create market aggregations
      const marketAggregations = aggregateByMarket(unifiedTrades);

      setProgress("Creating ZIP...");

      // Create ZIP
      const zip = new JSZip();
      const dateStr = format(new Date(), "yyyy-MM-dd-HHmmss");

      // Create folders for organization
      const botFolder = zip.folder("bot_data");
      const gabagoolFolder = zip.folder("gabagool_benchmark");
      const unifiedFolder = zip.folder("unified_analysis");

      // Add bot data files
      const botTables = [
        "live_trades", "order_queue", "orders", "fill_logs", "live_trade_results",
        "settlement_logs", "settlement_failures", "inventory_snapshots",
        "funding_snapshots", "hedge_intents", "hedge_feasibility",
        "snapshot_logs", "bot_events", "bot_positions"
      ];
      
      for (const tableName of botTables) {
        const data = tables[tableName];
        if (data && data.length > 0) {
          botFolder?.file(`${tableName}.json`, JSON.stringify(data, null, 2));
        }
      }

      // Add gabagool benchmark data (filtered for 15m crypto)
      const gabagoolTrades = (tables.trades || []).filter(t => 
        is15mCryptoMarket(t.market_slug as string || t.market as string)
      );
      gabagoolFolder?.file("trades_15m_crypto.json", JSON.stringify(gabagoolTrades, null, 2));
      gabagoolFolder?.file("positions.json", JSON.stringify(tables.positions || [], null, 2));
      gabagoolFolder?.file("position_snapshots.json", JSON.stringify(tables.position_snapshots || [], null, 2));

      // Add unified analysis files
      unifiedFolder?.file("unified_trades.json", JSON.stringify(unifiedTrades, null, 2));
      unifiedFolder?.file("market_aggregations.json", JSON.stringify(marketAggregations, null, 2));
      
      // Add CSV versions of unified data
      if (unifiedTrades.length > 0) {
        const csvHeaders = Object.keys(unifiedTrades[0]).join(",");
        const csvRows = unifiedTrades.map(t => Object.values(t).join(","));
        unifiedFolder?.file("unified_trades.csv", [csvHeaders, ...csvRows].join("\n"));
      }
      
      if (marketAggregations.length > 0) {
        const csvHeaders = Object.keys(marketAggregations[0]).join(",");
        const csvRows = marketAggregations.map(t => Object.values(t).join(","));
        unifiedFolder?.file("market_aggregations.csv", [csvHeaders, ...csvRows].join("\n"));
      }

      // Add reference data
      const refFolder = zip.folder("reference_data");
      refFolder?.file("strike_prices.json", JSON.stringify(tables.strike_prices || [], null, 2));
      refFolder?.file("market_history.json", JSON.stringify(tables.market_history || [], null, 2));
      refFolder?.file("price_ticks.json", JSON.stringify(tables.price_ticks || [], null, 2));
      refFolder?.file("runner_heartbeats.json", JSON.stringify(tables.runner_heartbeats || [], null, 2));
      refFolder?.file("bot_config.json", JSON.stringify(tables.bot_config || [], null, 2));
      refFolder?.file("claim_logs.json", JSON.stringify(tables.claim_logs || [], null, 2));
      refFolder?.file("live_bot_settings.json", JSON.stringify(tables.live_bot_settings || [], null, 2));
      refFolder?.file("paper_bot_settings.json", JSON.stringify(tables.paper_bot_settings || [], null, 2));

      // Add a comprehensive manifest
      let totalRecords = 0;
      const manifest = {
        exported_at: new Date().toISOString(),
        cutoff_date: cutoff,
        export_version: "2.0-unified",
        description: "Unified Bot + Gabagool Benchmark Export for Strategy v6.x Analysis",
        folders: {
          bot_data: "All bot trading, settlement, inventory and hedge data",
          gabagool_benchmark: "Gabagool22 trades filtered for 15m BTC/ETH markets",
          unified_analysis: "Combined trades with source field for direct comparison",
          reference_data: "Strike prices, market history, and price ticks"
        },
        tables: Object.entries(tables)
          .map(([name, data]) => {
            totalRecords += data.length;
            return { name, records: data.length };
          })
          .sort((a, b) => b.records - a.records),
        unified_stats: {
          total_unified_trades: unifiedTrades.length,
          bot_trades: unifiedTrades.filter(t => t.source === 'BOT').length,
          gabagool_trades: unifiedTrades.filter(t => t.source === 'GABAGOOL').length,
          markets_with_both: marketAggregations.filter(m => 
            marketAggregations.some(m2 => m2.market_id === m.market_id && m2.source !== m.source)
          ).length / 2,
        },
        total_records: totalRecords,
      };
      zip.file("_manifest.json", JSON.stringify(manifest, null, 2));

      // Add analysis guide
      const analysisGuide = `
# Unified Trade Data Export - Analysis Guide

## Purpose
This export enables direct comparison between our bot's performance and gabagool22's trades
on Polymarket 15-minute BTC/ETH markets.

## Key Files for Analysis

### unified_analysis/unified_trades.json
All trades with unified schema:
- source: BOT | GABAGOOL
- ts: timestamp in UTC ms
- market_id, asset, side, outcome, price, shares, notional

### unified_analysis/market_aggregations.json
Per-market summary:
- total_up_shares, total_down_shares
- avg_up_cost, avg_down_cost
- pair_cost (for hedged positions)
- trade_count

### bot_data/settlement_logs.json
Final settlement per market:
- realized_pnl, theoretical_pnl
- final_up_shares, final_down_shares
- pair_cost, fees

### bot_data/inventory_snapshots.json
Time series of inventory state:
- state: FLAT | ONE_SIDED | HEDGED | SKEWED | UNWIND
- unpaired_shares, pair_cost
- skew_allowed_reason

### bot_data/funding_snapshots.json
Capital allocation over time:
- balance_available, reserved_total
- spendable, blocked_reason

### bot_data/hedge_intents.json
Hedge execution tracking:
- intended_qty vs filled_qty
- abort_reason, hedge_intent_status

## Analysis Questions This Export Can Answer

1. **Realized vs Theoretical PnL**: Compare settlement_logs.realized_pnl with theoretical calculations
2. **Pairing Discipline**: Compare pair_cost and unpaired_shares between bot and gabagool
3. **Hedge Timing**: Analyze hedge_intents timing vs inventory_snapshots state changes
4. **Why Gabagool Wins**: Compare avg_up_cost + avg_down_cost patterns in market_aggregations

## Data Filters Applied
- Bot data: All 15m BTC/ETH/SOL/XRP trades
- Gabagool data: Filtered to 15m BTC/ETH markets only
- Time range: Last 30 days
`;
      zip.file("ANALYSIS_GUIDE.md", analysisGuide);

      setProgress("Compressing...");

      // Generate and download
      const blob = await zip.generateAsync({ 
        type: "blob", 
        compression: "DEFLATE",
        compressionOptions: { level: 6 }
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `polymarket-unified-export-${dateStr}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      toast.success(`Downloaded ${totalRecords.toLocaleString()} records + unified analysis`);
    } catch (error) {
      console.error("ZIP download error:", error);
      toast.error("Failed to create ZIP file");
    } finally {
      setIsDownloading(false);
      setProgress("");
    }
  };

  return (
    <Button
      variant="ghost"
      onClick={downloadAllAsZip}
      disabled={isDownloading}
      className="w-full justify-start gap-2 text-xs h-8"
    >
      {isDownloading ? (
        <Loader2 className="h-3 w-3 animate-spin" />
      ) : (
        <Archive className="h-3 w-3" />
      )}
      {isDownloading ? progress || "Creating..." : "Unified ZIP"}
    </Button>
  );
}
