import { useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { 
  RefreshCw, 
  TrendingUp, 
  TrendingDown, 
  Wifi, 
  WifiOff,
  Activity,
  Zap
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useRealtimePrices } from '@/hooks/useRealtimePrices';
import { useClobOrderbook } from '@/hooks/useClobOrderbook';
import { usePolymarketRealtime } from '@/hooks/usePolymarketRealtime';

interface RealtimePriceMonitorProps {
  className?: string;
}

export function RealtimePriceMonitor({ className }: RealtimePriceMonitorProps) {
  // Binance spot prices
  const { 
    spotPrices, 
    binanceConnected,
    messageCount: binanceMessageCount,
    lastUpdate: binanceLastUpdate,
    getSpotPrice,
    getDelta,
    reconnect: reconnectBinance
  } = useRealtimePrices(true);

  // CLOB orderbook data
  const {
    orderbooks,
    connected: clobConnected,
    messageCount: clobMessageCount,
    lastUpdate: clobLastUpdate,
    reconnect: reconnectClob
  } = useClobOrderbook(true);

  // Market metadata (for strike prices)
  const { markets } = usePolymarketRealtime(true);

  const assets = ['BTC', 'ETH', 'SOL', 'XRP'];

  const totalMessageCount = binanceMessageCount + clobMessageCount;
  const lastUpdate = Math.max(binanceLastUpdate, clobLastUpdate);

  const timeSinceUpdate = useMemo(() => {
    const diff = Date.now() - lastUpdate;
    if (diff < 1000) return 'just now';
    if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
    return `${Math.floor(diff / 60000)}m ago`;
  }, [lastUpdate, totalMessageCount]);

  const formatSpotPrice = (asset: string): string => {
    const price = getSpotPrice(asset);
    if (price === null) return '—';
    
    if (asset === 'XRP') {
      return `$${price.toFixed(4)}`;
    }
    return `$${price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };

  const formatCents = (price: number | null | undefined): string => {
    if (price === null || price === undefined) return '—';
    return `${(price * 100).toFixed(1)}¢`;
  };

  // Calculate combined ask and edge for each asset
  const getMarketData = (asset: string) => {
    const ob = orderbooks.get(asset);
    if (!ob) return null;

    const upAsk = ob.up.ask;
    const downAsk = ob.down.ask;
    const upBid = ob.up.bid;
    const downBid = ob.down.bid;

    const combined = upAsk !== null && downAsk !== null ? upAsk + downAsk : null;
    const edge = combined !== null ? (1 - combined) * 100 : null;

    return {
      upBid,
      upAsk,
      downBid,
      downAsk,
      combined,
      edge,
      lastUpdate: Math.max(ob.up.timestamp, ob.down.timestamp),
      isRealBook: ob.up.isRealBook && ob.down.isRealBook,
    };
  };

  // Find active markets per asset for strike prices
  const getStrikePrice = (asset: string): number | null => {
    const market = markets.find(m => m.asset === asset);
    return market?.strikePrice ?? null;
  };

  const handleReconnect = () => {
    reconnectBinance();
    reconnectClob();
  };

  return (
    <Card className={cn('glass', className)}>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-lg flex items-center gap-2">
          <Zap className="h-5 w-5 text-yellow-400" />
          Real-Time Price Monitor
          <Badge variant="outline" className="text-xs">
            {totalMessageCount} ticks
          </Badge>
        </CardTitle>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1">
            <Badge 
              variant="outline" 
              className={cn(
                'text-xs',
                binanceConnected 
                  ? 'bg-green-500/10 text-green-400 border-green-500/20' 
                  : 'bg-red-500/10 text-red-400 border-red-500/20'
              )}
            >
              {binanceConnected ? <Wifi className="h-3 w-3 mr-1" /> : <WifiOff className="h-3 w-3 mr-1" />}
              Binance
            </Badge>
            <Badge 
              variant="outline" 
              className={cn(
                'text-xs',
                clobConnected 
                  ? 'bg-green-500/10 text-green-400 border-green-500/20' 
                  : 'bg-red-500/10 text-red-400 border-red-500/20'
              )}
            >
              {clobConnected ? <Wifi className="h-3 w-3 mr-1" /> : <WifiOff className="h-3 w-3 mr-1" />}
              CLOB
            </Badge>
          </div>
          <span className="text-xs text-muted-foreground">{timeSinceUpdate}</span>
          <Button variant="ghost" size="sm" onClick={handleReconnect}>
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Spot Prices Bar */}
        <div className="flex items-center gap-4 p-3 bg-muted/30 rounded-lg">
          <Activity className="h-4 w-4 text-muted-foreground" />
          <span className="text-xs font-medium text-muted-foreground">SPOT:</span>
          {assets.map(asset => {
            const spot = spotPrices.get(asset);
            const age = spot ? Date.now() - spot.timestamp : Infinity;
            const isStale = age > 5000;
            
            return (
              <div key={asset} className="flex items-center gap-1">
                <span className="text-xs font-medium">{asset}:</span>
                <span className={cn(
                  'font-mono text-sm',
                  isStale ? 'text-muted-foreground' : 'text-foreground'
                )}>
                  {formatSpotPrice(asset)}
                </span>
                {!isStale && (
                  <span className="h-2 w-2 rounded-full bg-green-400 animate-pulse" />
                )}
              </div>
            );
          })}
        </div>

        {/* Per-Asset Details */}
        <ScrollArea className="h-[350px]">
          <div className="space-y-3">
            {assets.map(asset => {
              const spot = getSpotPrice(asset);
              const strike = getStrikePrice(asset);
              const delta = strike !== null ? getDelta(asset, strike) : null;
              const marketData = getMarketData(asset);

              return (
                <div key={asset} className="glass rounded-lg p-4 space-y-3">
                  {/* Header Row */}
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <span className="text-lg font-bold">{asset}</span>
                      <span className={cn(
                        'font-mono text-xl font-bold',
                        spot !== null ? 'text-foreground' : 'text-muted-foreground'
                      )}>
                        {formatSpotPrice(asset)}
                      </span>
                      {spot !== null && (
                        <span className="h-2 w-2 rounded-full bg-green-400 animate-pulse" />
                      )}
                    </div>
                    {delta && (
                      <Badge 
                        variant="outline" 
                        className={cn(
                          'text-sm',
                          delta.side === 'UP' 
                            ? 'bg-green-500/10 text-green-400 border-green-500/20' 
                            : 'bg-red-500/10 text-red-400 border-red-500/20'
                        )}
                      >
                        {delta.side === 'UP' ? <TrendingUp className="h-4 w-4 mr-1" /> : <TrendingDown className="h-4 w-4 mr-1" />}
                        {delta.side} ${Math.abs(delta.delta).toFixed(2)}
                      </Badge>
                    )}
                  </div>

                  {/* Strike Price */}
                  {strike !== null && (
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">Strike Price:</span>
                      <span className="font-mono">${strike.toLocaleString(undefined, { 
                        minimumFractionDigits: 2,
                        maximumFractionDigits: asset === 'XRP' ? 4 : 2 
                      })}</span>
                    </div>
                  )}

                  {/* Orderbook Grid */}
                  {marketData && (
                    <div className="grid grid-cols-2 gap-4">
                      {/* UP Side */}
                      <div className="space-y-1">
                        <div className="flex items-center gap-1 text-green-400 font-medium text-sm">
                          <TrendingUp className="h-4 w-4" />
                          UP
                          {marketData.isRealBook && (
                            <span className="h-1.5 w-1.5 rounded-full bg-green-400" title="Real book data" />
                          )}
                        </div>
                        <div className="grid grid-cols-2 gap-1 text-xs">
                          <span className="text-muted-foreground">Bid:</span>
                          <span className="font-mono">{formatCents(marketData.upBid)}</span>
                          <span className="text-muted-foreground">Ask:</span>
                          <span className="font-mono">{formatCents(marketData.upAsk)}</span>
                        </div>
                      </div>
                      
                      {/* DOWN Side */}
                      <div className="space-y-1">
                        <div className="flex items-center gap-1 text-red-400 font-medium text-sm">
                          <TrendingDown className="h-4 w-4" />
                          DOWN
                          {marketData.isRealBook && (
                            <span className="h-1.5 w-1.5 rounded-full bg-green-400" title="Real book data" />
                          )}
                        </div>
                        <div className="grid grid-cols-2 gap-1 text-xs">
                          <span className="text-muted-foreground">Bid:</span>
                          <span className="font-mono">{formatCents(marketData.downBid)}</span>
                          <span className="text-muted-foreground">Ask:</span>
                          <span className="font-mono">{formatCents(marketData.downAsk)}</span>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Combined Edge */}
                  {marketData && marketData.combined !== null && marketData.edge !== null && (
                    <div className="flex items-center justify-between text-sm pt-2 border-t border-border/50">
                      <span className="text-muted-foreground">Combined / Edge:</span>
                      <span className={cn(
                        'font-mono font-medium',
                        marketData.edge > 0 ? 'text-green-400' : 'text-muted-foreground'
                      )}>
                        {formatCents(marketData.combined)} / {marketData.edge.toFixed(2)}%
                      </span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </ScrollArea>

        {/* Connection Info */}
        <div className="text-xs text-muted-foreground text-center">
          WebSocket feeds: Binance trades + Polymarket CLOB orderbooks
        </div>
      </CardContent>
    </Card>
  );
}
