import React, { useMemo, useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { TrendingUp, TrendingDown, RefreshCw, DollarSign, Clock } from 'lucide-react';
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
  created_at: string;
}

interface HourlyPnLData {
  hour: string;
  hourStart: Date;
  pnl: number;
  count: number;
  assets: string[];
}

interface LiveHourlyPnLChartProps {
  defaultHours?: number;
}

export function LiveHourlyPnLChart({ defaultHours = 24 }: LiveHourlyPnLChartProps) {
  const [settlements, setSettlements] = useState<SettlementLog[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date());
  const [hoursToShow, setHoursToShow] = useState(defaultHours);

  const fetchData = async () => {
    setIsLoading(true);
    try {
      const cutoffTime = subHours(new Date(), hoursToShow);
      const cutoffTs = Math.floor(cutoffTime.getTime() / 1000);
      
      const { data, error } = await supabase
        .from('settlement_logs')
        .select('id, ts, iso, asset, realized_pnl, theoretical_pnl, pair_cost, total_payout_usd, winning_side, created_at')
        .gte('ts', cutoffTs)
        .order('ts', { ascending: false });

      if (error) throw error;
      
      setSettlements(data || []);
      setLastRefresh(new Date());
    } catch (err) {
      console.error('Error fetching settlement data:', err);
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
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [hoursToShow]);

  const hourlyData = useMemo(() => {
    const now = new Date();
    const hours: HourlyPnLData[] = [];

    // Create hour buckets
    for (let i = hoursToShow - 1; i >= 0; i--) {
      const hourStart = startOfHour(subHours(now, i));
      hours.push({
        hour: format(hourStart, 'HH:mm', { locale: nl }),
        hourStart,
        pnl: 0,
        count: 0,
        assets: [],
      });
    }

    // Aggregate settlements into hourly buckets
    settlements.forEach((settlement) => {
      const settlementTime = new Date(settlement.ts * 1000);
      const pnl = settlement.realized_pnl ?? settlement.theoretical_pnl ?? 0;
      
      for (let i = 0; i < hours.length; i++) {
        const hourStart = hours[i].hourStart;
        const hourEnd = endOfHour(hourStart);
        
        if (settlementTime >= hourStart && settlementTime <= hourEnd) {
          hours[i].pnl += pnl;
          hours[i].count += 1;
          if (!hours[i].assets.includes(settlement.asset)) {
            hours[i].assets.push(settlement.asset);
          }
          break;
        }
      }
    });

    return hours;
  }, [settlements, hoursToShow]);

  const stats = useMemo(() => {
    const totalPnL = hourlyData.reduce((sum, h) => sum + h.pnl, 0);
    const totalCount = hourlyData.reduce((sum, h) => sum + h.count, 0);
    const profitableHours = hourlyData.filter(h => h.pnl > 0).length;
    const losingHours = hourlyData.filter(h => h.pnl < 0).length;
    const bestHour = hourlyData.reduce((best, h) => h.pnl > best.pnl ? h : best, hourlyData[0]);
    const worstHour = hourlyData.reduce((worst, h) => h.pnl < worst.pnl ? h : worst, hourlyData[0]);
    const activeHours = hourlyData.filter(h => h.count > 0).length;
    const avgPnlPerHour = activeHours > 0 ? totalPnL / activeHours : 0;

    return { totalPnL, totalCount, profitableHours, losingHours, bestHour, worstHour, avgPnlPerHour, activeHours };
  }, [hourlyData]);

  const CustomTooltip = ({ active, payload }: any) => {
    if (active && payload && payload.length) {
      const data = payload[0].payload as HourlyPnLData;
      const isProfitable = data.pnl >= 0;
      
      return (
        <div className="bg-background/95 backdrop-blur-sm border rounded-lg p-3 shadow-lg">
          <p className="font-semibold flex items-center gap-2">
            <Clock className="w-4 h-4" />
            {data.hour} - {format(endOfHour(data.hourStart), 'HH:mm', { locale: nl })}
          </p>
          <div className="mt-2 space-y-1">
            <p className={`font-bold ${isProfitable ? 'text-green-500' : 'text-red-500'}`}>
              P/L: {isProfitable ? '+' : ''}${data.pnl.toFixed(2)}
            </p>
            <p className="text-muted-foreground text-sm">Settlements: {data.count}</p>
            {data.assets.length > 0 && (
              <p className="text-muted-foreground text-sm">
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
          {stats.totalCount} settlements in {hoursToShow}u
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Stats Grid */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 text-sm">
          <div className={`rounded-lg p-2 ${stats.totalPnL >= 0 ? 'bg-green-500/10' : 'bg-red-500/10'}`}>
            <div className="text-muted-foreground">Totaal P/L</div>
            <div className={`font-bold ${stats.totalPnL >= 0 ? 'text-green-500' : 'text-red-500'}`}>
              {stats.totalPnL >= 0 ? '+' : ''}${stats.totalPnL.toFixed(2)}
            </div>
          </div>
          <div className="bg-muted/50 rounded-lg p-2">
            <div className="text-muted-foreground">Settlements</div>
            <div className="font-semibold">{stats.totalCount}</div>
          </div>
          <div className="bg-muted/50 rounded-lg p-2">
            <div className="text-muted-foreground">Profit Uren</div>
            <div className="font-semibold text-green-500">{stats.profitableHours}</div>
          </div>
          <div className="bg-muted/50 rounded-lg p-2">
            <div className="text-muted-foreground">Loss Uren</div>
            <div className="font-semibold text-red-500">{stats.losingHours}</div>
          </div>
          <div className="bg-muted/50 rounded-lg p-2">
            <div className="text-muted-foreground">Gem./Actief Uur</div>
            <div className={`font-semibold ${stats.avgPnlPerHour >= 0 ? 'text-green-500' : 'text-red-500'}`}>
              {stats.avgPnlPerHour >= 0 ? '+' : ''}${stats.avgPnlPerHour.toFixed(2)}
            </div>
          </div>
        </div>

        {/* P/L Chart */}
        {stats.totalCount > 0 ? (
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
                <Bar dataKey="pnl" radius={[2, 2, 0, 0]} name="P/L">
                  {hourlyData.map((entry, index) => (
                    <Cell
                      key={`cell-${index}`}
                      fill={entry.pnl > 0 
                        ? 'hsl(142, 76%, 36%)' 
                        : entry.pnl < 0 
                          ? 'hsl(0, 84%, 60%)' 
                          : 'hsl(var(--muted))'}
                      opacity={entry.count > 0 ? 0.85 : 0.2}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <div className="h-[220px] flex items-center justify-center text-muted-foreground">
            {isLoading ? 'Laden...' : `Geen settlements in de afgelopen ${hoursToShow} uur`}
          </div>
        )}

        {/* Best/Worst Hour */}
        {stats.totalCount > 0 && (
          <div className="grid grid-cols-2 gap-4 pt-2 border-t">
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="bg-green-500/10 text-green-500 border-green-500/30">
                Beste Uur
              </Badge>
              <span className="text-sm font-mono">
                {stats.bestHour?.hour}: +${stats.bestHour?.pnl.toFixed(2)}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="bg-red-500/10 text-red-500 border-red-500/30">
                Slechtste Uur
              </Badge>
              <span className="text-sm font-mono">
                {stats.worstHour?.hour}: ${stats.worstHour?.pnl.toFixed(2)}
              </span>
            </div>
          </div>
        )}

        {/* Hourly Breakdown Table */}
        {stats.totalCount > 0 && (
          <div className="pt-2 border-t">
            <div className="text-xs font-semibold text-muted-foreground mb-2">Uur-voor-uur breakdown</div>
            <div className="max-h-[200px] overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-background">
                  <tr className="text-muted-foreground border-b border-border/50">
                    <th className="text-left pb-2 font-medium">Uur</th>
                    <th className="text-right pb-2 font-medium">Settlements</th>
                    <th className="text-right pb-2 font-medium">Assets</th>
                    <th className="text-right pb-2 font-medium">P/L</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/30">
                  {[...hourlyData].reverse().filter(h => h.count > 0).map(h => (
                    <tr key={h.hour} className="hover:bg-muted/30">
                      <td className="py-1.5 font-mono">{h.hour}</td>
                      <td className="py-1.5 text-right font-mono">{h.count}</td>
                      <td className="py-1.5 text-right text-muted-foreground">{h.assets.join(', ')}</td>
                      <td className={`py-1.5 text-right font-mono font-medium ${h.pnl >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                        {h.pnl >= 0 ? '+' : ''}${h.pnl.toFixed(2)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
