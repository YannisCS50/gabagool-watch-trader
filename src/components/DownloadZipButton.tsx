import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Archive, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { format } from "date-fns";
import JSZip from "jszip";

export function DownloadZipButton() {
  const [isDownloading, setIsDownloading] = useState(false);

  const downloadAllAsZip = async () => {
    setIsDownloading(true);
    toast.info("Preparing ZIP download...");

    try {
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      const cutoff = thirtyDaysAgo.toISOString();

      // Fetch all data in parallel
      const [
        liveTradesRes,
        orderQueueRes,
        botEventsRes,
        ordersRes,
        inventoryRes,
        fillsRes,
        snapshotsRes,
        settlementsRes,
        fundingRes,
        hedgeIntentsRes,
        priceTicksRes,
        runnerHeartbeatsRes,
        botPositionsRes,
        strikesPricesRes,
      ] = await Promise.all([
        supabase.from("live_trades").select("*").gte("created_at", cutoff).order("created_at", { ascending: false }),
        supabase.from("order_queue").select("*").gte("created_at", cutoff).order("created_at", { ascending: false }),
        supabase.from("bot_events").select("*").gte("created_at", cutoff).order("ts", { ascending: false }),
        supabase.from("orders").select("*").gte("created_at", cutoff).order("created_ts", { ascending: false }),
        supabase.from("inventory_snapshots").select("*").gte("created_at", cutoff).order("ts", { ascending: false }),
        supabase.from("fill_logs").select("*").gte("created_at", cutoff).order("ts", { ascending: false }),
        supabase.from("snapshot_logs").select("*").gte("created_at", cutoff).order("ts", { ascending: false }).limit(10000),
        supabase.from("settlement_logs").select("*").gte("created_at", cutoff).order("ts", { ascending: false }),
        supabase.from("funding_snapshots").select("*").gte("created_at", cutoff).order("ts", { ascending: false }),
        supabase.from("hedge_intents").select("*").gte("created_at", cutoff).order("ts", { ascending: false }),
        supabase.from("price_ticks").select("*").gte("created_at", cutoff).order("created_at", { ascending: false }).limit(5000),
        supabase.from("runner_heartbeats").select("*").order("last_heartbeat", { ascending: false }).limit(100),
        supabase.from("bot_positions").select("*").order("synced_at", { ascending: false }),
        supabase.from("strike_prices").select("*").order("created_at", { ascending: false }),
      ]);

      const tables = {
        live_trades: liveTradesRes.data || [],
        order_queue: orderQueueRes.data || [],
        bot_events: botEventsRes.data || [],
        orders: ordersRes.data || [],
        inventory_snapshots: inventoryRes.data || [],
        fill_logs: fillsRes.data || [],
        snapshot_logs: snapshotsRes.data || [],
        settlement_logs: settlementsRes.data || [],
        funding_snapshots: fundingRes.data || [],
        hedge_intents: hedgeIntentsRes.data || [],
        price_ticks: priceTicksRes.data || [],
        runner_heartbeats: runnerHeartbeatsRes.data || [],
        bot_positions: botPositionsRes.data || [],
        strike_prices: strikesPricesRes.data || [],
      };

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
        tables: Object.entries(tables).map(([name, data]) => ({
          name,
          records: data.length,
        })),
        total_records: totalRecords,
      };
      zip.file("_manifest.json", JSON.stringify(manifest, null, 2));

      // Generate and download
      const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
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
      {isDownloading ? "Creating ZIP..." : "Download ZIP"}
    </Button>
  );
}
