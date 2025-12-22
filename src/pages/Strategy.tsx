import { BarChart3, RefreshCw, ArrowLeft, Brain } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { useTrades } from '@/hooks/useTrades';
import { mockTrades, traderStats as mockStats } from '@/data/mockTrades';
import { format } from 'date-fns';
import { 
  TradingPatterns, 
  OutcomeAnalysis, 
  MarketAnalysis, 
  PositionSizing,
  StrategyInsights,
  EntryPriceAnalysis,
  TradeVelocity
} from '@/components/StrategyAnalysis';

const Strategy = () => {
  const { trades, stats, scrape, isScraping } = useTrades('gabagool22');

  // Use live data if available, fallback to mock data
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
              <span className="font-semibold text-lg">Strategy Analysis</span>
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
              <h1 className="text-2xl font-bold text-gradient">@gabagool22 Strategy</h1>
              <p className="text-muted-foreground">
                Analyzing {displayTrades.length} trades • Total Volume: ${displayStats.totalVolume.toLocaleString()}
              </p>
            </div>
          </div>
        </div>

        {/* Strategy Insights */}
        <StrategyInsights trades={displayTrades} />

        {/* Trading Patterns */}
        <div>
          <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
            <span className="text-primary">📊</span> Trading Patterns
          </h2>
          <TradingPatterns trades={displayTrades} />
        </div>

        {/* Outcome & Side Analysis */}
        <div>
          <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
            <span className="text-primary">🎯</span> Position Analysis
          </h2>
          <OutcomeAnalysis trades={displayTrades} />
        </div>

        {/* Market & Position Sizing */}
        <div className="grid lg:grid-cols-2 gap-6">
          <MarketAnalysis trades={displayTrades} />
          <PositionSizing trades={displayTrades} />
        </div>

        {/* Entry Price & Velocity Analysis - NEW */}
        <div>
          <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
            <span className="text-primary">⚡</span> Execution Analysis
          </h2>
          <div className="grid lg:grid-cols-2 gap-6">
            <EntryPriceAnalysis trades={displayTrades} />
            <TradeVelocity trades={displayTrades} />
          </div>
        </div>

        {/* How to Copy */}
        <div className="glass rounded-lg p-6 border-l-4 border-primary">
          <h2 className="text-lg font-semibold mb-3 flex items-center gap-2">
            <span>💡</span> Hoe deze strategie te kopiëren
          </h2>
          <div className="space-y-3 text-sm text-muted-foreground">
            <p>
              <strong className="text-foreground">1. Timing:</strong> Let op de uren en dagen waarop de meeste trades plaatsvinden. 
              Dit kan wijzen op specifieke nieuwsmomenten of marktpatronen.
            </p>
            <p>
              <strong className="text-foreground">2. Positie-grootte:</strong> Kopieer de gemiddelde positiegrootte relatief aan je eigen kapitaal. 
              Als gabagool22 gemiddeld $500 per trade inzet, en je hebt 10x minder kapitaal, richt dan op $50.
            </p>
            <p>
              <strong className="text-foreground">3. Market selectie:</strong> Focus op dezelfde type markten. 
              De meest verhandelde markten geven aan waar de expertise ligt.
            </p>
            <p>
              <strong className="text-foreground">4. Yes/No bias:</strong> Als er een sterke voorkeur is voor Yes of No posities, 
              kan dit een specifieke beleggingsfilosofie aangeven.
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
