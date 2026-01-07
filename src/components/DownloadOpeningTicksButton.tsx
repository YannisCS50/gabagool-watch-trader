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
        .neq("result", "UNKNOWN")
        .order("event_end_time", { ascending: false });

      if (marketsError) throw marketsError;
      if (!markets || markets.length === 0) {
        toast.error("No market results found");
        return;
      }

      toast.info(`Found ${markets.length} markets with results, fetching ticks...`);

      // 2. For each market, get the first 30 seconds of ticks (seconds_remaining >= 870)
      const allMarketTicks: {
        market: MarketResult;
        ticks: TickData[];
      }[] = [];

      // Process in batches
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
        
        toast.info(`Processed ${Math.min(i + batchSize, markets.length)}/${markets.length} markets...`);
      }

      // 3. Format in human-readable style like the user's example
      const lines: string[] = [];
      
      // Group by asset
      const byAsset = new Map<string, typeof allMarketTicks>();
      for (const item of allMarketTicks) {
        const asset = item.market.asset;
        if (!byAsset.has(asset)) byAsset.set(asset, []);
        byAsset.get(asset)!.push(item);
      }

      for (const [asset, marketItems] of byAsset) {
        lines.push(`\n${"=".repeat(60)}`);
        lines.push(`${asset} MARKETS`);
        lines.push(`${"=".repeat(60)}\n`);

        // Sort by event time
        marketItems.sort((a, b) => 
          new Date(a.market.event_start_time).getTime() - new Date(b.market.event_start_time).getTime()
        );

        for (const { market, ticks } of marketItems) {
          if (ticks.length === 0) continue;

          // Format: "ETH: Wo 7 Jan 10:00-10:15"
          const start = new Date(market.event_start_time);
          const end = new Date(market.event_end_time);
          const dayNames = ['Zo', 'Ma', 'Di', 'Wo', 'Do', 'Vr', 'Za'];
          const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dec'];
          
          const dayName = dayNames[start.getDay()];
          const day = start.getDate();
          const month = monthNames[start.getMonth()];
          const startTime = `${start.getHours().toString().padStart(2, '0')}:${start.getMinutes().toString().padStart(2, '0')}`;
          const endTime = `${end.getHours().toString().padStart(2, '0')}:${end.getMinutes().toString().padStart(2, '0')}`;

          lines.push(`\n${asset}: ${dayName} ${day} ${month} ${startTime}-${endTime}`);
          lines.push("-".repeat(40));
          lines.push("Time       | UP    | DOWN  | Sec");
          lines.push("-".repeat(40));

          // Sort ticks by seconds_remaining descending (start of market first)
          const sortedTicks = [...ticks].sort((a, b) => b.seconds_remaining - a.seconds_remaining);

          for (const tick of sortedTicks) {
            const tickTime = new Date(tick.iso);
            const timeStr = `${tickTime.getHours().toString().padStart(2, '0')}:${tickTime.getMinutes().toString().padStart(2, '0')}:${tickTime.getSeconds().toString().padStart(2, '0')}`;
            
            // Calculate mid prices in cents
            const upMid = tick.up_bid && tick.up_ask 
              ? Math.round((tick.up_bid + tick.up_ask) / 2 * 100) 
              : null;
            const downMid = tick.down_bid && tick.down_ask 
              ? Math.round((tick.down_bid + tick.down_ask) / 2 * 100) 
              : null;

            const upStr = upMid !== null ? `${upMid}¢`.padEnd(5) : "  -  ";
            const downStr = downMid !== null ? `${downMid}¢`.padEnd(5) : "  -  ";
            const secOffset = 900 - tick.seconds_remaining;

            lines.push(`${timeStr}  | ${upStr} | ${downStr} | ${secOffset}s`);
          }

          lines.push(`\nRESULT: ${market.result}`);
          lines.push(`Ticks: ${ticks.length}`);
        }
      }

      // 4. Also create CSV for analysis
      const csvLines: string[] = [];
      csvLines.push("asset,market_id,event_start,event_end,result,time,second_offset,up_mid_cents,down_mid_cents");
      
      for (const { market, ticks } of allMarketTicks) {
        const sortedTicks = [...ticks].sort((a, b) => b.seconds_remaining - a.seconds_remaining);
        for (const tick of sortedTicks) {
          const upMid = tick.up_bid && tick.up_ask 
            ? Math.round((tick.up_bid + tick.up_ask) / 2 * 100) 
            : "";
          const downMid = tick.down_bid && tick.down_ask 
            ? Math.round((tick.down_bid + tick.down_ask) / 2 * 100) 
            : "";
          const secOffset = 900 - tick.seconds_remaining;

          csvLines.push([
            market.asset,
            market.slug,
            market.event_start_time,
            market.event_end_time,
            market.result || "",
            tick.iso,
            secOffset.toString(),
            upMid.toString(),
            downMid.toString()
          ].join(","));
        }
      }

      // 5. Download both files
      const textContent = lines.join("\n");
      const csvContent = csvLines.join("\n");
      
      // Download readable text file
      const blob1 = new Blob([textContent], { type: "text/plain" });
      const url1 = URL.createObjectURL(blob1);
      const a1 = document.createElement("a");
      a1.href = url1;
      a1.download = `opening_ticks_readable_${new Date().toISOString().split("T")[0]}.txt`;
      a1.click();
      URL.revokeObjectURL(url1);

      // Download CSV
      const blob2 = new Blob([csvContent], { type: "text/csv" });
      const url2 = URL.createObjectURL(blob2);
      const a2 = document.createElement("a");
      a2.href = url2;
      a2.download = `opening_ticks_${new Date().toISOString().split("T")[0]}.csv`;
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