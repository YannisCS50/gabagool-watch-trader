import { useState, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { 
  usePaperSignals, 
  usePaperTraderStats, 
  usePaperTradingConfig,
  updatePaperTradingConfig,
  type PaperSignal 
} from '@/hooks/usePaperTraderData';
import { supabase } from '@/integrations/supabase/client';
import { RefreshCw, TrendingUp, TrendingDown, Target, XCircle, Clock, Activity, Wifi } from 'lucide-react';
import { toast } from 'sonner';
import { PriceLatencyChart } from './PriceLatencyChart';

function formatCents(value: number | null): string {
  if (value === null) return '-';
  return `${(value * 100).toFixed(1)}¢`;
}

function formatPnl(value: number | null): string {
  if (value === null) return '-';
  const prefix = value >= 0 ? '+' : '';
  return `${prefix}$${value.toFixed(2)}`;
}

function formatTime(ts: number | null): string {
  if (ts === null) return '-';
  return new Date(ts).toLocaleTimeString();
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    pending: 'bg-yellow-500/20 text-yellow-400',
    filled: 'bg-blue-500/20 text-blue-400',
    sold: 'bg-green-500/20 text-green-400',
    expired: 'bg-gray-500/20 text-gray-400',
    failed: 'bg-red-500/20 text-red-400',
  };
  
  return (
    <Badge className={colors[status] || 'bg-gray-500/20 text-gray-400'}>
      {status}
    </Badge>
  );
}

function ExitTypeBadge({ exitType }: { exitType: string | null }) {
  if (!exitType) return null;
  
  const config: Record<string, { icon: React.ReactNode; color: string; label: string }> = {
    tp: { icon: <Target className="h-3 w-3" />, color: 'bg-green-500/20 text-green-400', label: 'TP' },
    sl: { icon: <XCircle className="h-3 w-3" />, color: 'bg-red-500/20 text-red-400', label: 'SL' },
    timeout: { icon: <Clock className="h-3 w-3" />, color: 'bg-yellow-500/20 text-yellow-400', label: 'Timeout' },
  };
  
  const c = config[exitType];
  if (!c) return null;
  
  return (
    <Badge className={`${c.color} flex items-center gap-1`}>
      {c.icon}
      {c.label}
    </Badge>
  );
}

