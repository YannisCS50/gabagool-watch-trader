import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { RefreshCw, ExternalLink, TrendingUp, TrendingDown, Activity } from 'lucide-react';
import { useTrackedWallet, TrackedTrade } from '@/hooks/useTrackedWallet';
import { formatDistanceToNow } from 'date-fns';

const DEFAULT_WALLET = '0xa20b482f97063f4f88ef621c9203e60814399940';

function TradeRow({ trade }: { trade: TrackedTrade }) {
  const isBuy = trade.side === 'BUY';
  const notional = trade.size * trade.price;
  
  return (
    <div className="flex items-center justify-between p-3 rounded-lg bg-muted/50 hover:bg-muted transition-colors">
      <div className="flex items-center gap-3">
        <div className={`p-1.5 rounded ${isBuy ? 'bg-green-500/20' : 'bg-red-500/20'}`}>
          {isBuy ? (
            <TrendingUp className="h-4 w-4 text-green-500" />
          ) : (
            <TrendingDown className="h-4 w-4 text-red-500" />
          )}
        </div>
        <div>
          <div className="flex items-center gap-2">
            <Badge variant={isBuy ? 'default' : 'destructive'} className="text-xs">
              {trade.side}
            </Badge>
            {trade.asset && (
              <span className="font-semibold">{trade.asset}</span>
            )}
            <span className="text-muted-foreground text-sm">{trade.outcome}</span>
          </div>
          <div className="text-xs text-muted-foreground mt-0.5">
            {trade.market_slug?.substring(0, 50)}...
          </div>
        </div>
      </div>
      
      <div className="text-right">
        <div className="font-mono">
          {trade.size.toFixed(1)} @ {(trade.price * 100).toFixed(1)}¢
        </div>
        <div className="text-xs text-muted-foreground flex items-center justify-end gap-2">
          <span>${notional.toFixed(2)}</span>
          <span>•</span>
          <span>{formatDistanceToNow(new Date(trade.timestamp), { addSuffix: true })}</span>
        </div>
      </div>
    </div>
  );
}

function StatsGrid({ stats }: { stats: ReturnType<typeof useTrackedWallet>['stats'] }) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
      <div className="p-3 rounded-lg bg-muted/50">
        <div className="text-xs text-muted-foreground">Total Trades</div>
        <div className="text-xl font-bold">{stats.totalTrades}</div>
      </div>
      <div className="p-3 rounded-lg bg-muted/50">
        <div className="text-xs text-muted-foreground">Volume</div>
        <div className="text-xl font-bold">${stats.totalVolume.toFixed(0)}</div>
      </div>
      <div className="p-3 rounded-lg bg-muted/50">
        <div className="text-xs text-muted-foreground">Buy/Sell</div>
        <div className="text-xl font-bold">
          <span className="text-green-500">{stats.buyCount}</span>
          <span className="text-muted-foreground">/</span>
          <span className="text-red-500">{stats.sellCount}</span>
        </div>
      </div>
      <div className="p-3 rounded-lg bg-muted/50">
        <div className="text-xs text-muted-foreground">Avg Size</div>
        <div className="text-xl font-bold">${stats.avgTradeSize.toFixed(2)}</div>
      </div>
    </div>
  );
}

export function TrackedWalletPanel() {
  const [walletInput, setWalletInput] = useState(DEFAULT_WALLET);
  const [activeWallet, setActiveWallet] = useState(DEFAULT_WALLET);
  
  const { trades, stats, loading, syncing, error, syncTrades } = useTrackedWallet(activeWallet);

  const handleChangeWallet = () => {
    if (walletInput.startsWith('0x') && walletInput.length === 42) {
      setActiveWallet(walletInput.toLowerCase());
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Activity className="h-5 w-5" />
            Wallet Tracker
            {trades.length > 0 && (
              <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
            )}
          </div>
          <Button 
            variant="outline" 
            size="sm" 
            onClick={syncTrades}
            disabled={syncing}
          >
            <RefreshCw className={`h-4 w-4 mr-2 ${syncing ? 'animate-spin' : ''}`} />
            {syncing ? 'Syncing...' : 'Sync'}
          </Button>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {/* Wallet Input */}
        <div className="flex gap-2 mb-4">
          <Input
            value={walletInput}
            onChange={(e) => setWalletInput(e.target.value)}
            placeholder="0x..."
            className="font-mono text-xs"
          />
          <Button variant="secondary" size="sm" onClick={handleChangeWallet}>
            Track
          </Button>
          <Button variant="ghost" size="sm" asChild>
            <a 
              href={`https://polymarket.com/profile/${activeWallet}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              <ExternalLink className="h-4 w-4" />
            </a>
          </Button>
        </div>

        {/* Active Wallet Badge */}
        <div className="mb-4">
          <Badge variant="outline" className="font-mono text-xs">
            {activeWallet.slice(0, 8)}...{activeWallet.slice(-6)}
          </Badge>
        </div>

        {/* Error */}
        {error && (
          <div className="p-3 mb-4 bg-destructive/20 text-destructive rounded-lg text-sm">
            {error}
          </div>
        )}

        {/* Stats */}
        {!loading && <StatsGrid stats={stats} />}

        {/* Trades List */}
        {loading ? (
          <div className="space-y-2">
            {[...Array(5)].map((_, i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))}
          </div>
        ) : trades.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            <p>No trades found for this wallet.</p>
            <p className="text-sm mt-1">Click "Sync" to fetch from Polymarket.</p>
          </div>
        ) : (
          <ScrollArea className="h-[400px]">
            <div className="space-y-2">
              {trades.map((trade) => (
                <TradeRow key={trade.id} trade={trade} />
              ))}
            </div>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  );
}
