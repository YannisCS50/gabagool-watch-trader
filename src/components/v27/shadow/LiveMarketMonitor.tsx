import { useCallback, useEffect, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { Activity, RefreshCw, AlertTriangle, Target, Flame, ExternalLink } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";

interface LiveMarketRow {
  asset: string;
  marketId: string;
  marketSlug: string;
  marketName: string;
  timeRemaining: number;
  strikePrice: number | null;
  spotPrice: number;
  priceToBeat: number | null;
  deltaAbs: number | null;
  deltaPct: number | null;
  stateScore: number;
  expectedUp: number;
  expectedDown: number;
  upBid: number;
  upAsk: number;
  downBid: number;
  downAsk: number;
  spreadTicks: number;
  mispricingDollars: number;
  mispricingPctThreshold: number;
  nearSignal: boolean;
  hotSignal: boolean;
  blocked: boolean;
  blockReason: string | null;
  action: string;
  lastTs: number;
  polymarketUrl: string;
}

type PriceFeedsResponse = {
  success: boolean;
  timestamp: number;
  prices: Record<
    string,
    {
      chainlink?: number;
      chainlink_ts?: number;
      binance?: number;
      binance_ts?: number;
    }
  >;
};

function isValidPrice(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}

function formatPrice(value: number | null | undefined, maxFractionDigits = 0) {
  if (!isValidPrice(value)) return "—";
  return value.toLocaleString(undefined, { maximumFractionDigits: maxFractionDigits });
}

export function LiveMarketMonitor() {
  const [markets, setMarkets] = useState<LiveMarketRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Live spot prices, sourced from the same backend feed used elsewhere (Chainlink RPC).
  const [liveSpotPrices, setLiveSpotPrices] = useState<Record<string, number>>({});
  const liveSpotPricesRef = useRef<Record<string, number>>({});

  useEffect(() => {
    liveSpotPricesRef.current = liveSpotPrices;
  }, [liveSpotPrices]);

  // Keep strike_prices populated (open/close) so "To Beat" stays stable.
  useEffect(() => {
    const tick = async () => {
      try {
        await supabase.functions.invoke("chainlink-price-collector", { body: {} });
      } catch {
        // ignore
      }
    };

    tick();
    const id = setInterval(tick, 60_000);
    return () => clearInterval(id);
  }, []);

  // Poll live crypto prices (BTC/ETH/SOL/XRP) from backend.
  useEffect(() => {
    let cancelled = false;

    const fetchPrices = async () => {
      try {
        const { data, error } = await supabase.functions.invoke<PriceFeedsResponse>("price-feeds", {
          body: { assets: ["BTC", "ETH", "SOL", "XRP"], chainlinkOnly: true },
        });

        if (cancelled) return;
        if (error || !data?.success || !data?.prices) return;

        const next: Record<string, number> = {};
        for (const [asset, v] of Object.entries(data.prices)) {
          if (isValidPrice(v?.chainlink)) next[asset] = v.chainlink;
        }
        setLiveSpotPrices(next);
      } catch {
        // ignore
      }
    };

    fetchPrices();
    const id = setInterval(fetchPrices, 2000);

    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const fetchMarkets = useCallback(async () => {
    try {
      // Fetch recent v27_evaluations to show live market state
      const { data: evals, error } = await supabase
        .from("v27_evaluations")
        .select("*")
        .order("ts", { ascending: false })
        .limit(200);

      if (error) {
        console.error("Failed to fetch evaluations:", error);
        return;
      }

      if (evals && evals.length > 0) {
        // Group by market_id and take latest for each
        const marketMap = new Map<string, any>();
        for (const e of evals) {
          if (!marketMap.has(e.market_id) || marketMap.get(e.market_id).ts < e.ts) {
            marketMap.set(e.market_id, e);
          }
        }

        const now = Date.now();

        const base = Array.from(marketMap.values()).map((e) => {
          // Polymarket 15-min market URL format: {asset}-updown-15m-{start_timestamp}
          const endTs = parseInt(String(e.market_id).split("-").pop() || "0", 10);
          const startTs = endTs - 15 * 60;
          const endDate = new Date(endTs * 1000);
          const timeStr = endDate.toLocaleTimeString("en-US", {
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
          });

          const marketSlug = e.market_slug || `${String(e.asset).toLowerCase()}-updown-15m-${startTs}`;
          const polymarketUrl = `https://polymarket.com/event/${marketSlug}`;

          const parts = String(e.market_id).split("-");
          const endTsFromId = parseInt(parts[parts.length - 1], 10) || 0;
          const timeRemaining = Math.max(0, (endTsFromId * 1000 - now) / 1000);

          // Live spot price preferred; fallback to evaluation spot_price.
          const asset = String(e.asset);
          const spotPrice =
            liveSpotPricesRef.current[asset] ??
            (isValidPrice(Number(e.spot_price)) ? Number(e.spot_price) : 0);

          const strikeFromEval = Number(e.strike_price);

          const upBid = Number(e.pm_up_bid) || 0;
          const upAsk = Number(e.pm_up_ask) || 1;
          const downBid = Number(e.pm_down_bid) || 0;
          const downAsk = Number(e.pm_down_ask) || 1;

          const expectedUp = Number(e.theoretical_up) || 0.5;
          const expectedDown = Number(e.theoretical_down) || 0.5;

          const mispricingDollars = Number(e.mispricing_magnitude) || 0;
          const threshold = Number(e.dynamic_threshold) || Number(e.base_threshold) || 1;
          const mispricingPctThreshold = threshold > 0 ? (mispricingDollars / threshold) * 100 : 0;

          const nearSignal = mispricingPctThreshold >= 60;
          const hotSignal = mispricingPctThreshold >= 85 || e.signal_valid;
          const blocked = e.adverse_blocked || false;

          return {
            e,
            asset,
            marketSlug,
            polymarketUrl,
            timeRemaining,
            timeStr,
            spotPrice,
            strikeFromEval,
            upBid,
            upAsk,
            downBid,
            downAsk,
            expectedUp,
            expectedDown,
            mispricingDollars,
            mispricingPctThreshold,
            nearSignal,
            hotSignal,
            blocked,
          };
        });

        // Fetch stable "To Beat" (strike/open) from strike_prices, so it never tracks the live price.
        const slugs = Array.from(new Set(base.map((b) => b.marketSlug))).filter(Boolean);
        const strikeBySlug: Record<string, number> = {};

        if (slugs.length > 0) {
          const { data: strikes } = await supabase
            .from("strike_prices")
            .select("market_slug, open_price, strike_price")
            .in("market_slug", slugs);

          for (const row of strikes || []) {
            const slug = (row as any).market_slug as string;
            const open = (row as any).open_price as number | null;
            const strike = (row as any).strike_price as number | null;
            const value = isValidPrice(open) ? open : isValidPrice(strike) ? strike : null;
            if (slug && value !== null) strikeBySlug[slug] = value;
          }
        }

        const activeMarkets: LiveMarketRow[] = base
          .map((b) => {
            const strikePrice = isValidPrice(b.strikeFromEval)
              ? b.strikeFromEval
              : strikeBySlug[b.marketSlug] ?? null;

            const priceToBeat = strikePrice;

            const rawDelta = strikePrice && strikePrice > 0 ? (b.spotPrice - strikePrice) / strikePrice : null;
            const deltaAbs = rawDelta === null ? null : Math.abs(rawDelta);
            const deltaPct = rawDelta === null ? null : rawDelta * 100;

            const marketName = `${b.asset} ${strikePrice ? `>${strikePrice.toLocaleString()}` : "Up/Down"} @ ${b.timeStr}`;

            return {
              asset: b.asset,
              marketId: b.e.market_id,
              marketSlug: b.marketSlug,
              marketName,
              timeRemaining: b.timeRemaining,
              strikePrice,
              spotPrice: b.spotPrice,
              priceToBeat,
              deltaAbs,
              deltaPct,
              stateScore: b.mispricingPctThreshold,
              expectedUp: b.expectedUp,
              expectedDown: b.expectedDown,
              upBid: b.upBid,
              upAsk: b.upAsk,
              downBid: b.downBid,
              downAsk: b.downAsk,
              spreadTicks: Math.round(((b.upAsk - b.upBid) + (b.downAsk - b.downBid)) / 2 * 100),
              mispricingDollars: b.mispricingDollars,
              mispricingPctThreshold: b.mispricingPctThreshold,
              nearSignal: b.nearSignal,
              hotSignal: b.hotSignal,
              blocked: b.blocked,
              blockReason: b.e.adverse_reason || b.e.skip_reason || null,
              action: b.e.action || "SCAN",
              lastTs: b.e.ts,
              polymarketUrl: b.polymarketUrl,
            };
          })
          .filter((m) => m.timeRemaining > 60) // Only show markets with at least 1 minute remaining
          .sort((a, b) => b.timeRemaining - a.timeRemaining || a.asset.localeCompare(b.asset));

        setMarkets(activeMarkets);
      }
    } catch (err) {
      console.error("Error fetching markets:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  const handleRefresh = async () => {
    setRefreshing(true);
    await fetchMarkets();
    setRefreshing(false);
  };

  useEffect(() => {
    fetchMarkets();
    const interval = setInterval(fetchMarkets, 3000);
    return () => clearInterval(interval);
  }, [fetchMarkets]);

  const formatTime = (seconds: number) => {
    if (seconds <= 0) return "Exp";
    if (seconds < 60) return `${Math.floor(seconds)}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
    return `${Math.floor(seconds / 3600)}h`;
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-3 px-3 sm:px-6">
        <CardTitle className="text-base sm:text-lg flex items-center gap-2">
          <Activity className="h-4 w-4 sm:h-5 sm:w-5 text-primary" />
          <span className="hidden xs:inline">Live Market Monitor</span>
          <span className="xs:hidden">Markets</span>
          <Badge variant="outline" className="ml-1 text-xs">
            {markets.length}
          </Badge>
        </CardTitle>
        <Button
          variant="ghost"
          size="sm"
          onClick={handleRefresh}
          disabled={refreshing}
          className="h-8 w-8 p-0"
        >
          <RefreshCw className={cn("h-4 w-4", refreshing && "animate-spin")} />
        </Button>
      </CardHeader>
      <CardContent className="p-0">
        {/* Mobile Card View */}
        <div className="block md:hidden">
          <ScrollArea className="h-[350px]">
            <div className="space-y-2 p-3">
              {markets.length === 0 && !loading && (
                <div className="text-center text-muted-foreground py-8 text-sm">No active markets</div>
              )}
              {markets.map((m) => {
                const deltaForColor = m.deltaPct ?? 0;

                return (
                  <div
                    key={m.marketId}
                    className={cn(
                      "p-3 rounded-lg border",
                      m.blocked && "bg-red-500/10 border-red-500/30",
                      m.action === "ENTRY" && "bg-green-500/10 border-green-500/30",
                      m.hotSignal && !m.blocked && m.action !== "ENTRY" && "bg-orange-500/10 border-orange-500/30",
                      !m.blocked && !m.hotSignal && m.action !== "ENTRY" && "bg-muted/20 border-border",
                    )}
                  >
                    {/* Header: Asset, Status, Time + Link */}
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className="font-mono font-bold text-xs">
                          {m.asset}
                        </Badge>
                        {m.action === "ENTRY" ? (
                          <Badge className="bg-green-500/20 text-green-400 border-green-500/30 text-xs">ENTRY</Badge>
                        ) : m.blocked ? (
                          <Badge variant="destructive" className="text-xs">
                            Block
                          </Badge>
                        ) : m.hotSignal ? (
                          <Badge className="bg-orange-500/20 text-orange-400 border-orange-500/30 text-xs">
                            <Flame className="h-3 w-3 mr-0.5" />HOT
                          </Badge>
                        ) : m.nearSignal ? (
                          <Badge className="bg-amber-500/20 text-amber-400 border-amber-500/30 text-xs">Near</Badge>
                        ) : (
                          <Badge variant="outline" className="text-xs">Scan</Badge>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground">{formatTime(m.timeRemaining)}</span>
                        <a
                          href={m.polymarketUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-primary hover:text-primary/80 p-1"
                        >
                          <ExternalLink className="h-3.5 w-3.5" />
                        </a>
                      </div>
                    </div>

                    {/* Market Name */}
                    <div className="text-xs text-muted-foreground mb-2 truncate">{m.marketName}</div>

                    {/* Price Info: Actual, To Beat, Delta */}
                    <div className="grid grid-cols-3 gap-2 text-xs mb-2">
                      <div>
                        <span className="text-muted-foreground block text-[10px]">Actual</span>
                        <span className="font-mono font-medium">${formatPrice(m.spotPrice, 0)}</span>
                      </div>
                      <div>
                        <span className="text-muted-foreground block text-[10px]">To Beat</span>
                        <span className="font-mono font-medium">${formatPrice(m.priceToBeat, 0)}</span>
                      </div>
                      <div>
                        <span className="text-muted-foreground block text-[10px]">Delta</span>
                        <span
                          className={cn(
                            "font-mono font-medium",
                            deltaForColor > 0
                              ? "text-green-400"
                              : deltaForColor < 0
                                ? "text-red-400"
                                : "text-muted-foreground",
                          )}
                        >
                          {m.deltaPct === null ? "—" : `${m.deltaPct >= 0 ? "+" : ""}${m.deltaPct.toFixed(2)}%`}
                        </span>
                      </div>
                    </div>

                    {/* Bid/Ask */}
                    <div className="grid grid-cols-2 gap-2 text-xs">
                      <div>
                        <span className="text-muted-foreground">UP: </span>
                        <span className="font-mono text-green-400">{(m.upBid * 100).toFixed(0)}</span>
                        <span className="text-muted-foreground">/</span>
                        <span className="font-mono text-green-400">{(m.upAsk * 100).toFixed(0)}</span>
                      </div>
                      <div>
                        <span className="text-muted-foreground">DN: </span>
                        <span className="font-mono text-red-400">{(m.downBid * 100).toFixed(0)}</span>
                        <span className="text-muted-foreground">/</span>
                        <span className="font-mono text-red-400">{(m.downAsk * 100).toFixed(0)}</span>
                      </div>
                    </div>

                    {/* Mispricing */}
                    <div className="flex items-center justify-between mt-2 pt-2 border-t border-border/50 text-xs">
                      <span className="text-muted-foreground">Mispricing</span>
                      <div className="flex items-center gap-2">
                        <span className="font-mono">
                          {Math.abs(m.mispricingDollars) < 1
                            ? `${(m.mispricingDollars * 100).toFixed(1)}¢`
                            : `$${m.mispricingDollars.toFixed(2)}`}
                        </span>
                        <span
                          className={cn(
                            "font-mono font-bold",
                            m.mispricingPctThreshold >= 100 && "text-green-400",
                            m.mispricingPctThreshold >= 85 && m.mispricingPctThreshold < 100 && "text-orange-400",
                            m.mispricingPctThreshold < 85 && "text-muted-foreground",
                          )}
                        >
                          {m.mispricingPctThreshold.toFixed(0)}%
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </ScrollArea>
        </div>

        {/* Desktop Table View */}
        <ScrollArea className="h-[400px] hidden md:block">
          <Table>
            <TableHeader className="sticky top-0 bg-background z-10">
              <TableRow>
                <TableHead className="w-[70px]">Asset</TableHead>
                <TableHead>Name</TableHead>
                <TableHead className="w-[50px]">Time</TableHead>
                <TableHead className="text-right">Actual</TableHead>
                <TableHead className="text-right">To Beat</TableHead>
                <TableHead className="text-right">Δ%</TableHead>
                <TableHead className="text-right">UP</TableHead>
                <TableHead className="text-right">DOWN</TableHead>
                <TableHead className="text-right">Misp.</TableHead>
                <TableHead className="w-[70px]">Status</TableHead>
                <TableHead className="w-[40px]"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {markets.length === 0 && !loading && (
                <TableRow>
                  <TableCell colSpan={12} className="text-center text-muted-foreground py-8">
                    No active markets - waiting for evaluations...
                  </TableCell>
                </TableRow>
              )}
              {markets.map((m) => {
                const deltaForColor = m.deltaPct ?? 0;

                return (
                  <TableRow
                    key={m.marketId}
                    className={cn(
                      m.blocked && "bg-red-500/5",
                      m.action === "ENTRY" && "bg-green-500/10",
                      m.hotSignal && !m.blocked && m.action !== "ENTRY" && "bg-orange-500/10",
                      m.nearSignal && !m.hotSignal && !m.blocked && "bg-amber-500/5",
                    )}
                  >
                    <TableCell>
                      <Badge variant="outline" className="font-mono font-bold">
                        {m.asset}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground max-w-[200px] truncate">{m.marketName}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{formatTime(m.timeRemaining)}</TableCell>
                    <TableCell className="text-right font-mono text-sm">${formatPrice(m.spotPrice, 0)}</TableCell>
                    <TableCell className="text-right font-mono text-sm">${formatPrice(m.priceToBeat, 0)}</TableCell>
                    <TableCell className="text-right">
                      <span
                        className={cn(
                          "font-mono",
                          deltaForColor > 0 ? "text-green-400" : deltaForColor < 0 ? "text-red-400" : "text-muted-foreground",
                        )}
                      >
                        {m.deltaPct === null ? "—" : `${m.deltaPct >= 0 ? "+" : ""}${m.deltaPct.toFixed(2)}%`}
                      </span>
                    </TableCell>
                    <TableCell className="text-right text-xs font-mono">
                      <span className="text-green-400">{(m.upBid * 100).toFixed(0)}</span>
                      <span className="text-muted-foreground">/</span>
                      <span className="text-green-400">{(m.upAsk * 100).toFixed(0)}</span>
                    </TableCell>
                    <TableCell className="text-right text-xs font-mono">
                      <span className="text-red-400">{(m.downBid * 100).toFixed(0)}</span>
                      <span className="text-muted-foreground">/</span>
                      <span className="text-red-400">{(m.downAsk * 100).toFixed(0)}</span>
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm">
                      <span
                        className={cn(
                          m.mispricingPctThreshold >= 100 && "text-green-400 font-bold",
                          m.mispricingPctThreshold >= 85 && m.mispricingPctThreshold < 100 && "text-orange-400",
                          m.mispricingPctThreshold < 85 && "text-muted-foreground",
                        )}
                      >
                        {Math.abs(m.mispricingDollars) < 1
                          ? `${(m.mispricingDollars * 100).toFixed(0)}¢`
                          : `$${m.mispricingDollars.toFixed(0)}`}
                      </span>
                    </TableCell>
                    <TableCell>
                      {m.action === "ENTRY" ? (
                        <Badge className="bg-green-500/20 text-green-400 border-green-500/30 text-xs">ENTRY</Badge>
                      ) : m.blocked ? (
                        <Badge variant="destructive" className="text-xs">
                          <AlertTriangle className="h-3 w-3 mr-1" />
                          Block
                        </Badge>
                      ) : m.hotSignal ? (
                        <Badge className="bg-orange-500/20 text-orange-400 border-orange-500/30 text-xs">
                          <Flame className="h-3 w-3 mr-1" />
                          HOT
                        </Badge>
                      ) : m.nearSignal ? (
                        <Badge className="bg-amber-500/20 text-amber-400 border-amber-500/30 text-xs">
                          <Target className="h-3 w-3 mr-1" />
                          Near
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-xs text-muted-foreground">
                          Scan
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <a
                        href={m.polymarketUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary hover:text-primary/80 p-1 inline-flex"
                      >
                        <ExternalLink className="h-4 w-4" />
                      </a>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
