import React, { useMemo, useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { TrendingUp, TrendingDown, RefreshCw, DollarSign, Clock, AlertCircle, Target } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { format, subHours, startOfHour, endOfHour } from 'date-fns';
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

interface SettlementLog {
  id: string;
  ts: number;
  iso: string;
  asset: string;
  realized_pnl: number | null;
  theoretical_pnl: number | null;
  pair_cost: number | null;
  total_payout_usd: number | null;
  winning_side: string | null;
  final_up_shares: number;
  final_down_shares: number;
  avg_up_cost: number | null;
  avg_down_cost: number | null;
  created_at: string;
}

interface SnapshotLog {
  id: string;
  asset: string;
  market_id: string;
  up_shares: number;
  down_shares: number;
  avg_up_cost: number | null;
  avg_down_cost: number | null;
  pair_cost: number | null;
  delta: number | null;
  spot_price: number | null;
  strike_price: number | null;
  seconds_remaining: number;
  created_at: string;
}

interface FillLog {
  id: string;
  ts: number;
  asset: string;
  market_id: string;
  side: string;
  fill_qty: number;
  fill_price: number;
  fill_notional: number;
  created_at: string;
}

interface HourlyPnLData {
  hour: string;
  hourStart: Date;
  settledPnl: number;      // Actual realized P/L from settlements
  expectedPnl: number;     // Calculated expected P/L from open positions
  totalPnl: number;        // settled + expected
  settledCount: number;
  openCount: number;
  assets: string[];
  isProjected: boolean;    // Has open positions (expected P/L)
}

interface OpenPositionPnL {
  asset: string;
  marketId: string;
  upShares: number;
  downShares: number;
  upCost: number;
  downCost: number;
  totalCost: number;
  delta: number | null;
  expectedWinner: 'UP' | 'DOWN' | null;
  expectedPnl: number;
  secondsRemaining: number;
  entryHour: string;
}

interface LiveHourlyPnLChartProps {
  defaultHours?: number;
}

export function LiveHourlyPnLChart({ defaultHours = 24 }: LiveHourlyPnLChartProps) {
  const [settlements, setSettlements] = useState<SettlementLog[]>([]);
  const [snapshots, setSnapshots] = useState<SnapshotLog[]>([]);
  const [fills, setFills] = useState<FillLog[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date());
  const [hoursToShow, setHoursToShow] = useState(defaultHours);

  const fetchData = async () => {
    setIsLoading(true);
    try {
      const cutoffTime = subHours(new Date(), hoursToShow);
      const cutoffTs = Math.floor(cutoffTime.getTime() / 1000);
      
      // Fetch settlements, snapshots, and fills in parallel
      const [settlementsRes, snapshotsRes, fillsRes] = await Promise.all([
        // Settlements (actual realized P/L)
        supabase
          .from('settlement_logs')
          .select('id, ts, iso, asset, realized_pnl, theoretical_pnl, pair_cost, total_payout_usd, winning_side, final_up_shares, final_down_shares, avg_up_cost, avg_down_cost, created_at')
          .gte('ts', cutoffTs)
          .order('ts', { ascending: false }),
        
        // Latest snapshots per market (for open positions)
        supabase
          .from('snapshot_logs')
          .select('id, asset, market_id, up_shares, down_shares, avg_up_cost, avg_down_cost, pair_cost, delta, spot_price, strike_price, seconds_remaining, created_at')
          .gt('seconds_remaining', 0)  // Only active markets
          .order('ts', { ascending: false })
          .limit(50),
        
        // Recent fills (to attribute P/L to entry hour)
        supabase
          .from('fill_logs')
          .select('id, ts, asset, market_id, side, fill_qty, fill_price, fill_notional, created_at')
          .gte('ts', cutoffTs)
          .order('ts', { ascending: false })
      ]);

      if (settlementsRes.error) throw settlementsRes.error;
      if (snapshotsRes.error) throw snapshotsRes.error;
      if (fillsRes.error) throw fillsRes.error;
      
      setSettlements(settlementsRes.data || []);
      setFills(fillsRes.data || []);
      
      // Dedupe snapshots to get latest per market
      const latestByMarket = new Map<string, SnapshotLog>();
      for (const s of snapshotsRes.data || []) {
        const key = `${s.market_id}:${s.asset}`;
        if (!latestByMarket.has(key)) {
          latestByMarket.set(key, s);
        }
      }
      setSnapshots(Array.from(latestByMarket.values()));
      
      setLastRefresh(new Date());
    } catch (err) {
      console.error('Error fetching P/L data:', err);
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
      .channel('live-hourly-pnl-chart-realtime')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'settlement_logs' },
        () => fetchData()
      )
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'snapshot_logs' },
        () => fetchData()
      )
      .subscribe();

    // Refresh every 10s for live expected P/L updates
    const interval = setInterval(fetchData, 10000);

    return () => {
      supabase.removeChannel(channel);
      clearInterval(interval);
    };
  }, [hoursToShow]);

  // Calculate expected P/L for open positions
  const openPositionsPnL = useMemo((): OpenPositionPnL[] => {
    return snapshots
      .filter(s => s.up_shares > 0 || s.down_shares > 0)
      .map(s => {
        const upCost = (s.avg_up_cost ?? 0) * s.up_shares;
        const downCost = (s.avg_down_cost ?? 0) * s.down_shares;
        const totalCost = upCost + downCost;
        
        // Determine expected winner based on delta
        // delta > 0 means spot > strike, so UP wins
        // delta < 0 means spot < strike, so DOWN wins
        let expectedWinner: 'UP' | 'DOWN' | null = null;
        let expectedPnl = 0;
        
        if (s.delta !== null) {
          if (s.delta > 0) {
            expectedWinner = 'UP';
            expectedPnl = (s.up_shares * 1.0) - totalCost;
          } else if (s.delta < 0) {
            expectedWinner = 'DOWN';
            expectedPnl = (s.down_shares * 1.0) - totalCost;
          }
        }
        
        // Find entry hour from fills
        const marketFills = fills.filter(f => f.market_id === s.market_id && f.asset === s.asset);
        const firstFill = marketFills.length > 0 
          ? marketFills.reduce((oldest, f) => f.ts < oldest.ts ? f : oldest, marketFills[0])
          : null;
        const entryHour = firstFill 
          ? format(startOfHour(new Date(firstFill.ts * 1000)), 'HH:mm', { locale: nl })
          : format(startOfHour(new Date()), 'HH:mm', { locale: nl });
        
        return {
          asset: s.asset,
          marketId: s.market_id,
          upShares: s.up_shares,
          downShares: s.down_shares,
          upCost,
          downCost,
          totalCost,
          delta: s.delta,
          expectedWinner,
          expectedPnl,
          secondsRemaining: s.seconds_remaining,
          entryHour,
        };
      });
  }, [snapshots, fills]);

  const hourlyData = useMemo(() => {
    const now = new Date();
    const hours: HourlyPnLData[] = [];

    // Create hour buckets
    for (let i = hoursToShow - 1; i >= 0; i--) {
      const hourStart = startOfHour(subHours(now, i));
      hours.push({
        hour: format(hourStart, 'HH:mm', { locale: nl }),
        hourStart,
        settledPnl: 0,
        expectedPnl: 0,
        totalPnl: 0,
        settledCount: 0,
        openCount: 0,
        assets: [],
        isProjected: false,
      });
    }

    // Aggregate SETTLED P/L into hourly buckets
    settlements.forEach((settlement) => {
      const settlementTime = new Date(settlement.ts * 1000);
      const pnl = settlement.realized_pnl ?? settlement.theoretical_pnl ?? 0;
      
      for (let i = 0; i < hours.length; i++) {
        const hourStart = hours[i].hourStart;
        const hourEnd = endOfHour(hourStart);
        
        if (settlementTime >= hourStart && settlementTime <= hourEnd) {
          hours[i].settledPnl += pnl;
          hours[i].settledCount += 1;
          if (!hours[i].assets.includes(settlement.asset)) {
            hours[i].assets.push(settlement.asset);
          }
          break;
        }
      }
    });

    // Aggregate EXPECTED P/L from open positions into entry hour buckets
    openPositionsPnL.forEach((pos) => {
      for (let i = 0; i < hours.length; i++) {
        if (hours[i].hour === pos.entryHour) {
          hours[i].expectedPnl += pos.expectedPnl;
          hours[i].openCount += 1;
          hours[i].isProjected = true;
          if (!hours[i].assets.includes(pos.asset)) {
            hours[i].assets.push(pos.asset);
          }
          break;
        }
      }
    });

    // Calculate totals
    hours.forEach(h => {
      h.totalPnl = h.settledPnl + h.expectedPnl;
    });

    return hours;
  }, [settlements, openPositionsPnL, hoursToShow]);

  const stats = useMemo(() => {
    const settledPnL = hourlyData.reduce((sum, h) => sum + h.settledPnl, 0);
    const expectedPnL = hourlyData.reduce((sum, h) => sum + h.expectedPnl, 0);
    const totalPnL = settledPnL + expectedPnL;
    const settledCount = hourlyData.reduce((sum, h) => sum + h.settledCount, 0);
    const openCount = openPositionsPnL.length;
    const profitableHours = hourlyData.filter(h => h.totalPnl > 0).length;
    const losingHours = hourlyData.filter(h => h.totalPnl < 0).length;
    const bestHour = hourlyData.reduce((best, h) => h.totalPnl > best.totalPnl ? h : best, hourlyData[0]);
    const worstHour = hourlyData.reduce((worst, h) => h.totalPnl < worst.totalPnl ? h : worst, hourlyData[0]);
    const activeHours = hourlyData.filter(h => h.settledCount > 0 || h.openCount > 0).length;
    const avgPnlPerHour = activeHours > 0 ? totalPnL / activeHours : 0;

    return { 
      settledPnL, expectedPnL, totalPnL, settledCount, openCount,
      profitableHours, losingHours, bestHour, worstHour, avgPnlPerHour, activeHours 
    };
  }, [hourlyData, openPositionsPnL]);

  const CustomTooltip = ({ active, payload }: any) => {
    if (active && payload && payload.length) {
      const data = payload[0].payload as HourlyPnLData;
      
      return (
        <div className="bg-background/95 backdrop-blur-sm border rounded-lg p-3 shadow-lg">
          <p className="font-semibold flex items-center gap-2">
            <Clock className="w-4 h-4" />
            {data.hour} - {format(endOfHour(data.hourStart), 'HH:mm', { locale: nl })}
          </p>
          <div className="mt-2 space-y-1 text-sm">
            {data.settledCount > 0 && (
              <p className={`font-medium ${data.settledPnl >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                ✅ Settled: {data.settledPnl >= 0 ? '+' : ''}${data.settledPnl.toFixed(2)} ({data.settledCount})
              </p>
            )}
            {data.isProjected && (
              <p className={`font-medium ${data.expectedPnl >= 0 ? 'text-blue-400' : 'text-orange-400'}`}>
                ⏳ Expected: {data.expectedPnl >= 0 ? '+' : ''}${data.expectedPnl.toFixed(2)} ({data.openCount} open)
              </p>
            )}
            <p className={`font-bold border-t pt-1 ${data.totalPnl >= 0 ? 'text-green-500' : 'text-red-500'}`}>
              Total: {data.totalPnl >= 0 ? '+' : ''}${data.totalPnl.toFixed(2)}
            </p>
            {data.assets.length > 0 && (
              <p className="text-muted-foreground text-xs">
                Assets: {data.assets.join(', ')}
              </p>
            )}
          </div>
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
            <DollarSign className="w-5 h-5" />
            Winst/Verlies per Uur
            {stats.openCount > 0 && (
              <Badge variant="outline" className="text-xs bg-blue-500/10 text-blue-400 border-blue-500/30">
                {stats.openCount} open
              </Badge>
            )}
          </CardTitle>
          <div className="flex items-center gap-3">
            <Select value={hoursToShow.toString()} onValueChange={(v) => setHoursToShow(parseInt(v))}>
              <SelectTrigger className="w-24 h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="6">6 uur</SelectItem>
                <SelectItem value="12">12 uur</SelectItem>
                <SelectItem value="24">24 uur</SelectItem>
                <SelectItem value="48">48 uur</SelectItem>
                <SelectItem value="72">72 uur</SelectItem>
              </SelectContent>
            </Select>
            <Button 
              variant="ghost" 
              size="sm" 
              onClick={fetchData}
              disabled={isLoading}
            >
              <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
            </Button>
            {stats.totalPnL >= 0 ? (
              <TrendingUp className="w-5 h-5 text-green-500" />
            ) : (
              <TrendingDown className="w-5 h-5 text-red-500" />
            )}
            <span className={`text-xl font-bold ${
              stats.totalPnL >= 0 ? 'text-green-500' : 'text-red-500'
            }`}>
              {stats.totalPnL >= 0 ? '+' : ''}${stats.totalPnL.toFixed(2)}
            </span>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Update: {format(lastRefresh, 'HH:mm:ss', { locale: nl })} • 
          {stats.settledCount} settled + {stats.openCount} open posities
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Stats Grid */}
        <div className="grid grid-cols-2 md:grid-cols-6 gap-3 text-sm">
          <div className={`rounded-lg p-2 ${stats.settledPnL >= 0 ? 'bg-green-500/10' : 'bg-red-500/10'}`}>
            <div className="text-muted-foreground flex items-center gap-1">
              <span>✅</span> Settled
            </div>
            <div className={`font-bold ${stats.settledPnL >= 0 ? 'text-green-500' : 'text-red-500'}`}>
              {stats.settledPnL >= 0 ? '+' : ''}${stats.settledPnL.toFixed(2)}
            </div>
          </div>
          <div className={`rounded-lg p-2 ${stats.expectedPnL >= 0 ? 'bg-blue-500/10' : 'bg-orange-500/10'}`}>
            <div className="text-muted-foreground flex items-center gap-1">
              <span>⏳</span> Expected
            </div>
            <div className={`font-bold ${stats.expectedPnL >= 0 ? 'text-blue-400' : 'text-orange-400'}`}>
              {stats.expectedPnL >= 0 ? '+' : ''}${stats.expectedPnL.toFixed(2)}
            </div>
          </div>
          <div className="bg-muted/50 rounded-lg p-2">
            <div className="text-muted-foreground">Settled</div>
            <div className="font-semibold">{stats.settledCount}</div>
          </div>
          <div className="bg-muted/50 rounded-lg p-2">
            <div className="text-muted-foreground">Open</div>
            <div className="font-semibold">{stats.openCount}</div>
          </div>
          <div className="bg-muted/50 rounded-lg p-2">
            <div className="text-muted-foreground">Win/Loss Uren</div>
            <div className="font-semibold">
              <span className="text-green-500">{stats.profitableHours}</span>
              <span className="text-muted-foreground"> / </span>
              <span className="text-red-500">{stats.losingHours}</span>
            </div>
          </div>
          <div className="bg-muted/50 rounded-lg p-2">
            <div className="text-muted-foreground">Gem./Actief Uur</div>
            <div className={`font-semibold ${stats.avgPnlPerHour >= 0 ? 'text-green-500' : 'text-red-500'}`}>
              {stats.avgPnlPerHour >= 0 ? '+' : ''}${stats.avgPnlPerHour.toFixed(2)}
            </div>
          </div>
        </div>

        {/* Open Positions Detail */}
        {openPositionsPnL.length > 0 && (
          <div className="bg-blue-500/5 border border-blue-500/20 rounded-lg p-3">
            <div className="flex items-center gap-2 text-sm font-medium text-blue-400 mb-2">
              <Target className="w-4 h-4" />
              Open Posities (verwachte P/L op basis van huidige delta)
            </div>
            <div className="grid gap-2 md:grid-cols-2 lg:grid-cols-3">
              {openPositionsPnL.map((pos, i) => (
                <div key={i} className="bg-background/50 rounded p-2 text-xs">
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{pos.asset}</span>
                    <Badge variant="outline" className={`text-xs ${pos.expectedPnl >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                      {pos.expectedPnl >= 0 ? '+' : ''}${pos.expectedPnl.toFixed(2)}
                    </Badge>
                  </div>
                  <div className="text-muted-foreground mt-1">
                    UP: {pos.upShares.toFixed(1)} | DOWN: {pos.downShares.toFixed(1)} | 
                    {pos.expectedWinner && (
                      <span className={pos.expectedWinner === 'UP' ? 'text-green-500' : 'text-red-500'}>
                        {' '}{pos.expectedWinner} winning
                      </span>
                    )}
                  </div>
                  <div className="text-muted-foreground">
                    Cost: ${pos.totalCost.toFixed(2)} | {pos.secondsRemaining}s remaining
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* P/L Chart */}
        {(stats.settledCount > 0 || stats.openCount > 0) ? (
          <div className="h-[220px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={hourlyData} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
                <XAxis
                  dataKey="hour"
                  tick={{ fontSize: 10 }}
                  interval={Math.floor(hoursToShow / 8)}
                />
                <YAxis
                  tick={{ fontSize: 10 }}
                  tickFormatter={(value) => `$${value}`}
                />
                <Tooltip content={<CustomTooltip />} />
                <ReferenceLine y={0} stroke="hsl(var(--muted-foreground))" strokeWidth={1} />
                <Bar dataKey="totalPnl" radius={[2, 2, 0, 0]} name="P/L">
                  {hourlyData.map((entry, index) => {
                    // Color: green for profit, red for loss, blue tint if has projected
                    let fill = 'hsl(var(--muted))';
                    if (entry.totalPnl > 0) {
                      fill = entry.isProjected ? 'hsl(190, 76%, 45%)' : 'hsl(142, 76%, 36%)';
                    } else if (entry.totalPnl < 0) {
                      fill = entry.isProjected ? 'hsl(30, 84%, 50%)' : 'hsl(0, 84%, 60%)';
                    }
                    return (
                      <Cell
                        key={`cell-${index}`}
                        fill={fill}
                        opacity={entry.settledCount > 0 || entry.openCount > 0 ? 0.85 : 0.2}
                      />
                    );
                  })}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <div className="h-[220px] flex items-center justify-center text-muted-foreground">
            {isLoading ? 'Laden...' : `Geen trades in de afgelopen ${hoursToShow} uur`}
          </div>
        )}

        {/* Legend */}
        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          <div className="flex items-center gap-1">
            <div className="w-3 h-3 rounded bg-green-500/80" />
            <span>Settled Profit</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-3 h-3 rounded bg-red-500/80" />
            <span>Settled Loss</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-3 h-3 rounded bg-cyan-500/80" />
            <span>Expected Profit</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-3 h-3 rounded bg-orange-500/80" />
            <span>Expected Loss</span>
          </div>
        </div>

        {/* Best/Worst Hour */}
        {(stats.settledCount > 0 || stats.openCount > 0) && (
          <div className="grid grid-cols-2 gap-4 pt-2 border-t">
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="bg-green-500/10 text-green-500 border-green-500/30">
                Beste Uur
              </Badge>
              <span className="text-sm font-mono">
                {stats.bestHour?.hour}: +${Math.max(0, stats.bestHour?.totalPnl || 0).toFixed(2)}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="bg-red-500/10 text-red-500 border-red-500/30">
                Slechtste Uur
              </Badge>
              <span className="text-sm font-mono">
                {stats.worstHour?.hour}: ${Math.min(0, stats.worstHour?.totalPnl || 0).toFixed(2)}
              </span>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
