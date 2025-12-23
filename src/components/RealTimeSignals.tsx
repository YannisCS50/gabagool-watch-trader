import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Activity,
  DollarSign,
  Layers,
  Radio,
  Satellite,
  Target,
  Timer,
  TrendingDown,
  TrendingUp,
  Wifi,
  WifiOff,
  Zap,
} from "lucide-react";
import { LivePrice } from "@/components/LivePrice";
import { useChainlinkRealtime } from "@/hooks/useChainlinkRealtime";
import { usePolymarketRealtime } from "@/hooks/usePolymarketRealtime";

interface LiveMarket {
  slug: string;
  asset: "BTC" | "ETH";
  upPrice: number;
  downPrice: number;
  combinedPrice: number;
  arbitrageEdge: number;
  eventStartTime: Date;
  eventEndTime: Date;
  remainingSeconds: number;
}

function build15mMarketSlugs(nowMs: number) {
  const nowSec = Math.floor(nowMs / 1000);
  const slot = Math.floor(nowSec / 900) * 900;
  const next = slot + 900;

  const mk = (asset: "BTC" | "ETH", t: number) => {
    const prefix = asset === "BTC" ? "btc" : "eth";
    return {
      asset,
      slug: `${prefix}-updown-15m-${t}`,
      eventStartTime: new Date(t * 1000),
      eventEndTime: new Date((t + 900) * 1000),
    };
  };

  return [mk("BTC", slot), mk("BTC", next), mk("ETH", slot), mk("ETH", next)];
}

