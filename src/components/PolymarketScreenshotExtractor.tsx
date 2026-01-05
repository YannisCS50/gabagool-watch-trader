import { useState, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { supabase } from "@/integrations/supabase/client";
import { Upload, Loader2, Download, Image, AlertCircle } from "lucide-react";
import { toast } from "sonner";

interface Position {
  outcome: string;
  shares: number;
  avg_price_cents: number;
  total_cost_usd: number;
  current_value_usd: number;
  pnl_usd: number;
  pnl_pct: number;
}

interface OpenOrder {
  side: string;
  outcome: string;
  price_cents: number;
  shares: number;
  total_usd: number;
  filled_shares: number;
  expiration: string | null;
}

interface DerivedMetrics {
  net_up_shares: number;
  net_down_shares: number;
  inventory_skew_pct: number;
  implied_pair_cost: number;
  is_fully_paired: boolean;
  is_one_sided: boolean;
}

interface MarketExtraction {
  asset: string;
  start_time: string | null;
  end_time: string | null;
  current_price: number | null;
  time_remaining_seconds: number | null;
  positions: Position[];
  open_orders: OpenOrder[];
  derived_metrics: DerivedMetrics;
}

interface ExtractionResult {
  markets: MarketExtraction[];
  extraction_notes: string;
}

export function PolymarketScreenshotExtractor() {
  const [isLoading, setIsLoading] = useState(false);
  const [result, setResult] = useState<ExtractionResult | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Validate file type
    if (!file.type.startsWith("image/")) {
      toast.error("Please select an image file");
      return;
    }

    // Create preview
    const reader = new FileReader();
    reader.onload = (event) => {
      setPreviewUrl(event.target?.result as string);
    };
    reader.readAsDataURL(file);

    // Convert to base64 and extract
    await extractFromFile(file);
  };

  const extractFromFile = async (file: File) => {
    setIsLoading(true);
    setResult(null);

    try {
      // Convert file to base64
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const result = reader.result as string;
          // Remove data URL prefix
          const base64Data = result.split(",")[1];
          resolve(base64Data);
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });

      const { data, error } = await supabase.functions.invoke(
        "extract-polymarket-screenshot",
        {
          body: { image_base64: base64 },
        }
      );

      if (error) throw error;

      if (data.success) {
        setResult(data.data);
        toast.success("Extraction complete!");
      } else {
        throw new Error(data.error || "Extraction failed");
      }
    } catch (error) {
      console.error("Extraction error:", error);
      toast.error(`Extraction failed: ${error.message}`);
    } finally {
      setIsLoading(false);
    }
  };

  const downloadResult = () => {
    if (!result) return;

    const blob = new Blob([JSON.stringify(result, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `polymarket-extraction-${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Card className="border-border/50">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <Image className="h-5 w-5 text-primary" />
          Screenshot Extractor
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Upload Area */}
        <div
          className="border-2 border-dashed border-border rounded-lg p-6 text-center cursor-pointer hover:border-primary/50 transition-colors"
          onClick={() => fileInputRef.current?.click()}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            onChange={handleFileSelect}
            className="hidden"
          />
          {isLoading ? (
            <div className="flex flex-col items-center gap-2">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
              <p className="text-sm text-muted-foreground">Extracting data...</p>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-2">
              <Upload className="h-8 w-8 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                Click to upload Polymarket screenshot
              </p>
            </div>
          )}
        </div>

        {/* Preview */}
        {previewUrl && (
          <div className="relative">
            <img
              src={previewUrl}
              alt="Screenshot preview"
              className="w-full rounded-lg border border-border"
            />
          </div>
        )}

        {/* Results */}
        {result && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h4 className="font-medium">
                Extracted {result.markets?.length || 0} market(s)
              </h4>
              <Button size="sm" variant="outline" onClick={downloadResult}>
                <Download className="h-4 w-4 mr-1" />
                Download JSON
              </Button>
            </div>

            {result.extraction_notes && (
              <div className="flex items-start gap-2 text-sm text-muted-foreground bg-muted/50 rounded-lg p-3">
                <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                <p>{result.extraction_notes}</p>
              </div>
            )}

            {result.markets?.map((market, idx) => (
              <Card key={idx} className="bg-card/50">
                <CardContent className="pt-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="font-mono font-bold text-primary">
                      {market.asset}
                    </span>
                    {market.time_remaining_seconds !== null && (
                      <span className="text-xs text-muted-foreground">
                        {Math.floor(market.time_remaining_seconds / 60)}m remaining
                      </span>
                    )}
                  </div>

                  {/* Positions */}
                  {market.positions?.length > 0 && (
                    <div>
                      <p className="text-xs text-muted-foreground mb-1">Positions</p>
                      <div className="grid grid-cols-2 gap-2">
                        {market.positions.map((pos, pIdx) => (
                          <div
                            key={pIdx}
                            className={`text-xs p-2 rounded ${
                              pos.outcome === "Up"
                                ? "bg-green-500/10 text-green-400"
                                : "bg-red-500/10 text-red-400"
                            }`}
                          >
                            <div className="font-medium">{pos.outcome}</div>
                            <div>{pos.shares} shares @ {pos.avg_price_cents}¢</div>
                            <div>P&L: ${pos.pnl_usd?.toFixed(2)} ({pos.pnl_pct?.toFixed(1)}%)</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Derived Metrics */}
                  {market.derived_metrics && (
                    <div className="grid grid-cols-3 gap-2 text-xs">
                      <div className="bg-muted/50 rounded p-2">
                        <div className="text-muted-foreground">Pair Cost</div>
                        <div className="font-mono">
                          {market.derived_metrics.implied_pair_cost?.toFixed(2) ?? "—"}¢
                        </div>
                      </div>
                      <div className="bg-muted/50 rounded p-2">
                        <div className="text-muted-foreground">Skew</div>
                        <div className="font-mono">
                          {market.derived_metrics.inventory_skew_pct?.toFixed(1) ?? "—"}%
                        </div>
                      </div>
                      <div className="bg-muted/50 rounded p-2">
                        <div className="text-muted-foreground">State</div>
                        <div className="font-mono">
                          {market.derived_metrics.is_one_sided
                            ? "1-sided"
                            : market.derived_metrics.is_fully_paired
                            ? "Paired"
                            : "Partial"}
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Open Orders */}
                  {market.open_orders?.length > 0 && (
                    <div>
                      <p className="text-xs text-muted-foreground mb-1">
                        Open Orders ({market.open_orders.length})
                      </p>
                      <div className="space-y-1">
                        {market.open_orders.map((order, oIdx) => (
                          <div
                            key={oIdx}
                            className="text-xs bg-muted/30 rounded p-2 flex justify-between"
                          >
                            <span>
                              {order.side} {order.outcome} @ {order.price_cents}¢
                            </span>
                            <span className="text-muted-foreground">
                              {order.shares} shares
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
