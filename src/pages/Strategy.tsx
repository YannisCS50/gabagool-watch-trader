import { BarChart3, RefreshCw, ArrowLeft, Brain, Target, Sparkles } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { useTrades } from '@/hooks/useTrades';
import { mockTrades, traderStats as mockStats } from '@/data/mockTrades';
import { format } from 'date-fns';

const Strategy = () => {
  const { trades, stats, scrape, isScraping } = useTrades('gabagool22');

  const displayTrades = trades.length > 0 ? trades : mockTrades;
  const displayStats = stats?.totalTrades ? stats : mockStats;
  const isLiveData = trades.length > 0;

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border/50 bg-card/50 backdrop-blur-xl sticky top-0 z-50">
        <div className="container mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Link to="/" className="flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors">
                <ArrowLeft className="w-4 h-4" />
              </Link>
              <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-primary to-emerald-400 flex items-center justify-center">
                <Brain className="w-4 h-4 text-primary-foreground" />
              </div>
              <span className="font-semibold text-lg">Strategy Hub</span>
              {isLiveData && (
                <span className="text-xs px-2 py-0.5 rounded-full bg-success/20 text-success font-mono">
                  LIVE
                </span>
              )}
            </div>
            <div className="flex items-center gap-4">
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
        {/* Trader Info */}
        <div className="glass rounded-lg p-6">
          <div className="flex items-center gap-4">
            <div className="w-16 h-16 rounded-full bg-gradient-to-br from-primary to-emerald-400 flex items-center justify-center text-primary-foreground font-bold text-2xl">
              G
            </div>
            <div>
              <h1 className="text-2xl font-bold text-gradient">@gabagool22 Strategy Hub</h1>
              <p className="text-muted-foreground">
                Analyzing {displayTrades.length} trades • Total Volume: ${displayStats.totalVolume.toLocaleString()}
              </p>
            </div>
          </div>
        </div>

        {/* Strategy Cards */}
        <div className="grid md:grid-cols-2 gap-6">
          {/* Arbitrage Card */}
          <Link to="/arbitrage" className="group">
            <div className="glass rounded-lg p-6 border-2 border-transparent hover:border-success/50 transition-all h-full">
              <div className="flex items-start gap-4">
                <div className="w-12 h-12 rounded-lg bg-gradient-to-br from-success to-emerald-400 flex items-center justify-center flex-shrink-0">
                  <Target className="w-6 h-6 text-primary-foreground" />
                </div>
                <div className="flex-1">
                  <h2 className="text-xl font-semibold mb-2 group-hover:text-success transition-colors">
                    💰 Arbitrage Analysis
                  </h2>
                  <p className="text-sm text-muted-foreground mb-4">
                    Analyse van YES + NO trades in dezelfde markt. Detecteer winstgevende arbitrage kansen 
                    en exposed/unhedged posities.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <span className="text-xs px-2 py-1 rounded-full bg-success/20 text-success">Complete Arbs</span>
                    <span className="text-xs px-2 py-1 rounded-full bg-warning/20 text-warning">Exposed Positions</span>
                    <span className="text-xs px-2 py-1 rounded-full bg-primary/20 text-primary">Risk Analysis</span>
                  </div>
                </div>
              </div>
              <div className="mt-4 pt-4 border-t border-border flex justify-between items-center">
                <span className="text-xs text-muted-foreground">Klik om te openen →</span>
                <span className="text-xs font-mono text-success">YES + NO &lt; 1.00 = Profit</span>
              </div>
            </div>
          </Link>

          {/* Trading Strategies Card */}
          <Link to="/trading-strategies" className="group">
            <div className="glass rounded-lg p-6 border-2 border-transparent hover:border-purple-500/50 transition-all h-full">
              <div className="flex items-start gap-4">
                <div className="w-12 h-12 rounded-lg bg-gradient-to-br from-purple-500 to-pink-500 flex items-center justify-center flex-shrink-0">
                  <Sparkles className="w-6 h-6 text-primary-foreground" />
                </div>
                <div className="flex-1">
                  <h2 className="text-xl font-semibold mb-2 group-hover:text-purple-400 transition-colors">
                    📊 Trading Strategies
                  </h2>
                  <p className="text-sm text-muted-foreground mb-4">
                    Analyse van near-certain trades, longshots, mid-range bets en scalping patronen. 
                    Begrijp de volledige trading strategie.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <span className="text-xs px-2 py-1 rounded-full bg-success/20 text-success">Near-Certain</span>
                    <span className="text-xs px-2 py-1 rounded-full bg-purple-500/20 text-purple-400">Longshots</span>
                    <span className="text-xs px-2 py-1 rounded-full bg-warning/20 text-warning">Mid-Range</span>
                    <span className="text-xs px-2 py-1 rounded-full bg-primary/20 text-primary">Scalping</span>
                  </div>
                </div>
              </div>
              <div className="mt-4 pt-4 border-t border-border flex justify-between items-center">
                <span className="text-xs text-muted-foreground">Klik om te openen →</span>
                <span className="text-xs font-mono text-purple-400">4 Strategy Types</span>
              </div>
            </div>
          </Link>
        </div>

        {/* Quick Stats */}
        <div className="glass rounded-lg p-6">
          <h2 className="text-lg font-semibold mb-4">📈 Quick Stats</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="bg-muted/50 rounded-lg p-4 text-center">
              <p className="text-xs text-muted-foreground">Total Trades</p>
              <p className="text-2xl font-mono font-semibold text-primary">{displayTrades.length}</p>
            </div>
            <div className="bg-muted/50 rounded-lg p-4 text-center">
              <p className="text-xs text-muted-foreground">Total Volume</p>
              <p className="text-2xl font-mono font-semibold">${displayStats.totalVolume.toLocaleString()}</p>
            </div>
            <div className="bg-muted/50 rounded-lg p-4 text-center">
              <p className="text-xs text-muted-foreground">Win Rate</p>
              <p className="text-2xl font-mono font-semibold text-success">{displayStats.winRate}%</p>
            </div>
            <div className="bg-muted/50 rounded-lg p-4 text-center">
              <p className="text-xs text-muted-foreground">Avg Trade Size</p>
              <p className="text-2xl font-mono font-semibold">${displayStats.avgTradeSize.toFixed(0)}</p>
            </div>
          </div>
        </div>

        {/* How it works */}
        <div className="glass rounded-lg p-6 border-l-4 border-primary">
          <h2 className="text-lg font-semibold mb-3">🎓 Hoe het werkt</h2>
          <div className="space-y-3 text-sm text-muted-foreground">
            <p>
              <strong className="text-foreground">Arbitrage:</strong> Koopt zowel YES als NO in dezelfde markt. 
              Als de gecombineerde prijs onder $1.00 is, maak je gegarandeerd winst ongeacht de uitkomst.
            </p>
            <p>
              <strong className="text-foreground">Near-Certain:</strong> Koopt shares voor events die vrijwel zeker zijn (90%+). 
              Kleine maar consistente winsten.
            </p>
            <p>
              <strong className="text-foreground">Longshots:</strong> Koopt goedkope shares (&lt;10¢) voor onwaarschijnlijke events. 
              Hoge risk/reward ratio.
            </p>
            <p>
              <strong className="text-foreground">Mid-Range:</strong> Trades tussen 10-90¢ gebaseerd op eigen research en informatie-voordeel.
            </p>
          </div>
        </div>

        {/* Footer */}
        <div className="text-center py-8">
          <p className="text-xs text-muted-foreground">
            {isLiveData 
              ? 'Analyse gebaseerd op live Polymarket data'
              : 'Analyse gebaseerd op demo data. Klik "Refresh Data" voor live data.'
            }
          </p>
        </div>
      </main>
    </div>
  );
};

export default Strategy;
