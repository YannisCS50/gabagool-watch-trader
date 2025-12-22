import { RefreshCw, ArrowLeft, Sparkles } from 'lucide-react';
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
  TradeVelocity,
} from '@/components/StrategyAnalysis';

const TradingStrategies = () => {
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
              <Link to="/strategy" className="flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors">
                <ArrowLeft className="w-4 h-4" />
              </Link>
              <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-purple-500 to-pink-500 flex items-center justify-center">
                <Sparkles className="w-4 h-4 text-primary-foreground" />
              </div>
              <span className="font-semibold text-lg">Trading Strategies</span>
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
            <div className="w-16 h-16 rounded-full bg-gradient-to-br from-purple-500 to-pink-500 flex items-center justify-center text-primary-foreground font-bold text-2xl">
              G
            </div>
            <div>
              <h1 className="text-2xl font-bold text-gradient">@gabagool22 Strategies</h1>
              <p className="text-muted-foreground">
                Analyzing {displayTrades.length} trades • Total Volume: ${displayStats.totalVolume.toLocaleString()}
              </p>
            </div>
          </div>
        </div>

        {/* Strategy Types */}
        <div className="glass rounded-lg p-6">
          <h2 className="text-lg font-semibold mb-4">📊 Strategie Types</h2>
          <div className="grid md:grid-cols-4 gap-4">
            <div className="bg-success/10 border border-success/20 rounded-lg p-4 text-center">
              <p className="text-2xl mb-1">🎯</p>
              <p className="font-semibold text-success">Near-Certain</p>
              <p className="text-xs text-muted-foreground">90-99¢ trades</p>
              <p className="text-xs text-muted-foreground mt-1">Kleine maar zekere winsten</p>
            </div>
            <div className="bg-purple-500/10 border border-purple-500/20 rounded-lg p-4 text-center">
              <p className="text-2xl mb-1">🎲</p>
              <p className="font-semibold text-purple-400">Longshots</p>
              <p className="text-xs text-muted-foreground">1-10¢ trades</p>
              <p className="text-xs text-muted-foreground mt-1">Hoge risk/reward ratio</p>
            </div>
            <div className="bg-warning/10 border border-warning/20 rounded-lg p-4 text-center">
              <p className="text-2xl mb-1">⚖️</p>
              <p className="font-semibold text-warning">Mid-Range</p>
              <p className="text-xs text-muted-foreground">10-90¢ trades</p>
              <p className="text-xs text-muted-foreground mt-1">Gebalanceerde bets</p>
            </div>
            <div className="bg-primary/10 border border-primary/20 rounded-lg p-4 text-center">
              <p className="text-2xl mb-1">⚡</p>
              <p className="font-semibold text-primary">Scalping</p>
              <p className="text-xs text-muted-foreground">Snelle trades</p>
              <p className="text-xs text-muted-foreground mt-1">Kleine prijsbewegingen</p>
            </div>
          </div>
        </div>

        {/* Entry Price & Extreme Odds Analysis */}
        <div>
          <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
            <span className="text-success">🎯</span> Entry Prices & Extreme Odds
          </h2>
          <EntryPriceAnalysis trades={displayTrades} />
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

        {/* Trade Velocity */}
        <div>
          <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
            <span className="text-primary">⚡</span> Trade Velocity
          </h2>
          <TradeVelocity trades={displayTrades} />
        </div>

        {/* How to Copy */}
        <div className="glass rounded-lg p-6 border-l-4 border-purple-500">
          <h2 className="text-lg font-semibold mb-3 flex items-center gap-2">
            <span>💡</span> Strategie Kopiëren
          </h2>
          <div className="space-y-3 text-sm text-muted-foreground">
            <p>
              <strong className="text-foreground">Near-Certain Strategy:</strong> Koop shares tegen 95¢+ voor events die vrijwel zeker zijn. 
              Je wint 5% per trade, maar verliest alles als je fout zit.
            </p>
            <p>
              <strong className="text-foreground">Longshot Strategy:</strong> Koop penny shares (1-5¢) voor onwaarschijnlijke events. 
              De meeste verliezen, maar één hit kan 20-100x opleveren.
            </p>
            <p>
              <strong className="text-foreground">Mid-Range Strategy:</strong> Focus op 30-70¢ trades waar je een informatievoordeel hebt. 
              Dit vereist de meeste research maar biedt de beste risk-adjusted returns.
            </p>
            <p>
              <strong className="text-foreground">Scalping:</strong> Profiteer van korte-termijn prijsbewegingen door snel in en uit te stappen. 
              Vereist veel tijd en snelle executie.
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

export default TradingStrategies;
