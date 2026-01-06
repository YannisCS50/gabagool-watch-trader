import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Download, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { format } from "date-fns";

export function DownloadGabagoolButton() {
  const [isDownloading, setIsDownloading] = useState(false);

  const downloadGabagoolData = async () => {
    setIsDownloading(true);
    try {
      toast.info("Fetching Gabagool trades...");

      // Fetch all gabagool trades
      const { data: trades, error: tradesError } = await supabase
        .from("trades")
        .select("*")
        .eq("trader_username", "gabagool22")
        .order("timestamp", { ascending: false });

      if (tradesError) throw tradesError;

      // Fetch position snapshots
      const { data: snapshots, error: snapshotsError } = await supabase
        .from("position_snapshots")
        .select("*")
        .eq("trader_username", "gabagool22")
        .order("snapshot_at", { ascending: false });

      if (snapshotsError) throw snapshotsError;

      // Fetch current positions
      const { data: positions, error: positionsError } = await supabase
        .from("positions")
        .select("*")
        .eq("trader_username", "gabagool22")
        .order("updated_at", { ascending: false });

      if (positionsError) throw positionsError;

      const exportData = {
        exported_at: new Date().toISOString(),
        trader: "gabagool22",
        summary: {
          total_trades: trades?.length || 0,
          total_snapshots: snapshots?.length || 0,
          current_positions: positions?.length || 0,
        },
        trades: trades || [],
        position_snapshots: snapshots || [],
        positions: positions || [],
      };

      const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `gabagool-data-${format(new Date(), "yyyy-MM-dd-HHmmss")}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      toast.success(`Downloaded ${trades?.length || 0} trades, ${snapshots?.length || 0} snapshots`);
    } catch (error) {
      console.error("Download error:", error);
      toast.error("Failed to download Gabagool data");
    } finally {
      setIsDownloading(false);
    }
  };

  return (
    <Button variant="outline" onClick={downloadGabagoolData} disabled={isDownloading}>
      {isDownloading ? (
        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
      ) : (
        <Download className="h-4 w-4 mr-2" />
      )}
      Gabagool
    </Button>
  );
}
