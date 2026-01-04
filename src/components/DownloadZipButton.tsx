import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Archive, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { format } from "date-fns";
import JSZip from "jszip";

// Helper to fetch ALL records with pagination (Supabase default limit is 1000)
async function fetchAllRecords(
  tableName: "live_trades" | "order_queue" | "bot_events" | "orders" | "fill_logs" | 
    "snapshot_logs" | "settlement_logs" | "funding_snapshots" | "hedge_intents" | 
    "inventory_snapshots" | "price_ticks" | "runner_heartbeats" | "bot_positions" | 
    "strike_prices" | "hedge_feasibility" | "settlement_failures" | "live_trade_results",
  orderBy: string,
  cutoffDate?: string,
  maxRecords: number = 100000
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
      query = query.gte("created_at", cutoffDate);
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

export function DownloadZipButton() {
  const [isDownloading, setIsDownloading] = useState(false);
  const [progress, setProgress] = useState("");

  type TableName = "live_trades" | "order_queue" | "bot_events" | "orders" | "fill_logs" | 
    "snapshot_logs" | "settlement_logs" | "funding_snapshots" | "hedge_intents" | 
    "inventory_snapshots" | "price_ticks" | "runner_heartbeats" | "bot_positions" | 
    "strike_prices" | "hedge_feasibility" | "settlement_failures" | "live_trade_results";

  const downloadAllAsZip = async () => {
    setIsDownloading(true);
    setProgress("Starting...");

    try {
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      const cutoff = thirtyDaysAgo.toISOString();

      const tables: Record<string, Record<string, unknown>[]> = {};

      // Fetch tables one by one with progress updates
      const tableConfigs: { name: TableName; orderBy: string; cutoff: boolean; maxRecords?: number }[] = [
        { name: "live_trades", orderBy: "created_at", cutoff: true },
        { name: "order_queue", orderBy: "created_at", cutoff: true },
        { name: "bot_events", orderBy: "created_at", cutoff: true },
        { name: "orders", orderBy: "created_at", cutoff: true },
        { name: "fill_logs", orderBy: "created_at", cutoff: true },
        { name: "snapshot_logs", orderBy: "created_at", cutoff: true, maxRecords: 50000 },
        { name: "settlement_logs", orderBy: "created_at", cutoff: true },
        { name: "funding_snapshots", orderBy: "created_at", cutoff: true },
        { name: "hedge_intents", orderBy: "created_at", cutoff: true },
        { name: "inventory_snapshots", orderBy: "created_at", cutoff: true },
        { name: "price_ticks", orderBy: "created_at", cutoff: true, maxRecords: 10000 },
        { name: "runner_heartbeats", orderBy: "last_heartbeat", cutoff: false, maxRecords: 500 },
        { name: "bot_positions", orderBy: "synced_at", cutoff: false },
        { name: "strike_prices", orderBy: "created_at", cutoff: false },
        { name: "hedge_feasibility", orderBy: "created_at", cutoff: true },
        { name: "settlement_failures", orderBy: "created_at", cutoff: true },
        { name: "live_trade_results", orderBy: "created_at", cutoff: true },
      ];

      for (let i = 0; i < tableConfigs.length; i++) {
        const config = tableConfigs[i];
        setProgress(`Fetching ${config.name}... (${i + 1}/${tableConfigs.length})`);
        
        try {
          const data = await fetchAllRecords(
            config.name,
            config.orderBy,
            config.cutoff ? cutoff : undefined,
            config.maxRecords
          );
          tables[config.name] = data;
        } catch (err) {
          console.error(`Failed to fetch ${config.name}:`, err);
          tables[config.name] = [];
        }
      }

      setProgress("Creating ZIP...");

      // Create ZIP
      const zip = new JSZip();
      const dateStr = format(new Date(), "yyyy-MM-dd-HHmmss");

      // Add each table as a separate JSON file
      let totalRecords = 0;
      for (const [tableName, data] of Object.entries(tables)) {
        if (data.length > 0) {
          zip.file(`${tableName}.json`, JSON.stringify(data, null, 2));
          totalRecords += data.length;
        }
      }

      // Add a manifest file
      const manifest = {
        exported_at: new Date().toISOString(),
        cutoff_date: cutoff,
        tables: Object.entries(tables)
          .map(([name, data]) => ({
            name,
            records: data.length,
          }))
          .sort((a, b) => b.records - a.records),
        total_records: totalRecords,
      };
      zip.file("_manifest.json", JSON.stringify(manifest, null, 2));

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
      a.download = `polymarket-bot-data-${dateStr}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      toast.success(`Downloaded ${totalRecords.toLocaleString()} records in ZIP`);
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
      variant="default"
      onClick={downloadAllAsZip}
      disabled={isDownloading}
      className="gap-2"
    >
      {isDownloading ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <Archive className="h-4 w-4" />
      )}
      {isDownloading ? progress || "Creating ZIP..." : "Download ZIP"}
    </Button>
  );
}
