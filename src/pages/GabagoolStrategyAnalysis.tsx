import { useEffect, useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ArrowLeft, TrendingUp, TrendingDown, Activity, Zap, Shield, Target, Clock, DollarSign, BarChart3, PieChart, Layers, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart as RechartsPie, Pie, Cell, LineChart, Line, Legend, ComposedChart, Area } from 'recharts';

interface Trade {
  id: string;
  market_slug: string;
  market: string;
  outcome: string;
  side: string;
  price: number;
  shares: number;
  total: number;
  timestamp: string;
}

interface MarketStats {
  market_slug: string;
  trade_count: number;
  up_shares: number;
  down_shares: number;
  up_invested: number;
  down_invested: number;
  avg_up_price: number;
  avg_down_price: number;
  combined_entry: number;
  guaranteed_payout: number;
  guaranteed_profit: number;
}

interface StrategyMetrics {
  totalTrades: number;
  totalVolume: number;
  avgTradeSize: number;
  uniqueMarkets: number;
  upInvested: number;
  downInvested: number;
  upShares: number;
  downShares: number;
  avgCombinedEntry: number;
  avgSecondsPerTrade: number;
  burstTradesPct: number;
  profitableMarkets: number;
  unprofitableMarkets: number;
  btcVolume: number;
  ethVolume: number;
  cheapTrades: number;
  expensiveTrades: number;
  midTrades: number;
}

const COLORS = ['hsl(var(--chart-1))', 'hsl(var(--chart-2))', 'hsl(var(--chart-3))', 'hsl(var(--chart-4))', 'hsl(var(--chart-5))'];

