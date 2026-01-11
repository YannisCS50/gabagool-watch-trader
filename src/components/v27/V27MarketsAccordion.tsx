import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { 
  Accordion, 
  AccordionContent, 
  AccordionItem, 
  AccordionTrigger 
} from '@/components/ui/accordion';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { TrendingUp, TrendingDown, Activity, Clock, AlertCircle, RefreshCw, Target } from 'lucide-react';
import { format, formatDistanceToNow } from 'date-fns';
import { nl } from 'date-fns/locale';

interface LiveMarket {
  id: string;
  slug: string;
  asset: string;
  strikePrice: number;
  eventEndTime: string;
  upTokenId: string;
  downTokenId: string;
  upMid?: number;
  downMid?: number;
}

interface MarketEvaluation {
  id: string;
  created_at: string;
  asset: string;
  market_id: string;
  action: string;
  skip_reason: string | null;
  signal_valid: boolean;
  spot_price: number | null;
  mispricing_magnitude: number | null;
  mispricing_side: string | null;
  delta_up: number | null;
  delta_down: number | null;
}

export function V27MarketsAccordion() {
  const [liveMarkets, setLiveMarkets] = useState<LiveMarket[]>([]);
  const [spotPrices, setSpotPrices] = useState<Record<string, number>>({});
  const [evaluationsByMarket, setEvaluationsByMarket] = useState<Record<string, MarketEvaluation[]>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchLiveMarkets = useCallback(async () => {
    try {
      const { data, error: fetchError } = await supabase.functions.invoke('clob-prices', {
        body: { assets: ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE'] }
      });

      if (fetchError) {
        console.error('Failed to fetch markets:', fetchError);
        setError('Failed to load markets from API');
        return;
      }

      if (data?.markets) {
        const now = Date.now();
        const activeMarkets = data.markets
          .filter((m: LiveMarket) => new Date(m.eventEndTime).getTime() > now)
          .sort((a: LiveMarket, b: LiveMarket) => 
            new Date(a.eventEndTime).getTime() - new Date(b.eventEndTime).getTime()
          );
        
        setLiveMarkets(activeMarkets);
        setSpotPrices(data.spotPrices || {});
        setError(null);
      }
    } catch (err) {
      console.error('Error fetching markets:', err);
      setError('Failed to load markets');
    }
  }, []);

  const fetchEvaluations = useCallback(async () => {
    try {
      const { data, error: evalError } = await supabase
        .from('v27_evaluations')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(500);

      if (evalError) {
        console.warn('Failed to fetch evaluations:', evalError);
        return;
      }

      // Group by market_id
      const grouped: Record<string, MarketEvaluation[]> = {};
      for (const row of data || []) {
        const marketId = row.market_id;
        if (!grouped[marketId]) {
          grouped[marketId] = [];
        }
        grouped[marketId].push({
          id: row.id,
          created_at: row.created_at,
          asset: row.asset,
          market_id: row.market_id,
          action: row.action || 'SKIP',
          skip_reason: row.skip_reason || row.adverse_reason,
          signal_valid: row.signal_valid ?? false,
          spot_price: row.spot_price,
          mispricing_magnitude: row.mispricing_magnitude,
          mispricing_side: row.mispricing_side,
          delta_up: row.delta_up,
          delta_down: row.delta_down,
        });
      }
      setEvaluationsByMarket(grouped);
    } catch (err) {
      console.error('Error fetching evaluations:', err);
    }
  }, []);

  const loadData = useCallback(async () => {
    await Promise.all([fetchLiveMarkets(), fetchEvaluations()]);
    setLoading(false);
  }, [fetchLiveMarkets, fetchEvaluations]);

  const handleRefresh = async () => {
    setRefreshing(true);
    await loadData();
    setRefreshing(false);
  };

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 30000);
    return () => clearInterval(interval);
  }, [loadData]);

  // Realtime subscription for new evaluations
  useEffect(() => {
    const channel = supabase
      .channel('v27_markets_evals_realtime')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'v27_evaluations' },
        (payload) => {
          const newEval = payload.new as any;
          setEvaluationsByMarket(prev => {
            const marketId = newEval.market_id;
            const existing = prev[marketId] || [];
            return {
              ...prev,
              [marketId]: [{
                id: newEval.id,
                created_at: newEval.created_at,
                asset: newEval.asset,
                market_id: newEval.market_id,
                action: newEval.action || 'SKIP',
                skip_reason: newEval.skip_reason || newEval.adverse_reason,
                signal_valid: newEval.signal_valid ?? false,
                spot_price: newEval.spot_price,
                strike_price: newEval.strike_price,
                delta_abs: newEval.delta_abs,
                delta_pct: newEval.delta_pct,
              }, ...existing.slice(0, 49)]
            };
          });
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  const getTimeRemaining = (endTime: string) => {
    const end = new Date(endTime);
    const now = new Date();
    const diff = end.getTime() - now.getTime();
    
    if (diff <= 0) return 'Ended';
    
    const hours = Math.floor(diff / (1000 * 60 * 60));
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
  };

  const getActionBadge = (action: string) => {
    switch (action) {
      case 'ENTER':
        return <Badge className="bg-green-500/20 text-green-400 border-green-500/30 text-xs">ENTER</Badge>;
      case 'SHADOW_ENTRY':
        return <Badge className="bg-blue-500/20 text-blue-400 border-blue-500/30 text-xs">SHADOW</Badge>;
      default:
        return <Badge variant="secondary" className="text-xs">SKIP</Badge>;
    }
  };

  if (loading) {
    return (
      <Card className="bg-card/50 backdrop-blur border-border/50">
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Activity className="h-5 w-5 text-primary" />
            Active Markets
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </CardContent>
      </Card>
    );
  }

  if (error && liveMarkets.length === 0) {
    return (
      <Card className="bg-card/50 backdrop-blur border-border/50">
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2 text-destructive">
            <AlertCircle className="h-5 w-5" />
            Error Loading Markets
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground mb-4">{error}</p>
          <Button onClick={handleRefresh} variant="outline">
            <RefreshCw className="h-4 w-4 mr-2" />
            Retry
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="bg-card/50 backdrop-blur border-border/50">
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-lg flex items-center gap-2">
          <Activity className="h-5 w-5 text-primary" />
          Active Markets ({liveMarkets.length})
        </CardTitle>
        <Button 
          variant="ghost" 
          size="sm" 
          onClick={handleRefresh}
          disabled={refreshing}
        >
          <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
        </Button>
      </CardHeader>
      <CardContent className="pt-0">
        {liveMarkets.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            <Target className="h-12 w-12 mx-auto mb-4 opacity-50" />
            <p>No active markets found</p>
            <p className="text-sm mt-1">Markets will appear when available on Polymarket</p>
          </div>
        ) : (
          <Accordion type="multiple" className="space-y-2">
            {liveMarkets.map((market) => {
              const evals = evaluationsByMarket[market.id] || [];
              const entryCount = evals.filter(e => e.action === 'ENTER' || e.action === 'SHADOW_ENTRY').length;
              const skipCount = evals.filter(e => e.action === 'SKIP').length;
              const spotPrice = spotPrices[market.asset] || 0;
              
              // Calculate spot vs strike
              const spotVsStrike = spotPrice && market.strikePrice
                ? ((spotPrice - market.strikePrice) / market.strikePrice * 100)
                : null;

              return (
                <AccordionItem 
                  key={market.id} 
                  value={market.id}
                  className="border border-border/50 rounded-lg px-4 bg-background/50"
                >
                  <AccordionTrigger className="hover:no-underline py-3">
                    <div className="flex items-center justify-between w-full pr-4">
                      <div className="flex items-center gap-3">
                        <Badge variant="outline" className="font-mono font-bold">
                          {market.asset}
                        </Badge>
                        <div className="text-left">
                          <div className="font-medium text-sm">
                            Strike: ${market.strikePrice.toLocaleString()}
                          </div>
                          <div className="text-xs text-muted-foreground flex items-center gap-2">
                            <Clock className="h-3 w-3" />
                            {getTimeRemaining(market.eventEndTime)}
                            {spotPrice > 0 && (
                              <span className="ml-2">
                                Spot: ${spotPrice.toLocaleString()}
                                {spotVsStrike !== null && (
                                  <span className={spotVsStrike >= 0 ? 'text-green-400 ml-1' : 'text-red-400 ml-1'}>
                                    ({spotVsStrike >= 0 ? '+' : ''}{spotVsStrike.toFixed(2)}%)
                                  </span>
                                )}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                      
                      <div className="flex items-center gap-3">
                        {/* Implied probabilities */}
                        <div className="flex gap-2 text-xs">
                          <span className="flex items-center gap-1 text-green-400">
                            <TrendingUp className="h-3 w-3" />
                            {market.upMid ? `${(market.upMid * 100).toFixed(1)}%` : '?'}
                          </span>
                          <span className="flex items-center gap-1 text-red-400">
                            <TrendingDown className="h-3 w-3" />
                            {market.downMid ? `${(market.downMid * 100).toFixed(1)}%` : '?'}
                          </span>
                        </div>
                        
                        {/* Evaluation counts */}
                        {evals.length > 0 ? (
                          <div className="flex gap-2">
                            {entryCount > 0 && (
                              <Badge className="bg-green-500/20 text-green-400 text-xs">
                                {entryCount} entries
                              </Badge>
                            )}
                            <Badge variant="secondary" className="text-xs">
                              {evals.length} evals
                            </Badge>
                          </div>
                        ) : (
                          <Badge variant="outline" className="text-xs text-muted-foreground">
                            No evals yet
                          </Badge>
                        )}
                      </div>
                    </div>
                  </AccordionTrigger>
                  
                  <AccordionContent>
                    <div className="space-y-4 pt-2">
                      {/* Market Details */}
                      <div className="grid grid-cols-2 gap-4 text-xs bg-muted/30 rounded-lg p-3">
                        <div>
                          <div className="text-muted-foreground">Market ID</div>
                          <div className="font-mono truncate">{market.id}</div>
                        </div>
                        <div>
                          <div className="text-muted-foreground">Slug</div>
                          <div className="font-mono">{market.slug}</div>
                        </div>
                        <div>
                          <div className="text-muted-foreground">Up Token</div>
                          <div className="font-mono truncate">{market.upTokenId}</div>
                        </div>
                        <div>
                          <div className="text-muted-foreground">Down Token</div>
                          <div className="font-mono truncate">{market.downTokenId}</div>
                        </div>
                      </div>
                      
                      {/* Evaluations Log */}
                      <div>
                        <div className="text-sm font-medium mb-2 flex items-center gap-2">
                          <Activity className="h-4 w-4" />
                          Evaluation Log ({evals.length})
                        </div>
                        
                        {evals.length === 0 ? (
                          <div className="text-sm text-muted-foreground bg-muted/20 rounded-lg p-4 text-center">
                            <Clock className="h-8 w-8 mx-auto mb-2 opacity-50" />
                            No evaluations yet. Start the runner to see V27 decisions.
                          </div>
                        ) : (
                          <ScrollArea className="h-[250px]">
                            <div className="space-y-2 pr-4">
                              {evals.slice(0, 30).map((ev) => (
                                <div 
                                  key={ev.id} 
                                  className={`p-3 rounded-lg border text-sm ${
                                    ev.action === 'ENTER' || ev.action === 'SHADOW_ENTRY'
                                      ? 'bg-green-500/10 border-green-500/30'
                                      : 'bg-muted/30 border-border/50'
                                  }`}
                                >
                                  <div className="flex items-center justify-between mb-2">
                                    <div className="flex items-center gap-2">
                                      {getActionBadge(ev.action)}
                                      <span className="text-xs text-muted-foreground">
                                        {format(new Date(ev.created_at), 'HH:mm:ss')}
                                      </span>
                                    </div>
                                    {ev.signal_valid && (
                                      <Badge variant="outline" className="text-green-500 border-green-500/50 text-xs">
                                        Signal Valid
                                      </Badge>
                                    )}
                                  </div>
                                  
                                  <div className="grid grid-cols-3 gap-2 text-xs">
                                    {ev.spot_price && (
                                      <div>
                                        <span className="text-muted-foreground">Spot: </span>
                                        <span className="font-mono">${ev.spot_price.toLocaleString()}</span>
                                      </div>
                                    )}
                                    {ev.mispricing_magnitude !== null && (
                                      <div>
                                        <span className="text-muted-foreground">Mispricing: </span>
                                        <span className="font-mono">{(ev.mispricing_magnitude * 100).toFixed(2)}%</span>
                                      </div>
                                    )}
                                    {ev.mispricing_side && (
                                      <div>
                                        <span className="text-muted-foreground">Side: </span>
                                        <span className={`font-mono ${ev.mispricing_side === 'UP' ? 'text-green-400' : 'text-red-400'}`}>
                                          {ev.mispricing_side}
                                        </span>
                                      </div>
                                    )}
                                  </div>
                                  
                                  {ev.skip_reason && (
                                    <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                                      <AlertCircle className="h-3 w-3" />
                                      <span>{ev.skip_reason}</span>
                                    </div>
                                  )}
                                </div>
                              ))}
                            </div>
                          </ScrollArea>
                        )}
                      </div>
                    </div>
                  </AccordionContent>
                </AccordionItem>
              );
            })}
          </Accordion>
        )}
      </CardContent>
    </Card>
  );
}
