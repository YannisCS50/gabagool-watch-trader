import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { supabase } from '@/integrations/supabase/client';
import { CheckCircle2, XCircle, TrendingUp, AlertTriangle, Activity } from 'lucide-react';
import { format } from 'date-fns';

interface HedgeFeasibility {
  id: string;
  market_id: string;
  asset: string;
  opening_side: string;
  opening_price: number;
  opening_shares: number;
  opening_at: string;
  hedge_side: string;
  max_hedge_price: number;
  min_hedge_ask_seen: number | null;
  min_hedge_ask_at: string | null;
  hedge_window_seconds: number | null;
  was_hedged: boolean;
  actual_hedge_price: number | null;
  actual_hedge_at: string | null;
  hedge_was_possible: boolean;
  hedge_was_profitable: boolean;
  event_end_time: string | null;
  created_at: string;
}

interface SummaryStats {
  total: number;
  hedgeable: number;
  notHedgeable: number;
  actuallyHedged: number;
  missedOpportunities: number;
  profitableHedges: number;
  hedgeablePercent: number;
}

export function HedgeFeasibilityDashboard() {
  const [data, setData] = useState<HedgeFeasibility[]>([]);
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState<SummaryStats | null>(null);

  const fetchData = async () => {
    const { data: feasibility, error } = await supabase
      .from('hedge_feasibility')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(200);

    if (error) {
      console.error('Error fetching hedge feasibility:', error);
      return;
    }

    // Cast to our interface since types haven't regenerated yet
    const typedData = (feasibility || []) as unknown as HedgeFeasibility[];
    setData(typedData);

    // Calculate stats
    const total = typedData.length;
    const hedgeable = typedData.filter(d => d.hedge_was_possible).length;
    const notHedgeable = total - hedgeable;
    const actuallyHedged = typedData.filter(d => d.was_hedged).length;
    const missedOpportunities = typedData.filter(d => d.hedge_was_possible && !d.was_hedged).length;
    const profitableHedges = typedData.filter(d => d.hedge_was_profitable).length;

    setStats({
      total,
      hedgeable,
      notHedgeable,
      actuallyHedged,
      missedOpportunities,
      profitableHedges,
      hedgeablePercent: total > 0 ? (hedgeable / total) * 100 : 0,
    });

    setLoading(false);
  };

  useEffect(() => {
    fetchData();

    // Subscribe to realtime updates
    const channel = supabase
      .channel('hedge-feasibility-changes')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'hedge_feasibility' },
        () => fetchData()
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  if (loading) {
    return (
      <Card>
        <CardContent className="p-6">
          <div className="flex items-center gap-2 text-muted-foreground">
            <Activity className="h-4 w-4 animate-pulse" />
            Loading hedge feasibility data...
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {/* Summary Stats */}
      <div className="grid gap-4 md:grid-cols-5">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total Bets</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats?.total ?? 0}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-1">
              <CheckCircle2 className="h-4 w-4 text-green-500" />
              Hedgeable
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-600">{stats?.hedgeable ?? 0}</div>
            <div className="text-xs text-muted-foreground">
              {stats?.hedgeablePercent.toFixed(1)}%
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-1">
              <XCircle className="h-4 w-4 text-red-500" />
              Not Hedgeable
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-red-600">{stats?.notHedgeable ?? 0}</div>
            <div className="text-xs text-muted-foreground">
              {stats && stats.total > 0 ? ((stats.notHedgeable / stats.total) * 100).toFixed(1) : 0}%
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-1">
              <TrendingUp className="h-4 w-4 text-blue-500" />
              Actually Hedged
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-blue-600">{stats?.actuallyHedged ?? 0}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-1">
              <AlertTriangle className="h-4 w-4 text-yellow-500" />
              Missed
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-yellow-600">{stats?.missedOpportunities ?? 0}</div>
          </CardContent>
        </Card>
      </div>

      {/* Headline Summary */}
      <Card className="bg-gradient-to-r from-primary/5 to-primary/10 border-primary/20">
        <CardContent className="p-6">
          <div className="text-2xl font-bold text-center">
            {stats?.total ?? 0} bets: {stats?.hedgeable ?? 0} mogelijk, {stats?.notHedgeable ?? 0} niet
          </div>
          <div className="text-center text-muted-foreground mt-1">
            {stats && stats.hedgeable > 0 && (
              <span>
                Van de hedgeable bets: {stats.actuallyHedged} werkelijk gehedged, {stats.missedOpportunities} gemist
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Recent Records */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Recente Hedge Analyse</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b">
                  <th className="text-left py-2 px-2">Market</th>
                  <th className="text-left py-2 px-2">Asset</th>
                  <th className="text-right py-2 px-2">Opening</th>
                  <th className="text-right py-2 px-2">Max Hedge</th>
                  <th className="text-right py-2 px-2">Min Ask Gezien</th>
                  <th className="text-center py-2 px-2">Mogelijk?</th>
                  <th className="text-center py-2 px-2">Gehedged?</th>
                  <th className="text-left py-2 px-2">Tijd</th>
                </tr>
              </thead>
              <tbody>
                {data.slice(0, 20).map((row) => {
                  const maxHedge = row.max_hedge_price * 100;
                  const minAsk = row.min_hedge_ask_seen ? row.min_hedge_ask_seen * 100 : null;
                  const opening = row.opening_price * 100;
                  
                  return (
                    <tr key={row.id} className="border-b border-border/50 hover:bg-muted/20">
                      <td className="py-2 px-2 font-mono text-xs">
                        {row.market_id.slice(-15)}
                      </td>
                      <td className="py-2 px-2">
                        <Badge variant="outline">{row.asset}</Badge>
                      </td>
                      <td className="py-2 px-2 text-right">
                        {row.opening_side} @ {opening.toFixed(0)}¢
                      </td>
                      <td className="py-2 px-2 text-right text-muted-foreground">
                        ≤{maxHedge.toFixed(0)}¢
                      </td>
                      <td className="py-2 px-2 text-right">
                        {minAsk !== null ? (
                          <span className={minAsk <= maxHedge ? 'text-green-600' : 'text-red-600'}>
                            {minAsk.toFixed(0)}¢
                          </span>
                        ) : (
                          <span className="text-muted-foreground">-</span>
                        )}
                      </td>
                      <td className="py-2 px-2 text-center">
                        {row.hedge_was_possible ? (
                          <CheckCircle2 className="h-4 w-4 text-green-500 inline" />
                        ) : (
                          <XCircle className="h-4 w-4 text-red-500 inline" />
                        )}
                      </td>
                      <td className="py-2 px-2 text-center">
                        {row.was_hedged ? (
                          <Badge variant="default" className="text-xs">
                            @ {row.actual_hedge_price ? (row.actual_hedge_price * 100).toFixed(0) : '?'}¢
                          </Badge>
                        ) : (
                          <Badge variant="secondary" className="text-xs">Nee</Badge>
                        )}
                      </td>
                      <td className="py-2 px-2 text-muted-foreground text-xs">
                        {format(new Date(row.created_at), 'HH:mm:ss')}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {data.length === 0 && (
              <div className="text-center py-8 text-muted-foreground">
                Nog geen hedge feasibility data. Start de bot om te beginnen met tracking.
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
