import { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { supabase } from '@/integrations/supabase/client';
import { Loader2, TrendingUp, TrendingDown, Scale, Zap, AlertTriangle, CheckCircle } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, Cell, PieChart, Pie } from 'recharts';

interface PatternStats {
  pattern_type: string;
  count: number;
  settled_count: number;
  avg_profit_loss: number;
  total_profit_loss: number;
  avg_profit_loss_pct: number;
  wins: number;
  losses: number;
  avg_trades: number;
  avg_invested: number;
}

interface MarketDetail {
  market_slug: string;
  asset: string;
  pattern_type: string;
  total_trades: number;
  final_up_shares: number;
  final_down_shares: number;
  profit_loss: number;
  profit_loss_percent: number;
  total_invested: number;
  is_settled: boolean;
  first_break_at: number | null;
  returned_to_balanced: number;
}

const PATTERN_LABELS: Record<string, string> = {
  'stayed_hedged': 'Gehedged gebleven',
  'hedge_broke_then_returned': 'Hedge gebroken, later hersteld',
  'hedge_broke_never_returned': 'Hedge gebroken, nooit hersteld',
  'never_hedged': 'Nooit gehedged'
};

const PATTERN_COLORS: Record<string, string> = {
  'stayed_hedged': 'hsl(var(--chart-2))',
  'hedge_broke_then_returned': 'hsl(var(--chart-3))',
  'hedge_broke_never_returned': 'hsl(var(--chart-4))',
  'never_hedged': 'hsl(var(--chart-5))'
};

