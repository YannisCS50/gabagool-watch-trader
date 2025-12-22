import { TrendingUp, DollarSign, Target, BarChart3 } from 'lucide-react';
import { mockTrades, traderStats, positions } from '@/data/mockTrades';
import { StatCard } from '@/components/StatCard';
import { TradesTable } from '@/components/TradesTable';
import { PositionCard } from '@/components/PositionCard';
import { ActivityChart } from '@/components/ActivityChart';
import { TraderHeader } from '@/components/TraderHeader';
import { format } from 'date-fns';

const Index = () => {
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
            </div>
            <div className="text-xs font-mono text-muted-foreground">
              {format(new Date(), 'MMM dd, yyyy HH:mm')} UTC
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="container mx-auto px-4 py-6 space-y-6">
        {/* Trader Header */}
        <TraderHeader username="gabagool22" stats={traderStats} />

        {/* Stats Grid */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard
            label="Total Trades"
            value={traderStats.totalTrades}
            icon={<TrendingUp className="w-5 h-5" />}
          />
          <StatCard
            label="Total Volume"
            value={`$${traderStats.totalVolume.toLocaleString()}`}
            icon={<DollarSign className="w-5 h-5" />}
          />
          <StatCard
            label="Win Rate"
            value={`${traderStats.winRate}%`}
            icon={<Target className="w-5 h-5" />}
            trend={{ value: 2.3, isPositive: true }}
          />
          <StatCard
            label="Avg Trade"
            value={`$${traderStats.avgTradeSize}`}
            icon={<BarChart3 className="w-5 h-5" />}
          />
        </div>

        {/* Chart & Positions */}
        <div className="grid lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2">
            <ActivityChart trades={mockTrades} />
          </div>
          <div className="space-y-4">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              Active Positions
            </h2>
            <div className="space-y-3">
              {positions.slice(0, 3).map((position, index) => (
                <PositionCard key={position.marketSlug} position={position} index={index} />
              ))}
            </div>
          </div>
        </div>

        {/* Trades Table */}
        <TradesTable trades={mockTrades} />

        {/* Footer Note */}
        <div className="text-center py-8">
          <p className="text-xs text-muted-foreground">
            Data shown is for demonstration purposes. Connect to Lovable Cloud to enable live tracking.
          </p>
        </div>
      </main>
    </div>
  );
};

export default Index;
