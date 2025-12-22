import { TrendingUp, DollarSign, Target, BarChart3, RefreshCw, Brain, AlertCircle, Calculator, ChevronDown } from 'lucide-react';
import { Link } from 'react-router-dom';
import { StatCard } from '@/components/StatCard';
import { TradesTable } from '@/components/TradesTable';
import { PositionCard } from '@/components/PositionCard';
import { ActivityChart } from '@/components/ActivityChart';
import { TraderHeader } from '@/components/TraderHeader';
import { Button } from '@/components/ui/button';
import { useTrades } from '@/hooks/useTrades';
import { format } from 'date-fns';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

const Index = () => {
  const { trades, stats, positions, isLoading, scrape, isScraping } = useTrades('gabagool22');

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
      {/* Header */}
      <header className="border-b border-border/50 bg-card/50 backdrop-blur-xl sticky top-0 z-50">
        <div className="container mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-primary to-emerald-400 flex items-center justify-center">
                <BarChart3 className="w-4 h-4 text-primary-foreground" />
              </div>
              <span className="font-semibold text-lg">PolyTracker</span>
              {hasData && (
                <span className="text-xs px-2 py-0.5 rounded-full bg-success/20 text-success font-mono">
                  LIVE
                </span>
              )}
            </div>
            <div className="flex items-center gap-4">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="secondary" size="sm" className="font-mono text-xs">
                    <Brain className="w-3 h-3 mr-2" />
                    Analysis
                    <ChevronDown className="w-3 h-3 ml-2" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem asChild>
                    <Link to="/strategy" className="flex items-center gap-2">
                      <Brain className="w-4 h-4" />
                      Strategy Analysis
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <Link to="/arbitrage" className="flex items-center gap-2">
                      <Target className="w-4 h-4" />
                      Arbitrage Analysis
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <Link to="/entry-analysis" className="flex items-center gap-2">
                      <Calculator className="w-4 h-4" />
                      Entry Price Analysis
                    </Link>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <Button
                variant="outline"
                size="sm"
                onClick={() => scrape()}
                disabled={isScraping}
                className="font-mono text-xs"
              >
                <RefreshCw className={`w-3 h-3 mr-2 ${isScraping ? 'animate-spin' : ''}`} />
                {isScraping ? 'Scraping...' : 'Refresh Data'}
              </Button>
              <div className="text-xs font-mono text-muted-foreground">
                {format(new Date(), 'MMM dd, yyyy HH:mm')} UTC
              </div>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="container mx-auto px-4 py-6 space-y-6">
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
            label="Win Rate"
            value={`${displayStats.winRate}%`}
            icon={<Target className="w-5 h-5" />}
            trend={{ value: 2.3, isPositive: true }}
          />
          <StatCard
            label="Avg Trade"
            value={`$${Math.round(displayStats.avgTradeSize)}`}
            icon={<BarChart3 className="w-5 h-5" />}
          />
        </div>

        {/* Chart & Positions */}
        <div className="grid lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2">
            <ActivityChart trades={trades} />
          </div>
          <div className="space-y-4">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              Active Positions
            </h2>
            {positions.length > 0 ? (
              <div className="space-y-3">
                {positions.slice(0, 3).map((position, index) => (
                  <PositionCard key={position.marketSlug + position.outcome} position={position} index={index} />
                ))}
              </div>
            ) : (
              <div className="glass rounded-lg p-6 text-center">
                <AlertCircle className="w-8 h-8 mx-auto mb-2 text-muted-foreground/50" />
                <p className="text-sm text-muted-foreground">No open positions</p>
              </div>
            )}
          </div>
        </div>

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