function StatsCards() {
  const { data: stats, isLoading } = usePaperTraderStats();
  
  if (isLoading || !stats) {
    return <div className="text-muted-foreground">Loading stats...</div>;
  }
  
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
      <Card>
        <CardContent className="pt-4">
          <div className="text-sm text-muted-foreground">Total Trades</div>
          <div className="text-2xl font-bold">{stats.totalTrades}</div>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="pt-4">
          <div className="text-sm text-muted-foreground">Total PnL</div>
          <div className={`text-2xl font-bold ${stats.totalPnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
            {formatPnl(stats.totalPnl)}
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="pt-4">
          <div className="text-sm text-muted-foreground">Win Rate</div>
          <div className="text-2xl font-bold">{stats.winRate.toFixed(1)}%</div>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="pt-4">
          <div className="text-sm text-muted-foreground">TP / SL / Timeout</div>
          <div className="text-lg font-bold">
            <span className="text-green-400">{stats.tpHits}</span>
            {' / '}
            <span className="text-red-400">{stats.slHits}</span>
            {' / '}
            <span className="text-yellow-400">{stats.timeouts}</span>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ============ Bot Price Feed (what the runner sees) ============

interface PriceSnapshot {
  id: string;
  ts: number;
  asset: string;
  binance_price: number | null;
  chainlink_price: number | null;
  strike_price: number | null;
  up_best_ask: number | null;
  up_best_bid: number | null;
  down_best_ask: number | null;
  down_best_bid: number | null;
  market_slug: string | null;
  created_at: string;
}

function useBotPriceSnapshots() {
  return useQuery({
    queryKey: ['bot-price-snapshots'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('paper_price_snapshots')
        .select('*')
        .order('ts', { ascending: false })
        .limit(100);
      
      if (error) throw error;
      return (data || []) as PriceSnapshot[];
    },
    refetchInterval: 2000,
  });
}

function BotPriceFeedPanel() {
  const { data: snapshots, isLoading, refetch } = useBotPriceSnapshots();
  
  // Get latest snapshot per asset
  const latestByAsset = snapshots?.reduce((acc, snap) => {
    if (!acc[snap.asset] || snap.ts > acc[snap.asset].ts) {
      acc[snap.asset] = snap;
    }
    return acc;
  }, {} as Record<string, PriceSnapshot>);
  
  const assets = ['BTC', 'ETH', 'SOL', 'XRP'];
  
  // Calculate time since last update
  const getAgeMs = (ts: number) => Date.now() - ts;
  const formatAge = (ts: number) => {
    const age = getAgeMs(ts);
    if (age < 1000) return 'now';
    if (age < 60000) return `${Math.floor(age / 1000)}s ago`;
    return `${Math.floor(age / 60000)}m ago`;
  };
  
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex justify-between items-center">
          <CardTitle className="text-lg flex items-center gap-2">
            <Wifi className="h-4 w-4 text-green-400" />
            Bot Price Feed
          </CardTitle>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="text-xs">
              Runner Data
            </Badge>
            <Button variant="ghost" size="sm" onClick={() => refetch()}>
              <RefreshCw className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="text-muted-foreground">Loading...</div>
        ) : !snapshots || snapshots.length === 0 ? (
          <div className="text-muted-foreground text-sm p-4 text-center border border-dashed rounded">
            No price data from runner yet. Start the paper trader.
          </div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {assets.map(asset => {
              const snap = latestByAsset?.[asset];
              const isStale = snap ? getAgeMs(snap.ts) > 15000 : true;
              
              // Calculate delta and mispricing
              const strikePrice = snap?.strike_price;
              const binancePrice = snap?.binance_price;
              const delta = binancePrice && strikePrice ? binancePrice - strikePrice : null;
              const deltaPercent = delta && strikePrice ? (delta / strikePrice) * 100 : null;
              const side = delta !== null ? (delta > 0 ? 'UP' : 'DOWN') : null;
              
              // Calculate combined cost and edge
              const combined = snap?.up_best_ask && snap?.down_best_ask 
                ? snap.up_best_ask + snap.down_best_ask 
                : null;
              const mispricing = combined ? (1 - combined) * 100 : null;
              
              // Calculate price to beat (the share price we need to pay)
              const sharePrice = side === 'UP' ? snap?.up_best_ask : snap?.down_best_ask;
              const priceToBeat = sharePrice ? 1 - sharePrice : null;
              
              return (
                <div 
                  key={asset} 
                  className={`border rounded-lg p-3 ${isStale ? 'border-muted opacity-60' : 'border-primary/30'}`}
                >
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-bold text-lg">{asset}</span>
                    <div className="flex items-center gap-1">
                      {side && (
                        <Badge 
                          variant="outline" 
                          className={`text-xs ${side === 'UP' ? 'text-green-400 border-green-400' : 'text-red-400 border-red-400'}`}
                        >
                          {side === 'UP' ? <TrendingUp className="h-3 w-3 mr-1" /> : <TrendingDown className="h-3 w-3 mr-1" />}
                          {side}
                        </Badge>
                      )}
                      {snap && (
                        <span className={`text-xs ${isStale ? 'text-muted-foreground' : 'text-green-400'}`}>
                          {formatAge(snap.ts)}
                        </span>
                      )}
                    </div>
                  </div>
                  
                  {snap ? (
                    <div className="space-y-2">
                      {/* Spot & Strike row */}
                      <div className="grid grid-cols-2 gap-2 text-xs">
                        <div>
                          <span className="text-muted-foreground">Spot</span>
                          <div className="font-mono text-yellow-500 font-semibold">
                            ${snap.binance_price?.toLocaleString(undefined, { maximumFractionDigits: 0 }) || '—'}
                          </div>
                        </div>
                        <div>
                          <span className="text-muted-foreground">Strike</span>
                          <div className="font-mono text-blue-400">
                            ${strikePrice?.toLocaleString(undefined, { maximumFractionDigits: 0 }) || '—'}
                          </div>
                        </div>
                      </div>
                      
                      {/* Delta */}
                      {delta !== null && (
                        <div className="flex justify-between items-center text-xs">
                          <span className="text-muted-foreground">Delta</span>
                          <span className={`font-mono font-semibold ${delta > 0 ? 'text-green-400' : 'text-red-400'}`}>
                            {delta > 0 ? '+' : ''}{delta.toFixed(0)} ({deltaPercent?.toFixed(2)}%)
                          </span>
                        </div>
                      )}
                      
                      {/* Price to Beat */}
                      {priceToBeat !== null && (
                        <div className="flex justify-between items-center text-xs border-t pt-2">
                          <span className="text-muted-foreground">Price to Beat</span>
                          <span className="font-mono font-bold text-primary">
                            {(priceToBeat * 100).toFixed(1)}¢
                          </span>
                        </div>
                      )}
                      
                      {/* CLOB prices */}
                      <div className="grid grid-cols-2 gap-2 text-xs">
                        <div>
                          <span className="text-muted-foreground">UP Ask</span>
                          <div className={`font-mono ${side === 'UP' ? 'text-green-400 font-bold' : 'text-muted-foreground'}`}>
                            {snap.up_best_ask ? `${(snap.up_best_ask * 100).toFixed(1)}¢` : '—'}
                          </div>
                        </div>
                        <div>
                          <span className="text-muted-foreground">DN Ask</span>
                          <div className={`font-mono ${side === 'DOWN' ? 'text-red-400 font-bold' : 'text-muted-foreground'}`}>
                            {snap.down_best_ask ? `${(snap.down_best_ask * 100).toFixed(1)}¢` : '—'}
                          </div>
                        </div>
                      </div>
                      
                      {/* Combined & Edge */}
                      {combined && (
                        <div className="border-t pt-2 space-y-1 text-xs">
                          <div className="flex justify-between">
                            <span className="text-muted-foreground">Combined</span>
                            <span className={`font-mono ${combined < 1 ? 'text-green-400' : 'text-muted-foreground'}`}>
                              {(combined * 100).toFixed(1)}¢
                            </span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-muted-foreground">Edge</span>
                            <span className={`font-mono font-bold ${
                              mispricing && mispricing > 0 
                                ? 'text-green-400' 
                                : 'text-red-400'
                            }`}>
                              {mispricing?.toFixed(1)}¢
                            </span>
                          </div>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="text-xs text-muted-foreground">No data</div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

interface DecisionLog {
  id: string;
  ts: number;
  run_id: string | null;
  asset: string;
  event_type: string;
  reason: string | null;
  binance_price: number | null;
  share_price: number | null;
  delta_usd: number | null;
  created_at: string;
}

function useDecisionLogs() {
  const queryClient = useQueryClient();
  
  const query = useQuery({
    queryKey: ['paper-trader-logs'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('paper_trader_logs')
        .select('*')
        .order('ts', { ascending: false })
        .limit(50);
      
      if (error) throw error;
      return (data || []) as DecisionLog[];
    },
    refetchInterval: 10000, // Fallback polling (less frequent since realtime works)
  });
  
  // Realtime subscription - stable effect
  useEffect(() => {
    const channel = supabase
      .channel('paper-trader-logs-realtime')
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'paper_trader_logs',
        },
        (payload) => {
          console.log('[DecisionLog] Realtime INSERT received:', payload);
          // Use queryClient.invalidateQueries for stable reference
          queryClient.invalidateQueries({ queryKey: ['paper-trader-logs'] });
        }
      )
      .subscribe((status) => {
        console.log('[DecisionLog] Realtime subscription status:', status);
      });
    
    return () => {
      supabase.removeChannel(channel);
    };
  }, [queryClient]);
  
  return query;
}

function DecisionLogPanel() {
  const { data: logs, isLoading, refetch } = useDecisionLogs();
  
  const eventColors: Record<string, string> = {
    skip_delta: 'text-muted-foreground',
    skip_bounds: 'text-yellow-400',
    skip_no_clob: 'text-orange-400',
    skip_active: 'text-blue-400',
    signal: 'text-green-400',
  };
  
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex justify-between items-center">
          <CardTitle className="text-lg">Decision Log</CardTitle>
          <Button variant="ghost" size="sm" onClick={() => refetch()}>
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="text-muted-foreground">Loading logs...</div>
        ) : !logs || logs.length === 0 ? (
          <div className="text-muted-foreground text-sm p-4 text-center border border-dashed rounded">
            No decision logs yet. Restart the paper trader to see logs.
          </div>
        ) : (
          <div className="max-h-[300px] overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-20">Time</TableHead>
                  <TableHead className="w-16">Asset</TableHead>
                  <TableHead>Event</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead className="text-right">Price</TableHead>
                  <TableHead className="text-right">Share</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {logs.map((log) => (
                  <TableRow key={log.id} className="text-xs">
                    <TableCell className="font-mono">
                      {new Date(log.ts).toLocaleTimeString()}
                    </TableCell>
                    <TableCell className="font-bold">{log.asset}</TableCell>
                    <TableCell className={eventColors[log.event_type] || ''}>
                      {log.event_type.replace('skip_', '')}
                    </TableCell>
                    <TableCell className="max-w-[200px] truncate" title={log.reason || ''}>
                      {log.reason}
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {log.binance_price ? `$${log.binance_price.toLocaleString()}` : '-'}
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {log.share_price ? `${(log.share_price * 100).toFixed(1)}¢` : '-'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

interface PriceSnapshot {
  id: string;
  asset: string;
  binance_price: number;
  up_best_bid: number | null;
  up_best_ask: number | null;
  down_best_bid: number | null;
  down_best_ask: number | null;
  strike_price: number | null;
  market_slug: string | null;
  created_at: string;
}

function usePriceSnapshots() {
  return useQuery({
    queryKey: ['paper-price-snapshots'],
    queryFn: async () => {
      // Get latest snapshot per asset
      const { data, error } = await supabase
        .from('paper_price_snapshots')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(20);
      
      if (error) throw error;
      
      // Group by asset, keep latest
      const byAsset = new Map<string, PriceSnapshot>();
      for (const row of (data || [])) {
        if (!byAsset.has(row.asset)) {
          byAsset.set(row.asset, row as PriceSnapshot);
        }
      }
      return Array.from(byAsset.values());
    },
    refetchInterval: 2000,
  });
}

function LivePriceMonitor() {
  const { data: snapshots, isLoading, refetch } = usePriceSnapshots();
  
  if (isLoading) {
    return <div className="text-muted-foreground">Loading prices...</div>;
  }
  
  const assets = ['BTC', 'ETH', 'SOL', 'XRP'];
  
  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <div className="flex items-center gap-2">
          <Activity className="h-5 w-5 text-green-400 animate-pulse" />
          <h3 className="font-semibold">Live Price Monitor</h3>
          {snapshots && snapshots.length > 0 && (
            <Badge variant="outline" className="text-green-400 border-green-400">
              <Wifi className="h-3 w-3 mr-1" />
              Connected
            </Badge>
          )}
        </div>
        <Button variant="ghost" size="sm" onClick={() => refetch()}>
          <RefreshCw className="h-4 w-4" />
        </Button>
      </div>
      
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {assets.map(asset => {
          const snap = snapshots?.find(s => s.asset === asset);
          
          return (
            <Card key={asset} className={snap ? 'border-green-500/30' : 'opacity-50'}>
              <CardHeader className="pb-2">
                <CardTitle className="text-lg flex items-center justify-between">
                  {asset}
                  {snap && (
                    <span className="text-xs text-muted-foreground font-normal">
                      {new Date(snap.created_at).toLocaleTimeString()}
                    </span>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {snap ? (
                  <>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground text-sm">Binance</span>
                      <span className="font-mono font-bold">
                        ${snap.binance_price.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                      </span>
                    </div>
                    
                    <div className="border-t pt-2 space-y-1">
                      <div className="flex justify-between text-sm">
                        <span className="text-green-400 flex items-center gap-1">
                          <TrendingUp className="h-3 w-3" /> UP
                        </span>
                        <span className="font-mono">
                          {snap.up_best_bid ? `${(snap.up_best_bid * 100).toFixed(1)}¢` : '-'}
                          {' / '}
                          {snap.up_best_ask ? `${(snap.up_best_ask * 100).toFixed(1)}¢` : '-'}
                        </span>
                      </div>
                      <div className="flex justify-between text-sm">
                        <span className="text-red-400 flex items-center gap-1">
                          <TrendingDown className="h-3 w-3" /> DOWN
                        </span>
                        <span className="font-mono">
                          {snap.down_best_bid ? `${(snap.down_best_bid * 100).toFixed(1)}¢` : '-'}
                          {' / '}
                          {snap.down_best_ask ? `${(snap.down_best_ask * 100).toFixed(1)}¢` : '-'}
                        </span>
                      </div>
                    </div>
                    
                    {snap.strike_price && snap.strike_price > 0 && (
                      <div className="text-xs text-muted-foreground border-t pt-1">
                        Strike: ${snap.strike_price.toLocaleString()}
                      </div>
                    )}
                  </>
                ) : (
                  <div className="text-muted-foreground text-sm">No data</div>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>
      
      {(!snapshots || snapshots.length === 0) && (
        <div className="text-center p-8 border rounded-md border-dashed">
          <p className="text-muted-foreground">
            No price data yet. Make sure the Paper Trader is running.
          </p>
          <pre className="mt-2 text-xs bg-muted p-2 rounded">
            npx tsx src/paper-trader.ts
          </pre>
        </div>
      )}
    </div>
  );
}

function SignalsTable() {
  const { data: signals, isLoading, refetch } = usePaperSignals(50);
  
  if (isLoading) {
    return <div className="text-muted-foreground">Loading signals...</div>;
  }
  
  return (
    <div className="space-y-2">
      <div className="flex justify-between items-center">
        <h3 className="font-semibold">Recent Signals</h3>
        <Button variant="ghost" size="sm" onClick={() => refetch()}>
          <RefreshCw className="h-4 w-4" />
        </Button>
      </div>
      
      <div className="rounded-md border max-h-[400px] overflow-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Time</TableHead>
              <TableHead>Asset</TableHead>
              <TableHead>Dir</TableHead>
              <TableHead>Entry</TableHead>
              <TableHead>Exit</TableHead>
              <TableHead>TP/SL</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Exit</TableHead>
              <TableHead className="text-right">PnL</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {signals?.map((signal) => (
              <TableRow key={signal.id}>
                <TableCell className="font-mono text-xs">
                  {formatTime(signal.signal_ts)}
                </TableCell>
                <TableCell className="font-bold">{signal.asset}</TableCell>
                <TableCell>
                  {signal.direction === 'UP' ? (
                    <TrendingUp className="h-4 w-4 text-green-400" />
                  ) : (
                    <TrendingDown className="h-4 w-4 text-red-400" />
                  )}
                </TableCell>
                <TableCell className="font-mono">{formatCents(signal.entry_price)}</TableCell>
                <TableCell className="font-mono">{formatCents(signal.exit_price)}</TableCell>
                <TableCell className="font-mono text-xs">
                  <span className="text-green-400">{formatCents(signal.tp_price)}</span>
                  {' / '}
                  <span className="text-red-400">{formatCents(signal.sl_price)}</span>
                </TableCell>
                <TableCell>
                  <StatusBadge status={signal.status} />
                </TableCell>
                <TableCell>
                  <ExitTypeBadge exitType={signal.exit_type} />
                </TableCell>
                <TableCell className={`text-right font-mono ${(signal.net_pnl ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                  {formatPnl(signal.net_pnl)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function ConfigEditor() {
  const { data: config, refetch } = usePaperTradingConfig();
  const [saving, setSaving] = useState(false);
  
  const handleUpdate = async (updates: Record<string, unknown>) => {
    setSaving(true);
    const success = await updatePaperTradingConfig(updates);
    setSaving(false);
    
    if (success) {
      toast.success('Config updated');
      refetch();
    } else {
      toast.error('Failed to update config');
    }
  };
  
  if (!config) {
    return <div className="text-muted-foreground">Loading config...</div>;
  }
  
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        <div className="flex items-center justify-between space-x-2">
          <Label>Enabled</Label>
          <Switch 
            checked={config.enabled} 
            onCheckedChange={(v) => handleUpdate({ enabled: v })}
          />
        </div>
        
        <div className="flex items-center justify-between space-x-2">
          <Label className="text-red-400">LIVE MODE</Label>
          <Switch 
            checked={config.is_live} 
            onCheckedChange={(v) => handleUpdate({ is_live: v })}
            className="data-[state=checked]:bg-red-500"
          />
        </div>
        
        <div>
          <Label>Trade Size ($)</Label>
          <Input 
            type="number" 
            value={config.trade_size_usd}
            onChange={(e) => handleUpdate({ trade_size_usd: parseFloat(e.target.value) || 5 })}
            className="h-8"
          />
        </div>
        
        <div>
          <Label>Min Delta ($)</Label>
          <Input 
            type="number" 
            value={config.min_delta_usd}
            onChange={(e) => handleUpdate({ min_delta_usd: parseFloat(e.target.value) || 10 })}
            className="h-8"
          />
        </div>
        
        <div>
          <Label>TP (¢)</Label>
          <div className="flex gap-1 items-center">
            <Input 
              type="number" 
              value={config.tp_cents}
              onChange={(e) => handleUpdate({ tp_cents: parseFloat(e.target.value) || 3 })}
              className="h-8"
              disabled={!config.tp_enabled}
            />
            <Switch 
              checked={config.tp_enabled} 
              onCheckedChange={(v) => handleUpdate({ tp_enabled: v })}
            />
          </div>
        </div>
        
        <div>
          <Label>SL (¢)</Label>
          <div className="flex gap-1 items-center">
            <Input 
              type="number" 
              value={config.sl_cents}
              onChange={(e) => handleUpdate({ sl_cents: parseFloat(e.target.value) || 3 })}
              className="h-8"
              disabled={!config.sl_enabled}
            />
            <Switch 
              checked={config.sl_enabled} 
              onCheckedChange={(v) => handleUpdate({ sl_enabled: v })}
            />
          </div>
        </div>
        
        <div>
          <Label>Timeout (s)</Label>
          <Input 
            type="number" 
            value={config.timeout_ms / 1000}
            onChange={(e) => handleUpdate({ timeout_ms: (parseFloat(e.target.value) || 15) * 1000 })}
            className="h-8"
          />
        </div>
        
        <div>
          <Label>Min Share (¢)</Label>
          <Input 
            type="number" 
            value={config.min_share_price * 100}
            onChange={(e) => handleUpdate({ min_share_price: (parseFloat(e.target.value) || 35) / 100 })}
            className="h-8"
          />
        </div>
        
        <div>
          <Label>Max Share (¢)</Label>
          <Input 
            type="number" 
            value={config.max_share_price * 100}
            onChange={(e) => handleUpdate({ max_share_price: (parseFloat(e.target.value) || 65) / 100 })}
            className="h-8"
          />
        </div>
      </div>
      
      {config.is_live && (
        <div className="p-4 bg-red-500/20 border border-red-500 rounded-md">
          <p className="text-red-400 font-bold">⚠️ LIVE MODE IS ENABLED</p>
          <p className="text-sm text-red-300">Real orders will be placed with ${config.trade_size_usd} per trade</p>
        </div>
      )}
    </div>
  );
}

export default function PaperTraderDashboard() {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold">Paper Trader</h2>
        <p className="text-muted-foreground">Monitor paper trading signals from the runner</p>
      </div>
      
      {/* Browser-based price feed for comparison */}
      <PriceLatencyChart />
      
      {/* What the runner actually sees */}
      <BotPriceFeedPanel />
      
      <StatsCards />
      
      <Tabs defaultValue="logs">
        <TabsList>
          <TabsTrigger value="logs">Decision Log</TabsTrigger>
          <TabsTrigger value="signals">Signals</TabsTrigger>
          <TabsTrigger value="config">Config</TabsTrigger>
        </TabsList>
        
        <TabsContent value="logs" className="mt-4">
          <DecisionLogPanel />
        </TabsContent>
        
        <TabsContent value="signals" className="mt-4">
          <Card>
            <CardContent className="pt-4">
              <SignalsTable />
            </CardContent>
          </Card>
        </TabsContent>
        
        <TabsContent value="config" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle>Paper Trading Configuration</CardTitle>
            </CardHeader>
            <CardContent>
              <ConfigEditor />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
