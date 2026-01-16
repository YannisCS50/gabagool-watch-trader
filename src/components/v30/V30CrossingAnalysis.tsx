import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { Loader2, TrendingUp, TrendingDown, AlertTriangle, CheckCircle } from "lucide-react";

interface CrossingStat {
  direction: string;
  delta_bucket_min: number;
  time_bucket_min_sec: number;
  sample_size: number;
  crossed_count: number;
  cross_pct: number;
  ci_lower_95: number;
  ci_upper_95: number;
}

type Asset = 'BTC' | 'ETH' | 'SOL' | 'XRP';

export function V30CrossingAnalysis() {
  const [asset, setAsset] = useState<Asset>('BTC');
  const [stats, setStats] = useState<CrossingStat[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);

  useEffect(() => {
    loadStats();
  }, [asset]);

  async function loadStats() {
    setLoading(true);
    
    try {
      // Load raw tick data
      const { data: rawData, error: rawError } = await supabase
        .from('v30_ticks')
        .select('asset, delta_to_strike, seconds_remaining, c_price, strike_price, market_slug, ts')
        .eq('asset', asset)
        .not('delta_to_strike', 'is', null)
        .not('seconds_remaining', 'is', null)
        .order('ts', { ascending: false })
        .limit(5000);

      if (rawError || !rawData) {
        console.error('Failed to load crossing data:', rawError);
        setLoading(false);
        return;
      }

      // Process client-side
      const processed = processTicksForCrossing(rawData);
      setStats(processed);
    } catch (err) {
      console.error('Error loading stats:', err);
    }
    
    setLastUpdate(new Date());
    setLoading(false);
  }

  // Process ticks to calculate crossing statistics
  function processTicksForCrossing(ticks: any[]): CrossingStat[] {
    // Group by market
    const byMarket = new Map<string, any[]>();
    for (const tick of ticks) {
      if (!tick.market_slug) continue;
      if (!byMarket.has(tick.market_slug)) {
        byMarket.set(tick.market_slug, []);
      }
      byMarket.get(tick.market_slug)!.push(tick);
    }

    // For each tick, determine if price crossed strike after
    const observations: { direction: string; deltaBucket: number; timeBucket: number; crossed: boolean }[] = [];
    
    for (const [_, marketTicks] of byMarket) {
      marketTicks.sort((a, b) => a.ts - b.ts);
      
      for (let i = 0; i < marketTicks.length; i++) {
        const tick = marketTicks[i];
        if (!tick.delta_to_strike || tick.seconds_remaining === null || !tick.strike_price) continue;
        
        const isAbove = tick.delta_to_strike > 0;
        const absDelta = Math.abs(tick.delta_to_strike);
        
        // Delta bucket
        let deltaBucket = 0;
        if (absDelta >= 300) deltaBucket = 300;
        else if (absDelta >= 200) deltaBucket = 200;
        else if (absDelta >= 100) deltaBucket = 100;
        else if (absDelta >= 50) deltaBucket = 50;
        else if (absDelta >= 25) deltaBucket = 25;
        
        // Time bucket
        let timeBucket = 0;
        if (tick.seconds_remaining >= 600) timeBucket = 600;
        else if (tick.seconds_remaining >= 300) timeBucket = 300;
        else if (tick.seconds_remaining >= 180) timeBucket = 180;
        else if (tick.seconds_remaining >= 120) timeBucket = 120;
        else if (tick.seconds_remaining >= 60) timeBucket = 60;
        
        // Check if price crossed strike after this tick
        let crossed = false;
        for (let j = i + 1; j < marketTicks.length; j++) {
          const future = marketTicks[j];
          if (!future.c_price) continue;
          const futureAbove = future.c_price > tick.strike_price;
          if (isAbove && !futureAbove) { crossed = true; break; }
          if (!isAbove && futureAbove) { crossed = true; break; }
        }
        
        observations.push({
          direction: isAbove ? 'ABOVE' : 'BELOW',
          deltaBucket,
          timeBucket,
          crossed,
        });
      }
    }

    // Aggregate
    const groups = new Map<string, { total: number; crossed: number }>();
    for (const obs of observations) {
      const key = `${obs.direction}:${obs.deltaBucket}:${obs.timeBucket}`;
      if (!groups.has(key)) {
        groups.set(key, { total: 0, crossed: 0 });
      }
      const g = groups.get(key)!;
      g.total++;
      if (obs.crossed) g.crossed++;
    }

    // Convert to output format with Wilson CI
    const results: CrossingStat[] = [];
    for (const [key, g] of groups) {
      if (g.total < 30) continue; // Need minimum samples
      
      const [dir, delta, time] = key.split(':');
      const p = g.crossed / g.total;
      const z = 1.96;
      const z2 = z * z;
      
      const denom = 1 + z2 / g.total;
      const center = p + z2 / (2 * g.total);
      const spread = z * Math.sqrt((p * (1 - p) + z2 / (4 * g.total)) / g.total);
      
      results.push({
        direction: dir,
        delta_bucket_min: parseInt(delta),
        time_bucket_min_sec: parseInt(time),
        sample_size: g.total,
        crossed_count: g.crossed,
        cross_pct: Math.round(p * 1000) / 10,
        ci_lower_95: Math.round(Math.max(0, (center - spread) / denom) * 1000) / 10,
        ci_upper_95: Math.round(Math.min(1, (center + spread) / denom) * 1000) / 10,
      });
    }

    // Sort
    results.sort((a, b) => {
      if (a.direction !== b.direction) return a.direction.localeCompare(b.direction);
      if (a.delta_bucket_min !== b.delta_bucket_min) return a.delta_bucket_min - b.delta_bucket_min;
      return b.time_bucket_min_sec - a.time_bucket_min_sec;
    });

    return results;
  }

  const formatTime = (sec: number) => {
    if (sec >= 600) return '10-15min';
    if (sec >= 300) return '5-10min';
    if (sec >= 180) return '3-5min';
    if (sec >= 120) return '2-3min';
    if (sec >= 60) return '1-2min';
    return '0-1min';
  };

  const getConfidenceColor = (lower: number, upper: number) => {
    const width = upper - lower;
    if (width < 10) return 'text-green-400';
    if (width < 20) return 'text-yellow-400';
    return 'text-orange-400';
  };

  const getSignificanceBadge = (crossPct: number, ciUpper: number) => {
    if (ciUpper < 5) {
      return <Badge className="bg-green-500/20 text-green-400 border-green-500/30"><CheckCircle className="w-3 h-3 mr-1" />Safe (&lt;5%)</Badge>;
    }
    if (ciUpper < 10) {
      return <Badge className="bg-emerald-500/20 text-emerald-400 border-emerald-500/30">Very Low</Badge>;
    }
    if (crossPct < 25) {
      return <Badge className="bg-yellow-500/20 text-yellow-400 border-yellow-500/30"><AlertTriangle className="w-3 h-3 mr-1" />Caution</Badge>;
    }
    return <Badge className="bg-red-500/20 text-red-400 border-red-500/30">High Risk</Badge>;
  };

  const aboveStats = stats.filter(s => s.direction === 'ABOVE');
  const belowStats = stats.filter(s => s.direction === 'BELOW');

  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg flex items-center gap-2">
            📊 Empirical Crossing Analysis
            <Badge variant="outline" className="ml-2">
              {stats.length} cells
            </Badge>
          </CardTitle>
          <div className="flex items-center gap-2">
            <Select value={asset} onValueChange={(v) => setAsset(v as Asset)}>
              <SelectTrigger className="w-24">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="BTC">BTC</SelectItem>
                <SelectItem value="ETH">ETH</SelectItem>
                <SelectItem value="SOL">SOL</SelectItem>
                <SelectItem value="XRP">XRP</SelectItem>
              </SelectContent>
            </Select>
            {loading && <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />}
          </div>
        </div>
        {lastUpdate && (
          <p className="text-xs text-muted-foreground">
            Last updated: {lastUpdate.toLocaleTimeString()}
          </p>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Above Strike Table */}
        <div>
          <h4 className="text-sm font-medium flex items-center gap-2 mb-2">
            <TrendingUp className="w-4 h-4 text-green-400" />
            ABOVE Strike (Price &gt; Strike → DOWN should win)
          </h4>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left py-1 px-2">Delta ≥</th>
                  <th className="text-left py-1 px-2">Time</th>
                  <th className="text-right py-1 px-2">n</th>
                  <th className="text-right py-1 px-2">Cross%</th>
                  <th className="text-right py-1 px-2">95% CI</th>
                  <th className="text-center py-1 px-2">Significance</th>
                </tr>
              </thead>
              <tbody>
                {aboveStats.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-4 text-center text-muted-foreground">
                      {loading ? 'Loading...' : 'No data with sufficient samples'}
                    </td>
                  </tr>
                ) : (
                  aboveStats.map((stat, i) => (
                    <tr key={i} className="border-b border-border/50 hover:bg-muted/20">
                      <td className="py-1 px-2 font-mono">${stat.delta_bucket_min}</td>
                      <td className="py-1 px-2">{formatTime(stat.time_bucket_min_sec)}</td>
                      <td className="py-1 px-2 text-right">{stat.sample_size}</td>
                      <td className="py-1 px-2 text-right font-mono">{stat.cross_pct}%</td>
                      <td className={`py-1 px-2 text-right font-mono ${getConfidenceColor(stat.ci_lower_95, stat.ci_upper_95)}`}>
                        [{stat.ci_lower_95}-{stat.ci_upper_95}]
                      </td>
                      <td className="py-1 px-2 text-center">
                        {getSignificanceBadge(stat.cross_pct, stat.ci_upper_95)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Below Strike Table */}
        <div>
          <h4 className="text-sm font-medium flex items-center gap-2 mb-2">
            <TrendingDown className="w-4 h-4 text-red-400" />
            BELOW Strike (Price &lt; Strike → UP should win)
          </h4>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left py-1 px-2">Delta ≥</th>
                  <th className="text-left py-1 px-2">Time</th>
                  <th className="text-right py-1 px-2">n</th>
                  <th className="text-right py-1 px-2">Cross%</th>
                  <th className="text-right py-1 px-2">95% CI</th>
                  <th className="text-center py-1 px-2">Significance</th>
                </tr>
              </thead>
              <tbody>
                {belowStats.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-4 text-center text-muted-foreground">
                      {loading ? 'Loading...' : 'No data with sufficient samples'}
                    </td>
                  </tr>
                ) : (
                  belowStats.map((stat, i) => (
                    <tr key={i} className="border-b border-border/50 hover:bg-muted/20">
                      <td className="py-1 px-2 font-mono">${stat.delta_bucket_min}</td>
                      <td className="py-1 px-2">{formatTime(stat.time_bucket_min_sec)}</td>
                      <td className="py-1 px-2 text-right">{stat.sample_size}</td>
                      <td className="py-1 px-2 text-right font-mono">{stat.cross_pct}%</td>
                      <td className={`py-1 px-2 text-right font-mono ${getConfidenceColor(stat.ci_lower_95, stat.ci_upper_95)}`}>
                        [{stat.ci_lower_95}-{stat.ci_upper_95}]
                      </td>
                      <td className="py-1 px-2 text-center">
                        {getSignificanceBadge(stat.cross_pct, stat.ci_upper_95)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Key Insights */}
        <div className="bg-muted/30 rounded-lg p-3 space-y-2">
          <h4 className="text-sm font-medium">📌 Key Insights (95% Confidence)</h4>
          <ul className="text-xs space-y-1 text-muted-foreground">
            <li>• <span className="text-green-400">Safe</span>: Upper CI &lt; 5% → Near-certain outcome</li>
            <li>• <span className="text-yellow-400">Caution</span>: Cross probability 10-25% → Still risky</li>
            <li>• <span className="text-red-400">High Risk</span>: Cross probability &gt; 25% → Uncertain outcome</li>
          </ul>
        </div>
      </CardContent>
    </Card>
  );
}
