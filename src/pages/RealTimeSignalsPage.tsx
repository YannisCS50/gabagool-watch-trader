import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  ArrowLeft,
  Activity,
  TrendingUp,
  TrendingDown,
  Zap,
  Target,
  DollarSign,
  Wifi,
  WifiOff,
  Timer,
  Layers,
  Radio,
  Satellite,
  Search,
} from "lucide-react";
import { usePolymarketRealtime } from "@/hooks/usePolymarketRealtime";
import { useChainlinkRealtime } from "@/hooks/useChainlinkRealtime";
import { LivePrice } from "@/components/LivePrice";

interface LiveMarket {
  slug: string;
  question: string;
  asset: "BTC" | "ETH" | "SOL" | "XRP";
  upPrice: number;
  downPrice: number;
  combinedPrice: number;
  arbitrageEdge: number;
  eventStartTime: Date;
  eventEndTime: Date;
  remainingSeconds: number;
  marketType: string;
}

const RealTimeSignalsPage = () => {
  const [isLive, setIsLive] = useState(true);
  const [nowMs, setNowMs] = useState(() => Date.now());

  // Drive countdown
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 500);
    return () => clearInterval(id);
  }, []);

  // Auto-discovers 15m markets and connects to CLOB
  const {
    markets: discoveredMarkets,
    getPrice,
    isConnected: clobConnected,
    connectionState: clobState,
    updateCount: clobUpdates,
    latencyMs: clobLatency,
  } = usePolymarketRealtime(isLive);

  const {
    btcPrice,
    ethPrice,
    isConnected: chainlinkConnected,
    updateCount: chainlinkUpdates,
  } = useChainlinkRealtime(isLive);

  const liveMarkets = useMemo((): LiveMarket[] => {
    const readUpDown = (slug: string) => {
      const up = getPrice(slug, "up") ?? getPrice(slug, "yes");
      const down = getPrice(slug, "down") ?? getPrice(slug, "no");
      return { up, down };
    };

    return discoveredMarkets
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
          question: market.question,
          asset: market.asset,
          upPrice,
          downPrice,
          combinedPrice,
          arbitrageEdge,
          eventStartTime: market.eventStartTime,
          eventEndTime: market.eventEndTime,
          remainingSeconds,
          marketType: market.marketType,
        };
      })
      // Show markets with remaining time (up to 7 days for daily markets)
      .filter((m) => m.remainingSeconds > 0 && m.remainingSeconds <= 7 * 24 * 3600)
      .sort((a, b) => a.remainingSeconds - b.remainingSeconds);
  }, [discoveredMarkets, nowMs, getPrice]);

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

  const getConnectionBadge = () => {
    switch (clobState) {
      case "discovering":
        return (
          <Badge className="bg-blue-500/20 text-blue-400 border-blue-500/30 flex items-center gap-1">
            <Search className="w-3 h-3 animate-pulse" />
            Discovering...
          </Badge>
        );
      case "connecting":
        return (
          <Badge className="bg-yellow-500/20 text-yellow-400 border-yellow-500/30 flex items-center gap-1">
            <Radio className="w-3 h-3 animate-pulse" />
            Connecting...
          </Badge>
        );
      case "connected":
        return (
          <Badge className="bg-emerald-500/20 text-emerald-400 border-emerald-500/30 flex items-center gap-1">
            <Wifi className="w-3 h-3" />
            LIVE
          </Badge>
        );
      case "error":
        return (
          <Badge className="bg-red-500/20 text-red-400 border-red-500/30 flex items-center gap-1">
            <WifiOff className="w-3 h-3" />
            Error
          </Badge>
        );
      default:
        return (
          <Badge variant="outline" className="flex items-center gap-1">
            <WifiOff className="w-3 h-3" />
            Paused
          </Badge>
        );
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border/50 bg-card/50 backdrop-blur-xl sticky top-0 z-50">
        <div className="container mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <Link to="/" className="flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors">
                <ArrowLeft className="w-4 h-4" />
                <span className="text-sm">Back</span>
              </Link>
              <div className="flex items-center gap-3">
                <div className="p-2 bg-primary/10 rounded-lg relative">
                  <Activity className="w-5 h-5 text-primary" />
                  {isLive && clobConnected && (
                    <span className="absolute -top-1 -right-1 w-3 h-3 bg-emerald-500 rounded-full animate-pulse" />
                  )}
                </div>
                <div>
                  <h1 className="font-bold text-lg flex items-center gap-2">
                    Polymarket CLOB
                    {getConnectionBadge()}
                  </h1>
                  <p className="text-xs text-muted-foreground flex items-center gap-2 flex-wrap">
                    Real-time order book data
                    <Badge variant="outline" className="text-xs text-purple-400 border-purple-500/30">
                      <Radio className="w-2.5 h-2.5 mr-1" />
                      CLOB {clobUpdates} | {clobLatency}ms
                    </Badge>
                    <Badge variant="outline" className="text-xs text-orange-400 border-orange-500/30">
                      <Satellite className="w-2.5 h-2.5 mr-1" />
                      Chainlink {chainlinkUpdates}
                    </Badge>
                  </p>
                </div>
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
        </div>
      </header>

      <main className="container mx-auto px-4 py-6 space-y-6">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Card className={chainlinkConnected ? "border-orange-500/30" : ""}>
            <CardContent className="pt-6">
              <div className="flex items-center gap-2 text-muted-foreground mb-1">
                <DollarSign className="w-4 h-4" />
                <span className="text-sm">Bitcoin</span>
                {chainlinkConnected && (
                  <Badge variant="outline" className="text-xs text-orange-400 border-orange-500/30 px-1">LIVE</Badge>
                )}
              </div>
              <LivePrice price={btcPrice ?? 0} format="dollars" className="text-2xl font-bold text-orange-400" showFlash={chainlinkConnected} />
            </CardContent>
          </Card>

          <Card className={chainlinkConnected ? "border-blue-500/30" : ""}>
            <CardContent className="pt-6">
              <div className="flex items-center gap-2 text-muted-foreground mb-1">
                <DollarSign className="w-4 h-4" />
                <span className="text-sm">Ethereum</span>
                {chainlinkConnected && (
                  <Badge variant="outline" className="text-xs text-blue-400 border-blue-500/30 px-1">LIVE</Badge>
                )}
              </div>
              <LivePrice price={ethPrice ?? 0} format="dollars" className="text-2xl font-bold text-blue-400" showFlash={chainlinkConnected} />
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-2 text-muted-foreground mb-1">
                <Timer className="w-4 h-4" />
                <span className="text-sm">Discovered Markets</span>
              </div>
              <div className="text-2xl font-bold text-emerald-400">{discoveredMarkets.length}</div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-2 text-muted-foreground mb-1">
                <Zap className="w-4 h-4" />
                <span className="text-sm">Arb Opportunities</span>
              </div>
              <div className="text-2xl font-bold text-primary">{liveMarkets.filter((m) => m.arbitrageEdge >= 2).length}</div>
            </CardContent>
          </Card>
        </div>

        {clobState === "discovering" && isLive && (
          <Card className="border-blue-500/50 bg-blue-500/10">
            <CardContent className="py-4">
              <div className="flex items-center gap-2 text-blue-400">
                <Search className="w-5 h-5 animate-pulse" />
                <span>Discovering active 15-minute markets via Gamma API...</span>
              </div>
            </CardContent>
          </Card>
        )}

        {clobState === "connecting" && isLive && (
          <Card className="border-yellow-500/50 bg-yellow-500/10">
            <CardContent className="py-4">
              <div className="flex items-center gap-2 text-yellow-400">
                <Radio className="w-5 h-5 animate-pulse" />
                <span>Connecting to Polymarket CLOB WebSocket...</span>
              </div>
            </CardContent>
          </Card>
        )}

        {clobState === "error" && isLive && (
          <Card className="border-red-500/50 bg-red-500/10">
            <CardContent className="py-4">
              <div className="flex items-center gap-2 text-red-400">
                <WifiOff className="w-5 h-5" />
                <span>Could not find active 15m markets or connect to CLOB. Will retry...</span>
              </div>
            </CardContent>
          </Card>
        )}

        {liveMarkets.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <span className="relative flex h-3 w-3">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-3 w-3 bg-emerald-500"></span>
                </span>
                LIVE NOW ({liveMarkets.length})
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
                    {/* Market Title */}
                    <div className="mb-3">
                      <p className="text-sm font-medium text-foreground">
                        {market.question || `${market.asset} Up/Down`}
                      </p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {market.slug}
                      </p>
                    </div>

                    <div className="flex items-center justify-between mb-4">
                      <div className="flex items-center gap-2">
                        <Badge
                          className={
                            market.asset === "BTC"
                              ? "bg-orange-500/20 text-orange-400 border-orange-500/30"
                              : market.asset === "ETH"
                                ? "bg-blue-500/20 text-blue-400 border-blue-500/30"
                                : market.asset === "SOL"
                                  ? "bg-purple-500/20 text-purple-400 border-purple-500/30"
                                  : "bg-cyan-500/20 text-cyan-400 border-cyan-500/30"
                          }
                        >
                          {market.asset}
                        </Badge>
                        <Badge 
                          variant="outline" 
                          className={market.marketType === '15min' 
                            ? "text-emerald-400 border-emerald-500/30" 
                            : "text-muted-foreground"}
                        >
                          {market.marketType === '15min' ? '15m' : 'Daily'}
                        </Badge>
                        <Badge className="bg-purple-500/20 text-purple-400 border-purple-500/30 text-xs flex items-center gap-1">
                          <Radio className="w-2.5 h-2.5" />
                          CLOB
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
                      <div className="flex items-center gap-2">
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
                        {market.arbitrageEdge >= 2 && (
                          <Badge variant="outline" className="text-emerald-400 border-emerald-500/30">
                            Arbitrage
                          </Badge>
                        )}
                      </div>
                    </div>

                    <div className="grid grid-cols-4 gap-3 text-sm">
                      <div className="text-center p-3 bg-emerald-500/10 rounded-lg">
                        <div className="flex items-center justify-center gap-1 text-emerald-400 mb-1">
                          <TrendingUp className="w-3 h-3" />
                          <span className="text-xs">Up (Ask)</span>
                        </div>
                        <LivePrice price={market.upPrice} format="cents" className="font-bold text-lg text-emerald-400" showFlash={true} />
                      </div>
                      <div className="text-center p-3 bg-red-500/10 rounded-lg">
                        <div className="flex items-center justify-center gap-1 text-red-400 mb-1">
                          <TrendingDown className="w-3 h-3" />
                          <span className="text-xs">Down (Ask)</span>
                        </div>
                        <LivePrice price={market.downPrice} format="cents" className="font-bold text-lg text-red-400" showFlash={true} />
                      </div>
                      <div className="text-center p-3 bg-muted/50 rounded-lg">
                        <div className="flex items-center justify-center gap-1 text-muted-foreground mb-1">
                          <Layers className="w-3 h-3" />
                          <span className="text-xs">Σ Cost</span>
                        </div>
                        <span className={`font-mono font-bold text-lg ${market.combinedPrice < 1 ? "text-emerald-400" : ""}`}>
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

        {discoveredMarkets.length === 0 && clobConnected && (
          <Card>
            <CardContent className="py-8 text-center">
              <Search className="w-8 h-8 text-muted-foreground mx-auto mb-2" />
              <p className="text-muted-foreground">No active 15-minute crypto markets found</p>
              <p className="text-xs text-muted-foreground mt-1">Scanning Gamma API for BTC/ETH 15M markets...</p>
            </CardContent>
          </Card>
        )}

        {liveMarkets.length === 0 && discoveredMarkets.length > 0 && clobConnected && (
          <Card>
            <CardContent className="py-8 text-center">
              <Timer className="w-8 h-8 text-muted-foreground mx-auto mb-2" />
              <p className="text-muted-foreground">Waiting for price updates from CLOB...</p>
              <p className="text-xs text-muted-foreground mt-1">
                Subscribed to {discoveredMarkets.length} markets with {discoveredMarkets.length * 2} tokens
              </p>
            </CardContent>
          </Card>
        )}
      </main>
    </div>
  );
};

export default RealTimeSignalsPage;
