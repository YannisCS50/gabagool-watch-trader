import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { 
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, 
  LineChart, Line, Legend, Cell, PieChart, Pie 
} from 'recharts';
import { Shield, TrendingUp, TrendingDown, AlertTriangle, CheckCircle, XCircle, Activity, Calendar, Download, Loader2 } from 'lucide-react';
import { format } from 'date-fns';
import { toast } from 'sonner';

// Go-live timestamp for the toxicity filter
const TOXICITY_FILTER_GO_LIVE = new Date('2026-01-11T00:00:00Z');

interface ToxicityFeature {
  id: string;
  market_id: string;
  market_slug: string;
  asset: string;
  market_start_time: string;
  classification: string;
  decision: string;
  confidence: string;
  toxicity_score: number | null;
  liquidity_pull_detected: boolean;
  outcome: string | null;
  pnl: number | null;
  n_ticks: number;
  data_quality: string;
  ask_volatility: number | null;
  ask_change_count: number | null;
  spread_volatility: number | null;
  filter_version: string;
}

interface V26Trade {
  id: string;
  asset: string;
  market_slug: string;
  status: string;
  result: string | null;
  pnl: number | null;
  created_at: string;
  settled_at: string | null;
}

function useHistoricalTrades() {
  return useQuery({
    queryKey: ['v26-trades-historical'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('v26_trades')
        .select('*')
        .not('result', 'is', null)
        .lt('created_at', TOXICITY_FILTER_GO_LIVE.toISOString())
        .order('created_at', { ascending: false });
      
      if (error) throw error;
      return (data || []) as V26Trade[];
    },
    staleTime: 60_000,
  });
}

