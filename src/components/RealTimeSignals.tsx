import { useState, useEffect, useCallback, useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { 
  Activity, 
  TrendingUp, 
  TrendingDown, 
  RefreshCw, 
  Zap,
  Target,
  AlertTriangle,
  Clock,
  DollarSign,
  Wifi,
  WifiOff,
  Timer,
  Radio,
  Satellite
} from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { LiveCountdown } from './LiveCountdown';
import { LivePrice, LiveMarketPrices } from './LivePrice';
import { usePolymarketRealtime, fetch15MinMarketTokenIds } from '@/hooks/usePolymarketRealtime';
import { useChainlinkRealtime } from '@/hooks/useChainlinkRealtime';

interface TradingSignal {
  market: string;
  marketSlug: string;
  asset: 'BTC' | 'ETH';
  priceToBeat: number | null;
  priceToBeatSource: string | null;
  priceToBeatQuality: string | null;
  currentPrice: number | null;
  priceDelta: number | null;
  priceDeltaPercent: number | null;
  upPrice: number;
  downPrice: number;
  upTokenId?: string;
  downTokenId?: string;
  combinedPrice: number;
  cheaperSide: 'Up' | 'Down';
  cheaperPrice: number;
  spread: number;
  potentialReturn: number;
  arbitrageEdge: number;
  confidence: 'high' | 'medium' | 'low';
  signalType: string;
  action: string;
  eventStartTime: string;
  eventEndTime: string;
  remainingSeconds: number;
  remainingFormatted: string;
  timestamp: string;
  hasLiveWsData?: boolean;
}

interface RealTimeData {
  success: boolean;
  timestamp: string;
  cryptoPrices: {
    BTC: number | null;
    ETH: number | null;
  };
  marketsAnalyzed: number;
  liveMarkets: TradingSignal[];
  soonUpcoming: TradingSignal[];
  laterMarkets: TradingSignal[];
  signals: TradingSignal[];
  summary: {
    highConfidenceCount: number;
    arbitrageOpportunityCount: number;
    liveCount: number;
    soonCount: number;
    laterCount: number;
    avgCombinedPrice: number;
    avgArbitrageEdge: number;
  };
}

interface MarketTokenMapping {
  slug: string;
  asset: 'BTC' | 'ETH';
  upTokenId: string;
  downTokenId: string;
  eventStartTime?: string;
  eventEndTime?: string;
}

const REFRESH_INTERVAL = 5000; // 5 seconds for API data
const WS_ENABLED = true; // Enable WebSocket for real-time prices

export const RealTimeSignals = () => {
  const [data, setData] = useState<RealTimeData | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLive, setIsLive] = useState(true);
  const [secondsSinceUpdate, setSecondsSinceUpdate] = useState(0);
  const [marketTokens, setMarketTokens] = useState<MarketTokenMapping[]>([]);
  const [wsUpdateCount, setWsUpdateCount] = useState(0);

  // Extract all token IDs for WebSocket subscription
  const tokenIds = useMemo(() => {
    return marketTokens.flatMap(m => [m.upTokenId, m.downTokenId]).filter(Boolean);
  }, [marketTokens]);

  // Polymarket CLOB WebSocket for Up/Down prices
  const { 
    orderBooks, 
    isConnected: wsConnected, 
    connectionState,
    updateCount 
  } = usePolymarketRealtime({
    tokenIds,
    enabled: WS_ENABLED && isLive && tokenIds.length > 0
  });

  // Chainlink WebSocket for real-time BTC/ETH prices
  const {
    btcPrice: chainlinkBtcPrice,
    ethPrice: chainlinkEthPrice,
    isConnected: chainlinkConnected,
    updateCount: chainlinkUpdateCount,
    lastUpdate: chainlinkLastUpdate
  } = useChainlinkRealtime(WS_ENABLED && isLive);

  // Fetch token IDs from Gamma API
  useEffect(() => {
    const fetchTokens = async () => {
      try {
        const { markets } = await fetch15MinMarketTokenIds();
        setMarketTokens(markets.map(m => ({
          slug: m.slug,
          asset: m.asset,
          upTokenId: m.upTokenId,
          downTokenId: m.downTokenId,
          eventStartTime: m.eventStartTime,
          eventEndTime: m.eventEndTime
        })));
        console.log('[Tokens] Loaded mappings for', markets.length, 'markets:', markets.map(m => m.slug));
      } catch (err) {
        console.error('Failed to fetch market tokens:', err);
      }
    };
    
    fetchTokens();
    // Refresh token mappings every 5 minutes
    const interval = setInterval(fetchTokens, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  // Get real-time prices from WebSocket
  const getWsPrice = useCallback((tokenId: string): number | null => {
    const book = orderBooks.get(tokenId);
    return book?.midPrice ?? null;
  }, [orderBooks]);

  // Merge WebSocket prices with API data - use Chainlink for current price
  const liveMarketsWithWsPrices = useMemo(() => {
    if (!data?.liveMarkets) return [];
    
    return data.liveMarkets.map(signal => {
      // Find token mapping for this market - try multiple matching strategies
      let tokenMapping = marketTokens.find(m => m.slug === signal.marketSlug);
      
      // If no exact match, try matching by timestamp in slug
      if (!tokenMapping) {
        const timestampMatch = signal.marketSlug.match(/(\d{10})$/);
        if (timestampMatch) {
          const timestamp = timestampMatch[1];
          tokenMapping = marketTokens.find(m => 
            m.slug.includes(timestamp) && 
            m.asset === signal.asset
          );
        }
      }
      
      // If still no match, try matching by asset and approximate time
      if (!tokenMapping) {
        const eventStartMs = new Date(signal.eventStartTime).getTime();
        tokenMapping = marketTokens.find(m => {
          if (m.asset !== signal.asset) return false;
          const tokenEventMs = new Date(m.eventStartTime).getTime();
          // Match if within 5 minutes
          return Math.abs(eventStartMs - tokenEventMs) < 5 * 60 * 1000;
        });
      }
      
      // Get WebSocket prices for Up/Down
      const wsUpPrice = tokenMapping ? getWsPrice(tokenMapping.upTokenId) : null;
      const wsDownPrice = tokenMapping ? getWsPrice(tokenMapping.downTokenId) : null;
      
      // Use WebSocket prices if available, otherwise fall back to API
      const upPrice = wsUpPrice ?? signal.upPrice;
      const downPrice = wsDownPrice ?? signal.downPrice;
      const combinedPrice = upPrice + downPrice;
      
      // Use Chainlink WebSocket price for current crypto price
      const currentPrice = signal.asset === 'BTC' 
        ? (chainlinkBtcPrice ?? signal.currentPrice)
        : (chainlinkEthPrice ?? signal.currentPrice);
      
      // Calculate delta based on real-time current price
      const priceToBeat = signal.priceToBeat;
      const priceDelta = priceToBeat && currentPrice ? currentPrice - priceToBeat : null;
      const priceDeltaPercent = priceToBeat && priceDelta !== null 
        ? (priceDelta / priceToBeat) * 100 
        : null;
      
      // Log for debugging
      if (tokenMapping) {
        console.log(`[Match] ${signal.marketSlug} -> ${tokenMapping.slug} (Up: ${wsUpPrice}, Down: ${wsDownPrice})`);
      }
      
      return {
        ...signal,
        upPrice,
        downPrice,
        combinedPrice,
        currentPrice,
        priceDelta,
        priceDeltaPercent,
        upTokenId: tokenMapping?.upTokenId,
        downTokenId: tokenMapping?.downTokenId,
        arbitrageEdge: (1 - combinedPrice) * 100,
        cheaperSide: upPrice < downPrice ? 'Up' as const : 'Down' as const,
        cheaperPrice: Math.min(upPrice, downPrice),
        hasLiveWsData: !!(wsUpPrice || wsDownPrice)
      };
    });
  }, [data?.liveMarkets, marketTokens, getWsPrice, orderBooks, chainlinkBtcPrice, chainlinkEthPrice]);

  // Track which markets we've already triggered price collection for
  const [triggeredMarkets, setTriggeredMarkets] = useState<Set<string>>(new Set());

  // Trigger price collector for markets with pending/missing prices
  const triggerPriceCollection = useCallback(async () => {
    if (!data?.liveMarkets) return;
    
    const marketsNeedingPrices = data.liveMarkets.filter(m => 
      (m.priceToBeatQuality === 'pending' || m.priceToBeatQuality === 'missing' || !m.priceToBeat) &&
      !triggeredMarkets.has(m.marketSlug)
    );
    
    if (marketsNeedingPrices.length > 0) {
      console.log('Triggering price collection for', marketsNeedingPrices.length, 'markets');
      setTriggeredMarkets(prev => {
        const next = new Set(prev);
        marketsNeedingPrices.forEach(m => next.add(m.marketSlug));
        return next;
      });
      
      try {
        await supabase.functions.invoke('chainlink-price-collector');
        console.log('Price collection triggered successfully');
      } catch (err) {
        console.error('Failed to trigger price collection:', err);
      }
    }
  }, [data?.liveMarkets, triggeredMarkets]);

  // Auto-trigger price collection when we detect markets needing prices
  useEffect(() => {
    if (isLive && data?.liveMarkets) {
      triggerPriceCollection();
    }
  }, [isLive, data?.liveMarkets, triggerPriceCollection]);

  const fetchSignals = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    
    try {
      const { data: responseData, error: invokeError } = await supabase.functions.invoke('polymarket-realtime');
      
      if (invokeError) {
        throw new Error(invokeError.message);
      }
      
      setData(responseData);
      setLastUpdate(new Date());
      setSecondsSinceUpdate(0);
    } catch (err: any) {
      console.error('Error fetching signals:', err);
      setError(err.message || 'Failed to fetch signals');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSignals();
  }, [fetchSignals]);

  useEffect(() => {
    if (!isLive) return;
    const interval = setInterval(fetchSignals, REFRESH_INTERVAL);
    return () => clearInterval(interval);
  }, [isLive, fetchSignals]);

  useEffect(() => {
    const interval = setInterval(() => {
      setSecondsSinceUpdate(prev => prev + 1);
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  const getConfidenceBadge = (confidence: string) => {
    switch (confidence) {
      case 'high':
        return <Badge className="bg-emerald-500/20 text-emerald-400 border-emerald-500/30">High</Badge>;
      case 'medium':
        return <Badge className="bg-yellow-500/20 text-yellow-400 border-yellow-500/30">Medium</Badge>;
      default:
        return <Badge className="bg-muted text-muted-foreground">Low</Badge>;
    }
  };

  const getSignalTypeBadge = (signalType: string) => {
    switch (signalType) {
      case 'dual_side':
        return <Badge variant="outline" className="text-purple-400 border-purple-500/30">Dual Side</Badge>;
      case 'arbitrage':
        return <Badge variant="outline" className="text-emerald-400 border-emerald-500/30">Arbitrage</Badge>;
      case 'single_side':
        return <Badge variant="outline" className="text-blue-400 border-blue-500/30">Single Side</Badge>;
      default:
        return <Badge variant="outline" className="text-muted-foreground">Wait</Badge>;
    }
  };

  const formatDelta = (delta: number | null, percent: number | null): string => {
    if (delta === null || percent === null) return '-';
    const sign = delta >= 0 ? '+' : '';
    return `${sign}$${delta.toFixed(0)} (${sign}${percent.toFixed(3)}%)`;
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
                  Real-Time Market Signals
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
                <CardDescription className="flex items-center gap-2 flex-wrap">
                  Live Chainlink Price to Beat vs Current Price
                  {lastUpdate && (
                    <span className="text-xs">
                      • API {secondsSinceUpdate}s old
                    </span>
                  )}
                  {chainlinkConnected && (
                    <Badge variant="outline" className="text-xs text-orange-400 border-orange-500/30 flex items-center gap-1">
                      <Satellite className="w-3 h-3" />
                      Chainlink ({chainlinkUpdateCount} updates)
                    </Badge>
                  )}
                  {wsConnected && (
                    <Badge variant="outline" className="text-xs text-purple-400 border-purple-500/30 flex items-center gap-1">
                      <Radio className="w-3 h-3" />
                      CLOB WS ({updateCount} updates)
                    </Badge>
                  )}
                </CardDescription>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant={isLive ? "default" : "outline"}
                size="sm"
                onClick={() => setIsLive(!isLive)}
                className={isLive ? 'bg-emerald-600 hover:bg-emerald-700' : ''}
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
              <Button
                variant="outline"
                size="sm"
                onClick={fetchSignals}
                disabled={isLoading}
              >
                <RefreshCw className={`w-4 h-4 mr-2 ${isLoading ? 'animate-spin' : ''}`} />
                Refresh
              </Button>
            </div>
          </div>
        </CardHeader>
      </Card>

      {error && (
        <Card className="border-destructive/50 bg-destructive/10">
          <CardContent className="py-4">
            <div className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="w-5 h-5" />
              <span>{error}</span>
            </div>
          </CardContent>
        </Card>
      )}

      {data && (
        <>
          {/* Crypto Prices & Summary */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Card className={chainlinkConnected ? 'border-orange-500/30' : ''}>
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
                  price={chainlinkBtcPrice ?? data.cryptoPrices.BTC ?? 0}
                  format="dollars"
                  className="text-2xl font-bold text-orange-400"
                  showFlash={chainlinkConnected}
                />
              </CardContent>
            </Card>
            
            <Card>
              <CardContent className="pt-6">
                <div className="flex items-center gap-2 text-muted-foreground mb-1">
                  <DollarSign className="w-4 h-4" />
                  <span className="text-sm">Ethereum</span>
                </div>
                <LivePrice 
                  price={chainlinkEthPrice ?? data.cryptoPrices.ETH ?? 0}
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
                  <span className="text-sm">Live Now</span>
                </div>
                <div className="text-2xl font-bold text-emerald-400">
                  {data.liveMarkets?.length || 0}
                </div>
              </CardContent>
            </Card>
            
            <Card>
              <CardContent className="pt-6">
                <div className="flex items-center gap-2 text-muted-foreground mb-1">
                  <Zap className="w-4 h-4" />
                  <span className="text-sm">High Confidence</span>
                </div>
                <div className="text-2xl font-bold text-primary">
                  {data.summary.highConfidenceCount}
                </div>
              </CardContent>
            </Card>
          </div>

          {/* LIVE NOW Section - Priority Display with WebSocket prices */}
          {liveMarketsWithWsPrices && liveMarketsWithWsPrices.length > 0 && (
            <Card className="border-emerald-500/50 bg-gradient-to-br from-emerald-500/10 to-transparent">
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-lg flex items-center gap-2">
                    <div className="relative">
                      <Timer className="w-5 h-5 text-emerald-400" />
                      <span className="absolute -top-1 -right-1 w-2 h-2 bg-emerald-500 rounded-full animate-ping" />
                    </div>
                    <span className="text-emerald-400">LIVE NOW</span>
                    <Badge className="bg-emerald-500/20 text-emerald-400 border-emerald-500/30">
                      {liveMarketsWithWsPrices.length}
                    </Badge>
                    {wsConnected && (
                      <Badge variant="outline" className="text-purple-400 border-purple-500/30 text-xs">
                        <Radio className="w-3 h-3 mr-1" />
                        REAL-TIME
                      </Badge>
                    )}
                  </CardTitle>
                </div>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  {liveMarketsWithWsPrices.map((signal) => (
                    <div
                      key={`live-${signal.marketSlug}`}
                      className={`p-4 rounded-lg border-2 ${
                        signal.confidence === 'high' 
                          ? 'border-emerald-500/50 bg-emerald-500/10' 
                          : signal.confidence === 'medium'
                          ? 'border-yellow-500/50 bg-yellow-500/10'
                          : 'border-emerald-500/30 bg-muted/10'
                      }`}
                    >
                      {/* Top row: Asset + Countdown */}
                      <div className="flex items-center justify-between mb-4">
                        <div className="flex items-center gap-3">
                          <Badge 
                            className={`text-lg px-3 py-1 ${
                              signal.asset === 'BTC' 
                                ? 'bg-orange-500/20 text-orange-400 border-orange-500/30' 
                                : 'bg-blue-500/20 text-blue-400 border-blue-500/30'
                            }`}
                          >
                            {signal.asset}
                          </Badge>
                          <span className="text-sm text-muted-foreground">15-min market</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-sm text-muted-foreground">Ends in:</span>
                          <LiveCountdown 
                            eventEndTime={signal.eventEndTime} 
                            className="text-2xl font-bold"
                          />
                        </div>
                      </div>

                      {/* Price comparison row */}
                      <div className="grid grid-cols-3 gap-4 mb-4">
                        <div className="text-center p-3 bg-background/50 rounded-lg">
                          <div className="text-xs text-muted-foreground mb-1 flex items-center justify-center gap-1">
                            Price to Beat
                            {signal.priceToBeatQuality === 'exact' && (
                              <Badge className="bg-emerald-500/20 text-emerald-400 border-emerald-500/30 text-[10px] px-1 py-0">
                                ✓
                              </Badge>
                            )}
                            {signal.priceToBeatQuality === 'pending' && (
                              <Badge className="bg-yellow-500/20 text-yellow-400 border-yellow-500/30 text-[10px] px-1 py-0 animate-pulse">
                                ...
                              </Badge>
                            )}
                            {(signal.priceToBeatQuality === 'late' || signal.priceToBeatQuality === 'estimated') && (
                              <Badge className="bg-orange-500/20 text-orange-400 border-orange-500/30 text-[10px] px-1 py-0">
                                ~
                              </Badge>
                            )}
                          </div>
                          <div className="font-mono font-bold text-lg">
                            {signal.priceToBeat 
                              ? `$${signal.priceToBeat.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` 
                              : '-'}
                          </div>
                          {signal.priceToBeatSource && signal.priceToBeatSource !== 'none' && (
                            <div className="text-[10px] text-muted-foreground mt-0.5">
                              {signal.priceToBeatSource === 'polymarket_rtds' && 'Polymarket RTDS'}
                              {signal.priceToBeatSource === 'chainlink_delayed' && 'Chainlink (delayed)'}
                              {signal.priceToBeatSource === 'current_estimate' && 'Estimate (pending)'}
                              {signal.priceToBeatSource === 'coingecko_fallback' && 'CoinGecko'}
                            </div>
                          )}
                        </div>
                        <div className="text-center p-3 bg-background/50 rounded-lg">
                          <div className="text-xs text-muted-foreground mb-1">
                            Current {chainlinkConnected && <span className="text-orange-400">(LIVE)</span>}
                          </div>
                          <LivePrice 
                            price={signal.currentPrice ?? 0}
                            format="dollars"
                            className={`font-mono font-bold text-lg ${
                              signal.priceDelta !== null 
                                ? signal.priceDelta >= 0 ? 'text-emerald-400' : 'text-red-400'
                                : ''
                            }`}
                            showFlash={chainlinkConnected}
                          />
                        </div>
                        <div className="text-center p-3 bg-background/50 rounded-lg">
                          <div className="text-xs text-muted-foreground mb-1">
                            Delta {chainlinkConnected && <span className="text-orange-400">(LIVE)</span>}
                          </div>
                          <div className={`font-mono font-bold text-lg ${
                            signal.priceDeltaPercent !== null 
                              ? signal.priceDeltaPercent >= 0 ? 'text-emerald-400' : 'text-red-400'
                              : ''
                          }`}>
                            {signal.priceDeltaPercent !== null 
                              ? `${signal.priceDeltaPercent >= 0 ? '+' : ''}${signal.priceDeltaPercent.toFixed(3)}%`
                              : '-'}
                          </div>
                        </div>
                      </div>

                      {/* Market prices with LIVE updates */}
                      <div className="flex items-center justify-between p-3 bg-background/30 rounded-lg">
                        <div className="flex items-center gap-6 text-sm">
                          <div className="flex items-center gap-1">
                            <TrendingUp className="w-4 h-4 text-emerald-400" />
                            <span className="text-muted-foreground">Up:</span>
                            <LivePrice 
                              price={signal.upPrice} 
                              className="text-emerald-400 font-medium"
                              showFlash={signal.hasLiveWsData}
                            />
                            {signal.hasLiveWsData && (
                              <span className="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-pulse" />
                            )}
                          </div>
                          <div className="flex items-center gap-1">
                            <TrendingDown className="w-4 h-4 text-red-400" />
                            <span className="text-muted-foreground">Down:</span>
                            <LivePrice 
                              price={signal.downPrice} 
                              className="text-red-400 font-medium"
                              showFlash={signal.hasLiveWsData}
                            />
                            {signal.hasLiveWsData && (
                              <span className="w-1.5 h-1.5 bg-red-500 rounded-full animate-pulse" />
                            )}
                          </div>
                          <div className="flex items-center gap-1">
                            <span className="text-muted-foreground">Σ:</span>
                            <span className={`font-mono font-medium ${signal.combinedPrice < 1 ? 'text-emerald-400' : 'text-muted-foreground'}`}>
                              {(signal.combinedPrice * 100).toFixed(1)}¢
                            </span>
                            {signal.arbitrageEdge > 0 && (
                              <span className="text-emerald-400 text-xs">
                                (+{signal.arbitrageEdge.toFixed(1)}%)
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          {getConfidenceBadge(signal.confidence)}
                        </div>
                      </div>

                      {/* Action recommendation */}
                      {signal.action && signal.confidence !== 'low' && (
                        <div className="mt-3 p-2 bg-primary/10 rounded text-sm text-center font-medium text-primary">
                          {signal.action}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Coming Soon Section */}
          {data.soonUpcoming && data.soonUpcoming.length > 0 && (
            <Card className="border-blue-500/30">
              <CardHeader className="pb-3">
                <CardTitle className="text-lg flex items-center gap-2">
                  <Clock className="w-5 h-5 text-blue-400" />
                  <span>Coming Soon</span>
                  <Badge variant="outline" className="text-blue-400 border-blue-500/30">
                    {data.soonUpcoming.length}
                  </Badge>
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid gap-3">
                  {data.soonUpcoming.slice(0, 4).map((signal) => (
                    <div 
                      key={`soon-${signal.marketSlug}`}
                      className="flex items-center justify-between p-3 rounded-lg bg-muted/20 border border-border/50"
                    >
                      <div className="flex items-center gap-3">
                        <Badge 
                          variant="outline"
                          className={signal.asset === 'BTC' 
                            ? 'text-orange-400 border-orange-500/30' 
                            : 'text-blue-400 border-blue-500/30'
                          }
                        >
                          {signal.asset}
                        </Badge>
                        <span className="text-sm text-muted-foreground">
                          Starts: {new Date(signal.eventStartTime).toLocaleTimeString()}
                        </span>
                      </div>
                      <LiveCountdown 
                        eventEndTime={signal.eventEndTime} 
                        showMilliseconds={false}
                        className="text-lg"
                      />
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* No live markets message */}
          {(!data.liveMarkets || data.liveMarkets.length === 0) && (
            <Card className="border-muted">
              <CardContent className="py-12">
                <div className="flex flex-col items-center justify-center gap-4 text-center">
                  <Timer className="w-12 h-12 text-muted-foreground/50" />
                  <div>
                    <h3 className="font-medium text-lg">No Live Markets</h3>
                    <p className="text-sm text-muted-foreground">
                      Waiting for the next 15-minute market window...
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Gabagool Hypothesis Card */}
          <Card className="border-purple-500/30 bg-gradient-to-br from-purple-500/5 to-transparent">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg">
                <Target className="w-5 h-5 text-purple-400" />
                Gabagool Hypothese: Price Delta Trigger
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="p-4 bg-background/50 rounded-lg border border-border/50">
                <h4 className="font-medium mb-2">De Theorie:</h4>
                <p className="text-sm text-muted-foreground">
                  Gabagool koopt wanneer de <span className="text-purple-400 font-medium">Current Price</span> zeer 
                  dicht bij de <span className="text-purple-400 font-medium">Price to Beat (Chainlink)</span> ligt. 
                  Dit creëert maximale onzekerheid, waardoor beide kanten (Up/Down) goedkoop zijn.
                </p>
              </div>
              
              <div className="grid grid-cols-3 gap-4">
                <div className="p-3 bg-emerald-500/10 rounded-lg border border-emerald-500/20 text-center">
                  <div className="text-2xl font-bold text-emerald-400">
                    {data.signals?.filter(s => s.confidence === 'high').length || 0}
                  </div>
                  <div className="text-xs text-muted-foreground">High Uncertainty</div>
                  <div className="text-xs text-emerald-400">Delta &lt; 0.03%</div>
                </div>
                
                <div className="p-3 bg-yellow-500/10 rounded-lg border border-yellow-500/20 text-center">
                  <div className="text-2xl font-bold text-yellow-400">
                    {data.signals?.filter(s => s.confidence === 'medium').length || 0}
                  </div>
                  <div className="text-xs text-muted-foreground">Near Strike</div>
                  <div className="text-xs text-yellow-400">Delta &lt; 0.1%</div>
                </div>
                
                <div className="p-3 bg-muted/50 rounded-lg border border-border text-center">
                  <div className="text-2xl font-bold text-muted-foreground">
                    {data.signals?.filter(s => s.confidence === 'low').length || 0}
                  </div>
                  <div className="text-xs text-muted-foreground">Directional</div>
                  <div className="text-xs text-muted-foreground">Delta &gt; 0.1%</div>
                </div>
              </div>
            </CardContent>
          </Card>
        </>
      )}
      
      {isLoading && !data && (
        <Card>
          <CardContent className="py-12">
            <div className="flex flex-col items-center justify-center gap-4">
              <RefreshCw className="w-8 h-8 animate-spin text-primary" />
              <span className="text-muted-foreground">Loading real-time data...</span>
            </div>
          </CardContent>
        </Card>
      )}
    </section>
  );
};