export function HedgeBreakAnalysis() {
  const [patternStats, setPatternStats] = useState<PatternStats[]>([]);
  const [marketDetails, setMarketDetails] = useState<MarketDetail[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    fetchRawAnalysis();
  }, []);

  const fetchRawAnalysis = async () => {
    // Get all trades
    const { data: trades } = await supabase
      .from('live_trades')
      .select('*')
      .order('created_at', { ascending: true });

    const { data: results } = await supabase
      .from('live_trade_results')
      .select('*');

    if (!trades || !results) {
      setIsLoading(false);
      return;
    }

    // Group trades by market
    const marketTrades: Record<string, typeof trades> = {};
    trades.forEach(t => {
      if (!marketTrades[t.market_slug]) marketTrades[t.market_slug] = [];
      marketTrades[t.market_slug].push(t);
    });

    // Analyze each market
    const details: MarketDetail[] = [];
    const statsMap: Record<string, { count: number; settled: number; totalPL: number; wins: number; losses: number; totalInvested: number; totalTrades: number }> = {};

    Object.entries(marketTrades).forEach(([slug, marketTradeList]) => {
      if (marketTradeList.length < 3) return;

      let cumulUp = 0;
      let cumulDown = 0;
      let wasEverBalanced = false;
      let firstBreakAt: number | null = null;
      let returnedToBalanced = 0;
      let prevState = 'exposed';

      marketTradeList.forEach((t, idx) => {
        if (t.outcome === 'Up' || t.outcome === 'UP') cumulUp += Number(t.shares);
        else cumulDown += Number(t.shares);

        const isBalanced = cumulUp > 0 && cumulDown > 0 && 
          Math.min(cumulUp, cumulDown) / Math.max(cumulUp, cumulDown) >= 0.7;
        const state = isBalanced ? 'balanced' : 'exposed';

        if (state === 'balanced') wasEverBalanced = true;
        if (state === 'exposed' && prevState === 'balanced' && firstBreakAt === null) {
          firstBreakAt = idx + 1;
        }
        if (state === 'balanced' && prevState === 'exposed') {
          returnedToBalanced = idx + 1;
        }
        prevState = state;
      });

      let patternType: string;
      if (wasEverBalanced && firstBreakAt !== null && returnedToBalanced === 0) {
        patternType = 'hedge_broke_never_returned';
      } else if (wasEverBalanced && firstBreakAt !== null && returnedToBalanced > 0) {
        patternType = 'hedge_broke_then_returned';
      } else if (wasEverBalanced && firstBreakAt === null) {
        patternType = 'stayed_hedged';
      } else {
        patternType = 'never_hedged';
      }

      const result = results.find(r => r.market_slug === slug);
      const isSettled = !!result?.settled_at;
      const pl = result?.profit_loss || 0;
      const plPct = result?.profit_loss_percent || 0;
      const invested = result?.total_invested || 0;

      details.push({
        market_slug: slug,
        asset: marketTradeList[0].asset,
        pattern_type: patternType,
        total_trades: marketTradeList.length,
        final_up_shares: cumulUp,
        final_down_shares: cumulDown,
        profit_loss: pl,
        profit_loss_percent: plPct,
        total_invested: invested,
        is_settled: isSettled,
        first_break_at: firstBreakAt,
        returned_to_balanced: returnedToBalanced
      });

      if (!statsMap[patternType]) {
        statsMap[patternType] = { count: 0, settled: 0, totalPL: 0, wins: 0, losses: 0, totalInvested: 0, totalTrades: 0 };
      }
      statsMap[patternType].count++;
      statsMap[patternType].totalTrades += marketTradeList.length;
      if (isSettled) {
        statsMap[patternType].settled++;
        statsMap[patternType].totalPL += pl;
        statsMap[patternType].totalInvested += invested;
        if (pl > 0) statsMap[patternType].wins++;
        else statsMap[patternType].losses++;
      }
    });

    const stats: PatternStats[] = Object.entries(statsMap).map(([pattern, s]) => ({
      pattern_type: pattern,
      count: s.count,
      settled_count: s.settled,
      avg_profit_loss: s.settled > 0 ? s.totalPL / s.settled : 0,
      total_profit_loss: s.totalPL,
      avg_profit_loss_pct: 0,
      wins: s.wins,
      losses: s.losses,
      avg_trades: s.count > 0 ? s.totalTrades / s.count : 0,
      avg_invested: s.settled > 0 ? s.totalInvested / s.settled : 0
    }));

    setPatternStats(stats);
    setMarketDetails(details);
    setIsLoading(false);
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-48">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  const stayedHedged = patternStats.find(p => p.pattern_type === 'stayed_hedged');
  const brokeThenReturned = patternStats.find(p => p.pattern_type === 'hedge_broke_then_returned');
  const neverHedged = patternStats.find(p => p.pattern_type === 'never_hedged');

  const chartData = patternStats.map(p => ({
    name: PATTERN_LABELS[p.pattern_type] || p.pattern_type,
    pattern: p.pattern_type,
    'Gem. P/L': p.avg_profit_loss,
    'Totaal P/L': p.total_profit_loss,
    'Win Rate': p.settled_count > 0 ? Math.round((p.wins / p.settled_count) * 100) : 0,
    count: p.count
  }));

  const pieData = patternStats.map(p => ({
    name: PATTERN_LABELS[p.pattern_type] || p.pattern_type,
    value: p.count,
    pattern: p.pattern_type
  }));

  return (
    <div className="space-y-6">
      <Card className="border-primary/20">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-amber-500" />
            Hedge Break Analyse
          </CardTitle>
          <CardDescription>
            Wat gebeurt er als een gehedgde positie wordt doorbroken door bijkopen?
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
            {/* Stayed Hedged */}
            <Card className="bg-chart-2/10 border-chart-2/30">
              <CardContent className="pt-4">
                <div className="flex items-center gap-2 mb-2">
                  <Scale className="h-5 w-5 text-chart-2" />
                  <span className="font-semibold">Gehedged gebleven</span>
                </div>
                <div className="space-y-1 text-sm">
                  <p>Markten: <strong>{stayedHedged?.count || 0}</strong></p>
                  <p>Totaal P/L: <strong className={stayedHedged?.total_profit_loss && stayedHedged.total_profit_loss > 0 ? 'text-green-500' : 'text-red-500'}>
                    ${stayedHedged?.total_profit_loss?.toFixed(2) || '0.00'}
                  </strong></p>
                  <p>Gem. P/L: <strong>${stayedHedged?.avg_profit_loss?.toFixed(2) || '0.00'}</strong></p>
                  <p>Win rate: <strong>{stayedHedged?.settled_count ? Math.round((stayedHedged.wins / stayedHedged.settled_count) * 100) : 0}%</strong></p>
                </div>
              </CardContent>
            </Card>

            {/* Broke then returned */}
            <Card className="bg-chart-3/10 border-chart-3/30">
              <CardContent className="pt-4">
                <div className="flex items-center gap-2 mb-2">
                  <Zap className="h-5 w-5 text-chart-3" />
                  <span className="font-semibold">Hedge gebroken, hersteld</span>
                </div>
                <div className="space-y-1 text-sm">
                  <p>Markten: <strong>{brokeThenReturned?.count || 0}</strong></p>
                  <p>Totaal P/L: <strong className={brokeThenReturned?.total_profit_loss && brokeThenReturned.total_profit_loss > 0 ? 'text-green-500' : 'text-red-500'}>
                    ${brokeThenReturned?.total_profit_loss?.toFixed(2) || '0.00'}
                  </strong></p>
                  <p>Gem. P/L: <strong>${brokeThenReturned?.avg_profit_loss?.toFixed(2) || '0.00'}</strong></p>
                  <p>Win rate: <strong>{brokeThenReturned?.settled_count ? Math.round((brokeThenReturned.wins / brokeThenReturned.settled_count) * 100) : 0}%</strong></p>
                </div>
              </CardContent>
            </Card>

            {/* Never hedged */}
            <Card className="bg-chart-5/10 border-chart-5/30">
              <CardContent className="pt-4">
                <div className="flex items-center gap-2 mb-2">
                  <TrendingDown className="h-5 w-5 text-chart-5" />
                  <span className="font-semibold">Nooit gehedged</span>
                </div>
                <div className="space-y-1 text-sm">
                  <p>Markten: <strong>{neverHedged?.count || 0}</strong></p>
                  <p>Totaal P/L: <strong className={neverHedged?.total_profit_loss && neverHedged.total_profit_loss > 0 ? 'text-green-500' : 'text-red-500'}>
                    ${neverHedged?.total_profit_loss?.toFixed(2) || '0.00'}
                  </strong></p>
                  <p>Gem. P/L: <strong>${neverHedged?.avg_profit_loss?.toFixed(2) || '0.00'}</strong></p>
                  <p>Win rate: <strong>{neverHedged?.settled_count ? Math.round((neverHedged.wins / neverHedged.settled_count) * 100) : 0}%</strong></p>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Key Insight */}
          <Card className="bg-primary/5 border-primary/20 mb-6">
            <CardContent className="pt-4">
              <div className="flex items-start gap-3">
                <CheckCircle className="h-6 w-6 text-primary mt-0.5" />
                <div>
                  <h4 className="font-semibold mb-1">Belangrijkste Inzicht</h4>
                  <p className="text-sm text-muted-foreground">
                    {stayedHedged && brokeThenReturned && neverHedged ? (
                      <>
                        <strong>Gehedged blijven</strong> levert gemiddeld <strong>${stayedHedged.avg_profit_loss.toFixed(2)}</strong> per markt op met een win rate van <strong>{Math.round((stayedHedged.wins / stayedHedged.settled_count) * 100)}%</strong>.
                        <br />
                        <strong>Hedge breken en herstellen</strong> levert gemiddeld <strong>${brokeThenReturned.avg_profit_loss.toFixed(2)}</strong> per markt op - 
                        {brokeThenReturned.avg_profit_loss < stayedHedged.avg_profit_loss 
                          ? ` dat is $${(stayedHedged.avg_profit_loss - brokeThenReturned.avg_profit_loss).toFixed(2)} minder dan altijd gehedged blijven.`
                          : ` dat is $${(brokeThenReturned.avg_profit_loss - stayedHedged.avg_profit_loss).toFixed(2)} meer dan altijd gehedged blijven.`
                        }
                        <br />
                        <strong>Nooit hedgen</strong> resulteert in gemiddeld verlies van <strong>${Math.abs(neverHedged.avg_profit_loss).toFixed(2)}</strong> per markt.
                      </>
                    ) : 'Onvoldoende data voor analyse.'}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        </CardContent>
      </Card>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>P/L per Patroon</CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis dataKey="name" tick={{ fontSize: 10 }} angle={-20} textAnchor="end" height={80} />
                <YAxis />
                <Tooltip 
                  contentStyle={{ 
                    backgroundColor: 'hsl(var(--card))', 
                    border: '1px solid hsl(var(--border))',
                    borderRadius: '8px'
                  }} 
                />
                <Bar dataKey="Totaal P/L" name="Totaal P/L ($)">
                  {chartData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={PATTERN_COLORS[entry.pattern]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Win Rate per Patroon</CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis dataKey="name" tick={{ fontSize: 10 }} angle={-20} textAnchor="end" height={80} />
                <YAxis domain={[0, 100]} />
                <Tooltip 
                  contentStyle={{ 
                    backgroundColor: 'hsl(var(--card))', 
                    border: '1px solid hsl(var(--border))',
                    borderRadius: '8px'
                  }} 
                />
                <Bar dataKey="Win Rate" name="Win Rate (%)">
                  {chartData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={PATTERN_COLORS[entry.pattern]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>

      {/* Detailed Stats Table */}
      <Card>
        <CardHeader>
          <CardTitle>Gedetailleerde Statistieken</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left py-2 px-3">Patroon</th>
                  <th className="text-right py-2 px-3">Markten</th>
                  <th className="text-right py-2 px-3">Settled</th>
                  <th className="text-right py-2 px-3">Gem. Trades</th>
                  <th className="text-right py-2 px-3">Gem. Investering</th>
                  <th className="text-right py-2 px-3">Gem. P/L</th>
                  <th className="text-right py-2 px-3">Totaal P/L</th>
                  <th className="text-right py-2 px-3">Wins</th>
                  <th className="text-right py-2 px-3">Losses</th>
                  <th className="text-right py-2 px-3">Win Rate</th>
                </tr>
              </thead>
              <tbody>
                {patternStats.map(p => (
                  <tr key={p.pattern_type} className="border-b border-border/50 hover:bg-muted/50">
                    <td className="py-2 px-3 font-medium">
                      <span className="inline-flex items-center gap-2">
                        <span 
                          className="w-3 h-3 rounded-full" 
                          style={{ backgroundColor: PATTERN_COLORS[p.pattern_type] }}
                        />
                        {PATTERN_LABELS[p.pattern_type] || p.pattern_type}
                      </span>
                    </td>
                    <td className="text-right py-2 px-3">{p.count}</td>
                    <td className="text-right py-2 px-3">{p.settled_count}</td>
                    <td className="text-right py-2 px-3">{p.avg_trades.toFixed(1)}</td>
                    <td className="text-right py-2 px-3">${p.avg_invested.toFixed(2)}</td>
                    <td className={`text-right py-2 px-3 font-medium ${p.avg_profit_loss >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                      ${p.avg_profit_loss.toFixed(2)}
                    </td>
                    <td className={`text-right py-2 px-3 font-medium ${p.total_profit_loss >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                      ${p.total_profit_loss.toFixed(2)}
                    </td>
                    <td className="text-right py-2 px-3 text-green-500">{p.wins}</td>
                    <td className="text-right py-2 px-3 text-red-500">{p.losses}</td>
                    <td className="text-right py-2 px-3 font-medium">
                      {p.settled_count > 0 ? Math.round((p.wins / p.settled_count) * 100) : 0}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