function useToxicityFeatures() {
  return useQuery({
    queryKey: ['toxicity-features'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('toxicity_features')
        .select('*')
        .order('market_start_time', { ascending: false })
        .limit(500);
      
      if (error) throw error;
      return (data || []) as ToxicityFeature[];
    },
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

function useNewTrades() {
  return useQuery({
    queryKey: ['v26-trades-new'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('v26_trades')
        .select('*')
        .gte('created_at', TOXICITY_FILTER_GO_LIVE.toISOString())
        .order('created_at', { ascending: false });
      
      if (error) throw error;
      return (data || []) as V26Trade[];
    },
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

function calculateStats(trades: V26Trade[]) {
  const settled = trades.filter(t => t.result);
  const wins = settled.filter(t => t.result === 'WIN');
  const losses = settled.filter(t => t.result === 'LOSS');
  const totalPnl = settled.reduce((sum, t) => sum + (t.pnl || 0), 0);
  const avgPnl = settled.length > 0 ? totalPnl / settled.length : 0;
  
  return {
    total: trades.length,
    settled: settled.length,
    wins: wins.length,
    losses: losses.length,
    winRate: settled.length > 0 ? (wins.length / settled.length) * 100 : 0,
    totalPnl,
    avgPnl,
  };
}

function StatComparison({ 
  label, 
  before, 
  after, 
  format: formatFn = (v: number) => v.toFixed(1),
  higherIsBetter = true 
}: { 
  label: string; 
  before: number; 
  after: number; 
  format?: (v: number) => string;
  higherIsBetter?: boolean;
}) {
  const diff = after - before;
  const isImproved = higherIsBetter ? diff > 0 : diff < 0;
  const diffPct = before !== 0 ? ((diff / Math.abs(before)) * 100) : 0;
  
  return (
    <div className="flex items-center justify-between py-2 border-b border-border/50 last:border-0">
      <span className="text-sm text-muted-foreground">{label}</span>
      <div className="flex items-center gap-4">
        <span className="text-sm text-muted-foreground">{formatFn(before)}</span>
        <span className="text-muted-foreground">→</span>
        <span className="text-sm font-medium">{formatFn(after)}</span>
        {diff !== 0 && (
          <Badge variant={isImproved ? 'default' : 'destructive'} className="text-xs">
            {diff > 0 ? '+' : ''}{formatFn(diff)} ({diffPct > 0 ? '+' : ''}{diffPct.toFixed(0)}%)
          </Badge>
        )}
      </div>
    </div>
  );
}

export default function ToxicityFilterDashboard() {
  const { data: historicalTrades = [], isLoading: loadingHistorical } = useHistoricalTrades();
  const { data: newTrades = [], isLoading: loadingNew } = useNewTrades();
  const { data: toxicityFeatures = [], isLoading: loadingFeatures } = useToxicityFeatures();
  
  const [activeTab, setActiveTab] = useState('overview');
  const [isExporting, setIsExporting] = useState(false);
  
  const beforeStats = useMemo(() => calculateStats(historicalTrades), [historicalTrades]);
  const afterStats = useMemo(() => calculateStats(newTrades), [newTrades]);
  
  // Filter decisions breakdown
  const decisionBreakdown = useMemo(() => {
    const counts = { TRADE: 0, REDUCED: 0, SKIP: 0, PENDING: 0 };
    toxicityFeatures.forEach(f => {
      if (f.decision in counts) counts[f.decision as keyof typeof counts]++;
    });
    return Object.entries(counts).map(([name, value]) => ({ name, value }));
  }, [toxicityFeatures]);
  
  // Classification breakdown
  const classificationBreakdown = useMemo(() => {
    const counts = { HEALTHY: 0, BORDERLINE: 0, TOXIC: 0, UNKNOWN: 0 };
    toxicityFeatures.forEach(f => {
      if (f.classification in counts) counts[f.classification as keyof typeof counts]++;
    });
    return Object.entries(counts).map(([name, value]) => ({ name, value }));
  }, [toxicityFeatures]);
  
  // Winrate by classification (only settled)
  const winrateByClass = useMemo(() => {
    const byClass: Record<string, { wins: number; total: number }> = {};
    toxicityFeatures.filter(f => f.outcome).forEach(f => {
      if (!byClass[f.classification]) byClass[f.classification] = { wins: 0, total: 0 };
      byClass[f.classification].total++;
      if (f.outcome === 'WIN') byClass[f.classification].wins++;
    });
    return Object.entries(byClass).map(([name, { wins, total }]) => ({
      name,
      winRate: total > 0 ? (wins / total) * 100 : 0,
      total,
    }));
  }, [toxicityFeatures]);
  
  // Liquidity pull impact
  const liquidityPullImpact = useMemo(() => {
    const withPull = toxicityFeatures.filter(f => f.liquidity_pull_detected && f.outcome);
    const withoutPull = toxicityFeatures.filter(f => !f.liquidity_pull_detected && f.outcome);
    
    const pullWins = withPull.filter(f => f.outcome === 'WIN').length;
    const noPullWins = withoutPull.filter(f => f.outcome === 'WIN').length;
    
    return [
      { 
        name: 'With Liquidity Pull', 
        winRate: withPull.length > 0 ? (pullWins / withPull.length) * 100 : 0,
        count: withPull.length,
      },
      { 
        name: 'Without Liquidity Pull', 
        winRate: withoutPull.length > 0 ? (noPullWins / withoutPull.length) * 100 : 0,
        count: withoutPull.length,
      },
    ];
  }, [toxicityFeatures]);

  const isLoading = loadingHistorical || loadingNew || loadingFeatures;
  const isLive = new Date() >= TOXICITY_FILTER_GO_LIVE;
  
  const COLORS = {
    HEALTHY: 'hsl(var(--chart-2))',
    BORDERLINE: 'hsl(var(--chart-4))',
    TOXIC: 'hsl(var(--chart-1))',
    UNKNOWN: 'hsl(var(--muted))',
    TRADE: 'hsl(var(--chart-2))',
    REDUCED: 'hsl(var(--chart-4))',
    SKIP: 'hsl(var(--chart-1))',
    PENDING: 'hsl(var(--muted))',
  };

  const handleExportCSV = async () => {
    setIsExporting(true);
    try {
      // Fetch ALL toxicity features (not just the 500 limit)
      const { data: allFeatures, error } = await supabase
        .from('toxicity_features')
        .select('*')
        .order('market_start_time', { ascending: false });

      if (error) throw error;

      const features = (allFeatures || []) as ToxicityFeature[];
      
      if (features.length === 0) {
        toast.error('No data to export');
        return;
      }

      // CSV header
      const headers = [
        'market_id',
        'market_slug',
        'asset',
        'market_start_time',
        'classification',
        'decision',
        'confidence',
        'toxicity_score',
        'liquidity_pull_detected',
        'outcome',
        'pnl',
        'n_ticks',
        'data_quality',
        'ask_volatility',
        'ask_change_count',
        'spread_volatility',
        'filter_version',
      ];

      const csvRows = [headers.join(',')];

      for (const f of features) {
        const row = [
          f.market_id,
          f.market_slug,
          f.asset,
          f.market_start_time,
          f.classification,
          f.decision,
          f.confidence,
          f.toxicity_score ?? '',
          f.liquidity_pull_detected,
          f.outcome ?? '',
          f.pnl ?? '',
          f.n_ticks,
          f.data_quality,
          f.ask_volatility ?? '',
          f.ask_change_count ?? '',
          f.spread_volatility ?? '',
          f.filter_version ?? '',
        ];
        csvRows.push(row.map(v => `"${v}"`).join(','));
      }

      const csv = csvRows.join('\n');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `toxicity-filter-export-${format(new Date(), 'yyyy-MM-dd-HHmm')}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      toast.success(`Exported ${features.length} records`);
    } catch (err) {
      console.error('Export error:', err);
      toast.error('Export failed');
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Shield className="h-6 w-6 text-primary" />
          <div>
            <h2 className="text-xl font-semibold">Toxicity Filter A/B Comparison</h2>
            <p className="text-sm text-muted-foreground">
              Comparing performance before vs. after filter activation
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleExportCSV}
            disabled={isExporting || toxicityFeatures.length === 0}
            className="gap-1.5"
          >
            {isExporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            Export CSV
          </Button>
          <Badge variant={isLive ? 'default' : 'secondary'} className="gap-1">
            {isLive ? <CheckCircle className="h-3 w-3" /> : <Calendar className="h-3 w-3" />}
            {isLive ? 'LIVE' : 'Pending'}
          </Badge>
          <span className="text-xs text-muted-foreground">
            Go-live: {format(TOXICITY_FILTER_GO_LIVE, 'PPp')}
          </span>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Before Filter</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{beforeStats.winRate.toFixed(1)}%</div>
            <p className="text-xs text-muted-foreground">
              {beforeStats.wins}W / {beforeStats.losses}L ({beforeStats.settled} settled)
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">After Filter</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {afterStats.settled > 0 ? `${afterStats.winRate.toFixed(1)}%` : '—'}
            </div>
            <p className="text-xs text-muted-foreground">
              {afterStats.wins}W / {afterStats.losses}L ({afterStats.settled} settled)
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Markets Filtered</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {toxicityFeatures.filter(f => f.decision === 'SKIP').length}
            </div>
            <p className="text-xs text-muted-foreground">
              of {toxicityFeatures.length} analyzed
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Liquidity Pulls</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-destructive">
              {toxicityFeatures.filter(f => f.liquidity_pull_detected).length}
            </div>
            <p className="text-xs text-muted-foreground">
              toxic signals detected
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Main Content Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="comparison">Before vs After</TabsTrigger>
          <TabsTrigger value="features">Feature Analysis</TabsTrigger>
          <TabsTrigger value="decisions">Decisions Log</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-4">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Decision Breakdown */}
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Filter Decisions</CardTitle>
              </CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={200}>
                  <PieChart>
                    <Pie
                      data={decisionBreakdown}
                      cx="50%"
                      cy="50%"
                      innerRadius={40}
                      outerRadius={80}
                      dataKey="value"
                      label={({ name, value }) => `${name}: ${value}`}
                    >
                      {decisionBreakdown.map((entry) => (
                        <Cell key={entry.name} fill={COLORS[entry.name as keyof typeof COLORS] || 'hsl(var(--muted))'} />
                      ))}
                    </Pie>
                    <Tooltip />
                  </PieChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>

            {/* Classification Breakdown */}
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Market Classifications</CardTitle>
              </CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart data={classificationBreakdown}>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                    <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                    <YAxis tick={{ fontSize: 12 }} />
                    <Tooltip />
                    <Bar dataKey="value" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]}>
                      {classificationBreakdown.map((entry) => (
                        <Cell key={entry.name} fill={COLORS[entry.name as keyof typeof COLORS] || 'hsl(var(--muted))'} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          </div>

          {/* Winrate by Classification */}
          {winrateByClass.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Winrate by Classification (Settled Only)</CardTitle>
                <CardDescription>Validates if classification correlates with outcome</CardDescription>
              </CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart data={winrateByClass}>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                    <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                    <YAxis domain={[0, 100]} tick={{ fontSize: 12 }} />
                    <Tooltip formatter={(value: number) => `${value.toFixed(1)}%`} />
                    <Bar dataKey="winRate" fill="hsl(var(--chart-2))" radius={[4, 4, 0, 0]}>
                      {winrateByClass.map((entry) => (
                        <Cell key={entry.name} fill={COLORS[entry.name as keyof typeof COLORS] || 'hsl(var(--muted))'} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="comparison" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Performance Comparison</CardTitle>
              <CardDescription>Before toxicity filter vs. after activation</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              <StatComparison 
                label="Win Rate" 
                before={beforeStats.winRate} 
                after={afterStats.winRate}
                format={v => `${v.toFixed(1)}%`}
              />
              <StatComparison 
                label="Avg PnL per Trade" 
                before={beforeStats.avgPnl} 
                after={afterStats.avgPnl}
                format={v => `$${v.toFixed(2)}`}
              />
              <StatComparison 
                label="Total PnL" 
                before={beforeStats.totalPnl} 
                after={afterStats.totalPnl}
                format={v => `$${v.toFixed(2)}`}
              />
              <StatComparison 
                label="Trade Count" 
                before={beforeStats.total} 
                after={afterStats.total}
                format={v => v.toString()}
                higherIsBetter={false}
              />
              <StatComparison 
                label="Settled Trades" 
                before={beforeStats.settled} 
                after={afterStats.settled}
                format={v => v.toString()}
              />
            </CardContent>
          </Card>

          {/* Liquidity Pull Impact */}
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Liquidity Pull Signal Impact</CardTitle>
              <CardDescription>Comparing outcomes when liquidity pull was detected vs. not</CardDescription>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={150}>
                <BarChart data={liquidityPullImpact} layout="vertical">
                  <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                  <XAxis type="number" domain={[0, 100]} tick={{ fontSize: 12 }} />
                  <YAxis type="category" dataKey="name" tick={{ fontSize: 12 }} width={150} />
                  <Tooltip formatter={(value: number) => `${value.toFixed(1)}%`} />
                  <Bar dataKey="winRate" fill="hsl(var(--primary))" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="features" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Feature Distributions</CardTitle>
              <CardDescription>Toxicity feature values across analyzed markets</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="space-y-1">
                  <span className="text-xs text-muted-foreground">Avg Toxicity Score</span>
                  <div className="text-lg font-semibold">
                    {toxicityFeatures.length > 0 
                      ? (toxicityFeatures.reduce((s, f) => s + (f.toxicity_score || 0), 0) / toxicityFeatures.length).toFixed(2)
                      : '—'}
                  </div>
                </div>
                <div className="space-y-1">
                  <span className="text-xs text-muted-foreground">Avg Ask Volatility</span>
                  <div className="text-lg font-semibold">
                    {toxicityFeatures.filter(f => f.ask_volatility).length > 0 
                      ? (toxicityFeatures.reduce((s, f) => s + (f.ask_volatility || 0), 0) / toxicityFeatures.filter(f => f.ask_volatility).length).toFixed(4)
                      : '—'}
                  </div>
                </div>
                <div className="space-y-1">
                  <span className="text-xs text-muted-foreground">Avg Ticks Collected</span>
                  <div className="text-lg font-semibold">
                    {toxicityFeatures.length > 0 
                      ? Math.round(toxicityFeatures.reduce((s, f) => s + f.n_ticks, 0) / toxicityFeatures.length)
                      : '—'}
                  </div>
                </div>
                <div className="space-y-1">
                  <span className="text-xs text-muted-foreground">Good Data Quality</span>
                  <div className="text-lg font-semibold">
                    {toxicityFeatures.length > 0 
                      ? `${((toxicityFeatures.filter(f => f.data_quality === 'GOOD').length / toxicityFeatures.length) * 100).toFixed(0)}%`
                      : '—'}
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="decisions" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Recent Filter Decisions</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="max-h-[400px] overflow-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Time</TableHead>
                      <TableHead>Asset</TableHead>
                      <TableHead>Market</TableHead>
                      <TableHead>Score</TableHead>
                      <TableHead>Classification</TableHead>
                      <TableHead>Decision</TableHead>
                      <TableHead>Outcome</TableHead>
                      <TableHead>PnL</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {toxicityFeatures.slice(0, 50).map((f) => (
                      <TableRow key={f.id}>
                        <TableCell className="text-xs">
                          {format(new Date(f.market_start_time), 'MM/dd HH:mm')}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline">{f.asset}</Badge>
                        </TableCell>
                        <TableCell className="text-xs max-w-[150px] truncate">
                          {f.market_slug}
                        </TableCell>
                        <TableCell className="font-mono text-xs">
                          {f.toxicity_score?.toFixed(2) ?? '—'}
                        </TableCell>
                        <TableCell>
                          <Badge 
                            variant={f.classification === 'HEALTHY' ? 'default' : f.classification === 'TOXIC' ? 'destructive' : 'secondary'}
                          >
                            {f.classification}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          {f.decision === 'TRADE' && <CheckCircle className="h-4 w-4 text-green-500" />}
                          {f.decision === 'REDUCED' && <AlertTriangle className="h-4 w-4 text-yellow-500" />}
                          {f.decision === 'SKIP' && <XCircle className="h-4 w-4 text-red-500" />}
                        </TableCell>
                        <TableCell>
                          {f.outcome ? (
                            <Badge variant={f.outcome === 'WIN' ? 'default' : 'destructive'}>
                              {f.outcome}
                            </Badge>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className={`font-mono text-xs ${f.pnl && f.pnl > 0 ? 'text-green-500' : f.pnl && f.pnl < 0 ? 'text-red-500' : ''}`}>
                          {f.pnl ? `$${f.pnl.toFixed(2)}` : '—'}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
