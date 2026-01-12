import { useCallback, useEffect, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { Activity, RefreshCw, AlertTriangle, Target, Flame, ExternalLink, Wifi, WifiOff, Zap } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";
import { usePolymarketRealtime } from "@/hooks/usePolymarketRealtime";
import { usePriceLatencyComparison, Asset } from "@/hooks/usePriceLatencyComparison";

// Asset-specific decimal precision
const ASSET_DECIMALS: Record<string, number> = {
  BTC: 2,
  ETH: 2,
  SOL: 2,
  XRP: 4,
};

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
  isLiveSpot: boolean;
  isLiveOrderbook: boolean;
  spotLastUpdate: number | null;
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

function formatPriceWithDecimals(value: number | null | undefined, asset: string) {
  if (!isValidPrice(value)) return "—";
  const decimals = ASSET_DECIMALS[asset] ?? 0;
  return value.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function formatPrice(value: number | null | undefined, maxFractionDigits = 0) {
  if (!isValidPrice(value)) return "—";
  return value.toLocaleString(undefined, { maximumFractionDigits: maxFractionDigits });
}

export function LiveMarketMonitor() {
  const [markets, setMarkets] = useState<LiveMarketRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Realtime orderbooks (CLOB WS)
  const {
    getOrderbook,
    isConnected: isOrderbookLive,
    connectionState: orderbookState,
    connect: connectOrderbooks,
    lastUpdateTime: orderbookLastUpdateTime,
  } = usePolymarketRealtime(true);

  // Real-time spot prices from Binance WebSocket
  const {
    connectionStatus: priceConnectionStatus,
    connect: connectPrices,
    getAllPrices,
  } = usePriceLatencyComparison();

  // Trigger re-renders on price updates
  const [priceVersion, setPriceVersion] = useState(0);

  // Auto-connect to real-time price feed
  useEffect(() => {
    if (priceConnectionStatus === 'disconnected') {
      connectPrices();
    }
  }, [priceConnectionStatus, connectPrices]);

  // Poll for price updates from the hook (since getAllPrices uses refs)
  useEffect(() => {
    const interval = setInterval(() => {
      setPriceVersion(v => v + 1);
    }, 200); // Update UI every 200ms with latest WebSocket prices
    return () => clearInterval(interval);
  }, []);

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

  // Get current live prices (for use in fetchMarkets)
  // IMPORTANT: Use Chainlink price as "Actual" because that's what Polymarket uses for settlement
  const getLiveSpotPrice = useCallback((asset: string): { price: number | null; isLive: boolean; ts: number | null } => {
    const prices = getAllPrices();
    const assetKey = asset as Asset;
    const data = prices[assetKey];
    
    // Prioritize Chainlink price (this is what Polymarket uses for settlement)
    if (data?.chainlink && data.chainlinkTs) {
      return { price: data.chainlink, isLive: true, ts: data.chainlinkTs };
    }
    // Fallback to Binance if Chainlink not available
    if (data?.binance && data.binanceTs) {
      return { price: data.binance, isLive: true, ts: data.binanceTs };
    }
    return { price: null, isLive: false, ts: null };
  }, [getAllPrices, priceVersion]); // priceVersion triggers re-evaluation

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
          const parts = String(e.market_id).split("-");
          const windowStartTs = parseInt(parts[parts.length - 1], 10) || 0;
          const startTs = windowStartTs;
          const endTs = startTs + 15 * 60;
          const endDate = new Date(endTs * 1000);

          const timeStr = endDate.toLocaleTimeString("en-US", {
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
          });

          const marketSlug = e.market_slug || `${String(e.asset).toLowerCase()}-updown-15m-${startTs}`;
          const polymarketUrl = `https://polymarket.com/event/${marketSlug}`;

          const timeRemaining = Math.max(0, (endTs * 1000 - now) / 1000);

          // Live spot price from WebSocket preferred; fallback to evaluation spot_price.
          const asset = String(e.asset);
          const liveSpot = getLiveSpotPrice(asset);
          const spotPrice = liveSpot.price ?? (isValidPrice(Number(e.spot_price)) ? Number(e.spot_price) : 0);
          const isLiveSpot = liveSpot.isLive;
          const spotLastUpdate = liveSpot.ts;

          const strikeFromEval = Number(e.strike_price);

          // Get live orderbook data from WebSocket
          const liveUpBook = getOrderbook(marketSlug, 'Up');
          const liveDownBook = getOrderbook(marketSlug, 'Down');
          
          const hasLiveOrderbook = !!(liveUpBook?.ask || liveDownBook?.ask);
          
          const upBid = liveUpBook?.bid ?? Number(e.pm_up_bid) ?? 0;
          const upAsk = liveUpBook?.ask ?? Number(e.pm_up_ask) ?? 1;
          const downBid = liveDownBook?.bid ?? Number(e.pm_down_bid) ?? 0;
          const downAsk = liveDownBook?.ask ?? Number(e.pm_down_ask) ?? 1;

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
            isLiveSpot,
            spotLastUpdate,
            strikeFromEval,
            upBid,
            upAsk,
            downBid,
            downAsk,
            hasLiveOrderbook,
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
              isLiveSpot: b.isLiveSpot,
              isLiveOrderbook: b.hasLiveOrderbook,
              spotLastUpdate: b.spotLastUpdate,
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
  }, [getLiveSpotPrice, getOrderbook]);

  const handleRefresh = async () => {
    setRefreshing(true);
    connectOrderbooks();
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
          {/* Spot price connection status */}
          {priceConnectionStatus === 'connected' ? (
            <Badge variant="outline" className="text-xs bg-green-500/10 border-green-500/30">
              <Zap className="h-3 w-3 mr-1 text-green-400" />
              <span className="text-green-400">Spot</span>
            </Badge>
          ) : (
            <Badge variant="outline" className="text-xs">
              <WifiOff className="h-3 w-3 mr-1" />
              Spot
            </Badge>
          )}
          {/* Orderbook connection status */}
          {isOrderbookLive ? (
            <Badge variant="outline" className="text-xs bg-green-500/10 border-green-500/30">
              <Wifi className="h-3 w-3 mr-1 text-green-400" />
              <span className="text-green-400">Book</span>
            </Badge>
          ) : (
            <Badge variant="outline" className="text-xs">
              <WifiOff className="h-3 w-3 mr-1" />
              {orderbookState}
            </Badge>
          )}
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
                // Get real-time spot price at render time
                const liveSpot = getLiveSpotPrice(m.asset);
                const spotPrice = liveSpot.price ?? m.spotPrice;
                const isLiveSpot = liveSpot.isLive;
                
                // Recalculate delta with live price
                const rawDelta = m.priceToBeat && m.priceToBeat > 0 ? (spotPrice - m.priceToBeat) / m.priceToBeat : null;
                const deltaPct = rawDelta === null ? null : rawDelta * 100;
                const deltaForColor = deltaPct ?? 0;

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
                        <span className="text-muted-foreground block text-[10px]">
                          Actual {isLiveSpot && <Zap className="inline h-2.5 w-2.5 text-green-400" />}
                        </span>
                        <span className="font-mono font-medium">${formatPriceWithDecimals(spotPrice, m.asset)}</span>
                      </div>
                      <div>
                        <span className="text-muted-foreground block text-[10px]">To Beat</span>
                        <span className="font-mono font-medium">${formatPriceWithDecimals(m.priceToBeat, m.asset)}</span>
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
                          {deltaPct === null ? "—" : `${deltaPct >= 0 ? "+" : ""}${deltaPct.toFixed(2)}%`}
                        </span>
                      </div>
                    </div>

                    {/* Bid/Ask */}
                    <div className="grid grid-cols-2 gap-2 text-xs">
                      <div className="flex items-center gap-1">
                        <span className="text-muted-foreground">UP: </span>
                        <span className="font-mono text-green-400">{(m.upBid * 100).toFixed(0)}</span>
                        <span className="text-muted-foreground">/</span>
                        <span className="font-mono text-green-400">{(m.upAsk * 100).toFixed(0)}</span>
                        {m.isLiveOrderbook && <Zap className="h-2.5 w-2.5 text-green-400" />}
                      </div>
                      <div className="flex items-center gap-1">
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
                // Get real-time spot price at render time
                const liveSpot = getLiveSpotPrice(m.asset);
                const spotPrice = liveSpot.price ?? m.spotPrice;
                const isLiveSpot = liveSpot.isLive;
                
                // Recalculate delta with live price
                const rawDelta = m.priceToBeat && m.priceToBeat > 0 ? (spotPrice - m.priceToBeat) / m.priceToBeat : null;
                const deltaPct = rawDelta === null ? null : rawDelta * 100;
                const deltaForColor = deltaPct ?? 0;

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
                    <TableCell className="text-right font-mono text-sm">
                      <span className="flex items-center justify-end gap-1">
                        ${formatPriceWithDecimals(spotPrice, m.asset)}
                        {isLiveSpot && <Zap className="h-3 w-3 text-green-400" />}
                      </span>
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm">${formatPriceWithDecimals(m.priceToBeat, m.asset)}</TableCell>
                    <TableCell className="text-right">
                      <span
                        className={cn(
                          "font-mono",
                          deltaForColor > 0 ? "text-green-400" : deltaForColor < 0 ? "text-red-400" : "text-muted-foreground",
                        )}
                      >
                        {deltaPct === null ? "—" : `${deltaPct >= 0 ? "+" : ""}${deltaPct.toFixed(2)}%`}
                      </span>
                    </TableCell>
                    <TableCell className="text-right text-xs font-mono">
                      <span className="flex items-center justify-end gap-1">
                        <span className="text-green-400">{(m.upBid * 100).toFixed(0)}</span>
                        <span className="text-muted-foreground">/</span>
                        <span className="text-green-400">{(m.upAsk * 100).toFixed(0)}</span>
                        {m.isLiveOrderbook && <Zap className="h-3 w-3 text-green-400" />}
                      </span>
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
