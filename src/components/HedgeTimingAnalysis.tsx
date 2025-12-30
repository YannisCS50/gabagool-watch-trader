import { useState, useEffect, useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { supabase } from '@/integrations/supabase/client';
import { Loader2, TrendingUp, TrendingDown, Clock, Target, Zap } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ScatterChart, Scatter, Cell, Legend } from 'recharts';

interface Trade {
  market_slug: string;
  asset: string;
  outcome: string;
  price: number;
  shares: number;
  total: number;
  reasoning: string;
  created_at: string;
  event_start_time: string;
}

interface TradeResult {
  market_slug: string;
  asset: string;
  up_shares: number;
  down_shares: number;
  up_cost: number;
  down_cost: number;
  total_invested: number;
  result: string;
  payout: number;
  profit_loss: number;
  profit_loss_percent: number;
}

interface MarketAnalysis {
  market_slug: string;
  asset: string;
  firstTradeTime: number; // seconds after open
  hedgeTime: number | null; // seconds after open
  isHedged: boolean;
  trades: Trade[];
  accumulationTrades: number;
  totalInvested: number;
  result?: string;
  profitLoss?: number;
  profitLossPercent?: number;
  payout?: number;
}

export function HedgeTimingAnalysis() {
  const [trades, setTrades] = useState<Trade[]>([]);
  const [results, setResults] = useState<TradeResult[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchData() {
      setLoading(true);
      
      const [tradesRes, resultsRes] = await Promise.all([
        supabase
          .from('live_trades')
          .select('market_slug, asset, outcome, price, shares, total, reasoning, created_at, event_start_time')
          .not('event_start_time', 'is', null)
          .order('created_at', { ascending: true }),
        supabase
          .from('live_trade_results')
          .select('market_slug, asset, up_shares, down_shares, up_cost, down_cost, total_invested, result, payout, profit_loss, profit_loss_percent')
          .not('settled_at', 'is', null)
      ]);

      if (tradesRes.data) setTrades(tradesRes.data as Trade[]);
      if (resultsRes.data) setResults(resultsRes.data as TradeResult[]);
      setLoading(false);
    }
    fetchData();
  }, []);

  const analysis = useMemo(() => {
    if (!trades.length) return null;

    // Group trades by market
    const marketMap = new Map<string, Trade[]>();
    trades.forEach(t => {
      const existing = marketMap.get(t.market_slug) || [];
      existing.push(t);
      marketMap.set(t.market_slug, existing);
    });

    // Build results map
    const resultsMap = new Map<string, TradeResult>();
    results.forEach(r => resultsMap.set(r.market_slug, r));

    const marketAnalyses: MarketAnalysis[] = [];

    marketMap.forEach((marketTrades, slug) => {
      // Sort by time
      marketTrades.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
      
      const firstTrade = marketTrades[0];
      const eventStart = new Date(firstTrade.event_start_time).getTime();
      const firstTradeTime = (new Date(firstTrade.created_at).getTime() - eventStart) / 1000;
      
      // Find first trade of each outcome
      const firstUp = marketTrades.find(t => t.outcome === 'UP');
      const firstDown = marketTrades.find(t => t.outcome === 'DOWN');
      
      let hedgeTime: number | null = null;
      let isHedged = false;
      
      if (firstUp && firstDown) {
        isHedged = true;
        // Hedge is the later of the two first trades
        const upTime = new Date(firstUp.created_at).getTime();
        const downTime = new Date(firstDown.created_at).getTime();
        hedgeTime = (Math.max(upTime, downTime) - eventStart) / 1000;
      }

      // Count accumulation trades (trades after initial position on same side)
      const outcomeCounts: Record<string, number> = { UP: 0, DOWN: 0 };
      let accumulationTrades = 0;
      marketTrades.forEach(t => {
        outcomeCounts[t.outcome]++;
        if (outcomeCounts[t.outcome] > 1 && !isHedged) {
          accumulationTrades++;
        } else if (isHedged && outcomeCounts.UP > 1 && outcomeCounts.DOWN > 1) {
          accumulationTrades++;
        }
      });

      const totalInvested = marketTrades.reduce((sum, t) => sum + t.total, 0);
      const result = resultsMap.get(slug);

      marketAnalyses.push({
        market_slug: slug,
        asset: firstTrade.asset,
        firstTradeTime: Math.max(0, firstTradeTime),
        hedgeTime: hedgeTime !== null ? Math.max(0, hedgeTime) : null,
        isHedged,
        trades: marketTrades,
        accumulationTrades: marketTrades.length - (isHedged ? 2 : 1),
        totalInvested,
        result: result?.result,
        profitLoss: result?.profit_loss,
        profitLossPercent: result?.profit_loss_percent,
        payout: result?.payout
      });
    });

    // Filter to settled markets only for P/L analysis
    const settledMarkets = marketAnalyses.filter(m => m.profitLoss !== undefined);
    
    // Hedged vs Unhedged comparison
    const hedgedMarkets = settledMarkets.filter(m => m.isHedged);
    const unhedgedMarkets = settledMarkets.filter(m => !m.isHedged);
    
    const hedgedStats = {
      count: hedgedMarkets.length,
      totalPL: hedgedMarkets.reduce((s, m) => s + (m.profitLoss || 0), 0),
      avgPL: hedgedMarkets.length ? hedgedMarkets.reduce((s, m) => s + (m.profitLoss || 0), 0) / hedgedMarkets.length : 0,
      avgPLPercent: hedgedMarkets.length ? hedgedMarkets.reduce((s, m) => s + (m.profitLossPercent || 0), 0) / hedgedMarkets.length : 0,
      winRate: hedgedMarkets.length ? (hedgedMarkets.filter(m => (m.profitLoss || 0) > 0).length / hedgedMarkets.length) * 100 : 0,
      avgHedgeTime: hedgedMarkets.length ? hedgedMarkets.reduce((s, m) => s + (m.hedgeTime || 0), 0) / hedgedMarkets.length : 0
    };

    const unhedgedStats = {
      count: unhedgedMarkets.length,
      totalPL: unhedgedMarkets.reduce((s, m) => s + (m.profitLoss || 0), 0),
      avgPL: unhedgedMarkets.length ? unhedgedMarkets.reduce((s, m) => s + (m.profitLoss || 0), 0) / unhedgedMarkets.length : 0,
      avgPLPercent: unhedgedMarkets.length ? unhedgedMarkets.reduce((s, m) => s + (m.profitLossPercent || 0), 0) / unhedgedMarkets.length : 0,
      winRate: unhedgedMarkets.length ? (unhedgedMarkets.filter(m => (m.profitLoss || 0) > 0).length / unhedgedMarkets.length) * 100 : 0
    };

    // Accumulation analysis
    const withAccumulation = settledMarkets.filter(m => m.accumulationTrades > 0);
    const withoutAccumulation = settledMarkets.filter(m => m.accumulationTrades === 0);

    const accumulationStats = {
      with: {
        count: withAccumulation.length,
        avgPL: withAccumulation.length ? withAccumulation.reduce((s, m) => s + (m.profitLoss || 0), 0) / withAccumulation.length : 0,
        avgPLPercent: withAccumulation.length ? withAccumulation.reduce((s, m) => s + (m.profitLossPercent || 0), 0) / withAccumulation.length : 0,
        totalPL: withAccumulation.reduce((s, m) => s + (m.profitLoss || 0), 0),
        avgTrades: withAccumulation.length ? withAccumulation.reduce((s, m) => s + m.accumulationTrades, 0) / withAccumulation.length : 0
      },
      without: {
        count: withoutAccumulation.length,
        avgPL: withoutAccumulation.length ? withoutAccumulation.reduce((s, m) => s + (m.profitLoss || 0), 0) / withoutAccumulation.length : 0,
        avgPLPercent: withoutAccumulation.length ? withoutAccumulation.reduce((s, m) => s + (m.profitLossPercent || 0), 0) / withoutAccumulation.length : 0,
        totalPL: withoutAccumulation.reduce((s, m) => s + (m.profitLoss || 0), 0)
      }
    };

    // Timing distribution
    const timingBuckets = [
      { name: '0-60s', min: 0, max: 60, hedged: 0, unhedged: 0, avgPL: 0, count: 0 },
      { name: '60-120s', min: 60, max: 120, hedged: 0, unhedged: 0, avgPL: 0, count: 0 },
      { name: '120-180s', min: 120, max: 180, hedged: 0, unhedged: 0, avgPL: 0, count: 0 },
      { name: '180-300s', min: 180, max: 300, hedged: 0, unhedged: 0, avgPL: 0, count: 0 },
      { name: '300-600s', min: 300, max: 600, hedged: 0, unhedged: 0, avgPL: 0, count: 0 },
      { name: '600s+', min: 600, max: Infinity, hedged: 0, unhedged: 0, avgPL: 0, count: 0 },
    ];

    settledMarkets.forEach(m => {
      const time = m.isHedged ? m.hedgeTime : m.firstTradeTime;
      if (time === null) return;
      
      const bucket = timingBuckets.find(b => time >= b.min && time < b.max);
      if (bucket) {
        if (m.isHedged) bucket.hedged++;
        else bucket.unhedged++;
        bucket.avgPL += m.profitLoss || 0;
        bucket.count++;
      }
    });

    timingBuckets.forEach(b => {
      if (b.count > 0) b.avgPL = b.avgPL / b.count;
    });

    // Scatter data for hedge timing vs P/L
    const scatterData = hedgedMarkets
      .filter(m => m.hedgeTime !== null && m.hedgeTime < 900 && m.hedgeTime >= 0)
      .map(m => ({
        x: m.hedgeTime,
        y: m.profitLoss || 0,
        asset: m.asset,
        slug: m.market_slug
      }));

    return {
      marketAnalyses,
      settledMarkets,
      hedgedStats,
      unhedgedStats,
      accumulationStats,
      timingBuckets,
      scatterData
    };
  }, [trades, results]);

  if (loading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center h-64">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  if (!analysis) {
    return (
      <Card>
        <CardContent className="p-6">
          <p className="text-muted-foreground">Geen trade data beschikbaar</p>
        </CardContent>
      </Card>
    );
  }

  const { hedgedStats, unhedgedStats, accumulationStats, timingBuckets, scatterData } = analysis;

  return (
    <div className="space-y-6">
      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Target className="h-4 w-4 text-green-500" />
              Gehedgede Markten
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{hedgedStats.count}</div>
            <div className="flex items-center gap-2 mt-1">
              <Badge variant={hedgedStats.totalPL >= 0 ? "default" : "destructive"}>
                ${hedgedStats.totalPL.toFixed(2)} P/L
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              Gem. hedge tijd: {hedgedStats.avgHedgeTime.toFixed(0)}s
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Zap className="h-4 w-4 text-yellow-500" />
              Niet-gehedgede Markten
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{unhedgedStats.count}</div>
            <div className="flex items-center gap-2 mt-1">
              <Badge variant={unhedgedStats.totalPL >= 0 ? "default" : "destructive"}>
                ${unhedgedStats.totalPL.toFixed(2)} P/L
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              Win rate: {unhedgedStats.winRate.toFixed(0)}%
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-blue-500" />
              Met Accumulatie
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{accumulationStats.with.count}</div>
            <div className="flex items-center gap-2 mt-1">
              <Badge variant={accumulationStats.with.totalPL >= 0 ? "default" : "destructive"}>
                ${accumulationStats.with.totalPL.toFixed(2)} P/L
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              Gem. extra trades: {accumulationStats.with.avgTrades.toFixed(1)}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <TrendingDown className="h-4 w-4 text-orange-500" />
              Zonder Accumulatie
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{accumulationStats.without.count}</div>
            <div className="flex items-center gap-2 mt-1">
              <Badge variant={accumulationStats.without.totalPL >= 0 ? "default" : "destructive"}>
                ${accumulationStats.without.totalPL.toFixed(2)} P/L
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              Gem. P/L: ${accumulationStats.without.avgPL.toFixed(2)}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Comparison Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Clock className="h-5 w-5" />
              Hedge vs Geen Hedge
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="p-4 rounded-lg bg-green-500/10 border border-green-500/20">
                  <p className="text-sm text-muted-foreground">Gehedged</p>
                  <p className="text-xl font-bold text-green-500">
                    ${hedgedStats.avgPL.toFixed(2)}
                  </p>
                  <p className="text-xs text-muted-foreground">gem. P/L per markt</p>
                  <p className="text-sm mt-2">
                    Win rate: <span className="font-medium">{hedgedStats.winRate.toFixed(0)}%</span>
                  </p>
                </div>
                <div className="p-4 rounded-lg bg-yellow-500/10 border border-yellow-500/20">
                  <p className="text-sm text-muted-foreground">Niet gehedged</p>
                  <p className={`text-xl font-bold ${unhedgedStats.avgPL >= 0 ? 'text-yellow-500' : 'text-red-500'}`}>
                    ${unhedgedStats.avgPL.toFixed(2)}
                  </p>
                  <p className="text-xs text-muted-foreground">gem. P/L per markt</p>
                  <p className="text-sm mt-2">
                    Win rate: <span className="font-medium">{unhedgedStats.winRate.toFixed(0)}%</span>
                  </p>
                </div>
              </div>
              <div className="p-3 rounded bg-muted/50">
                <p className="text-sm">
                  <strong>Conclusie:</strong> {hedgedStats.avgPL > unhedgedStats.avgPL 
                    ? `Hedgen levert gemiddeld $${(hedgedStats.avgPL - unhedgedStats.avgPL).toFixed(2)} meer op per markt`
                    : `Niet hedgen levert gemiddeld $${(unhedgedStats.avgPL - hedgedStats.avgPL).toFixed(2)} meer op per markt`
                  }
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <TrendingUp className="h-5 w-5" />
              Accumulatie Impact
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="p-4 rounded-lg bg-blue-500/10 border border-blue-500/20">
                  <p className="text-sm text-muted-foreground">Met accumulatie</p>
                  <p className={`text-xl font-bold ${accumulationStats.with.avgPL >= 0 ? 'text-blue-500' : 'text-red-500'}`}>
                    ${accumulationStats.with.avgPL.toFixed(2)}
                  </p>
                  <p className="text-xs text-muted-foreground">gem. P/L per markt</p>
                  <p className="text-sm mt-2">
                    {accumulationStats.with.avgPLPercent.toFixed(1)}% ROI
                  </p>
                </div>
                <div className="p-4 rounded-lg bg-orange-500/10 border border-orange-500/20">
                  <p className="text-sm text-muted-foreground">Zonder accumulatie</p>
                  <p className={`text-xl font-bold ${accumulationStats.without.avgPL >= 0 ? 'text-orange-500' : 'text-red-500'}`}>
                    ${accumulationStats.without.avgPL.toFixed(2)}
                  </p>
                  <p className="text-xs text-muted-foreground">gem. P/L per markt</p>
                  <p className="text-sm mt-2">
                    {accumulationStats.without.avgPLPercent.toFixed(1)}% ROI
                  </p>
                </div>
              </div>
              <div className="p-3 rounded bg-muted/50">
                <p className="text-sm">
                  <strong>Conclusie:</strong> {accumulationStats.with.avgPL > accumulationStats.without.avgPL 
                    ? `Accumulatie verbetert de winst met gemiddeld $${(accumulationStats.with.avgPL - accumulationStats.without.avgPL).toFixed(2)} per markt`
                    : `Accumulatie verslechtert de winst met gemiddeld $${(accumulationStats.without.avgPL - accumulationStats.with.avgPL).toFixed(2)} per markt`
                  }
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Timing Distributie</CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={timingBuckets}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis dataKey="name" tick={{ fill: 'hsl(var(--muted-foreground))' }} />
                <YAxis tick={{ fill: 'hsl(var(--muted-foreground))' }} />
                <Tooltip 
                  contentStyle={{ 
                    backgroundColor: 'hsl(var(--card))', 
                    border: '1px solid hsl(var(--border))',
                    borderRadius: '8px'
                  }}
                />
                <Legend />
                <Bar dataKey="hedged" name="Gehedged" fill="hsl(142, 76%, 36%)" />
                <Bar dataKey="unhedged" name="Niet gehedged" fill="hsl(48, 96%, 53%)" />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Hedge Timing vs P/L</CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={300}>
              <ScatterChart>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis 
                  dataKey="x" 
                  name="Hedge tijd (s)" 
                  tick={{ fill: 'hsl(var(--muted-foreground))' }}
                  label={{ value: 'Seconden na opening', position: 'bottom', fill: 'hsl(var(--muted-foreground))' }}
                />
                <YAxis 
                  dataKey="y" 
                  name="P/L ($)" 
                  tick={{ fill: 'hsl(var(--muted-foreground))' }}
                  label={{ value: 'P/L ($)', angle: -90, position: 'insideLeft', fill: 'hsl(var(--muted-foreground))' }}
                />
                <Tooltip 
                  contentStyle={{ 
                    backgroundColor: 'hsl(var(--card))', 
                    border: '1px solid hsl(var(--border))',
                    borderRadius: '8px'
                  }}
                  formatter={(value: number, name: string) => [
                    name === 'x' ? `${value.toFixed(0)}s` : `$${value.toFixed(2)}`,
                    name === 'x' ? 'Hedge tijd' : 'P/L'
                  ]}
                />
                <Scatter name="Trades" data={scatterData}>
                  {scatterData.map((entry, index) => (
                    <Cell 
                      key={`cell-${index}`} 
                      fill={entry.asset === 'BTC' ? 'hsl(38, 92%, 50%)' : 'hsl(231, 84%, 63%)'}
                    />
                  ))}
                </Scatter>
              </ScatterChart>
            </ResponsiveContainer>
            <div className="flex justify-center gap-4 mt-2">
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full bg-[hsl(38,92%,50%)]" />
                <span className="text-sm text-muted-foreground">BTC</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full bg-[hsl(231,84%,63%)]" />
                <span className="text-sm text-muted-foreground">ETH</span>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Detailed Stats */}
      <Card>
        <CardHeader>
          <CardTitle>Gedetailleerde Statistieken</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b">
                  <th className="text-left p-2">Categorie</th>
                  <th className="text-right p-2">Aantal</th>
                  <th className="text-right p-2">Totaal P/L</th>
                  <th className="text-right p-2">Gem. P/L</th>
                  <th className="text-right p-2">Gem. ROI %</th>
                  <th className="text-right p-2">Win Rate</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-b">
                  <td className="p-2 font-medium">Gehedged</td>
                  <td className="text-right p-2">{hedgedStats.count}</td>
                  <td className={`text-right p-2 ${hedgedStats.totalPL >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                    ${hedgedStats.totalPL.toFixed(2)}
                  </td>
                  <td className={`text-right p-2 ${hedgedStats.avgPL >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                    ${hedgedStats.avgPL.toFixed(2)}
                  </td>
                  <td className={`text-right p-2 ${hedgedStats.avgPLPercent >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                    {hedgedStats.avgPLPercent.toFixed(1)}%
                  </td>
                  <td className="text-right p-2">{hedgedStats.winRate.toFixed(0)}%</td>
                </tr>
                <tr className="border-b">
                  <td className="p-2 font-medium">Niet gehedged</td>
                  <td className="text-right p-2">{unhedgedStats.count}</td>
                  <td className={`text-right p-2 ${unhedgedStats.totalPL >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                    ${unhedgedStats.totalPL.toFixed(2)}
                  </td>
                  <td className={`text-right p-2 ${unhedgedStats.avgPL >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                    ${unhedgedStats.avgPL.toFixed(2)}
                  </td>
                  <td className={`text-right p-2 ${unhedgedStats.avgPLPercent >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                    {unhedgedStats.avgPLPercent.toFixed(1)}%
                  </td>
                  <td className="text-right p-2">{unhedgedStats.winRate.toFixed(0)}%</td>
                </tr>
                <tr className="border-b">
                  <td className="p-2 font-medium">Met accumulatie</td>
                  <td className="text-right p-2">{accumulationStats.with.count}</td>
                  <td className={`text-right p-2 ${accumulationStats.with.totalPL >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                    ${accumulationStats.with.totalPL.toFixed(2)}
                  </td>
                  <td className={`text-right p-2 ${accumulationStats.with.avgPL >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                    ${accumulationStats.with.avgPL.toFixed(2)}
                  </td>
                  <td className={`text-right p-2 ${accumulationStats.with.avgPLPercent >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                    {accumulationStats.with.avgPLPercent.toFixed(1)}%
                  </td>
                  <td className="text-right p-2">-</td>
                </tr>
                <tr>
                  <td className="p-2 font-medium">Zonder accumulatie</td>
                  <td className="text-right p-2">{accumulationStats.without.count}</td>
                  <td className={`text-right p-2 ${accumulationStats.without.totalPL >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                    ${accumulationStats.without.totalPL.toFixed(2)}
                  </td>
                  <td className={`text-right p-2 ${accumulationStats.without.avgPL >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                    ${accumulationStats.without.avgPL.toFixed(2)}
                  </td>
                  <td className={`text-right p-2 ${accumulationStats.without.avgPLPercent >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                    {accumulationStats.without.avgPLPercent.toFixed(1)}%
                  </td>
                  <td className="text-right p-2">-</td>
                </tr>
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
