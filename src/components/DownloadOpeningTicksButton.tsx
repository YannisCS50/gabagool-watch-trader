import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Download, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

interface TickData {
  market_id: string;
  asset: string;
  iso: string;
  seconds_remaining: number;
  up_bid: number | null;
  up_ask: number | null;
  down_bid: number | null;
  down_ask: number | null;
}

interface MarketResult {
  slug: string;
  asset: string;
  result: string | null;
  event_start_time: string;
  event_end_time: string;
}

export function DownloadOpeningTicksButton() {
  const [isDownloading, setIsDownloading] = useState(false);

  const downloadOpeningTicks = async () => {
    setIsDownloading(true);
    toast.info("Fetching opening tick data...");

    try {
      // 1. Get all markets with results
      const { data: markets, error: marketsError } = await supabase
        .from("market_history")
        .select("slug, asset, result, event_start_time, event_end_time")
        .not("result", "is", null)
        .order("event_end_time", { ascending: false });

      if (marketsError) throw marketsError;
      if (!markets || markets.length === 0) {
        toast.error("No market results found");
        return;
      }

      toast.info(`Found ${markets.length} markets with results, fetching ticks...`);

      // 2. For each market, get the first 30 seconds of ticks (seconds_remaining >= 870)
      // 15 min = 900 sec, so first 30 sec = 870-900
      const allMarketTicks: {
        market: MarketResult;
        ticks: TickData[];
      }[] = [];

      // Process in batches to avoid rate limits
      const batchSize = 10;
      for (let i = 0; i < markets.length; i += batchSize) {
        const batch = markets.slice(i, i + batchSize);
        
        const batchPromises = batch.map(async (market) => {
          const { data: ticks, error: ticksError } = await supabase
            .from("snapshot_logs")
            .select("market_id, asset, iso, seconds_remaining, up_bid, up_ask, down_bid, down_ask")
            .eq("market_id", market.slug)
            .gte("seconds_remaining", 870)
            .order("seconds_remaining", { ascending: false });

          if (ticksError) {
            console.error(`Error fetching ticks for ${market.slug}:`, ticksError);
            return null;
          }

          return { market, ticks: ticks || [] };
        });

        const batchResults = await Promise.all(batchPromises);
        allMarketTicks.push(...batchResults.filter((r): r is NonNullable<typeof r> => r !== null));
        
        // Progress update
        toast.info(`Processed ${Math.min(i + batchSize, markets.length)}/${markets.length} markets...`);
      }

      // 3. Format as CSV
      const csvLines: string[] = [];
      
      // Header
      csvLines.push([
        "asset",
        "market_id", 
        "event_start",
        "event_end",
        "result",
        "second_offset",
        "timestamp",
        "up_bid",
        "up_ask",
        "up_mid",
        "down_bid",
        "down_ask",
        "down_mid"
      ].join(","));

      // Data rows - grouped by market
      for (const { market, ticks } of allMarketTicks) {
        if (ticks.length === 0) continue;

        // Sort ticks by seconds_remaining descending (900 = start, 870 = 30sec in)
        const sortedTicks = [...ticks].sort((a, b) => b.seconds_remaining - a.seconds_remaining);

        for (const tick of sortedTicks) {
          const secondOffset = 900 - tick.seconds_remaining; // 0 = start, 30 = 30 seconds in
          const upMid = tick.up_bid && tick.up_ask ? ((tick.up_bid + tick.up_ask) / 2).toFixed(2) : "";
          const downMid = tick.down_bid && tick.down_ask ? ((tick.down_bid + tick.down_ask) / 2).toFixed(2) : "";

          csvLines.push([
            market.asset,
            market.slug,
            market.event_start_time,
            market.event_end_time,
            market.result || "UNKNOWN",
            secondOffset.toString(),
            tick.iso,
            tick.up_bid?.toString() || "",
            tick.up_ask?.toString() || "",
            upMid,
            tick.down_bid?.toString() || "",
            tick.down_ask?.toString() || "",
            downMid
          ].join(","));
        }
      }

      // 4. Also create a summary view
      const summaryLines: string[] = [];
      summaryLines.push("asset,market_id,event_start,event_end,result,tick_count,first_up_mid,first_down_mid,last_up_mid,last_down_mid");
      
      for (const { market, ticks } of allMarketTicks) {
        if (ticks.length === 0) continue;
        
        const sortedTicks = [...ticks].sort((a, b) => b.seconds_remaining - a.seconds_remaining);
        const first = sortedTicks[0];
        const last = sortedTicks[sortedTicks.length - 1];
        
        const firstUpMid = first.up_bid && first.up_ask ? ((first.up_bid + first.up_ask) / 2).toFixed(2) : "";
        const firstDownMid = first.down_bid && first.down_ask ? ((first.down_bid + first.down_ask) / 2).toFixed(2) : "";
        const lastUpMid = last.up_bid && last.up_ask ? ((last.up_bid + last.up_ask) / 2).toFixed(2) : "";
        const lastDownMid = last.down_bid && last.down_ask ? ((last.down_bid + last.down_ask) / 2).toFixed(2) : "";

        summaryLines.push([
          market.asset,
          market.slug,
          market.event_start_time,
          market.event_end_time,
          market.result || "UNKNOWN",
          ticks.length.toString(),
          firstUpMid,
          firstDownMid,
          lastUpMid,
          lastDownMid
        ].join(","));
      }

      // 5. Download both files
      const csvContent = csvLines.join("\n");
      const summaryContent = summaryLines.join("\n");
      
      // Download detailed ticks
      const blob1 = new Blob([csvContent], { type: "text/csv" });
      const url1 = URL.createObjectURL(blob1);
      const a1 = document.createElement("a");
      a1.href = url1;
      a1.download = `opening_ticks_first_30s_${new Date().toISOString().split("T")[0]}.csv`;
      a1.click();
      URL.revokeObjectURL(url1);

      // Download summary
      const blob2 = new Blob([summaryContent], { type: "text/csv" });
      const url2 = URL.createObjectURL(blob2);
      const a2 = document.createElement("a");
      a2.href = url2;
      a2.download = `opening_ticks_summary_${new Date().toISOString().split("T")[0]}.csv`;
      a2.click();
      URL.revokeObjectURL(url2);

      const totalTicks = allMarketTicks.reduce((sum, m) => sum + m.ticks.length, 0);
      toast.success(`Downloaded ${totalTicks} ticks from ${allMarketTicks.length} markets`);

    } catch (error) {
      console.error("Error downloading opening ticks:", error);
      toast.error("Failed to download opening ticks");
    } finally {
      setIsDownloading(false);
    }
  };

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={downloadOpeningTicks}
      disabled={isDownloading}
      className="gap-2"
    >
      {isDownloading ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <Download className="h-4 w-4" />
      )}
      Opening Ticks (30s)
    </Button>
  );
}
