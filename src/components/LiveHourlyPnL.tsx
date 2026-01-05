import React, { useMemo, useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Clock, TrendingUp, TrendingDown, RefreshCw, Activity, AlertTriangle } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { format, subHours, startOfHour } from 'date-fns';
import { nl } from 'date-fns/locale';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Cell,
  ReferenceLine,
} from 'recharts';

interface HourlyData {
  hour: string;
  hourStart: Date;
  trades: number;
  invested: number;
  markets: number;
}

interface LiveTrade {
  id: string;
  market_slug: string;
  asset: string;
  outcome: string;
  shares: number;
  price: number;
  total: number;
  status: string;
  created_at: string;
  event_end_time: string | null;
}

interface LiveTradeResult {
  id: string;
  market_slug: string;
  asset: string;
  profit_loss: number | null;
  total_invested: number | null;
  settled_at: string | null;
  created_at: string;
}

interface LiveHourlyPnLProps {
  hoursToShow?: number;
}

export function LiveHourlyPnL({ hoursToShow = 24 }: LiveHourlyPnLProps) {
  const [trades, setTrades] = useState<LiveTrade[]>([]);
  const [results, setResults] = useState<LiveTradeResult[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date());

  const fetchData = async () => {
    setIsLoading(true);
    try {
      const cutoffTime = subHours(new Date(), hoursToShow).toISOString();
      
      // Fetch filled trades from the time period
      const [tradesRes, resultsRes] = await Promise.all([
        supabase
          .from('live_trades')
          .select('id, market_slug, asset, outcome, shares, price, total, status, created_at, event_end_time')
          .eq('status', 'filled')
          .gte('created_at', cutoffTime)
          .order('created_at', { ascending: false }),
        supabase
          .from('live_trade_results')
          .select('id, market_slug, asset, profit_loss, total_invested, settled_at, created_at')
          .not('settled_at', 'is', null)
          .gte('settled_at', cutoffTime)
          .order('settled_at', { ascending: false })
      ]);

      if (tradesRes.error) throw tradesRes.error;
      if (resultsRes.error) throw resultsRes.error;
      
      setTrades(tradesRes.data || []);
      setResults(resultsRes.data || []);
      setLastRefresh(new Date());
    } catch (err) {
      console.error('Error fetching live trade data:', err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, [hoursToShow]);

  // Subscribe to real-time updates
  useEffect(() => {
    const channel = supabase
      .channel('live-hourly-pnl-realtime')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'live_trades' },
        (payload) => {
          const newTrade = payload.new as LiveTrade;
          if (newTrade.status === 'filled') {
            setTrades(prev => [newTrade, ...prev]);
          }
        }
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'live_trade_results' },
        () => fetchData()
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [hoursToShow]);

  // Auto-refresh every 2 minutes
  useEffect(() => {
    const interval = setInterval(fetchData, 2 * 60 * 1000);
    return () => clearInterval(interval);
  }, [hoursToShow]);

  const hourlyData = useMemo(() => {
    const now = new Date();
    const hours: HourlyData[] = [];

    for (let i = hoursToShow - 1; i >= 0; i--) {
      const hourStart = startOfHour(subHours(now, i));
      hours.push({
        hour: format(hourStart, 'HH:mm', { locale: nl }),
        hourStart,
        trades: 0,
        invested: 0,
        markets: 0,
      });
    }

    // Aggregate trades into hourly buckets
    const marketsByHour: Map<number, Set<string>> = new Map();
    
    trades.forEach((trade) => {
      const createdAt = new Date(trade.created_at);
      
      for (let i = 0; i < hours.length; i++) {
        const hourStart = hours[i].hourStart;
        const hourEnd = i < hours.length - 1 ? hours[i + 1].hourStart : new Date();
        
        if (createdAt >= hourStart && createdAt < hourEnd) {
          hours[i].trades += 1;
          hours[i].invested += trade.total;
          
          if (!marketsByHour.has(i)) {
            marketsByHour.set(i, new Set());
          }
          marketsByHour.get(i)!.add(trade.market_slug);
          break;
        }
      }
    });

    // Set unique market counts
    marketsByHour.forEach((markets, idx) => {
      hours[idx].markets = markets.size;
    });

    return hours;
  }, [trades, hoursToShow]);

  // Calculate P&L from settled results
  const settledStats = useMemo(() => {
    const totalPnL = results.reduce((sum, r) => sum + (r.profit_loss || 0), 0);
    const totalInvested = results.reduce((sum, r) => sum + (r.total_invested || 0), 0);
    const winCount = results.filter(r => (r.profit_loss || 0) > 0).length;
    const lossCount = results.filter(r => (r.profit_loss || 0) <= 0 && r.settled_at).length;
    
    return { totalPnL, totalInvested, winCount, lossCount, count: results.length };
  }, [results]);

  const summaryStats = useMemo(() => {
    const totalTrades = hourlyData.reduce((sum, h) => sum + h.trades, 0);
    const totalInvested = hourlyData.reduce((sum, h) => sum + h.invested, 0);
    const activeHours = hourlyData.filter((h) => h.trades > 0).length;
    const totalMarkets = new Set(trades.map(t => t.market_slug)).size;
    
    // Find busiest hour
    const busiestHour = hourlyData.reduce((best, h) => 
      h.trades > best.trades ? h : best, hourlyData[0]
    );

    return { totalTrades, totalInvested, activeHours, totalMarkets, busiestHour };
  }, [hourlyData, trades]);

  const hasSettledData = settledStats.count > 0;

  const CustomTooltip = ({ active, payload }: any) => {
    if (active && payload && payload.length) {
      const data = payload[0].payload as HourlyData;
      return (
        <div className="bg-background/95 backdrop-blur-sm border rounded-lg p-3 shadow-lg">
          <p className="font-semibold">{data.hour}</p>
          <p className="text-muted-foreground text-sm">Trades: {data.trades}</p>
          <p className="text-muted-foreground text-sm">Invested: ${data.invested.toFixed(2)}</p>
          <p className="text-muted-foreground text-sm">Markets: {data.markets}</p>
        </div>
      );
    }
    return null;
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-lg">
            <Clock className="w-5 h-5" />
            Live Trading Activity
            <Badge variant="outline" className="ml-2">{hoursToShow}u</Badge>
          </CardTitle>
          <div className="flex items-center gap-3">
            <Button 
              variant="ghost" 
              size="sm" 
              onClick={fetchData}
              disabled={isLoading}
            >
              <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
            </Button>
            {hasSettledData && (
              <>
                {settledStats.totalPnL >= 0 ? (
                  <TrendingUp className="w-5 h-5 text-green-500" />
                ) : (
                  <TrendingDown className="w-5 h-5 text-red-500" />
                )}
                <span className={`text-xl font-bold ${
                  settledStats.totalPnL >= 0 ? 'text-green-500' : 'text-red-500'
                }`}>
                  {settledStats.totalPnL >= 0 ? '+' : ''}${settledStats.totalPnL.toFixed(2)}
                </span>
              </>
            )}
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Update: {format(lastRefresh, 'HH:mm:ss', { locale: nl })} • 
          {summaryStats.totalTrades} trades in {summaryStats.totalMarkets} markets
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Warning if no settled data */}
        {!hasSettledData && summaryStats.totalTrades > 0 && (
          <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-3 flex items-center gap-3">
            <AlertTriangle className="w-5 h-5 text-yellow-500 flex-shrink-0" />
            <div className="text-sm">
              <div className="font-semibold text-yellow-500">Settlement Pending</div>
              <div className="text-muted-foreground">
                {summaryStats.totalTrades} trades zijn nog niet gesettled. P/L wordt berekend na market expiry.
              </div>
            </div>
          </div>
        )}

        {/* Summary Stats */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 text-sm">
          <div className="bg-muted/50 rounded-lg p-2">
            <div className="text-muted-foreground">Trades</div>
            <div className="font-semibold">{summaryStats.totalTrades}</div>
          </div>
          <div className="bg-muted/50 rounded-lg p-2">
            <div className="text-muted-foreground">Invested</div>
            <div className="font-semibold">${summaryStats.totalInvested.toFixed(2)}</div>
          </div>
          <div className="bg-muted/50 rounded-lg p-2">
            <div className="text-muted-foreground">Markets</div>
            <div className="font-semibold">{summaryStats.totalMarkets}</div>
          </div>
          <div className="bg-muted/50 rounded-lg p-2">
            <div className="text-muted-foreground">Actieve uren</div>
            <div className="font-semibold">{summaryStats.activeHours}</div>
          </div>
          {hasSettledData && (
            <div className="bg-muted/50 rounded-lg p-2">
              <div className="text-muted-foreground">Settled</div>
              <div className="font-semibold">
                <span className="text-green-500">{settledStats.winCount}W</span>
                {' / '}
                <span className="text-red-500">{settledStats.lossCount}L</span>
              </div>
            </div>
          )}
        </div>

        {/* Activity Chart */}
        {summaryStats.totalTrades > 0 ? (
          <div className="h-[180px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={hourlyData} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
                <XAxis
                  dataKey="hour"
                  tick={{ fontSize: 10 }}
                  interval={Math.floor(hoursToShow / 8)}
                />
                <YAxis
                  tick={{ fontSize: 10 }}
                  tickFormatter={(value) => `${value}`}
                />
                <Tooltip content={<CustomTooltip />} />
                <ReferenceLine y={0} stroke="hsl(var(--muted-foreground))" strokeDasharray="3 3" />
                <Bar dataKey="trades" radius={[2, 2, 0, 0]} name="Trades">
                  {hourlyData.map((entry, index) => (
                    <Cell
                      key={`cell-${index}`}
                      fill={entry.trades > 0 ? 'hsl(var(--primary))' : 'hsl(var(--muted))'}
                      opacity={entry.trades > 0 ? 0.8 : 0.3}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <div className="h-[180px] flex items-center justify-center text-muted-foreground">
            {isLoading ? 'Laden...' : `Geen trades in de afgelopen ${hoursToShow} uur`}
          </div>
        )}

        {/* Settled P/L if available */}
        {hasSettledData && (
          <div className="border-t pt-3">
            <div className="text-xs font-semibold text-muted-foreground mb-2">
              Settled Results ({settledStats.count})
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className={`rounded-lg p-2 ${settledStats.totalPnL >= 0 ? 'bg-green-500/10' : 'bg-red-500/10'}`}>
                <div className="text-xs text-muted-foreground">P/L</div>
                <div className={`font-bold ${settledStats.totalPnL >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                  {settledStats.totalPnL >= 0 ? '+' : ''}${settledStats.totalPnL.toFixed(2)}
                </div>
              </div>
              <div className="bg-muted/50 rounded-lg p-2">
                <div className="text-xs text-muted-foreground">Invested</div>
                <div className="font-bold">${settledStats.totalInvested.toFixed(2)}</div>
              </div>
              <div className="bg-muted/50 rounded-lg p-2">
                <div className="text-xs text-muted-foreground">ROI</div>
                <div className={`font-bold ${settledStats.totalPnL >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                  {settledStats.totalInvested > 0 
                    ? ((settledStats.totalPnL / settledStats.totalInvested) * 100).toFixed(1) 
                    : 0}%
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Recent Trades */}
        {trades.length > 0 && (
          <div className="border-t pt-3">
            <div className="text-xs font-semibold text-muted-foreground mb-2">
              Laatste trades
            </div>
            <div className="space-y-1">
              {trades.slice(0, 6).map((trade) => (
                <div 
                  key={trade.id} 
                  className="flex items-center justify-between text-xs py-1 px-2 rounded bg-muted/30"
                >
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className={`text-xs ${
                      trade.outcome === 'UP' ? 'text-green-500 border-green-500/50' : 'text-red-500 border-red-500/50'
                    }`}>
                      {trade.asset} {trade.outcome}
                    </Badge>
                    <span className="text-muted-foreground font-mono">
                      {trade.shares.toFixed(0)} @ {(trade.price * 100).toFixed(0)}¢
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="font-mono">${trade.total.toFixed(2)}</span>
                    <span className="text-muted-foreground">
                      {format(new Date(trade.created_at), 'HH:mm', { locale: nl })}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