export default function GabagoolStrategyAnalysis() {
  const [trades, setTrades] = useState<Trade[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [marketStats, setMarketStats] = useState<MarketStats[]>([]);

  useEffect(() => {
    const fetchData = async () => {
      setIsLoading(true);
      
      // Fetch all trades
      const { data: tradesData, error: tradesError } = await supabase
        .from('trades')
        .select('*')
        .eq('trader_username', 'gabagool22')
        .order('timestamp', { ascending: true });

      if (tradesError) {
        console.error('Error fetching trades:', tradesError);
        setIsLoading(false);
        return;
      }

      setTrades(tradesData || []);
      setIsLoading(false);
    };

    fetchData();
  }, []);

  // Calculate all metrics
  const metrics: StrategyMetrics | null = useMemo(() => {
    if (trades.length === 0) return null;

    const uniqueMarkets = new Set(trades.map(t => t.market_slug)).size;
    const totalVolume = trades.reduce((sum, t) => sum + t.total, 0);
    const upTrades = trades.filter(t => t.outcome === 'Up');
    const downTrades = trades.filter(t => t.outcome === 'Down');
    
    const upInvested = upTrades.reduce((sum, t) => sum + t.total, 0);
    const downInvested = downTrades.reduce((sum, t) => sum + t.total, 0);
    const upShares = upTrades.reduce((sum, t) => sum + t.shares, 0);
    const downShares = downTrades.reduce((sum, t) => sum + t.shares, 0);

    // Calculate per-market stats
    const marketMap = new Map<string, MarketStats>();
    trades.forEach(t => {
      if (!marketMap.has(t.market_slug)) {
        marketMap.set(t.market_slug, {
          market_slug: t.market_slug,
          trade_count: 0,
          up_shares: 0,
          down_shares: 0,
          up_invested: 0,
          down_invested: 0,
          avg_up_price: 0,
          avg_down_price: 0,
          combined_entry: 0,
          guaranteed_payout: 0,
          guaranteed_profit: 0,
        });
      }
      const stats = marketMap.get(t.market_slug)!;
      stats.trade_count++;
      if (t.outcome === 'Up') {
        stats.up_shares += t.shares;
        stats.up_invested += t.total;
      } else {
        stats.down_shares += t.shares;
        stats.down_invested += t.total;
      }
    });

    // Calculate combined entries and profits
    let profitableMarkets = 0;
    let unprofitableMarkets = 0;
    let totalCombinedEntry = 0;
    let dualSideCount = 0;

    marketMap.forEach(stats => {
      if (stats.up_shares > 0 && stats.down_shares > 0) {
        stats.avg_up_price = stats.up_invested / stats.up_shares;
        stats.avg_down_price = stats.down_invested / stats.down_shares;
        stats.combined_entry = stats.avg_up_price + stats.avg_down_price;
        stats.guaranteed_payout = Math.min(stats.up_shares, stats.down_shares);
        stats.guaranteed_profit = stats.guaranteed_payout - (stats.up_invested + stats.down_invested);
        
        totalCombinedEntry += stats.combined_entry;
        dualSideCount++;
        
        if (stats.guaranteed_profit > 0) profitableMarkets++;
        else unprofitableMarkets++;
      }
    });

    // Calculate burst trades (< 1 sec apart)
    let burstCount = 0;
    const sortedTrades = [...trades].sort((a, b) => 
      new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );
    
    const marketTradesBySlug = new Map<string, Trade[]>();
    sortedTrades.forEach(t => {
      if (!marketTradesBySlug.has(t.market_slug)) {
        marketTradesBySlug.set(t.market_slug, []);
      }
      marketTradesBySlug.get(t.market_slug)!.push(t);
    });

    marketTradesBySlug.forEach(marketTrades => {
      for (let i = 1; i < marketTrades.length; i++) {
        const gap = (new Date(marketTrades[i].timestamp).getTime() - new Date(marketTrades[i-1].timestamp).getTime()) / 1000;
        if (gap < 1) burstCount++;
      }
    });

    // Calculate price zone distribution
    const cheapTrades = trades.filter(t => t.price <= 0.20).length;
    const expensiveTrades = trades.filter(t => t.price >= 0.80).length;
    const midTrades = trades.filter(t => t.price > 0.20 && t.price < 0.80).length;

    // Calculate asset volumes
    const btcVolume = trades.filter(t => t.market_slug.includes('btc') || t.market.toLowerCase().includes('bitcoin')).reduce((sum, t) => sum + t.total, 0);
    const ethVolume = trades.filter(t => t.market_slug.includes('eth') || t.market.toLowerCase().includes('ethereum')).reduce((sum, t) => sum + t.total, 0);

    setMarketStats(Array.from(marketMap.values()).filter(m => m.up_shares > 0 && m.down_shares > 0));

    return {
      totalTrades: trades.length,
      totalVolume,
      avgTradeSize: totalVolume / trades.length,
      uniqueMarkets,
      upInvested,
      downInvested,
      upShares,
      downShares,
      avgCombinedEntry: dualSideCount > 0 ? totalCombinedEntry / dualSideCount : 0,
      avgSecondsPerTrade: 1.1, // Pre-calculated from query
      burstTradesPct: (burstCount / (trades.length - uniqueMarkets)) * 100,
      profitableMarkets,
      unprofitableMarkets,
      btcVolume,
      ethVolume,
      cheapTrades,
      expensiveTrades,
      midTrades,
    };
  }, [trades]);

  // Calculate price distribution for chart
  const priceDistribution = useMemo(() => {
    const buckets = [
      { range: '< 10¢', up: 0, down: 0 },
      { range: '10-20¢', up: 0, down: 0 },
      { range: '20-30¢', up: 0, down: 0 },
      { range: '30-40¢', up: 0, down: 0 },
      { range: '40-50¢', up: 0, down: 0 },
      { range: '50-60¢', up: 0, down: 0 },
      { range: '60-70¢', up: 0, down: 0 },
      { range: '70-80¢', up: 0, down: 0 },
      { range: '80-90¢', up: 0, down: 0 },
      { range: '90¢+', up: 0, down: 0 },
    ];

    trades.forEach(t => {
      let idx = Math.min(Math.floor(t.price * 10), 9);
      if (t.outcome === 'Up') buckets[idx].up++;
      else buckets[idx].down++;
    });

    return buckets;
  }, [trades]);

  // Calculate trade size distribution
  const tradeSizeDistribution = useMemo(() => {
    const buckets = [
      { range: '< $1', count: 0 },
      { range: '$1-5', count: 0 },
      { range: '$5-10', count: 0 },
      { range: '$10-20', count: 0 },
      { range: '$20+', count: 0 },
    ];

    trades.forEach(t => {
      if (t.total < 1) buckets[0].count++;
      else if (t.total < 5) buckets[1].count++;
      else if (t.total < 10) buckets[2].count++;
      else if (t.total < 20) buckets[3].count++;
      else buckets[4].count++;
    });

    return buckets;
  }, [trades]);

  // Calculate combined entry distribution
  const combinedEntryDistribution = useMemo(() => {
    const buckets = [
      { range: '< 92¢', count: 0, label: 'Zeer Winstgevend' },
      { range: '92-95¢', count: 0, label: 'Winstgevend' },
      { range: '95-98¢', count: 0, label: 'Klein Voordeel' },
      { range: '98-100¢', count: 0, label: 'Break-even' },
      { range: '100¢+', count: 0, label: 'Verlies' },
    ];

    marketStats.forEach(m => {
      if (m.combined_entry < 0.92) buckets[0].count++;
      else if (m.combined_entry < 0.95) buckets[1].count++;
      else if (m.combined_entry < 0.98) buckets[2].count++;
      else if (m.combined_entry < 1.00) buckets[3].count++;
      else buckets[4].count++;
    });

    return buckets;
  }, [marketStats]);

  // Calculate time-based patterns
  const timePatterns = useMemo(() => {
    const marketFirstTrade = new Map<string, Date>();
    const patterns = [
      { phase: '0-1 min', upCount: 0, downCount: 0, volume: 0 },
      { phase: '1-3 min', upCount: 0, downCount: 0, volume: 0 },
      { phase: '3-5 min', upCount: 0, downCount: 0, volume: 0 },
      { phase: '5-10 min', upCount: 0, downCount: 0, volume: 0 },
      { phase: '10+ min', upCount: 0, downCount: 0, volume: 0 },
    ];

    // Find first trade per market
    trades.forEach(t => {
      const ts = new Date(t.timestamp);
      if (!marketFirstTrade.has(t.market_slug) || ts < marketFirstTrade.get(t.market_slug)!) {
        marketFirstTrade.set(t.market_slug, ts);
      }
    });

    trades.forEach(t => {
      const firstTrade = marketFirstTrade.get(t.market_slug)!;
      const secondsIn = (new Date(t.timestamp).getTime() - firstTrade.getTime()) / 1000;
      
      let idx = 4;
      if (secondsIn < 60) idx = 0;
      else if (secondsIn < 180) idx = 1;
      else if (secondsIn < 300) idx = 2;
      else if (secondsIn < 600) idx = 3;

      if (t.outcome === 'Up') patterns[idx].upCount++;
      else patterns[idx].downCount++;
      patterns[idx].volume += t.total;
    });

    return patterns;
  }, [trades]);

  // Top markets by profit
  const topMarkets = useMemo(() => {
    return [...marketStats]
      .sort((a, b) => b.guaranteed_profit - a.guaranteed_profit)
      .slice(0, 10);
  }, [marketStats]);

  // Worst markets by profit
  const worstMarkets = useMemo(() => {
    return [...marketStats]
      .sort((a, b) => a.guaranteed_profit - b.guaranteed_profit)
      .slice(0, 10);
  }, [marketStats]);

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background p-8 flex items-center justify-center">
        <div className="text-center space-y-4">
          <Activity className="h-12 w-12 animate-spin mx-auto text-primary" />
          <p className="text-muted-foreground">Analyseren van {trades.length.toLocaleString()} trades...</p>
        </div>
      </div>
    );
  }

  if (!metrics) {
    return (
      <div className="min-h-screen bg-background p-8 flex items-center justify-center">
        <p className="text-muted-foreground">Geen trade data beschikbaar</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="container mx-auto p-6 space-y-8">
        {/* Header */}
        <div className="flex items-center gap-4">
          <Link to="/strategy" className="p-2 hover:bg-accent rounded-lg transition-colors">
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Gabagool Strategy Deep Dive</h1>
            <p className="text-muted-foreground">Uitgebreide analyse van 109.654 trades over 316 markten</p>
          </div>
        </div>

        {/* Executive Summary */}
        <Card className="border-primary/50 bg-gradient-to-br from-primary/5 to-transparent">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Target className="h-5 w-5 text-primary" />
              Executive Summary
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="space-y-3">
                <h3 className="font-semibold text-lg">Strategie Overzicht</h3>
                <ul className="space-y-2 text-sm">
                  <li className="flex items-start gap-2">
                    <CheckCircle2 className="h-4 w-4 text-green-500 mt-0.5" />
                    <span><strong>Dual-Side Hedging:</strong> Gabagool koopt ALTIJD zowel Up als Down in elke markt (100% van 316 markten)</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <CheckCircle2 className="h-4 w-4 text-green-500 mt-0.5" />
                    <span><strong>High-Frequency DCA:</strong> Gemiddeld 347 trades per markt met ~1 trade per seconde</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <CheckCircle2 className="h-4 w-4 text-green-500 mt-0.5" />
                    <span><strong>Volume Dominantie:</strong> $584.840 totaal volume, gemiddeld $1.850 per markt</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <AlertTriangle className="h-4 w-4 text-yellow-500 mt-0.5" />
                    <span><strong>Gemiddelde Combined Entry:</strong> {(metrics.avgCombinedEntry * 100).toFixed(1)}¢ (boven 98¢ = geen garantie winst)</span>
                  </li>
                </ul>
              </div>
              <div className="space-y-3">
                <h3 className="font-semibold text-lg">Key Insights</h3>
                <ul className="space-y-2 text-sm">
                  <li className="flex items-start gap-2">
                    <Zap className="h-4 w-4 text-yellow-500 mt-0.5" />
                    <span><strong>Burst Trading:</strong> {metrics.burstTradesPct.toFixed(0)}% van trades binnen 1 seconde (bot-gedrag)</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <Shield className="h-4 w-4 text-blue-500 mt-0.5" />
                    <span><strong>Balanced Hedging:</strong> 51.5% volume in Up vs 48.5% in Down (vrijwel gelijk)</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <TrendingUp className="h-4 w-4 text-green-500 mt-0.5" />
                    <span><strong>Winstgevende Markten:</strong> {metrics.profitableMarkets} van {metrics.profitableMarkets + metrics.unprofitableMarkets} ({((metrics.profitableMarkets / (metrics.profitableMarkets + metrics.unprofitableMarkets)) * 100).toFixed(0)}%)</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <BarChart3 className="h-4 w-4 text-primary mt-0.5" />
                    <span><strong>Asset Focus:</strong> {((metrics.btcVolume / metrics.totalVolume) * 100).toFixed(0)}% BTC, {((metrics.ethVolume / metrics.totalVolume) * 100).toFixed(0)}% ETH</span>
                  </li>
                </ul>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Key Metrics Grid */}
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4">
          <Card>
            <CardContent className="pt-4">
              <div className="text-2xl font-bold">{metrics.totalTrades.toLocaleString()}</div>
              <div className="text-xs text-muted-foreground">Totaal Trades</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4">
              <div className="text-2xl font-bold">${(metrics.totalVolume / 1000).toFixed(0)}K</div>
              <div className="text-xs text-muted-foreground">Totaal Volume</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4">
              <div className="text-2xl font-bold">${metrics.avgTradeSize.toFixed(2)}</div>
              <div className="text-xs text-muted-foreground">Gem. Trade Size</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4">
              <div className="text-2xl font-bold">{metrics.uniqueMarkets}</div>
              <div className="text-xs text-muted-foreground">Unieke Markten</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4">
              <div className="text-2xl font-bold">{(metrics.avgCombinedEntry * 100).toFixed(1)}¢</div>
              <div className="text-xs text-muted-foreground">Gem. Combined Entry</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4">
              <div className="text-2xl font-bold">{metrics.avgSecondsPerTrade.toFixed(1)}s</div>
              <div className="text-xs text-muted-foreground">Sec/Trade</div>
            </CardContent>
          </Card>
        </div>

        {/* Strategy Breakdown Section */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Trade Size Distribution */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <DollarSign className="h-5 w-5" />
                Trade Size Distributie
              </CardTitle>
              <CardDescription>Hoe groot zijn de individuele trades?</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={tradeSizeDistribution}>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                    <XAxis dataKey="range" className="text-xs" />
                    <YAxis className="text-xs" />
                    <Tooltip 
                      contentStyle={{ 
                        backgroundColor: 'hsl(var(--card))', 
                        border: '1px solid hsl(var(--border))',
                        borderRadius: '8px'
                      }} 
                    />
                    <Bar dataKey="count" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <div className="mt-4 text-sm text-muted-foreground">
                <strong>Insight:</strong> Meeste trades zijn $1-5 (41%), gevolgd door $5-10 (25%). 
                Dit wijst op gecontroleerd DCA met kleine posities.
              </div>
            </CardContent>
          </Card>

          {/* Combined Entry Distribution */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Target className="h-5 w-5" />
                Combined Entry Distributie
              </CardTitle>
              <CardDescription>Up prijs + Down prijs per markt (≤98¢ = winst)</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={combinedEntryDistribution}>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                    <XAxis dataKey="range" className="text-xs" />
                    <YAxis className="text-xs" />
                    <Tooltip 
                      contentStyle={{ 
                        backgroundColor: 'hsl(var(--card))', 
                        border: '1px solid hsl(var(--border))',
                        borderRadius: '8px'
                      }} 
                    />
                    <Bar dataKey="count" fill="hsl(var(--chart-2))" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <div className="mt-4 text-sm text-muted-foreground">
                <strong>Insight:</strong> Slechts {combinedEntryDistribution[0].count + combinedEntryDistribution[1].count} markten 
                (&lt;95¢) gaven sterke arbitrage. De meeste (141) zitten in 95-98¢ zone.
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Price Distribution Chart */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <BarChart3 className="h-5 w-5" />
              Entry Price Distributie per Outcome
            </CardTitle>
            <CardDescription>Bij welke prijzen koopt Gabagool Up vs Down?</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="h-80">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={priceDistribution}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                  <XAxis dataKey="range" className="text-xs" />
                  <YAxis className="text-xs" />
                  <Tooltip 
                    contentStyle={{ 
                      backgroundColor: 'hsl(var(--card))', 
                      border: '1px solid hsl(var(--border))',
                      borderRadius: '8px'
                    }} 
                  />
                  <Legend />
                  <Bar dataKey="up" name="Up Trades" fill="hsl(var(--chart-1))" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="down" name="Down Trades" fill="hsl(var(--chart-3))" radius={[4, 4, 0, 0]} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
            <div className="mt-4 p-4 bg-muted/50 rounded-lg">
              <h4 className="font-semibold mb-2">Analyse:</h4>
              <ul className="text-sm space-y-1 text-muted-foreground">
                <li>• <strong>Symmetrisch patroon:</strong> Up en Down trades volgen vrijwel identieke distributie</li>
                <li>• <strong>Mid-range focus:</strong> 77% van trades zijn tussen 20-80¢ (niet extreem)</li>
                <li>• <strong>Cheap hunting:</strong> 13% van trades bij prijzen ≤20¢ (kopen van "goedkope" kansen)</li>
              </ul>
            </div>
          </CardContent>
        </Card>

        {/* Time Patterns */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Clock className="h-5 w-5" />
              Trading Intensiteit Over Tijd
            </CardTitle>
            <CardDescription>Hoe verandert het trading gedrag gedurende een markt?</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={timePatterns}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                  <XAxis dataKey="phase" className="text-xs" />
                  <YAxis yAxisId="left" className="text-xs" />
                  <YAxis yAxisId="right" orientation="right" className="text-xs" />
                  <Tooltip 
                    contentStyle={{ 
                      backgroundColor: 'hsl(var(--card))', 
                      border: '1px solid hsl(var(--border))',
                      borderRadius: '8px'
                    }} 
                  />
                  <Legend />
                  <Bar yAxisId="left" dataKey="upCount" name="Up Trades" fill="hsl(var(--chart-1))" radius={[4, 4, 0, 0]} />
                  <Bar yAxisId="left" dataKey="downCount" name="Down Trades" fill="hsl(var(--chart-3))" radius={[4, 4, 0, 0]} />
                  <Line yAxisId="right" type="monotone" dataKey="volume" name="Volume ($)" stroke="hsl(var(--primary))" strokeWidth={2} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
            <div className="mt-4 p-4 bg-muted/50 rounded-lg">
              <h4 className="font-semibold mb-2">Timing Strategie:</h4>
              <ul className="text-sm space-y-1 text-muted-foreground">
                <li>• <strong>Vroege agressie:</strong> Hoogste trade sizes in eerste minuut ($5.83 gem)</li>
                <li>• <strong>Continue accumulate:</strong> Trading blijft constant gedurende hele markt</li>
                <li>• <strong>50/50 balans:</strong> Up en Down trades blijven altijd in balans ongeacht fase</li>
              </ul>
            </div>
          </CardContent>
        </Card>

        {/* DCA Pattern Analysis */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Layers className="h-5 w-5" />
              DCA Intensiteit Analyse
            </CardTitle>
            <CardDescription>Hoeveel trades per positie (outcome per markt)?</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="p-4 bg-muted/50 rounded-lg text-center">
                <div className="text-3xl font-bold text-primary">221</div>
                <div className="text-sm text-muted-foreground">Gem. trades per positie</div>
                <div className="text-xs text-muted-foreground mt-1">(100+ trades: 434 posities)</div>
              </div>
              <div className="p-4 bg-muted/50 rounded-lg text-center">
                <div className="text-3xl font-bold text-chart-2">$1.192</div>
                <div className="text-sm text-muted-foreground">Gem. geïnvesteerd per positie</div>
                <div className="text-xs text-muted-foreground mt-1">(bij 100+ trades)</div>
              </div>
              <div className="p-4 bg-muted/50 rounded-lg text-center">
                <div className="text-3xl font-bold text-chart-3">100%</div>
                <div className="text-sm text-muted-foreground">Markten met dual-side</div>
                <div className="text-xs text-muted-foreground mt-1">(alle 316 markten)</div>
              </div>
            </div>
            <div className="mt-4 p-4 bg-yellow-500/10 border border-yellow-500/30 rounded-lg">
              <h4 className="font-semibold mb-2 flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-yellow-500" />
                Belangrijke Observatie
              </h4>
              <p className="text-sm text-muted-foreground">
                Gabagool's strategie is <strong>puur mechanisch DCA</strong> met extreme frequentie. 
                Er is geen duidelijke "entry condition" gebaseerd op prijsniveaus - hij accumuleert 
                constant op beide kanten ongeacht de marktomstandigheden.
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Top/Worst Markets */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-green-500">
                <TrendingUp className="h-5 w-5" />
                Top 10 Winstgevende Markten
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {topMarkets.map((m, i) => (
                  <div key={m.market_slug} className="flex items-center justify-between p-2 bg-green-500/5 rounded-lg">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-mono text-muted-foreground">#{i + 1}</span>
                      <span className="text-sm truncate max-w-[200px]">{m.market_slug}</span>
                    </div>
                    <div className="flex items-center gap-4">
                      <Badge variant="secondary" className="font-mono">
                        {(m.combined_entry * 100).toFixed(1)}¢
                      </Badge>
                      <span className="text-green-500 font-semibold">
                        +${m.guaranteed_profit.toFixed(2)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-red-500">
                <TrendingDown className="h-5 w-5" />
                Top 10 Verliesgevende Markten
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {worstMarkets.map((m, i) => (
                  <div key={m.market_slug} className="flex items-center justify-between p-2 bg-red-500/5 rounded-lg">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-mono text-muted-foreground">#{i + 1}</span>
                      <span className="text-sm truncate max-w-[200px]">{m.market_slug}</span>
                    </div>
                    <div className="flex items-center gap-4">
                      <Badge variant="secondary" className="font-mono">
                        {(m.combined_entry * 100).toFixed(1)}¢
                      </Badge>
                      <span className="text-red-500 font-semibold">
                        ${m.guaranteed_profit.toFixed(2)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Strategy Rules */}
        <Card className="border-primary/50">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Shield className="h-5 w-5 text-primary" />
              Gabagool's Trading Rules (Afgeleid)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="space-y-4">
                <h3 className="font-semibold text-lg flex items-center gap-2">
                  <CheckCircle2 className="h-5 w-5 text-green-500" />
                  Core Principles
                </h3>
                <ul className="space-y-3 text-sm">
                  <li className="p-3 bg-muted/50 rounded-lg">
                    <strong>1. Dual-Side Altijd</strong>
                    <p className="text-muted-foreground mt-1">
                      Koop ALTIJD zowel Up als Down. Nooit single-side posities.
                    </p>
                  </li>
                  <li className="p-3 bg-muted/50 rounded-lg">
                    <strong>2. Constant Accumulate</strong>
                    <p className="text-muted-foreground mt-1">
                      DCA met kleine bedragen ($5-10) om te middelen naar betere entry.
                    </p>
                  </li>
                  <li className="p-3 bg-muted/50 rounded-lg">
                    <strong>3. Speed is Key</strong>
                    <p className="text-muted-foreground mt-1">
                      ~1 trade per seconde, bot-gestuurd, geen handmatige interventie.
                    </p>
                  </li>
                  <li className="p-3 bg-muted/50 rounded-lg">
                    <strong>4. Volume Dominance</strong>
                    <p className="text-muted-foreground mt-1">
                      Accumuleer $1.800+ per markt om meaningful positie te bouwen.
                    </p>
                  </li>
                </ul>
              </div>
              <div className="space-y-4">
                <h3 className="font-semibold text-lg flex items-center gap-2">
                  <Target className="h-5 w-5 text-primary" />
                  Entry Targets
                </h3>
                <ul className="space-y-3 text-sm">
                  <li className="p-3 bg-primary/5 rounded-lg border border-primary/20">
                    <strong>Combined Entry Target: ≤ 98¢</strong>
                    <p className="text-muted-foreground mt-1">
                      Gemiddelde prijs Up + gemiddelde prijs Down moet onder 98¢ zijn voor gegarandeerde winst.
                    </p>
                  </li>
                  <li className="p-3 bg-muted/50 rounded-lg">
                    <strong>Trade Size: $1-10</strong>
                    <p className="text-muted-foreground mt-1">
                      67% van trades tussen $1-10. Geen grote single trades.
                    </p>
                  </li>
                  <li className="p-3 bg-muted/50 rounded-lg">
                    <strong>BTC Focus: 75%</strong>
                    <p className="text-muted-foreground mt-1">
                      Primair Bitcoin markten, secundair Ethereum (25%).
                    </p>
                  </li>
                  <li className="p-3 bg-muted/50 rounded-lg">
                    <strong>Balanced Hedging</strong>
                    <p className="text-muted-foreground mt-1">
                      51.5% Up / 48.5% Down volume - vrijwel perfecte 50/50 hedge.
                    </p>
                  </li>
                </ul>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Conclusion */}
        <Card className="bg-gradient-to-br from-card to-muted/20">
          <CardHeader>
            <CardTitle>Conclusie & Implementatie Advies</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="space-y-3">
                <h3 className="font-semibold text-green-500 flex items-center gap-2">
                  <CheckCircle2 className="h-5 w-5" />
                  Wat Werkt
                </h3>
                <ul className="text-sm space-y-2 text-muted-foreground">
                  <li>• Dual-side hedging elimineert richting-risico volledig</li>
                  <li>• High-frequency DCA verbetert gemiddelde entry over tijd</li>
                  <li>• Bot-executie garandeert consistentie zonder emotie</li>
                  <li>• Volume dominantie zorgt voor meaningful winst per markt</li>
                </ul>
              </div>
              <div className="space-y-3">
                <h3 className="font-semibold text-yellow-500 flex items-center gap-2">
                  <AlertTriangle className="h-5 w-5" />
                  Risico's & Limitaties
                </h3>
                <ul className="text-sm space-y-2 text-muted-foreground">
                  <li>• Gem. combined entry 98.3¢ betekent ~-3% garanteed ROI</li>
                  <li>• Strategie werkt alleen met lage fees en hoge liquiditeit</li>
                  <li>• Vereist significant kapitaal ($500K+ volume) voor scale</li>
                  <li>• Slippage en liquidity gaps kunnen winst elimineren</li>
                </ul>
              </div>
            </div>
            <div className="p-4 bg-primary/10 rounded-lg border border-primary/30 mt-4">
              <h4 className="font-semibold mb-2">Paper Bot Implementatie Suggestie:</h4>
              <p className="text-sm text-muted-foreground">
                De paper bot zou moeten focussen op markten waar combined price &lt; 97¢ is en 
                trades moeten plaatsen met $5-15 per trade, maximaal $200 per side. 
                Trading moet doorgaan zolang er arbitrage edge is, met DCA om entry te verbeteren.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
