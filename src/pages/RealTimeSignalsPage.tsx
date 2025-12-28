import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
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
  ChevronDown,
  History,
  Bot,
  Cpu,
  ArrowUpRight,
  ArrowDownRight,
  ExternalLink,
  Clock,
} from "lucide-react";
import { usePolymarketRealtime } from "@/hooks/usePolymarketRealtime";
import { useChainlinkRealtime } from "@/hooks/useChainlinkRealtime";
import { usePaperBotSettings } from "@/hooks/usePaperBotSettings";
import { useRealtimePaperBot } from "@/hooks/useRealtimePaperBot";
import { LivePrice } from "@/components/LivePrice";
import { GabagoolTradesSummary } from "@/components/GabagoolTradesSummary";
import { PaperBotTradesSummary } from "@/components/PaperBotTradesSummary";
import { LiveBotTradesSummary } from "@/components/LiveBotTradesSummary";
import { PaperBotOverview } from "@/components/PaperBotOverview";
import { LiveBotOverview } from "@/components/LiveBotOverview";
import { Switch } from "@/components/ui/switch";

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
  openPrice: number | null;
  strikePrice: number | null;
  previousClosePrice: number | null; // Previous bet's close = this bet's "price to beat"
}

const RealTimeSignalsPage = () => {
  const [isLive, setIsLive] = useState(true);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [expiredMarketsOpen, setExpiredMarketsOpen] = useState(false);
  const [upcomingMarketsOpen, setUpcomingMarketsOpen] = useState(false);

  const { isEnabled: botEnabled, toggleEnabled: toggleBot, isLoading: botLoading } = usePaperBotSettings();
  const realtimeBotStatus = useRealtimePaperBot();

  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 500);
    return () => clearInterval(id);
  }, []);

  const {
    markets: discoveredMarkets,
    expiredMarkets: dbExpiredMarkets,
    getPrice,
    getOrderbook,
    isConnected: clobConnected,
    connectionState: clobState,
    updateCount: clobUpdates,
    latencyMs: clobLatency,
    timeSinceLastUpdate,
  } = usePolymarketRealtime(isLive);

  const {
    btcPrice,
    ethPrice,
    isConnected: chainlinkConnected,
    updateCount: chainlinkUpdates,
  } = useChainlinkRealtime(isLive);

  const { btcMarkets, ethMarkets, upcomingMarkets, recentExpiredMarkets } = useMemo(() => {
    const readUpDown = (slug: string) => {
      const up = getPrice(slug, "up") ?? getPrice(slug, "yes");
      const down = getPrice(slug, "down") ?? getPrice(slug, "no");
      return { up, down };
    };

    const allMarkets = discoveredMarkets.map((market) => {
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
        openPrice: market.openPrice ?? market.strikePrice ?? null,
        strikePrice: market.openPrice ?? market.strikePrice ?? null,
        previousClosePrice: market.previousClosePrice ?? null,
      };
    });

    // Active = within 15 minutes
    const active = allMarkets
      .filter((m) => m.remainingSeconds > 0 && m.remainingSeconds <= 15 * 60)
      .sort((a, b) => a.remainingSeconds - b.remainingSeconds);
    
    // Upcoming = more than 15 minutes, less than 7 days
    const upcoming = allMarkets
      .filter((m) => m.remainingSeconds > 15 * 60 && m.remainingSeconds <= 7 * 24 * 3600)
      .sort((a, b) => a.remainingSeconds - b.remainingSeconds);

    return {
      btcMarkets: active.filter((m) => m.asset === "BTC"),
      ethMarkets: active.filter((m) => m.asset === "ETH"),
      upcomingMarkets: upcoming,
      recentExpiredMarkets: dbExpiredMarkets.slice(0, 20),
    };
  }, [discoveredMarkets, nowMs, getPrice, dbExpiredMarkets]);

  const liveMarkets = [...btcMarkets, ...ethMarkets];

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
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border/50 bg-card/80 backdrop-blur-xl sticky top-0 z-50">
        <div className="container mx-auto px-4 py-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <Link to="/" className="text-muted-foreground hover:text-foreground transition-colors">
                <ArrowLeft className="w-5 h-5" />
              </Link>
              <div className="flex items-center gap-3">
                <div className="relative">
                  <Activity className="w-5 h-5 text-primary" />
                  {isLive && clobConnected && (
                    <span className="absolute -top-0.5 -right-0.5 w-2 h-2 bg-emerald-500 rounded-full" />
                  )}
                </div>
                <div>
                  <h1 className="font-semibold text-base">Real-Time Signals</h1>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span className={clobConnected ? "text-emerald-500" : "text-muted-foreground"}>
                      {clobConnected ? "Connected" : clobState}
                    </span>
                    <span>•</span>
                    <span>{clobUpdates} updates</span>
                    <span>•</span>
                    <span>{clobLatency}ms</span>
                  </div>
                </div>
              </div>
            </div>
            <Button
              variant={isLive ? "default" : "outline"}
              size="sm"
              onClick={() => setIsLive(!isLive)}
            >
              {isLive ? <Wifi className="w-4 h-4 mr-1.5" /> : <WifiOff className="w-4 h-4 mr-1.5" />}
              {isLive ? "Live" : "Paused"}
            </Button>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-6 space-y-6">
        {/* Price Overview */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {/* BTC */}
          <Card className="bg-gradient-to-br from-orange-500/5 to-transparent border-orange-500/20">
            <CardContent className="p-4">
              <div className="flex items-center gap-2 mb-2">
                <div className="w-8 h-8 rounded-lg bg-orange-500/10 flex items-center justify-center text-orange-500 font-bold">₿</div>
                <div>
                  <div className="text-xs text-muted-foreground">Bitcoin</div>
                  {chainlinkConnected && <Badge variant="secondary" className="text-[10px] px-1 py-0">LIVE</Badge>}
                </div>
              </div>
              {btcPrice !== null ? (
                <LivePrice price={btcPrice} format="dollars" className="text-2xl font-bold text-orange-500" showFlash={chainlinkConnected} />
              ) : (
                <div className="text-2xl font-bold text-muted-foreground animate-pulse">Loading...</div>
              )}
              {btcMarkets.length > 0 && btcMarkets[0].openPrice && btcPrice && (
                <div className="mt-2 text-xs">
                  <div className="text-muted-foreground">Strike: ${btcMarkets[0].openPrice.toLocaleString()}</div>
                  {(() => {
                    const diff = btcPrice - btcMarkets[0].openPrice;
                    const pct = (diff / btcMarkets[0].openPrice) * 100;
                    return (
                      <div className={`flex items-center gap-1 ${diff >= 0 ? "text-emerald-500" : "text-red-500"}`}>
                        {diff >= 0 ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownRight className="w-3 h-3" />}
                        {diff >= 0 ? "+" : ""}{pct.toFixed(2)}%
                      </div>
                    );
                  })()}
                </div>
              )}
            </CardContent>
          </Card>

          {/* ETH */}
          <Card className="bg-gradient-to-br from-blue-500/5 to-transparent border-blue-500/20">
            <CardContent className="p-4">
              <div className="flex items-center gap-2 mb-2">
                <div className="w-8 h-8 rounded-lg bg-blue-500/10 flex items-center justify-center text-blue-500 font-bold">Ξ</div>
                <div>
                  <div className="text-xs text-muted-foreground">Ethereum</div>
                  {chainlinkConnected && <Badge variant="secondary" className="text-[10px] px-1 py-0">LIVE</Badge>}
                </div>
              </div>
              {ethPrice !== null ? (
                <LivePrice price={ethPrice} format="dollars" className="text-2xl font-bold text-blue-500" showFlash={chainlinkConnected} />
              ) : (
                <div className="text-2xl font-bold text-muted-foreground animate-pulse">Loading...</div>
              )}
              {ethMarkets.length > 0 && ethMarkets[0].openPrice && ethPrice && (
                <div className="mt-2 text-xs">
                  <div className="text-muted-foreground">Strike: ${ethMarkets[0].openPrice.toLocaleString()}</div>
                  {(() => {
                    const diff = ethPrice - ethMarkets[0].openPrice;
                    const pct = (diff / ethMarkets[0].openPrice) * 100;
                    return (
                      <div className={`flex items-center gap-1 ${diff >= 0 ? "text-emerald-500" : "text-red-500"}`}>
                        {diff >= 0 ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownRight className="w-3 h-3" />}
                        {diff >= 0 ? "+" : ""}{pct.toFixed(2)}%
                      </div>
                    );
                  })()}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Markets */}
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-2 mb-2">
                <div className="p-2 rounded-lg bg-muted">
                  <Timer className="w-4 h-4 text-muted-foreground" />
                </div>
                <span className="text-xs text-muted-foreground">Active Markets</span>
              </div>
              <div className="text-2xl font-bold">{discoveredMarkets.length}</div>
              <div className="text-xs text-muted-foreground mt-1">
                {btcMarkets.length} BTC • {ethMarkets.length} ETH
              </div>
            </CardContent>
          </Card>

          {/* Arbitrage */}
          <Card className={liveMarkets.filter(m => m.arbitrageEdge >= 2).length > 0 ? "border-primary/30" : ""}>
            <CardContent className="p-4">
              <div className="flex items-center gap-2 mb-2">
                <div className={`p-2 rounded-lg ${liveMarkets.filter(m => m.arbitrageEdge >= 2).length > 0 ? "bg-primary/10" : "bg-muted"}`}>
                  <Zap className={`w-4 h-4 ${liveMarkets.filter(m => m.arbitrageEdge >= 2).length > 0 ? "text-primary" : "text-muted-foreground"}`} />
                </div>
                <span className="text-xs text-muted-foreground">Arb Opportunities</span>
              </div>
              <div className={`text-2xl font-bold ${liveMarkets.filter(m => m.arbitrageEdge >= 2).length > 0 ? "text-primary" : ""}`}>
                {liveMarkets.filter((m) => m.arbitrageEdge >= 2).length}
              </div>
              <div className="text-xs text-muted-foreground mt-1">
                {liveMarkets.filter(m => m.arbitrageEdge >= 3).length} high confidence
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Paper Bot Section */}
        <PaperBotOverview 
          botEnabled={botEnabled}
          toggleBot={toggleBot}
          botLoading={botLoading}
          realtimeBotStatus={realtimeBotStatus}
          getPrice={getPrice}
        />

        {/* Live Bot Section */}
        <LiveBotOverview getPrice={getPrice} />

        {/* Status Messages */}
        {clobState === "discovering" && isLive && (
          <div className="flex items-center gap-2 p-3 rounded-lg bg-blue-500/10 border border-blue-500/20 text-blue-500 text-sm">
            <Search className="w-4 h-4 animate-pulse" />
            Discovering active markets...
          </div>
        )}

        {clobState === "connecting" && isLive && (
          <div className="flex items-center gap-2 p-3 rounded-lg bg-yellow-500/10 border border-yellow-500/20 text-yellow-500 text-sm">
            <Radio className="w-4 h-4 animate-pulse" />
            Connecting to order book...
          </div>
        )}

        {clobState === "error" && isLive && (
          <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-500 text-sm">
            <WifiOff className="w-4 h-4" />
            Connection error. Retrying...
          </div>
        )}

        {/* Active Markets Table */}
        {liveMarkets.length > 0 && (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <Activity className="w-4 h-4 text-primary" />
                Active Markets
                <Badge variant="secondary">{liveMarkets.length}</Badge>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="text-xs text-muted-foreground border-b border-border/50">
                      <th className="text-left pb-3 font-medium">Asset</th>
                      <th className="text-left pb-3 font-medium">Time</th>
                      <th className="text-center pb-3 font-medium">Strike</th>
                      <th className="text-center pb-3 font-medium">UP Orderbook</th>
                      <th className="text-center pb-3 font-medium">DOWN Orderbook</th>
                      <th className="text-center pb-3 font-medium">Combined</th>
                      <th className="text-right pb-3 font-medium">Edge</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/30">
                    {liveMarkets.map((market) => {
                      const confidence = getConfidenceLevel(market.arbitrageEdge);
                      const isExpiringSoon = market.remainingSeconds < 120;
                      const currentPrice = market.asset === "BTC" ? btcPrice : ethPrice;
                      const priceDiff = currentPrice && market.openPrice ? currentPrice - market.openPrice : null;
                      
                      // Get orderbook data
                      const upBook = getOrderbook(market.slug, "up");
                      const downBook = getOrderbook(market.slug, "down");
                      
                      return (
                        <tr key={market.slug} className="group hover:bg-muted/30 transition-colors">
                          <td className="py-3">
                            <div className="flex items-center gap-2">
                              <div className={`w-7 h-7 rounded-lg flex items-center justify-center font-bold text-xs ${
                                market.asset === 'BTC' ? 'bg-orange-500/10 text-orange-500' : 'bg-blue-500/10 text-blue-500'
                              }`}>
                                {market.asset === 'BTC' ? '₿' : 'Ξ'}
                              </div>
                              <div>
                                <div className="font-medium text-sm">{market.asset}</div>
                                <div className="text-[10px] text-muted-foreground">15m</div>
                              </div>
                            </div>
                          </td>
                          <td className="py-3">
                            <Badge variant={isExpiringSoon ? "destructive" : "secondary"} className="font-mono text-xs">
                              {formatTime(market.remainingSeconds)}
                            </Badge>
                          </td>
                          <td className="py-3 text-center">
                            {market.openPrice ? (
                              <div>
                                <div className="font-mono text-sm">${market.openPrice.toLocaleString()}</div>
                                {priceDiff !== null && (
                                  <div className={`text-[10px] ${priceDiff >= 0 ? "text-emerald-500" : "text-red-500"}`}>
                                    {priceDiff >= 0 ? "+" : ""}{priceDiff.toFixed(0)}
                                  </div>
                                )}
                              </div>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </td>
                          <td className="py-3 text-center">
                            <div className="flex flex-col items-center gap-0.5">
                              <span className="font-mono text-sm text-emerald-500">
                                {(market.upPrice * 100).toFixed(0)}¢
                              </span>
                              {upBook && (
                                <div className="flex gap-1 text-[10px] text-muted-foreground">
                                  <span className="text-blue-400">
                                    {upBook.bid !== null ? `B:${(upBook.bid * 100).toFixed(0)}¢` : 'B:—'}
                                  </span>
                                  <span>/</span>
                                  <span className="text-orange-400">
                                    {upBook.ask !== null ? `A:${(upBook.ask * 100).toFixed(0)}¢` : 'A:—'}
                                  </span>
                                </div>
                              )}
                            </div>
                          </td>
                          <td className="py-3 text-center">
                            <div className="flex flex-col items-center gap-0.5">
                              <span className="font-mono text-sm text-red-500">
                                {(market.downPrice * 100).toFixed(0)}¢
                              </span>
                              {downBook && (
                                <div className="flex gap-1 text-[10px] text-muted-foreground">
                                  <span className="text-blue-400">
                                    {downBook.bid !== null ? `B:${(downBook.bid * 100).toFixed(0)}¢` : 'B:—'}
                                  </span>
                                  <span>/</span>
                                  <span className="text-orange-400">
                                    {downBook.ask !== null ? `A:${(downBook.ask * 100).toFixed(0)}¢` : 'A:—'}
                                  </span>
                                </div>
                              )}
                            </div>
                          </td>
                          <td className="py-3 text-center">
                            <span className={`font-mono text-sm font-medium ${market.combinedPrice < 1 ? "text-primary" : ""}`}>
                              {(market.combinedPrice * 100).toFixed(1)}¢
                            </span>
                          </td>
                          <td className="py-3 text-right">
                            <Badge 
                              variant="outline" 
                              className={`font-mono ${
                                confidence === "high" ? "text-emerald-500 border-emerald-500/30 bg-emerald-500/10" :
                                confidence === "medium" ? "text-yellow-500 border-yellow-500/30 bg-yellow-500/10" :
                                "text-muted-foreground"
                              }`}
                            >
                              {market.arbitrageEdge > 0 ? "+" : ""}{market.arbitrageEdge.toFixed(1)}%
                            </Badge>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Market Details with Trades */}
        {[...btcMarkets, ...ethMarkets].length > 0 && (
          <div className="grid lg:grid-cols-2 gap-4">
            {[...btcMarkets, ...ethMarkets].slice(0, 4).map((market) => {
              const polymarketUrl = `https://polymarket.com/event/${market.slug}`;
              
              return (
                <Card key={market.slug} className={market.asset === "BTC" ? "border-orange-500/20" : "border-blue-500/20"}>
                  <CardHeader className="pb-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <div className={`w-6 h-6 rounded flex items-center justify-center font-bold text-xs ${
                          market.asset === 'BTC' ? 'bg-orange-500/10 text-orange-500' : 'bg-blue-500/10 text-blue-500'
                        }`}>
                          {market.asset === 'BTC' ? '₿' : 'Ξ'}
                        </div>
                        <div>
                          <span className="font-medium text-sm">{market.asset} 15m</span>
                          <a 
                            href={polymarketUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors"
                          >
                            Polymarket <ExternalLink className="w-3 h-3" />
                          </a>
                        </div>
                      </div>
                      <Badge variant="secondary" className="font-mono text-xs">
                        {formatTime(market.remainingSeconds)}
                      </Badge>
                    </div>
                    {market.question && (
                      <p className="text-xs text-muted-foreground mt-1 line-clamp-1">{market.question}</p>
                    )}
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {/* Price to Beat vs Current Price */}
                    {market.openPrice && (
                      <div className="p-2 rounded-lg bg-muted/30 border border-border/50">
                        <div className="flex items-center justify-between text-xs">
                          <div className="flex items-center gap-1.5">
                            <Target className="w-3 h-3 text-muted-foreground" />
                            <span className="text-muted-foreground">Strike:</span>
                            <span className="font-mono font-medium">
                              ${market.openPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                            </span>
                          </div>
                          {(() => {
                            const currentPrice = market.asset === 'BTC' ? btcPrice : ethPrice;
                            if (!currentPrice) return null;
                            const isAbove = currentPrice > market.openPrice;
                            const diff = currentPrice - market.openPrice;
                            const diffPercent = (diff / market.openPrice) * 100;
                            return (
                              <div className="flex items-center gap-1.5">
                                <span className="text-muted-foreground">Now:</span>
                                <span className={`font-mono font-medium ${isAbove ? 'text-emerald-500' : 'text-red-500'}`}>
                                  ${currentPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                                </span>
                                <Badge 
                                  variant="outline" 
                                  className={`text-[10px] px-1 py-0 ${isAbove ? 'text-emerald-500 border-emerald-500/30' : 'text-red-500 border-red-500/30'}`}
                                >
                                  {isAbove ? <ArrowUpRight className="w-2.5 h-2.5 mr-0.5" /> : <ArrowDownRight className="w-2.5 h-2.5 mr-0.5" />}
                                  {diffPercent > 0 ? '+' : ''}{diffPercent.toFixed(2)}%
                                </Badge>
                              </div>
                            );
                          })()}
                        </div>
                      </div>
                    )}
                    
                    <div className="grid grid-cols-4 gap-2 text-center text-sm">
                      <div className="p-2 rounded-lg bg-emerald-500/10">
                        <div className="text-[10px] text-muted-foreground">UP</div>
                        <div className="font-mono font-bold text-emerald-500">{(market.upPrice * 100).toFixed(0)}¢</div>
                      </div>
                      <div className="p-2 rounded-lg bg-red-500/10">
                        <div className="text-[10px] text-muted-foreground">DOWN</div>
                        <div className="font-mono font-bold text-red-500">{(market.downPrice * 100).toFixed(0)}¢</div>
                      </div>
                      <div className="p-2 rounded-lg bg-muted/50">
                        <div className="text-[10px] text-muted-foreground">Σ</div>
                        <div className={`font-mono font-bold ${market.combinedPrice < 1 ? "text-primary" : ""}`}>
                          {(market.combinedPrice * 100).toFixed(0)}¢
                        </div>
                      </div>
                      <div className="p-2 rounded-lg bg-primary/10">
                        <div className="text-[10px] text-muted-foreground">Edge</div>
                        <div className="font-mono font-bold text-primary">{market.arbitrageEdge.toFixed(1)}%</div>
                      </div>
                    </div>
                    
                    {market.arbitrageEdge >= 2 && (
                      <div className="p-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-xs text-emerald-500 flex items-center gap-1.5">
                        <Zap className="w-3 h-3" />
                        Arbitrage: Buy both @ {(market.combinedPrice * 100).toFixed(0)}¢
                      </div>
                    )}
                    
                    <GabagoolTradesSummary 
                      marketSlug={market.slug} 
                      upClobPrice={market.upPrice} 
                      downClobPrice={market.downPrice} 
                    />
                    <PaperBotTradesSummary 
                      marketSlug={market.slug} 
                      upClobPrice={market.upPrice} 
                      downClobPrice={market.downPrice} 
                    />
                    <LiveBotTradesSummary 
                      marketSlug={market.slug} 
                      upClobPrice={market.upPrice} 
                      downClobPrice={market.downPrice} 
                    />
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}

        {/* Upcoming Markets (>15 min) */}
        {upcomingMarkets.length > 0 && (
          <Collapsible open={upcomingMarketsOpen} onOpenChange={setUpcomingMarketsOpen}>
            <Card>
              <CollapsibleTrigger asChild>
                <CardHeader className="cursor-pointer hover:bg-muted/30 transition-colors">
                  <CardTitle className="flex items-center justify-between text-base text-muted-foreground">
                    <div className="flex items-center gap-2">
                      <Clock className="w-4 h-4" />
                      Upcoming Markets
                      <Badge variant="secondary">{upcomingMarkets.length}</Badge>
                    </div>
                    <ChevronDown className={`w-4 h-4 transition-transform ${upcomingMarketsOpen ? 'rotate-180' : ''}`} />
                  </CardTitle>
                </CardHeader>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <CardContent className="pt-0">
                  <div className="overflow-x-auto">
                    <table className="w-full">
                      <thead>
                        <tr className="text-xs text-muted-foreground border-b border-border/50">
                          <th className="text-left pb-3 font-medium">Asset</th>
                          <th className="text-left pb-3 font-medium">Time</th>
                          <th className="text-center pb-3 font-medium">Strike</th>
                          <th className="text-center pb-3 font-medium">UP</th>
                          <th className="text-center pb-3 font-medium">DOWN</th>
                          <th className="text-center pb-3 font-medium">Combined</th>
                          <th className="text-right pb-3 font-medium">Edge</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border/30">
                        {upcomingMarkets.slice(0, 20).map((market) => {
                          const confidence = getConfidenceLevel(market.arbitrageEdge);
                          const mins = Math.floor(market.remainingSeconds / 60);
                          const timeDisplay = mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`;
                          
                          return (
                            <tr key={market.slug} className="group hover:bg-muted/30 transition-colors">
                              <td className="py-3">
                                <div className="flex items-center gap-2">
                                  <div className={`w-7 h-7 rounded-lg flex items-center justify-center font-bold text-xs ${
                                    market.asset === 'BTC' ? 'bg-orange-500/10 text-orange-500' : 'bg-blue-500/10 text-blue-500'
                                  }`}>
                                    {market.asset === 'BTC' ? '₿' : 'Ξ'}
                                  </div>
                                  <div>
                                    <div className="font-medium text-sm">{market.asset}</div>
                                    <div className="text-[10px] text-muted-foreground">15m</div>
                                  </div>
                                </div>
                              </td>
                              <td className="py-3">
                                <Badge variant="secondary" className="font-mono text-xs">
                                  {timeDisplay}
                                </Badge>
                              </td>
                              <td className="py-3 text-center">
                                {market.openPrice ? (
                                  <div className="font-mono text-sm">${market.openPrice.toLocaleString()}</div>
                                ) : (
                                  <span className="text-muted-foreground">—</span>
                                )}
                              </td>
                              <td className="py-3 text-center">
                                <span className="font-mono text-sm text-emerald-500">
                                  {(market.upPrice * 100).toFixed(0)}¢
                                </span>
                              </td>
                              <td className="py-3 text-center">
                                <span className="font-mono text-sm text-red-500">
                                  {(market.downPrice * 100).toFixed(0)}¢
                                </span>
                              </td>
                              <td className="py-3 text-center">
                                <span className={`font-mono text-sm font-medium ${market.combinedPrice < 1 ? "text-primary" : ""}`}>
                                  {(market.combinedPrice * 100).toFixed(1)}¢
                                </span>
                              </td>
                              <td className="py-3 text-right">
                                <Badge 
                                  variant="outline" 
                                  className={`font-mono ${
                                    confidence === "high" ? "text-emerald-500 border-emerald-500/30 bg-emerald-500/10" :
                                    confidence === "medium" ? "text-yellow-500 border-yellow-500/30 bg-yellow-500/10" :
                                    "text-muted-foreground"
                                  }`}
                                >
                                  {market.arbitrageEdge > 0 ? "+" : ""}{market.arbitrageEdge.toFixed(1)}%
                                </Badge>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </CardContent>
              </CollapsibleContent>
            </Card>
          </Collapsible>
        )}

        {/* Expired Markets */}
        {recentExpiredMarkets.length > 0 && (
          <Collapsible open={expiredMarketsOpen} onOpenChange={setExpiredMarketsOpen}>
            <Card>
              <CollapsibleTrigger asChild>
                <CardHeader className="cursor-pointer hover:bg-muted/30 transition-colors">
                  <CardTitle className="flex items-center justify-between text-base text-muted-foreground">
                    <div className="flex items-center gap-2">
                      <History className="w-4 h-4" />
                      Expired Markets
                      <Badge variant="secondary">{recentExpiredMarkets.length}</Badge>
                    </div>
                    <ChevronDown className={`w-4 h-4 transition-transform ${expiredMarketsOpen ? 'rotate-180' : ''}`} />
                  </CardTitle>
                </CardHeader>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <CardContent className="pt-0">
                  <div className="space-y-4">
                    {recentExpiredMarkets.map((market) => (
                      <div
                        key={market.slug}
                        className={`p-4 rounded-lg ${
                          market.result === 'UP' 
                            ? 'bg-emerald-500/5 border border-emerald-500/20' 
                            : market.result === 'DOWN'
                              ? 'bg-red-500/5 border border-red-500/20'
                              : 'bg-muted/30 border border-border/50'
                        }`}
                      >
                        {/* Header Row */}
                        <div className="flex items-center justify-between mb-3">
                          <div className="flex items-center gap-3">
                            <div className={`w-8 h-8 rounded-lg flex items-center justify-center text-sm font-bold ${
                              market.asset === "BTC" ? "bg-orange-500/10 text-orange-500" : "bg-blue-500/10 text-blue-500"
                            }`}>
                              {market.asset === "BTC" ? "₿" : "Ξ"}
                            </div>
                            <div>
                              <div className="flex items-center gap-2">
                                <span className="font-medium">{market.asset} 15m</span>
                                <Badge 
                                  variant="outline"
                                  className={
                                    market.result === 'UP' ? 'text-emerald-500 border-emerald-500/30 bg-emerald-500/10' :
                                    market.result === 'DOWN' ? 'text-red-500 border-red-500/30 bg-red-500/10' :
                                    'text-muted-foreground'
                                  }
                                >
                                  {market.result || "Pending"}
                                </Badge>
                              </div>
                              {market.question && (
                                <div className="text-xs text-muted-foreground line-clamp-1 mt-0.5 max-w-md">
                                  {market.question}
                                </div>
                              )}
                            </div>
                          </div>
                          <div className="text-right text-xs text-muted-foreground">
                            {market.eventEndTime && (
                              <div>{new Date(market.eventEndTime).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' })}</div>
                            )}
                          </div>
                        </div>

                        {/* Price Info */}
                        <div className="flex items-center gap-4 text-sm mb-3 p-2 rounded bg-muted/30">
                          {market.openPrice && (
                            <div className="flex items-center gap-1.5">
                              <span className="text-muted-foreground">Strike:</span>
                              <span className="font-mono">${market.openPrice.toLocaleString()}</span>
                            </div>
                          )}
                          {market.closePrice && (
                            <>
                              <span className="text-muted-foreground">→</span>
                              <div className="flex items-center gap-1.5">
                                <span className="text-muted-foreground">Close:</span>
                                <span className={`font-mono ${
                                  market.openPrice && market.closePrice > market.openPrice ? 'text-emerald-500' : 
                                  market.openPrice && market.closePrice < market.openPrice ? 'text-red-500' : ''
                                }`}>
                                  ${market.closePrice.toLocaleString()}
                                </span>
                              </div>
                            </>
                          )}
                          {market.openPrice && market.closePrice && (
                            <Badge variant="outline" className={`ml-auto ${
                              market.closePrice > market.openPrice ? 'text-emerald-500 border-emerald-500/30' : 'text-red-500 border-red-500/30'
                            }`}>
                              {market.closePrice > market.openPrice ? '+' : ''}
                              {((market.closePrice - market.openPrice) / market.openPrice * 100).toFixed(2)}%
                            </Badge>
                          )}
                        </div>

                        {/* Bot Summaries */}
                        <div className="grid grid-cols-1 lg:grid-cols-3 gap-2">
                          <GabagoolTradesSummary 
                            marketSlug={market.slug} 
                            upClobPrice={0.5} 
                            downClobPrice={0.5} 
                            compact={true}
                            actualResult={market.result as 'UP' | 'DOWN' | null}
                          />
                          <PaperBotTradesSummary 
                            marketSlug={market.slug} 
                            upClobPrice={0.5} 
                            downClobPrice={0.5} 
                            compact={true}
                            actualResult={market.result as 'UP' | 'DOWN' | null}
                          />
                          <LiveBotTradesSummary 
                            marketSlug={market.slug} 
                            upClobPrice={0.5} 
                            downClobPrice={0.5} 
                            compact={true}
                            actualResult={market.result as 'UP' | 'DOWN' | null}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </CollapsibleContent>
            </Card>
          </Collapsible>
        )}

        {liveMarkets.length === 0 && !isLive && (
          <Card>
            <CardContent className="py-12 text-center">
              <WifiOff className="w-8 h-8 text-muted-foreground mx-auto mb-3" />
              <div className="text-muted-foreground">Live updates paused</div>
              <Button variant="outline" size="sm" className="mt-4" onClick={() => setIsLive(true)}>
                Resume
              </Button>
            </CardContent>
          </Card>
        )}
      </main>
    </div>
  );
};

export default RealTimeSignalsPage;
