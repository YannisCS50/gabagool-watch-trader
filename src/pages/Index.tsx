import { useMemo, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { TrendingUp, DollarSign, Target, BarChart3, RefreshCw, AlertCircle, Zap, ArrowRight, CheckCircle2, Activity } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { StatCard } from '@/components/StatCard';
import { TradesTable } from '@/components/TradesTable';
import { LiveOpenPositions } from '@/components/StrategyAnalysis';
import { ActivityChart } from '@/components/ActivityChart';
import { PnLChart } from '@/components/PnLChart';
import { TraderHeader } from '@/components/TraderHeader';
import { LiveRunnerStatus } from '@/components/LiveRunnerStatus';
import { MainNav } from '@/components/MainNav';
import { MobileNav } from '@/components/MobileNav';
import { DownloadRangeLogsButton } from '@/components/DownloadRangeLogsButton';
import { DownloadStrategyButton } from '@/components/DownloadStrategyButton';
import { DownloadOpeningTicksButton } from '@/components/DownloadOpeningTicksButton';
import { PolymarketScreenshotExtractor } from '@/components/PolymarketScreenshotExtractor';
import { Button } from '@/components/ui/button';
import { useTrades } from '@/hooks/useTrades';
import { format } from 'date-fns';

const Index = () => {
  const { trades, stats, positions, isLoading, scrape, isScraping } = useTrades('gabagool22');
  const [v26Online, setV26Online] = useState(false);
  const [v26TradesCount, setV26TradesCount] = useState(0);
  const [v27Stats, setV27Stats] = useState({ online: false, evaluations: 0, entries: 0 });

  // Fetch V26 and V27 runner status
  useEffect(() => {
    const fetchStatus = async () => {
      // V26 status
      const { data: v26Data } = await supabase
        .from('runner_heartbeats')
        .select('last_heartbeat, trades_count')
        .eq('runner_type', 'v26')
        .order('last_heartbeat', { ascending: false })
        .limit(1)
        .maybeSingle();
      
      if (v26Data) {
        const isOnline = new Date(v26Data.last_heartbeat).getTime() > Date.now() - 60000;
        setV26Online(isOnline);
        setV26TradesCount(v26Data.trades_count || 0);
      }

      // V27 status from evaluations - use any() to avoid type depth issues
      const recentDate = new Date(Date.now() - 60000).toISOString();
      const { count } = await (supabase as any)
        .from('v27_evaluations')
        .select('id', { count: 'exact', head: true })
        .gte('created_at', recentDate);

      const { count: entryCount } = await (supabase as any)
        .from('v27_evaluations')
        .select('id', { count: 'exact', head: true })
        .eq('decision', 'ENTER');

      setV27Stats({
        online: (count || 0) > 0,
        evaluations: count || 0,
        entries: entryCount || 0
      });
    };

    fetchStatus();
    const interval = setInterval(fetchStatus, 10000);
    return () => clearInterval(interval);
  }, []);

  // Calculate arbitrage success rate client-side (same logic as StrategyDeepDive)
  const arbitrageWinRate = useMemo(() => {
    if (trades.length === 0) return 0;

    // Group trades by market
    const marketGroups = new Map<string, typeof trades>();
    trades.forEach(t => {
      if (!marketGroups.has(t.market)) marketGroups.set(t.market, []);
      marketGroups.get(t.market)!.push(t);
    });

    let arbitrageCount = 0;
    let totalPairs = 0;

    marketGroups.forEach((marketTrades) => {
      const buys = marketTrades.filter(t => t.side === 'buy');
      const upBuys = buys.filter(t => 
        t.outcome === 'Yes' || t.outcome.toLowerCase().includes('up') || t.outcome.toLowerCase().includes('above')
      );
      const downBuys = buys.filter(t => 
        t.outcome === 'No' || t.outcome.toLowerCase().includes('down') || t.outcome.toLowerCase().includes('below')
      );

      if (upBuys.length > 0 && downBuys.length > 0) {
        // Match pairs by time proximity
        upBuys.forEach(upBuy => {
          const closestDown = downBuys.reduce((closest, down) => {
            const currentDiff = Math.abs(down.timestamp.getTime() - upBuy.timestamp.getTime());
            const closestDiff = closest ? Math.abs(closest.timestamp.getTime() - upBuy.timestamp.getTime()) : Infinity;
            return currentDiff < closestDiff ? down : closest;
          }, null as typeof downBuys[0] | null);

          if (closestDown) {
            const combinedPrice = upBuy.price + closestDown.price;
            totalPairs++;
            if (combinedPrice < 0.98) arbitrageCount++;
          }
        });
      }
    });

    return totalPairs > 0 ? Math.round((arbitrageCount / totalPairs) * 100) : 0;
  }, [trades]);

  // Use actual data - no mock fallback
  const hasData = trades.length > 0 || (stats?.totalTrades ?? 0) > 0;
  const defaultStats = {
    totalTrades: 0,
    totalVolume: 0,
    winRate: 0,
    avgTradeSize: 0,
    activeSince: new Date(),
    lastActive: new Date(),
  };
  const displayStats = stats?.totalTrades ? stats : defaultStats;

  return (
    <div className="min-h-screen bg-background">
      {/* Header with Main Nav */}
      <header className="border-b border-border/50 bg-card/50 backdrop-blur-xl sticky top-0 z-50">
        <div className="container mx-auto px-4 py-3">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <MobileNav />
              <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-primary to-emerald-400 flex items-center justify-center">
                <BarChart3 className="w-4 h-4 text-primary-foreground" />
              </div>
              <span className="font-semibold text-lg hidden sm:block">PolyTracker</span>
              {hasData && (
                <span className="text-xs px-2 py-0.5 rounded-full bg-success/20 text-success font-mono">
                  LIVE
                </span>
              )}
            </div>
            <div className="flex-1 overflow-x-auto hidden md:block">
              <MainNav />
            </div>
            <div className="flex items-center gap-2">
              <DownloadOpeningTicksButton />
              <DownloadRangeLogsButton />
              <DownloadStrategyButton />
              <Button
                variant="outline"
                size="sm"
                onClick={() => scrape()}
                disabled={isScraping}
                className="font-mono text-xs"
              >
                <RefreshCw className={`w-3 h-3 mr-2 ${isScraping ? 'animate-spin' : ''}`} />
                {isScraping ? 'Scraping...' : 'Refresh'}
              </Button>
              <div className="text-xs font-mono text-muted-foreground hidden lg:block">
                {format(new Date(), 'MMM dd, HH:mm')}
              </div>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="container mx-auto px-4 py-6 space-y-6">
        {/* V26 Strategy Dashboard Link */}
        <Link to="/v26" className="block">
          <div className={`relative overflow-hidden rounded-xl border p-4 hover:border-primary/50 transition-all group cursor-pointer ${
            v26Online 
              ? 'border-emerald-500/30 bg-gradient-to-r from-emerald-500/10 via-emerald-500/5 to-transparent hover:from-emerald-500/20' 
              : 'border-border/50 bg-gradient-to-r from-muted/30 via-muted/10 to-transparent'
          }`}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${
                  v26Online ? 'bg-emerald-500/20' : 'bg-muted/50'
                }`}>
                  <Zap className={`w-5 h-5 ${v26Online ? 'text-emerald-400' : 'text-muted-foreground'}`} />
                </div>
                <div>
                  <h3 className="font-semibold text-lg flex items-center gap-2">
                    V26 Pre-Market Strategy
                    {v26Online ? (
                      <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 font-mono flex items-center gap-1">
                        <CheckCircle2 className="w-3 h-3" />
                        ONLINE
                      </span>
                    ) : (
                      <span className="text-xs px-2 py-0.5 rounded-full bg-destructive/20 text-destructive font-mono flex items-center gap-1">
                        <AlertCircle className="w-3 h-3" />
                        OFFLINE
                      </span>
                    )}
                  </h3>
                  <p className="text-sm text-muted-foreground">
                    Automated DOWN-only pre-market trading • {v26TradesCount} trades
                  </p>
                </div>
              </div>
              <ArrowRight className={`w-5 h-5 group-hover:translate-x-1 transition-transform ${
                v26Online ? 'text-emerald-400' : 'text-muted-foreground'
              }`} />
            </div>
          </div>
        </Link>

        {/* V27 Delta Mispricing Strategy Link */}
        <Link to="/v27" className="block">
          <div className={`relative overflow-hidden rounded-xl border p-4 hover:border-primary/50 transition-all group cursor-pointer ${
            v27Stats.online 
              ? 'border-violet-500/30 bg-gradient-to-r from-violet-500/10 via-violet-500/5 to-transparent hover:from-violet-500/20' 
              : 'border-border/50 bg-gradient-to-r from-muted/30 via-muted/10 to-transparent'
          }`}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${
                  v27Stats.online ? 'bg-violet-500/20' : 'bg-muted/50'
                }`}>
                  <Activity className={`w-5 h-5 ${v27Stats.online ? 'text-violet-400' : 'text-muted-foreground'}`} />
                </div>
                <div>
                  <h3 className="font-semibold text-lg flex items-center gap-2">
                    V27 Delta Mispricing
                    {v27Stats.online ? (
                      <span className="text-xs px-2 py-0.5 rounded-full bg-violet-500/20 text-violet-400 font-mono flex items-center gap-1">
                        <CheckCircle2 className="w-3 h-3" />
                        SHADOW
                      </span>
                    ) : (
                      <span className="text-xs px-2 py-0.5 rounded-full bg-muted/50 text-muted-foreground font-mono flex items-center gap-1">
                        <AlertCircle className="w-3 h-3" />
                        OFFLINE
                      </span>
                    )}
                  </h3>
                  <p className="text-sm text-muted-foreground">
                    Spot-leading mispricing detection • {v27Stats.entries} shadow entries
                  </p>
                </div>
              </div>
              <ArrowRight className={`w-5 h-5 group-hover:translate-x-1 transition-transform ${
                v27Stats.online ? 'text-violet-400' : 'text-muted-foreground'
              }`} />
            </div>
          </div>
        </Link>

        {/* Live Runner Status Widget */}
        <LiveRunnerStatus />

        {/* Screenshot Extractor */}
        <PolymarketScreenshotExtractor />

        {/* Trader Header */}
        <TraderHeader username="gabagool22" stats={displayStats} />

        {/* Stats Grid */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard
            label="Total Trades"
            value={displayStats.totalTrades}
            icon={<TrendingUp className="w-5 h-5" />}
          />
          <StatCard
            label="Total Volume"
            value={`$${displayStats.totalVolume.toLocaleString()}`}
            icon={<DollarSign className="w-5 h-5" />}
          />
          <StatCard
            label="Arbitrage Rate"
            value={`${arbitrageWinRate}%`}
            icon={<Target className="w-5 h-5" />}
          />
          <StatCard
            label="Avg Trade"
            value={`$${Math.round(displayStats.avgTradeSize)}`}
            icon={<BarChart3 className="w-5 h-5" />}
          />
        </div>

        {/* PnL Chart */}
        <PnLChart trades={trades} />

        {/* Chart */}
        <ActivityChart trades={trades} />

        {/* All Positions - Same display as /arbitrage */}
        {positions.length > 0 && (
          <LiveOpenPositions positions={positions} trades={trades} />
        )}

        {/* Trades Table */}
        {isLoading ? (
          <div className="glass rounded-lg p-8 text-center">
            <div className="animate-pulse text-muted-foreground">Loading trades...</div>
          </div>
        ) : trades.length > 0 ? (
          <TradesTable trades={trades} />
        ) : (
          <div className="glass rounded-lg p-8 text-center">
            <AlertCircle className="w-10 h-10 mx-auto mb-3 text-muted-foreground/50" />
            <p className="text-muted-foreground mb-2">No trades found</p>
            <p className="text-xs text-muted-foreground/70">Click "Refresh Data" to fetch trades from Polymarket</p>
          </div>
        )}

        {/* Footer Note */}
        <div className="text-center py-8">
          <p className="text-xs text-muted-foreground">
            {hasData 
              ? 'Showing live data from Polymarket. Click "Refresh Data" to update.'
              : 'No data yet. Click "Refresh Data" to fetch live trades from Polymarket.'
            }
          </p>
        </div>
      </main>
    </div>
  );
};

export default Index;
