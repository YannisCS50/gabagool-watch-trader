import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { RefreshCw, TrendingUp, TrendingDown, Clock, Target, ExternalLink, Eye } from 'lucide-react';
import { cn } from '@/lib/utils';
import { format, formatDistanceToNow } from 'date-fns';
import { nl } from 'date-fns/locale';

interface ActiveMarket {
  slug: string;
  asset: string;
  question: string;
  strikePrice: number;
  openPrice: number;
  eventStartTime: string;
  eventEndTime: string;
  marketType: string;
  upTokenId: string;
  downTokenId: string;
  conditionId: string;
}

interface HypotheticalPosition {
  marketSlug: string;
  asset: string;
  side: 'UP' | 'DOWN';
  shares: number;
  avgPrice: number;
  entryTime: string;
  strikePrice: number;
}

interface OrderbookSnapshot {
  upBid: number | null;
  upAsk: number | null;
  downBid: number | null;
  downAsk: number | null;
}

export function ActiveMarketsPanel() {
  const [markets, setMarkets] = useState<ActiveMarket[]>([]);
  const [hypotheticalPositions, setHypotheticalPositions] = useState<HypotheticalPosition[]>([]);
  const [orderbooks, setOrderbooks] = useState<Map<string, OrderbookSnapshot>>(new Map());
  const [loading, setLoading] = useState(true);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);

  const fetchMarkets = useCallback(async () => {
    try {
      const { data, error } = await supabase.functions.invoke('get-market-tokens', { 
        body: {} 
      });

      if (error) throw error;

      if (data?.markets) {
        setMarkets(data.markets);
      }
      setLastUpdate(new Date());
    } catch (err) {
      console.error('Error fetching markets:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch orderbook prices from CLOB proxy
  const fetchOrderbooks = useCallback(async () => {
    if (markets.length === 0) return;

    const newOrderbooks = new Map<string, OrderbookSnapshot>();

    for (const market of markets) {
      try {
        const { data: clobData } = await supabase.functions.invoke('clob-prices', {
          body: { tokenId: market.upTokenId }
        });

        if (clobData?.book) {
          const upBook = clobData.book;
          
          // Fetch down book
          const { data: downData } = await supabase.functions.invoke('clob-prices', {
            body: { tokenId: market.downTokenId }
          });

          const downBook = downData?.book;

          newOrderbooks.set(market.slug, {
            upBid: upBook?.bids?.[0]?.price ?? null,
            upAsk: upBook?.asks?.[0]?.price ?? null,
            downBid: downBook?.bids?.[0]?.price ?? null,
            downAsk: downBook?.asks?.[0]?.price ?? null,
          });
        }
      } catch (err) {
        console.error(`Error fetching orderbook for ${market.slug}:`, err);
      }
    }

    setOrderbooks(newOrderbooks);
  }, [markets]);

  // Load existing hypothetical positions from localStorage
  useEffect(() => {
    const stored = localStorage.getItem('hypothetical_positions');
    if (stored) {
      try {
        const parsed = JSON.parse(stored);
        // Filter out expired positions
        const now = new Date();
        const active = parsed.filter((p: HypotheticalPosition) => {
          const market = markets.find(m => m.slug === p.marketSlug);
          return market && new Date(market.eventEndTime) > now;
        });
        setHypotheticalPositions(active);
      } catch (e) {
        console.error('Error parsing stored positions:', e);
      }
    }
  }, [markets]);

  // Save hypothetical positions to localStorage
  useEffect(() => {
    if (hypotheticalPositions.length > 0) {
      localStorage.setItem('hypothetical_positions', JSON.stringify(hypotheticalPositions));
    }
  }, [hypotheticalPositions]);

  // Initial load
  useEffect(() => {
    fetchMarkets();
    const interval = setInterval(fetchMarkets, 30000); // Refresh markets every 30s
    return () => clearInterval(interval);
  }, [fetchMarkets]);

  // Fetch orderbooks when markets change
  useEffect(() => {
    if (markets.length > 0) {
      fetchOrderbooks();
      const interval = setInterval(fetchOrderbooks, 5000); // Refresh orderbooks every 5s
      return () => clearInterval(interval);
    }
  }, [markets, fetchOrderbooks]);

  // Sync with v27_evaluations for hypothetical positions
  useEffect(() => {
    const syncPositions = async () => {
      // Fetch ENTER signals from v27_evaluations as hypothetical positions
      const { data: evaluations, error } = await supabase
        .from('v27_evaluations')
        .select('*')
        .eq('action', 'ENTER')
        .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
        .order('created_at', { ascending: false })
        .limit(50);

      if (error) {
        console.error('Error fetching evaluations:', error);
        return;
      }

      if (!evaluations || evaluations.length === 0) return;

      // Group by market - only keep latest per market
      const latestByMarket = new Map<string, typeof evaluations[0]>();
      for (const ev of evaluations) {
        if (!latestByMarket.has(ev.market_id)) {
          latestByMarket.set(ev.market_id, ev);
        }
      }

      // Convert to hypothetical positions
      const newPositions: HypotheticalPosition[] = [];
      for (const [marketId, ev] of latestByMarket) {
        // Check if market is still active
        const market = markets.find(m => m.slug === marketId);
        if (!market) continue;

        // Skip if already expired
        if (new Date(market.eventEndTime) <= new Date()) continue;

        // Determine side from signal - use mispricing_side directly
        const side = ev.mispricing_side === 'UP' ? 'UP' : 'DOWN';
        
        // Estimate shares based on typical position size ($35)
        const entryPrice = side === 'UP' 
          ? (orderbooks.get(marketId)?.upAsk ?? 0.48)
          : (orderbooks.get(marketId)?.downAsk ?? 0.48);
        const shares = entryPrice > 0 ? 35 / entryPrice : 72;

        newPositions.push({
          marketSlug: marketId,
          asset: ev.asset,
          side,
          shares,
          avgPrice: entryPrice,
          entryTime: ev.created_at,
          strikePrice: market.strikePrice,
        });
      }

      if (newPositions.length > 0) {
        setHypotheticalPositions(prev => {
          // Merge with existing, avoid duplicates
          const existing = new Map(prev.map(p => [p.marketSlug + p.side, p]));
          for (const np of newPositions) {
            if (!existing.has(np.marketSlug + np.side)) {
              existing.set(np.marketSlug + np.side, np);
            }
          }
          return Array.from(existing.values());
        });
      }
    };

    if (markets.length > 0) {
      syncPositions();
      const interval = setInterval(syncPositions, 15000);
      return () => clearInterval(interval);
    }
  }, [markets, orderbooks]);

  const formatPrice = (price: number | null | undefined): string => {
    if (price === null || price === undefined) return '—';
    return `${(price * 100).toFixed(1)}¢`;
  };

  const getTimeRemaining = (endTime: string): string => {
    const end = new Date(endTime);
    const now = new Date();
    const diffMs = end.getTime() - now.getTime();
    
    if (diffMs <= 0) return 'Expired';
    
    const diffSec = Math.floor(diffMs / 1000);
    if (diffSec < 60) return `${diffSec}s`;
    
    const mins = Math.floor(diffSec / 60);
    const secs = diffSec % 60;
    return `${mins}m ${secs}s`;
  };

  const getHypotheticalPnL = (position: HypotheticalPosition): { pnl: number; percent: number } => {
    const book = orderbooks.get(position.marketSlug);
    if (!book) return { pnl: 0, percent: 0 };

    const currentBid = position.side === 'UP' ? book.upBid : book.downBid;
    if (!currentBid) return { pnl: 0, percent: 0 };

    const entryValue = position.shares * position.avgPrice;
    const currentValue = position.shares * currentBid;
    const pnl = currentValue - entryValue;
    const percent = entryValue > 0 ? (pnl / entryValue) * 100 : 0;

    return { pnl, percent };
  };

  const totalHypotheticalPnL = hypotheticalPositions.reduce((sum, p) => {
    return sum + getHypotheticalPnL(p).pnl;
  }, 0);

  return (
    <Card className="glass">
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-lg flex items-center gap-2">
          <Target className="h-5 w-5 text-primary" />
          Active Markets
          <Badge variant="outline" className="ml-2">{markets.length}</Badge>
        </CardTitle>
        <div className="flex items-center gap-2">
          {lastUpdate && (
            <span className="text-xs text-muted-foreground">
              {formatDistanceToNow(lastUpdate, { addSuffix: true })}
            </span>
          )}
          <Button variant="ghost" size="sm" onClick={() => fetchMarkets()} disabled={loading}>
            <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading && markets.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            <RefreshCw className="h-6 w-6 animate-spin mx-auto mb-2" />
            Loading markets...
          </div>
        ) : markets.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            No active markets found.
          </div>
        ) : (
          <>
            {/* Hypothetical Positions Summary */}
            {hypotheticalPositions.length > 0 && (
              <div className="bg-muted/30 rounded-lg p-3 mb-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-medium flex items-center gap-2">
                    <Eye className="h-4 w-4 text-blue-400" />
                    Shadow Positions ({hypotheticalPositions.length})
                  </span>
                  <span className={cn(
                    'font-mono font-bold',
                    totalHypotheticalPnL >= 0 ? 'text-success' : 'text-destructive'
                  )}>
                    {totalHypotheticalPnL >= 0 ? '+' : ''}{totalHypotheticalPnL.toFixed(2)} USDC
                  </span>
                </div>
                <div className="space-y-1">
                  {hypotheticalPositions.map(pos => {
                    const { pnl, percent } = getHypotheticalPnL(pos);
                    return (
                      <div key={pos.marketSlug + pos.side} className="flex items-center justify-between text-xs">
                        <div className="flex items-center gap-2">
                          <Badge variant="outline" className={cn(
                            'text-xs',
                            pos.side === 'UP' ? 'text-success' : 'text-destructive'
                          )}>
                            {pos.side === 'UP' ? <TrendingUp className="h-3 w-3 mr-1" /> : <TrendingDown className="h-3 w-3 mr-1" />}
                            {pos.side}
                          </Badge>
                          <span className="font-medium">{pos.asset}</span>
                          <span className="text-muted-foreground">
                            {pos.shares.toFixed(1)} @ {formatPrice(pos.avgPrice)}
                          </span>
                        </div>
                        <span className={cn(
                          'font-mono',
                          pnl >= 0 ? 'text-success' : 'text-destructive'
                        )}>
                          {pnl >= 0 ? '+' : ''}{pnl.toFixed(2)} ({percent >= 0 ? '+' : ''}{percent.toFixed(1)}%)
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Active Markets Grid */}
            <ScrollArea className="h-[400px]">
              <div className="grid gap-3">
                {markets.map(market => {
                  const book = orderbooks.get(market.slug);
                  const timeRemaining = getTimeRemaining(market.eventEndTime);
                  const isExpiringSoon = timeRemaining.includes('s') && !timeRemaining.includes('m');
                  const hasPosition = hypotheticalPositions.some(p => p.marketSlug === market.slug);

                  return (
                    <div 
                      key={market.slug} 
                      className={cn(
                        'glass rounded-lg p-3 space-y-2',
                        hasPosition && 'ring-1 ring-blue-500/30'
                      )}
                    >
                      {/* Header */}
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-sm">{market.asset}</span>
                          <Badge variant="outline" className="text-xs">{market.marketType}</Badge>
                          {hasPosition && (
                            <Badge variant="outline" className="text-xs bg-blue-500/10 text-blue-400">
                              <Eye className="h-3 w-3 mr-1" />
                              Tracking
                            </Badge>
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          <Badge 
                            variant="outline" 
                            className={cn(
                              'text-xs',
                              isExpiringSoon ? 'bg-red-500/10 text-red-400 border-red-500/20' : ''
                            )}
                          >
                            <Clock className="h-3 w-3 mr-1" />
                            {timeRemaining}
                          </Badge>
                          <a 
                            href={`https://polymarket.com/event/${market.slug}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-muted-foreground hover:text-primary"
                          >
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        </div>
                      </div>

                      {/* Strike Price */}
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-muted-foreground">Strike Price:</span>
                        <span className="font-mono font-medium">
                          ${market.strikePrice.toLocaleString(undefined, { 
                            minimumFractionDigits: 2,
                            maximumFractionDigits: market.asset === 'XRP' ? 4 : 2 
                          })}
                        </span>
                      </div>

                      {/* Orderbook Prices */}
                      <div className="grid grid-cols-2 gap-3 text-xs">
                        <div className="space-y-1">
                          <div className="flex items-center gap-1 text-success font-medium">
                            <TrendingUp className="h-3 w-3" />
                            UP
                          </div>
                          <div className="grid grid-cols-2 gap-1 text-muted-foreground">
                            <span>Bid:</span>
                            <span className="font-mono text-foreground">{formatPrice(book?.upBid)}</span>
                            <span>Ask:</span>
                            <span className="font-mono text-foreground">{formatPrice(book?.upAsk)}</span>
                          </div>
                        </div>
                        <div className="space-y-1">
                          <div className="flex items-center gap-1 text-destructive font-medium">
                            <TrendingDown className="h-3 w-3" />
                            DOWN
                          </div>
                          <div className="grid grid-cols-2 gap-1 text-muted-foreground">
                            <span>Bid:</span>
                            <span className="font-mono text-foreground">{formatPrice(book?.downBid)}</span>
                            <span>Ask:</span>
                            <span className="font-mono text-foreground">{formatPrice(book?.downAsk)}</span>
                          </div>
                        </div>
                      </div>

                      {/* Combined Edge */}
                      {book?.upAsk && book?.downAsk && (
                        <div className="flex items-center justify-between text-xs pt-2 border-t border-border/50">
                          <span className="text-muted-foreground">Combined Ask / Edge:</span>
                          <span className={cn(
                            'font-mono font-medium',
                            (book.upAsk + book.downAsk) < 1 ? 'text-success' : 'text-muted-foreground'
                          )}>
                            {formatPrice(book.upAsk + book.downAsk)} / 
                            {((1 - (book.upAsk + book.downAsk)) * 100).toFixed(2)}%
                          </span>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </ScrollArea>
          </>
        )}
      </CardContent>
    </Card>
  );
}
