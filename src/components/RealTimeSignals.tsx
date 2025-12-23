import { useState, useEffect } from 'react';
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
  CheckCircle2,
  Clock,
  DollarSign
} from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';

interface TradingSignal {
  market: string;
  marketSlug: string;
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
  signalType: string;
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
  signals: TradingSignal[];
  summary: {
    highConfidenceCount: number;
    arbitrageOpportunityCount: number;
    avgCombinedPrice: number;
    avgArbitrageEdge: number;
  };
}

export const RealTimeSignals = () => {
  const [data, setData] = useState<RealTimeData | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(false);

  const fetchSignals = async () => {
    setIsLoading(true);
    setError(null);
    
    try {
      const { data: responseData, error: invokeError } = await supabase.functions.invoke('polymarket-realtime');
      
      if (invokeError) {
        throw new Error(invokeError.message);
      }
      
      setData(responseData);
      setLastUpdate(new Date());
    } catch (err: any) {
      console.error('Error fetching signals:', err);
      setError(err.message || 'Failed to fetch signals');
    } finally {
      setIsLoading(false);
    }
  };

  // Initial fetch
  useEffect(() => {
    fetchSignals();
  }, []);

  // Auto-refresh every 30 seconds if enabled
  useEffect(() => {
    if (!autoRefresh) return;
    
    const interval = setInterval(fetchSignals, 30000);
    return () => clearInterval(interval);
  }, [autoRefresh]);

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
      case 'uncertainty_high':
        return <Badge variant="outline" className="text-purple-400 border-purple-500/30">Uncertainty Zone</Badge>;
      case 'close_to_strike':
        return <Badge variant="outline" className="text-blue-400 border-blue-500/30">Near Strike</Badge>;
      case 'arbitrage_opportunity':
        return <Badge variant="outline" className="text-emerald-400 border-emerald-500/30">Arbitrage</Badge>;
      default:
        return <Badge variant="outline" className="text-muted-foreground">Directional</Badge>;
    }
  };

  const formatPrice = (price: number | null): string => {
    if (price === null) return '-';
    if (price > 1000) return `$${price.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
    return `${(price * 100).toFixed(1)}¢`;
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
              <div className="p-2 bg-primary/10 rounded-lg">
                <Activity className="w-6 h-6 text-primary" />
              </div>
              <div>
                <CardTitle className="text-xl">Real-Time Market Signals</CardTitle>
                <CardDescription>
                  Live Price to Beat vs Current Price analyse
                </CardDescription>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant={autoRefresh ? "default" : "outline"}
                size="sm"
                onClick={() => setAutoRefresh(!autoRefresh)}
              >
                {autoRefresh ? 'Auto ●' : 'Auto ○'}
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
            <Card>
              <CardContent className="pt-6">
                <div className="flex items-center gap-2 text-muted-foreground mb-1">
                  <DollarSign className="w-4 h-4" />
                  <span className="text-sm">Bitcoin</span>
                </div>
                <div className="text-2xl font-bold text-orange-400">
                  {data.cryptoPrices.BTC ? `$${data.cryptoPrices.BTC.toLocaleString()}` : '-'}
                </div>
              </CardContent>
            </Card>
            
            <Card>
              <CardContent className="pt-6">
                <div className="flex items-center gap-2 text-muted-foreground mb-1">
                  <DollarSign className="w-4 h-4" />
                  <span className="text-sm">Ethereum</span>
                </div>
                <div className="text-2xl font-bold text-blue-400">
                  {data.cryptoPrices.ETH ? `$${data.cryptoPrices.ETH.toLocaleString()}` : '-'}
                </div>
              </CardContent>
            </Card>
            
            <Card>
              <CardContent className="pt-6">
                <div className="flex items-center gap-2 text-muted-foreground mb-1">
                  <Zap className="w-4 h-4" />
                  <span className="text-sm">High Confidence</span>
                </div>
                <div className="text-2xl font-bold text-emerald-400">
                  {data.summary.highConfidenceCount}
                </div>
              </CardContent>
            </Card>
            
            <Card>
              <CardContent className="pt-6">
                <div className="flex items-center gap-2 text-muted-foreground mb-1">
                  <Target className="w-4 h-4" />
                  <span className="text-sm">Arbitrage Ops</span>
                </div>
                <div className="text-2xl font-bold text-primary">
                  {data.summary.arbitrageOpportunityCount}
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Signal Cards */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="text-lg">Active Signals ({data.signals.length})</CardTitle>
                {lastUpdate && (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Clock className="w-4 h-4" />
                    {lastUpdate.toLocaleTimeString()}
                  </div>
                )}
              </div>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {data.signals.slice(0, 10).map((signal, index) => (
                  <div
                    key={index}
                    className={`p-4 rounded-lg border ${
                      signal.confidence === 'high' 
                        ? 'border-emerald-500/30 bg-emerald-500/5' 
                        : signal.confidence === 'medium'
                        ? 'border-yellow-500/30 bg-yellow-500/5'
                        : 'border-border bg-muted/5'
                    }`}
                  >
                    <div className="flex items-start justify-between mb-3">
                      <div className="flex-1">
                        <div className="font-medium text-sm line-clamp-1 mb-2">
                          {signal.market}
                        </div>
                        <div className="flex items-center gap-2">
                          {getConfidenceBadge(signal.confidence)}
                          {getSignalTypeBadge(signal.signalType)}
                        </div>
                      </div>
                    </div>
                    
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                      {/* Price to Beat */}
                      <div>
                        <div className="text-muted-foreground mb-1">Price to Beat</div>
                        <div className="font-mono font-medium">
                          {signal.priceToBeat ? `$${signal.priceToBeat.toLocaleString()}` : '-'}
                        </div>
                      </div>
                      
                      {/* Current Price */}
                      <div>
                        <div className="text-muted-foreground mb-1">Current Price</div>
                        <div className="font-mono font-medium">
                          {signal.currentPrice ? `$${signal.currentPrice.toLocaleString()}` : '-'}
                        </div>
                      </div>
                      
                      {/* Delta */}
                      <div>
                        <div className="text-muted-foreground mb-1">Delta</div>
                        <div className={`font-mono font-medium ${
                          signal.priceDelta !== null 
                            ? signal.priceDelta >= 0 ? 'text-emerald-400' : 'text-red-400'
                            : ''
                        }`}>
                          {formatDelta(signal.priceDelta, signal.priceDeltaPercent)}
                        </div>
                      </div>
                      
                      {/* Cheaper Side */}
                      <div>
                        <div className="text-muted-foreground mb-1">Underpriced</div>
                        <div className="flex items-center gap-2">
                          {signal.cheaperSide === 'Up' ? (
                            <TrendingUp className="w-4 h-4 text-emerald-400" />
                          ) : (
                            <TrendingDown className="w-4 h-4 text-red-400" />
                          )}
                          <span className="font-mono">
                            {signal.cheaperSide} @ {(signal.cheaperPrice * 100).toFixed(1)}¢
                          </span>
                        </div>
                      </div>
                    </div>
                    
                    {/* Bottom row with prices */}
                    <div className="grid grid-cols-4 gap-4 mt-3 pt-3 border-t border-border/50 text-xs">
                      <div>
                        <span className="text-muted-foreground">Up: </span>
                        <span className="font-mono text-emerald-400">{(signal.upPrice * 100).toFixed(1)}¢</span>
                      </div>
                      <div>
                        <span className="text-muted-foreground">Down: </span>
                        <span className="font-mono text-red-400">{(signal.downPrice * 100).toFixed(1)}¢</span>
                      </div>
                      <div>
                        <span className="text-muted-foreground">Combined: </span>
                        <span className={`font-mono ${signal.combinedPrice < 1 ? 'text-emerald-400' : 'text-muted-foreground'}`}>
                          {(signal.combinedPrice * 100).toFixed(1)}¢
                        </span>
                      </div>
                      <div>
                        <span className="text-muted-foreground">Edge: </span>
                        <span className={`font-mono ${signal.arbitrageEdge > 0 ? 'text-primary' : 'text-muted-foreground'}`}>
                          {signal.arbitrageEdge.toFixed(1)}%
                        </span>
                      </div>
                    </div>
                  </div>
                ))}
                
                {data.signals.length === 0 && (
                  <div className="text-center py-8 text-muted-foreground">
                    No active crypto markets found
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

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
                  dicht bij de <span className="text-purple-400 font-medium">Price to Beat</span> ligt. 
                  Dit creëert maximale onzekerheid, waardoor beide kanten (Up/Down) goedkoop zijn.
                </p>
              </div>
              
              <div className="grid grid-cols-3 gap-4">
                <div className="p-3 bg-emerald-500/10 rounded-lg border border-emerald-500/20 text-center">
                  <div className="text-2xl font-bold text-emerald-400">
                    {data.signals.filter(s => s.confidence === 'high').length}
                  </div>
                  <div className="text-xs text-muted-foreground">High Uncertainty</div>
                  <div className="text-xs text-emerald-400">Delta &lt; 0.05%</div>
                </div>
                
                <div className="p-3 bg-yellow-500/10 rounded-lg border border-yellow-500/20 text-center">
                  <div className="text-2xl font-bold text-yellow-400">
                    {data.signals.filter(s => s.confidence === 'medium').length}
                  </div>
                  <div className="text-xs text-muted-foreground">Near Strike</div>
                  <div className="text-xs text-yellow-400">Delta &lt; 0.2%</div>
                </div>
                
                <div className="p-3 bg-muted/50 rounded-lg border border-border text-center">
                  <div className="text-2xl font-bold text-muted-foreground">
                    {data.signals.filter(s => s.confidence === 'low').length}
                  </div>
                  <div className="text-xs text-muted-foreground">Directional</div>
                  <div className="text-xs text-muted-foreground">Delta &gt; 0.2%</div>
                </div>
              </div>
              
              <div className="text-sm text-muted-foreground">
                <strong>Volgende stap:</strong> Valideer of Gabagool's historische trades correleren met 
                kleine price delta's op moment van aankoop.
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
