import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { 
  ArrowLeft,
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
  Layers
} from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';

interface TradingSignal {
  market: string;
  marketSlug: string;
  asset: 'BTC' | 'ETH';
  priceToBeat: number | null;
  currentPrice: number | null;
  priceDelta: number | null;
  priceDeltaPercent: number | null;
  upPrice: number;
  downPrice: number;
  combinedPrice: number;
  cheaperSide: 'Up' | 'Down';
  cheaperPrice: number;
  spread: number;
  potentialReturn: number;
  arbitrageEdge: number;
  confidence: 'high' | 'medium' | 'low';
  signalType: 'dual_side' | 'single_side' | 'arbitrage' | 'wait';
  action: string;
  eventStartTime: string;
  eventEndTime: string;
  remainingSeconds: number;
  remainingFormatted: string;
  timestamp: string;
}

interface RealTimeData {
  success: boolean;
  timestamp: string;
  cryptoPrices: {
    BTC: number | null;
    ETH: number | null;
  };
  marketsAnalyzed: number;
  currentMarkets: TradingSignal[];
  upcomingMarkets: TradingSignal[];
  signals: TradingSignal[];
  summary: {
    highConfidenceCount: number;
    arbitrageOpportunityCount: number;
    dualSideSignalCount: number;
    avgCombinedPrice: number;
    avgArbitrageEdge: number;
  };
}

const REFRESH_INTERVAL = 5000; // 5 seconds for live 15-min markets

