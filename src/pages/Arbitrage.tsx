import { RefreshCw, ArrowLeft, Target, AlertCircle } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { useTrades } from '@/hooks/useTrades';
import { mockTrades, traderStats as mockStats } from '@/data/mockTrades';
import { format } from 'date-fns';
import { ArbitrageAnalysis, ClosedBetsHistory, LiveOpenPositions } from '@/components/StrategyAnalysis';

const Arbitrage = () => {
  const { trades, stats, positions, scrape, isScraping } = useTrades('gabagool22');

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
              <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-success to-emerald-400 flex items-center justify-center">
                <Target className="w-4 h-4 text-primary-foreground" />
              </div>
              <span className="font-semibold text-lg">Arbitrage Analysis</span>
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
            <div className="w-16 h-16 rounded-full bg-gradient-to-br from-success to-emerald-400 flex items-center justify-center text-primary-foreground font-bold text-2xl">
              G
            </div>
            <div>
              <h1 className="text-2xl font-bold text-gradient">@gabagool22 Arbitrage</h1>
              <p className="text-muted-foreground">
                Analyzing {displayTrades.length} trades • Total Volume: ${displayStats.totalVolume.toLocaleString()}
              </p>
            </div>
          </div>
        </div>

        {/* Description */}
        <div className="glass rounded-lg p-6 border-l-4 border-success">
          <h2 className="text-lg font-semibold mb-2">💰 Wat is Arbitrage?</h2>
          <p className="text-sm text-muted-foreground mb-3">
            Arbitrage is wanneer je zowel YES als NO koopt in dezelfde markt voor een gecombineerde prijs onder $1.00. 
            Ongeacht de uitkomst win je het verschil. Bijvoorbeeld: YES @ 45¢ + NO @ 50¢ = 95¢ totaal → 5% winst gegarandeerd.
          </p>
          <div className="grid grid-cols-3 gap-4 text-center">
            <div className="bg-success/10 rounded-lg p-3">
              <p className="text-xs text-muted-foreground">Winstgevend als</p>
              <p className="text-lg font-mono font-semibold text-success">YES + NO &lt; 1.00</p>
            </div>
            <div className="bg-warning/10 rounded-lg p-3">
              <p className="text-xs text-muted-foreground">Breakeven</p>
              <p className="text-lg font-mono font-semibold text-warning">YES + NO = 1.00</p>
            </div>
            <div className="bg-destructive/10 rounded-lg p-3">
              <p className="text-xs text-muted-foreground">Verlies</p>
              <p className="text-lg font-mono font-semibold text-destructive">YES + NO &gt; 1.00</p>
            </div>
          </div>
        </div>

        {/* Live Open Positions from Polymarket */}
        {positions.length > 0 && (
          <LiveOpenPositions positions={positions} trades={displayTrades} />
        )}

        {/* Arbitrage Analysis Component */}
        <ArbitrageAnalysis trades={displayTrades} />

        {/* Closed Bets History */}
        <ClosedBetsHistory trades={displayTrades} />

        {/* Tips */}
        <div className="glass rounded-lg p-6">
          <h2 className="text-lg font-semibold mb-3">🎓 Arbitrage Tips</h2>
          <div className="space-y-3 text-sm text-muted-foreground">
            <p>
              <strong className="text-foreground">1. Timing is cruciaal:</strong> Arbitrage kansen verdwijnen snel. 
              Binnen seconden tot minuten corrigeert de markt zichzelf.
            </p>
            <p>
              <strong className="text-foreground">2. Let op fees:</strong> Polymarket rekent fees die je arbitrage marge kunnen opeten. 
              Zorg dat je spread groot genoeg is.
            </p>
            <p>
              <strong className="text-foreground">3. Exposed posities:</strong> Als je alleen één kant hebt gekocht, 
              wacht je mogelijk op een betere prijs voor de andere kant. Dit is riskanter.
            </p>
            <p>
              <strong className="text-foreground">4. Volume matching:</strong> Probeer gelijke hoeveelheden YES en NO te kopen 
              om volledig gehedged te zijn.
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

export default Arbitrage;
