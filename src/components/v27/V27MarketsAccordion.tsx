import { useState, useEffect } from 'react';
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
import { TrendingUp, TrendingDown, Activity, Clock, AlertCircle } from 'lucide-react';
import { format, formatDistanceToNow } from 'date-fns';
import { nl } from 'date-fns/locale';

interface MarketEvaluation {
  id: string;
  created_at: string;
  asset: string;
  market_id: string;
  action: string;
  skip_reason: string | null;
  signal_valid: boolean;
  mispricing_bps: number | null;
  spot_price: number | null;
  poly_mid: number | null;
  delta_bps: number | null;
}

interface MarketData {
  asset: string;
  market_id: string;
  evaluations: MarketEvaluation[];
  lastEval: string | null;
  evalCount: number;
  skipCount: number;
  entryCount: number;
}

export function V27MarketsAccordion() {
  const [markets, setMarkets] = useState<MarketData[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchMarkets() {
      try {
        // Fetch recent evaluations grouped by market
        const { data: evaluations, error } = await supabase
          .from('v27_evaluations')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(500);

        if (error) throw error;

        // Group by market_id
        const marketMap = new Map<string, MarketData>();

        (evaluations || []).forEach((eval_: any) => {
          const marketId = eval_.market_id || 'unknown';
          const existing = marketMap.get(marketId);

          const evaluation: MarketEvaluation = {
            id: eval_.id,
            created_at: eval_.created_at,
            asset: eval_.asset || 'UNKNOWN',
            market_id: marketId,
            action: eval_.action || 'SKIP',
            skip_reason: eval_.skip_reason || eval_.adverse_reason,
            signal_valid: eval_.signal_valid ?? false,
            mispricing_bps: eval_.mispricing_bps ?? null,
            spot_price: eval_.spot_price ?? null,
            poly_mid: eval_.poly_mid ?? null,
            delta_bps: eval_.delta_bps ?? null,
          };

          if (existing) {
            existing.evaluations.push(evaluation);
            existing.evalCount++;
            if (evaluation.action === 'SKIP') existing.skipCount++;
            if (evaluation.action === 'ENTRY' || evaluation.action === 'SHADOW_ENTRY') existing.entryCount++;
          } else {
            marketMap.set(marketId, {
              asset: evaluation.asset,
              market_id: marketId,
              evaluations: [evaluation],
              lastEval: evaluation.created_at,
              evalCount: 1,
              skipCount: evaluation.action === 'SKIP' ? 1 : 0,
              entryCount: (evaluation.action === 'ENTRY' || evaluation.action === 'SHADOW_ENTRY') ? 1 : 0,
            });
          }
        });

        setMarkets(Array.from(marketMap.values()));
      } catch (err) {
        console.error('Error fetching markets:', err);
      } finally {
        setLoading(false);
      }
    }

    fetchMarkets();
    const interval = setInterval(fetchMarkets, 15000);
    return () => clearInterval(interval);
  }, []);

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Activity className="h-5 w-5" />
            Markets
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-sm text-muted-foreground text-center py-8">
            Loading markets...
          </div>
        </CardContent>
      </Card>
    );
  }

  if (markets.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Activity className="h-5 w-5" />
            Markets
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-sm text-muted-foreground text-center py-8">
            No market evaluations yet. Runner needs to be online and evaluating markets.
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg flex items-center gap-2">
          <Activity className="h-5 w-5" />
          Markets ({markets.length})
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <Accordion type="multiple" className="w-full">
          {markets.map((market) => (
            <AccordionItem key={market.market_id} value={market.market_id} className="border-b-0">
              <AccordionTrigger className="px-4 hover:no-underline hover:bg-muted/30">
                <div className="flex items-center justify-between w-full pr-4">
                  <div className="flex items-center gap-3">
                    <Badge variant="outline" className="font-mono">
                      {market.asset}
                    </Badge>
                    <span className="text-sm text-muted-foreground truncate max-w-[200px]">
                      {market.market_id.substring(0, 12)}...
                    </span>
                  </div>
                  <div className="flex items-center gap-4">
                    <Badge variant="secondary" className="text-xs">
                      {market.evalCount} evals
                    </Badge>
                    {market.entryCount > 0 && (
                      <Badge className="bg-green-500 text-xs">
                        {market.entryCount} entries
                      </Badge>
                    )}
                    {market.skipCount > 0 && (
                      <Badge variant="outline" className="text-xs text-muted-foreground">
                        {market.skipCount} skips
                      </Badge>
                    )}
                    {market.lastEval && (
                      <span className="text-xs text-muted-foreground">
                        {formatDistanceToNow(new Date(market.lastEval), { addSuffix: true, locale: nl })}
                      </span>
                    )}
                  </div>
                </div>
              </AccordionTrigger>
              <AccordionContent>
                <ScrollArea className="h-[300px]">
                  <div className="px-4 space-y-2 pb-4">
                    {market.evaluations.slice(0, 50).map((eval_) => (
                      <div
                        key={eval_.id}
                        className={`p-3 rounded-lg border text-sm ${
                          eval_.action === 'ENTRY' || eval_.action === 'SHADOW_ENTRY'
                            ? 'bg-green-500/10 border-green-500/30'
                            : 'bg-muted/30 border-border'
                        }`}
                      >
                        <div className="flex items-center justify-between mb-2">
                          <div className="flex items-center gap-2">
                            <Clock className="h-3 w-3 text-muted-foreground" />
                            <span className="text-xs text-muted-foreground">
                              {format(new Date(eval_.created_at), 'HH:mm:ss.SSS')}
                            </span>
                            <Badge
                              variant={eval_.action === 'ENTRY' || eval_.action === 'SHADOW_ENTRY' ? 'default' : 'secondary'}
                              className="text-xs"
                            >
                              {eval_.action}
                            </Badge>
                          </div>
                          {eval_.signal_valid && (
                            <Badge variant="outline" className="text-green-500 border-green-500 text-xs">
                              Signal Valid
                            </Badge>
                          )}
                        </div>

                        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
                          {eval_.spot_price && (
                            <div>
                              <span className="text-muted-foreground">Spot: </span>
                              <span className="font-mono">${eval_.spot_price.toFixed(2)}</span>
                            </div>
                          )}
                          {eval_.poly_mid && (
                            <div>
                              <span className="text-muted-foreground">Poly Mid: </span>
                              <span className="font-mono">{(eval_.poly_mid * 100).toFixed(2)}%</span>
                            </div>
                          )}
                          {eval_.mispricing_bps !== null && (
                            <div className="flex items-center gap-1">
                              <span className="text-muted-foreground">Mispricing: </span>
                              <span className={`font-mono ${Math.abs(eval_.mispricing_bps) > 50 ? 'text-amber-500' : ''}`}>
                                {eval_.mispricing_bps.toFixed(1)} bps
                              </span>
                            </div>
                          )}
                          {eval_.delta_bps !== null && (
                            <div className="flex items-center gap-1">
                              {eval_.delta_bps >= 0 ? (
                                <TrendingUp className="h-3 w-3 text-green-500" />
                              ) : (
                                <TrendingDown className="h-3 w-3 text-red-500" />
                              )}
                              <span className="font-mono">
                                {eval_.delta_bps >= 0 ? '+' : ''}{eval_.delta_bps.toFixed(1)} bps
                              </span>
                            </div>
                          )}
                        </div>

                        {eval_.skip_reason && (
                          <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                            <AlertCircle className="h-3 w-3" />
                            <span>{eval_.skip_reason}</span>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </CardContent>
    </Card>
  );
}