const RealTimeSignalsPage = () => {
  const [data, setData] = useState<RealTimeData | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLive, setIsLive] = useState(true);
  const [secondsSinceUpdate, setSecondsSinceUpdate] = useState(0);
  const [countdowns, setCountdowns] = useState<Record<string, string>>({});

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

  // Initial fetch
  useEffect(() => {
    fetchSignals();
  }, [fetchSignals]);

  // Live auto-refresh
  useEffect(() => {
    if (!isLive) return;
    
    const interval = setInterval(fetchSignals, REFRESH_INTERVAL);
    return () => clearInterval(interval);
  }, [isLive, fetchSignals]);

  // Update seconds counter and countdowns
  useEffect(() => {
    const interval = setInterval(() => {
      setSecondsSinceUpdate(prev => prev + 1);
      
      // Update countdowns locally
      if (data?.signals) {
        const newCountdowns: Record<string, string> = {};
        data.signals.forEach(signal => {
          const remaining = signal.remainingSeconds - secondsSinceUpdate;
          if (remaining > 0) {
            const mins = Math.floor(remaining / 60);
            const secs = remaining % 60;
            newCountdowns[signal.marketSlug] = `${mins}:${secs.toString().padStart(2, '0')}`;
          } else {
            newCountdowns[signal.marketSlug] = 'EXPIRED';
          }
        });
        setCountdowns(newCountdowns);
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [data, secondsSinceUpdate]);

  const getConfidenceBadge = (confidence: string) => {
    switch (confidence) {
      case 'high':
        return <Badge className="bg-emerald-500/20 text-emerald-400 border-emerald-500/30">HIGH</Badge>;
      case 'medium':
        return <Badge className="bg-yellow-500/20 text-yellow-400 border-yellow-500/30">MEDIUM</Badge>;
      default:
        return <Badge className="bg-muted text-muted-foreground">LOW</Badge>;
    }
  };

  const getSignalTypeBadge = (signalType: string) => {
    switch (signalType) {
      case 'dual_side':
        return <Badge variant="outline" className="text-purple-400 border-purple-500/30">Dual-Side</Badge>;
      case 'arbitrage':
        return <Badge variant="outline" className="text-emerald-400 border-emerald-500/30">Arbitrage</Badge>;
      case 'single_side':
        return <Badge variant="outline" className="text-blue-400 border-blue-500/30">Single-Side</Badge>;
      default:
        return <Badge variant="outline" className="text-muted-foreground">Wait</Badge>;
    }
  };

  const getAssetBadge = (asset: 'BTC' | 'ETH') => {
    return asset === 'BTC' 
      ? <Badge className="bg-orange-500/20 text-orange-400 border-orange-500/30">BTC</Badge>
      : <Badge className="bg-blue-500/20 text-blue-400 border-blue-500/30">ETH</Badge>;
  };

  const formatDelta = (delta: number | null, percent: number | null): string => {
    if (delta === null || percent === null) return '-';
    const sign = delta >= 0 ? '+' : '';
    return `${sign}$${Math.abs(delta).toFixed(2)} (${sign}${percent.toFixed(4)}%)`;
  };

  const SignalCard = ({ signal, showCountdown = true }: { signal: TradingSignal; showCountdown?: boolean }) => {
    const countdown = countdowns[signal.marketSlug] || signal.remainingFormatted;
    const isExpiringSoon = signal.remainingSeconds < 120;
    const isExpired = countdown === 'EXPIRED';
    
    return (
      <div
        className={`p-4 rounded-lg border transition-all ${
          signal.confidence === 'high' 
            ? 'border-emerald-500/50 bg-emerald-500/10 shadow-lg shadow-emerald-500/10' 
            : signal.confidence === 'medium'
            ? 'border-yellow-500/30 bg-yellow-500/5'
            : 'border-border bg-muted/5'
        }`}
      >
        {/* Header with Asset, Countdown, Badges */}
        <div className="flex items-start justify-between mb-4">
          <div className="flex items-center gap-2">
            {getAssetBadge(signal.asset)}
            {showCountdown && (
              <div className={`flex items-center gap-1 px-2 py-1 rounded-md text-sm font-mono ${
                isExpired 
                  ? 'bg-destructive/20 text-destructive'
                  : isExpiringSoon 
                    ? 'bg-red-500/20 text-red-400 animate-pulse'
                    : 'bg-muted'
              }`}>
                <Timer className="w-3 h-3" />
                {countdown}
              </div>
            )}
          </div>
          <div className="flex items-center gap-2">
            {getConfidenceBadge(signal.confidence)}
            {getSignalTypeBadge(signal.signalType)}
          </div>
        </div>
        
        {/* Price Comparison - Main Focus */}
        <div className="grid grid-cols-3 gap-4 mb-4 p-3 bg-background/50 rounded-lg">
          <div className="text-center">
            <div className="text-xs text-muted-foreground mb-1">Price to Beat</div>
            <div className="text-lg font-bold font-mono">
              ${signal.priceToBeat?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) || '-'}
            </div>
          </div>
          <div className="text-center">
            <div className="text-xs text-muted-foreground mb-1">Current Price</div>
            <div className={`text-lg font-bold font-mono ${
              signal.priceDelta !== null 
                ? signal.priceDelta >= 0 ? 'text-emerald-400' : 'text-red-400'
                : ''
            }`}>
              ${signal.currentPrice?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) || '-'}
            </div>
          </div>
          <div className="text-center">
            <div className="text-xs text-muted-foreground mb-1">Delta</div>
            <div className={`text-sm font-mono font-medium ${
              signal.priceDelta !== null 
                ? signal.priceDelta >= 0 ? 'text-emerald-400' : 'text-red-400'
                : ''
            }`}>
              {formatDelta(signal.priceDelta, signal.priceDeltaPercent)}
            </div>
          </div>
        </div>
        
        {/* Action - Highlighted */}
        <div className={`p-3 rounded-lg mb-4 ${
          signal.confidence === 'high'
            ? 'bg-emerald-500/20 border border-emerald-500/30'
            : signal.confidence === 'medium'
            ? 'bg-yellow-500/10 border border-yellow-500/30'
            : 'bg-muted/50 border border-border'
        }`}>
          <div className="flex items-center gap-2">
            <Zap className={`w-4 h-4 ${
              signal.confidence === 'high' ? 'text-emerald-400' : 'text-muted-foreground'
            }`} />
            <span className="font-medium text-sm">{signal.action}</span>
          </div>
        </div>
        
        {/* Market Prices */}
        <div className="grid grid-cols-4 gap-3 text-sm">
          <div className="text-center p-2 bg-emerald-500/10 rounded-lg">
            <div className="flex items-center justify-center gap-1 text-emerald-400 mb-1">
              <TrendingUp className="w-3 h-3" />
              <span className="text-xs">Up</span>
            </div>
            <span className="font-mono font-bold">{(signal.upPrice * 100).toFixed(1)}¢</span>
          </div>
          <div className="text-center p-2 bg-red-500/10 rounded-lg">
            <div className="flex items-center justify-center gap-1 text-red-400 mb-1">
              <TrendingDown className="w-3 h-3" />
              <span className="text-xs">Down</span>
            </div>
            <span className="font-mono font-bold">{(signal.downPrice * 100).toFixed(1)}¢</span>
          </div>
          <div className="text-center p-2 bg-muted/50 rounded-lg">
            <div className="flex items-center justify-center gap-1 text-muted-foreground mb-1">
              <Layers className="w-3 h-3" />
              <span className="text-xs">Combined</span>
            </div>
            <span className={`font-mono font-bold ${signal.combinedPrice < 1 ? 'text-emerald-400' : ''}`}>
              {(signal.combinedPrice * 100).toFixed(1)}¢
            </span>
          </div>
          <div className="text-center p-2 bg-primary/10 rounded-lg">
            <div className="flex items-center justify-center gap-1 text-primary mb-1">
              <Target className="w-3 h-3" />
              <span className="text-xs">Edge</span>
            </div>
            <span className={`font-mono font-bold ${signal.arbitrageEdge > 0 ? 'text-primary' : ''}`}>
              {signal.arbitrageEdge.toFixed(1)}%
            </span>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
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
                  {isLive && (
                    <span className="absolute -top-1 -right-1 w-3 h-3 bg-emerald-500 rounded-full animate-pulse" />
                  )}
                </div>
                <div>
                  <h1 className="font-bold text-lg flex items-center gap-2">
                    Real-Time 15-Min Signals
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
                  </h1>
                  <p className="text-xs text-muted-foreground">
                    BTC/ETH 15-min markets • Gabagool-style signals
                    {lastUpdate && ` • Updated ${secondsSinceUpdate}s ago`}
                  </p>
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant={isLive ? "default" : "outline"}
                size="sm"
                onClick={() => setIsLive(!isLive)}
                className={isLive ? 'bg-emerald-600 hover:bg-emerald-700' : ''}
              >
                {isLive ? <Wifi className="w-4 h-4" /> : <WifiOff className="w-4 h-4" />}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={fetchSignals}
                disabled={isLoading}
              >
                <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
              </Button>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="container mx-auto px-4 py-6 space-y-6">
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
            {/* Crypto Prices */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <Card className="border-orange-500/30">
                <CardContent className="pt-6">
                  <div className="flex items-center gap-2 text-muted-foreground mb-1">
                    <DollarSign className="w-4 h-4 text-orange-400" />
                    <span className="text-sm">Bitcoin</span>
                  </div>
                  <div className="text-2xl font-bold text-orange-400 font-mono">
                    ${data.cryptoPrices.BTC?.toLocaleString() || '-'}
                  </div>
                </CardContent>
              </Card>
              
              <Card className="border-blue-500/30">
                <CardContent className="pt-6">
                  <div className="flex items-center gap-2 text-muted-foreground mb-1">
                    <DollarSign className="w-4 h-4 text-blue-400" />
                    <span className="text-sm">Ethereum</span>
                  </div>
                  <div className="text-2xl font-bold text-blue-400 font-mono">
                    ${data.cryptoPrices.ETH?.toLocaleString() || '-'}
                  </div>
                </CardContent>
              </Card>
              
              <Card className="border-emerald-500/30">
                <CardContent className="pt-6">
                  <div className="flex items-center gap-2 text-muted-foreground mb-1">
                    <Zap className="w-4 h-4 text-emerald-400" />
                    <span className="text-sm">High Confidence</span>
                  </div>
                  <div className="text-2xl font-bold text-emerald-400">
                    {data.summary.highConfidenceCount}
                  </div>
                </CardContent>
              </Card>
              
              <Card className="border-primary/30">
                <CardContent className="pt-6">
                  <div className="flex items-center gap-2 text-muted-foreground mb-1">
                    <Target className="w-4 h-4 text-primary" />
                    <span className="text-sm">Dual-Side Signals</span>
                  </div>
                  <div className="text-2xl font-bold text-primary">
                    {data.summary.dualSideSignalCount}
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* Current Markets (Active Now) */}
            {data.currentMarkets.length > 0 && (
              <Card className="border-primary/30 bg-gradient-to-br from-primary/5 to-transparent">
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Timer className="w-5 h-5 text-primary" />
                      <CardTitle className="text-lg">Active Now ({data.currentMarkets.length})</CardTitle>
                    </div>
                    <Badge variant="outline" className="text-primary">
                      &lt; 15 min remaining
                    </Badge>
                  </div>
                  <CardDescription>
                    Current 15-minute markets with live countdown
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  {data.currentMarkets.map((signal, index) => (
                    <SignalCard key={index} signal={signal} />
                  ))}
                </CardContent>
              </Card>
            )}

            {/* Upcoming Markets */}
            {data.upcomingMarkets.length > 0 && (
              <Card>
                <CardHeader>
                  <div className="flex items-center gap-2">
                    <Clock className="w-5 h-5 text-muted-foreground" />
                    <CardTitle className="text-lg">Upcoming Markets ({data.upcomingMarkets.length})</CardTitle>
                  </div>
                  <CardDescription>
                    Future 15-minute markets to monitor
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  {data.upcomingMarkets.slice(0, 4).map((signal, index) => (
                    <SignalCard key={index} signal={signal} showCountdown={true} />
                  ))}
                </CardContent>
              </Card>
            )}

            {/* Empty State */}
            {data.signals.length === 0 && (
              <Card>
                <CardContent className="py-12 text-center">
                  <Activity className="w-12 h-12 mx-auto mb-4 text-muted-foreground/50" />
                  <h3 className="text-lg font-medium mb-2">No Active 15-Min Markets</h3>
                  <p className="text-muted-foreground text-sm">
                    Waiting for BTC/ETH 15-minute prediction markets to become active.
                  </p>
                </CardContent>
              </Card>
            )}

            {/* Gabagool Strategy Info */}
            <Card className="border-purple-500/30 bg-gradient-to-br from-purple-500/5 to-transparent">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-lg">
                  <Target className="w-5 h-5 text-purple-400" />
                  Gabagool Strategie: 15-Min Dual-Side
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid md:grid-cols-3 gap-4">
                  <div className="p-4 bg-emerald-500/10 rounded-lg border border-emerald-500/20">
                    <h4 className="font-medium text-emerald-400 mb-2">HIGH Confidence</h4>
                    <p className="text-sm text-muted-foreground">
                      Delta &lt; 0.03% + Combined &lt; 100¢
                    </p>
                    <p className="text-xs text-emerald-400 mt-2">
                      → Buy BOTH sides for guaranteed profit
                    </p>
                  </div>
                  <div className="p-4 bg-yellow-500/10 rounded-lg border border-yellow-500/20">
                    <h4 className="font-medium text-yellow-400 mb-2">MEDIUM Confidence</h4>
                    <p className="text-sm text-muted-foreground">
                      Delta &lt; 0.1% or Combined &lt; 100¢
                    </p>
                    <p className="text-xs text-yellow-400 mt-2">
                      → Buy underpriced side near strike
                    </p>
                  </div>
                  <div className="p-4 bg-muted/50 rounded-lg border border-border">
                    <h4 className="font-medium text-muted-foreground mb-2">LOW Confidence</h4>
                    <p className="text-sm text-muted-foreground">
                      Larger delta, directional signal
                    </p>
                    <p className="text-xs text-muted-foreground mt-2">
                      → Consider single-side directional bet
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </>
        )}

        {/* Loading State */}
        {isLoading && !data && (
          <Card>
            <CardContent className="py-12 text-center">
              <RefreshCw className="w-8 h-8 mx-auto mb-4 animate-spin text-primary" />
              <p className="text-muted-foreground">Loading 15-min market signals...</p>
            </CardContent>
          </Card>
        )}
      </main>
    </div>
  );
};

export default RealTimeSignalsPage;