export const RealTimeSignals = () => {
  const [isLive, setIsLive] = useState(true);
  const [nowMs, setNowMs] = useState(() => Date.now());

  // Drive countdowns + 15-min market rotation
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 500);
    return () => clearInterval(id);
  }, []);

  const markets = useMemo(() => build15mMarketSlugs(nowMs), [nowMs]);
  const marketSlugs = useMemo(() => markets.map((m) => m.slug), [markets]);

  const {
    getPrice: getTradePrice,
    isConnected: rtdsConnected,
    connectionState: rtdsState,
    updateCount: rtdsUpdates,
    latencyMs: rtdsLatency,
  } = usePolymarketRealtime(marketSlugs, isLive);

  // Polymarket RTDS crypto prices (chainlink feed inside Polymarket)
  const {
    btcPrice,
    ethPrice,
    isConnected: chainlinkConnected,
    updateCount: chainlinkUpdates,
  } = useChainlinkRealtime(isLive);

  const readUpDown = (slug: string) => {
    // Up/Down markets sometimes come through as Up/Down; sometimes Yes/No
    const up = getTradePrice(slug, "up") ?? getTradePrice(slug, "yes");
    const down = getTradePrice(slug, "down") ?? getTradePrice(slug, "no");
    return { up, down };
  };

  const liveMarkets = useMemo((): LiveMarket[] => {
    return markets
      .map((market) => {
        const { up, down } = readUpDown(market.slug);
        const upPrice = up ?? 0.5;
        const downPrice = down ?? 0.5;
        const combinedPrice = upPrice + downPrice;
        const arbitrageEdge = (1 - combinedPrice) * 100;

        const remainingSeconds = Math.max(
          0,
          Math.floor((market.eventEndTime.getTime() - nowMs) / 1000)
        );

        return {
          slug: market.slug,
          asset: market.asset,
          upPrice,
          downPrice,
          combinedPrice,
          arbitrageEdge,
          eventStartTime: market.eventStartTime,
          eventEndTime: market.eventEndTime,
          remainingSeconds,
        };
      })
      .filter((m) => m.remainingSeconds > 0 && m.remainingSeconds <= 900)
      .sort((a, b) => a.remainingSeconds - b.remainingSeconds);
  }, [markets, nowMs, getTradePrice]);

  const formatTime = (seconds: number): string => {
    if (seconds <= 0) return "EXPIRED";
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  const getConfidenceLevel = (arbitrageEdge: number): "high" | "medium" | "low" => {
    if (arbitrageEdge >= 3) return "high";
    if (arbitrageEdge >= 1) return "medium";
    return "low";
  };

  return (
    <section className="space-y-6">
      {/* Header */}
      <Card className="border-primary/20 bg-gradient-to-br from-primary/5 to-transparent">
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-primary/10 rounded-lg relative">
                <Activity className="w-6 h-6 text-primary" />
                {isLive && (
                  <span className="absolute -top-1 -right-1 w-3 h-3 bg-emerald-500 rounded-full animate-pulse" />
                )}
              </div>
              <div>
                <CardTitle className="text-xl flex items-center gap-2">
                  Polymarket RTDS
                  {isLive ? (
                    <Badge className="bg-emerald-500/20 text-emerald-400 border-emerald-500/30 flex items-center gap-1">
                      <Wifi className="w-3 h-3" />
                      LIVE
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="flex items-center gap-1">
                      <WifiOff className="w-3 h-3" />
                      Paused
                    </Badge>
                  )}
                </CardTitle>
                <p className="text-sm text-muted-foreground flex items-center gap-2 flex-wrap">
                  Alleen Polymarket WebSockets
                  <Badge variant="outline" className="text-xs text-purple-400 border-purple-500/30">
                    <Radio className="w-2.5 h-2.5 mr-1" />
                    Trades {rtdsUpdates} | {rtdsLatency}ms
                  </Badge>
                  <Badge variant="outline" className="text-xs text-orange-400 border-orange-500/30">
                    <Satellite className="w-2.5 h-2.5 mr-1" />
                    Crypto {chainlinkUpdates}
                  </Badge>
                </p>
              </div>
            </div>
            <Button
              variant={isLive ? "default" : "outline"}
              size="sm"
              onClick={() => setIsLive(!isLive)}
              className={isLive ? "bg-emerald-600 hover:bg-emerald-700" : ""}
            >
              {isLive ? (
                <>
                  <Wifi className="w-4 h-4 mr-2" />
                  Live
                </>
              ) : (
                <>
                  <WifiOff className="w-4 h-4 mr-2" />
                  Paused
                </>
              )}
            </Button>
          </div>
        </CardHeader>
      </Card>

      {/* Crypto Prices */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card className={chainlinkConnected ? "border-orange-500/30" : ""}>
          <CardContent className="pt-6">
            <div className="flex items-center gap-2 text-muted-foreground mb-1">
              <DollarSign className="w-4 h-4" />
              <span className="text-sm">Bitcoin</span>
              {chainlinkConnected && (
                <Badge variant="outline" className="text-xs text-orange-400 border-orange-500/30 px-1">
                  LIVE
                </Badge>
              )}
            </div>
            <LivePrice
              price={btcPrice ?? 0}
              format="dollars"
              className="text-2xl font-bold text-orange-400"
              showFlash={chainlinkConnected}
            />
          </CardContent>
        </Card>

        <Card className={chainlinkConnected ? "border-blue-500/30" : ""}>
          <CardContent className="pt-6">
            <div className="flex items-center gap-2 text-muted-foreground mb-1">
              <DollarSign className="w-4 h-4" />
              <span className="text-sm">Ethereum</span>
              {chainlinkConnected && (
                <Badge variant="outline" className="text-xs text-blue-400 border-blue-500/30 px-1">
                  LIVE
                </Badge>
              )}
            </div>
            <LivePrice
              price={ethPrice ?? 0}
              format="dollars"
              className="text-2xl font-bold text-blue-400"
              showFlash={chainlinkConnected}
            />
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-2 text-muted-foreground mb-1">
              <Timer className="w-4 h-4" />
              <span className="text-sm">Live Markets</span>
            </div>
            <div className="text-2xl font-bold text-emerald-400">{liveMarkets.length}</div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-2 text-muted-foreground mb-1">
              <Zap className="w-4 h-4" />
              <span className="text-sm">Arb Opportunities</span>
            </div>
            <div className="text-2xl font-bold text-primary">
              {liveMarkets.filter((m) => m.arbitrageEdge >= 2).length}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Connection Status */}
      {!rtdsConnected && isLive && (
        <Card className="border-yellow-500/50 bg-yellow-500/10">
          <CardContent className="py-4">
            <div className="flex items-center gap-2 text-yellow-400">
              <Radio className="w-5 h-5 animate-pulse" />
              <span>Connecting to Polymarket RTDS… ({rtdsState})</span>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Live Markets */}
      {liveMarkets.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <span className="relative flex h-3 w-3">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-3 w-3 bg-emerald-500"></span>
              </span>
              LIVE NOW
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {liveMarkets.map((market) => {
              const confidence = getConfidenceLevel(market.arbitrageEdge);
              const isExpiringSoon = market.remainingSeconds < 120;

              return (
                <div
                  key={market.slug}
                  className={`p-4 rounded-lg border transition-all ${
                    confidence === "high"
                      ? "border-emerald-500/50 bg-emerald-500/10 shadow-lg shadow-emerald-500/10"
                      : confidence === "medium"
                        ? "border-yellow-500/30 bg-yellow-500/5"
                        : "border-border bg-muted/5"
                  }`}
                >
                  <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-2">
                      <Badge
                        className={
                          market.asset === "BTC"
                            ? "bg-orange-500/20 text-orange-400 border-orange-500/30"
                            : "bg-blue-500/20 text-blue-400 border-blue-500/30"
                        }
                      >
                        {market.asset}
                      </Badge>
                      <Badge className="bg-cyan-500/20 text-cyan-400 border-cyan-500/30 text-xs flex items-center gap-1">
                        <Radio className="w-2.5 h-2.5" />
                        RTDS
                      </Badge>
                      <div
                        className={`flex items-center gap-1 px-2 py-1 rounded-md text-sm font-mono ${
                          isExpiringSoon ? "bg-red-500/20 text-red-400 animate-pulse" : "bg-muted"
                        }`}
                      >
                        <Timer className="w-3 h-3" />
                        {formatTime(market.remainingSeconds)}
                      </div>
                    </div>
                    <Badge
                      className={
                        confidence === "high"
                          ? "bg-emerald-500/20 text-emerald-400 border-emerald-500/30"
                          : confidence === "medium"
                            ? "bg-yellow-500/20 text-yellow-400 border-yellow-500/30"
                            : "bg-muted text-muted-foreground"
                      }
                    >
                      {confidence.toUpperCase()}
                    </Badge>
                  </div>

                  <div className="grid grid-cols-4 gap-3 text-sm">
                    <div className="text-center p-3 bg-emerald-500/10 rounded-lg">
                      <div className="flex items-center justify-center gap-1 text-emerald-400 mb-1">
                        <TrendingUp className="w-3 h-3" />
                        <span className="text-xs">Up</span>
                      </div>
                      <LivePrice
                        price={market.upPrice}
                        format="cents"
                        className="font-bold text-lg text-emerald-400"
                        showFlash={true}
                      />
                    </div>
                    <div className="text-center p-3 bg-red-500/10 rounded-lg">
                      <div className="flex items-center justify-center gap-1 text-red-400 mb-1">
                        <TrendingDown className="w-3 h-3" />
                        <span className="text-xs">Down</span>
                      </div>
                      <LivePrice
                        price={market.downPrice}
                        format="cents"
                        className="font-bold text-lg text-red-400"
                        showFlash={true}
                      />
                    </div>
                    <div className="text-center p-3 bg-muted/50 rounded-lg">
                      <div className="flex items-center justify-center gap-1 text-muted-foreground mb-1">
                        <Layers className="w-3 h-3" />
                        <span className="text-xs">Σ</span>
                      </div>
                      <span
                        className={`font-mono font-bold text-lg ${
                          market.combinedPrice < 1 ? "text-emerald-400" : ""
                        }`}
                      >
                        {(market.combinedPrice * 100).toFixed(1)}¢
                      </span>
                    </div>
                    <div className="text-center p-3 bg-primary/10 rounded-lg">
                      <div className="flex items-center justify-center gap-1 text-primary mb-1">
                        <Target className="w-3 h-3" />
                        <span className="text-xs">Edge</span>
                      </div>
                      <span className={`font-mono font-bold text-lg ${market.arbitrageEdge > 0 ? "text-primary" : ""}`}>
                        {market.arbitrageEdge.toFixed(1)}%
                      </span>
                    </div>
                  </div>

                  {market.arbitrageEdge >= 2 && (
                    <div className="mt-4 p-3 rounded-lg bg-emerald-500/20 border border-emerald-500/30">
                      <div className="flex items-center gap-2">
                        <Zap className="w-4 h-4 text-emerald-400" />
                        <span className="font-medium text-sm text-emerald-400">
                          ARBITRAGE: Buy both @ {(market.combinedPrice * 100).toFixed(1)}¢ = {market.arbitrageEdge.toFixed(1)}% edge
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      {liveMarkets.length === 0 && rtdsConnected && (
        <Card>
          <CardContent className="py-8 text-center">
            <Timer className="w-8 h-8 text-muted-foreground mx-auto mb-2" />
            <p className="text-muted-foreground">Nog geen trades ontvangen voor deze 15-min markets</p>
            <p className="text-xs text-muted-foreground mt-1">We luisteren live naar Polymarket trades (market_slug)</p>
          </CardContent>
        </Card>
      )}
    </section>
  );
};
