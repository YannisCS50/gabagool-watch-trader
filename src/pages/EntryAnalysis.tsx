import { ArrowLeft, DollarSign, TrendingDown, Calculator, Target, AlertCircle } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useTrades } from '@/hooks/useTrades';
import { Trade } from '@/types/trade';
import { useMemo } from 'react';

interface MarketFirstBuy {
  market: string;
  marketSlug: string;
  outcome: 'Yes' | 'No';
  firstBuyPrice: number;
  firstBuyDate: Date;
  totalShares: number;
  avgPrice: number;
  requiredOppositePrice: number;
  currentSpread: number;
  status: 'profitable' | 'breakeven' | 'loss';
}

const EntryAnalysis = () => {
  const { trades, positions } = useTrades('gabagool22');

  const marketFirstBuys = useMemo(() => {
    // Groepeer trades per markt en vind de eerste buy
    const marketMap = new Map<string, Trade[]>();
    
    trades
      .filter(t => t.side === 'buy' && t.status === 'filled')
      .forEach(trade => {
        const key = `${trade.market}-${trade.outcome}`;
        if (!marketMap.has(key)) {
          marketMap.set(key, []);
        }
        marketMap.get(key)!.push(trade);
      });

    const results: MarketFirstBuy[] = [];

    marketMap.forEach((marketTrades, key) => {
      // Sorteer op datum (oudste eerst)
      const sorted = marketTrades.sort((a, b) => 
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
      );

      const firstBuy = sorted[0];
      const totalShares = sorted.reduce((sum, t) => sum + t.shares, 0);
      const totalCost = sorted.reduce((sum, t) => sum + t.total, 0);
      const avgPrice = totalCost / totalShares;
      
      // Bereken welke prijs de tegenovergestelde positie moet hebben voor arbitrage
      const requiredOppositePrice = 1 - avgPrice;
      
      // Check of er een opposite positie is
      const oppositeTrades = trades.filter(t => 
        t.market === firstBuy.market && 
        t.outcome !== firstBuy.outcome &&
        t.side === 'buy'
      );
      
      const oppositeAvgPrice = oppositeTrades.length > 0
        ? oppositeTrades.reduce((sum, t) => sum + t.total, 0) / 
          oppositeTrades.reduce((sum, t) => sum + t.shares, 0)
        : 0;

      const currentSpread = avgPrice + oppositeAvgPrice;
      
      let status: 'profitable' | 'breakeven' | 'loss' = 'breakeven';
      if (oppositeAvgPrice > 0) {
        if (currentSpread < 0.99) status = 'profitable';
        else if (currentSpread > 1.01) status = 'loss';
      }

      results.push({
        market: firstBuy.market,
        marketSlug: firstBuy.marketSlug,
        outcome: firstBuy.outcome,
        firstBuyPrice: firstBuy.price,
        firstBuyDate: firstBuy.timestamp,
        totalShares: totalShares,
        avgPrice: avgPrice,
        requiredOppositePrice: requiredOppositePrice,
        currentSpread: oppositeAvgPrice > 0 ? currentSpread : 0,
        status: status,
      });
    });

    return results.sort((a, b) => b.avgPrice - a.avgPrice);
  }, [trades]);

  const avgFirstBuyPrice = marketFirstBuys.length > 0
    ? marketFirstBuys.reduce((sum, m) => sum + m.firstBuyPrice, 0) / marketFirstBuys.length
    : 0;

  const avgEntryPrice = marketFirstBuys.length > 0
    ? marketFirstBuys.reduce((sum, m) => sum + m.avgPrice, 0) / marketFirstBuys.length
    : 0;

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border/50 bg-card/50 backdrop-blur-xl sticky top-0 z-50">
        <div className="container mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Link to="/arbitrage" className="flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors">
                <ArrowLeft className="w-4 h-4" />
              </Link>
              <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-primary to-purple-400 flex items-center justify-center">
                <Calculator className="w-4 h-4 text-primary-foreground" />
              </div>
              <span className="font-semibold text-lg">Entry Price Analysis</span>
            </div>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-6 space-y-6">
        {/* Stats Overview */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="glass rounded-lg p-6">
            <div className="flex items-center gap-3 mb-2">
              <DollarSign className="w-5 h-5 text-primary" />
              <span className="text-sm text-muted-foreground">Gem. Eerste Buy Prijs</span>
            </div>
            <p className="text-3xl font-mono font-bold">{(avgFirstBuyPrice * 100).toFixed(1)}¢</p>
            <p className="text-xs text-muted-foreground mt-1">Eerste aankoop per markt</p>
          </div>
          
          <div className="glass rounded-lg p-6">
            <div className="flex items-center gap-3 mb-2">
              <TrendingDown className="w-5 h-5 text-success" />
              <span className="text-sm text-muted-foreground">Gem. Entry Prijs (na middelen)</span>
            </div>
            <p className="text-3xl font-mono font-bold">{(avgEntryPrice * 100).toFixed(1)}¢</p>
            <p className="text-xs text-muted-foreground mt-1">Inclusief alle bijkopen</p>
          </div>

          <div className="glass rounded-lg p-6">
            <div className="flex items-center gap-3 mb-2">
              <Target className="w-5 h-5 text-warning" />
              <span className="text-sm text-muted-foreground">Markten Geanalyseerd</span>
            </div>
            <p className="text-3xl font-mono font-bold">{marketFirstBuys.length}</p>
            <p className="text-xs text-muted-foreground mt-1">Unieke posities</p>
          </div>
        </div>

        {/* Explanation Card */}
        <div className="glass rounded-lg p-6 border-l-4 border-primary">
          <h2 className="text-lg font-semibold mb-3 flex items-center gap-2">
            <Calculator className="w-5 h-5" />
            📊 Hoe Arbitrage & Middelen Werkt
          </h2>
          
          <div className="space-y-4 text-sm">
            <div className="bg-card/50 rounded-lg p-4">
              <h3 className="font-semibold text-foreground mb-2">🎯 Doel: Totale kosten &lt; $1.00</h3>
              <p className="text-muted-foreground">
                Bij prediction markets betaalt de winnende kant altijd $1.00 uit. Als je YES + NO samen 
                voor minder dan $1.00 kunt kopen, maak je gegarandeerd winst.
              </p>
            </div>

            <div className="bg-card/50 rounded-lg p-4">
              <h3 className="font-semibold text-foreground mb-2">📉 Middelen (Dollar Cost Averaging)</h3>
              <p className="text-muted-foreground mb-2">
                Als je eerste buy te hoog was, kun je bijkopen bij lagere prijzen om je gemiddelde entry te verlagen:
              </p>
              <div className="bg-background/50 rounded p-3 font-mono text-xs">
                <p className="text-muted-foreground">Voorbeeld:</p>
                <p>• 1e buy: 100 shares @ 60¢ = $60</p>
                <p>• 2e buy: 100 shares @ 40¢ = $40</p>
                <p className="text-success mt-1">→ Totaal: 200 shares @ 50¢ gemiddeld</p>
              </div>
            </div>

            <div className="bg-card/50 rounded-lg p-4">
              <h3 className="font-semibold text-foreground mb-2">⚖️ Arbitrage Strategie</h3>
              <div className="space-y-2 text-muted-foreground">
                <p><strong className="text-foreground">Stap 1:</strong> Koop YES voor prijs X</p>
                <p><strong className="text-foreground">Stap 2:</strong> Wacht tot NO zakt onder (100¢ - X)</p>
                <p><strong className="text-foreground">Stap 3:</strong> Koop gelijke hoeveelheid NO</p>
                <p className="text-success font-medium mt-2">
                  ✓ Als YES + NO &lt; 100¢ → Gegarandeerde winst!
                </p>
              </div>
            </div>

            <div className="bg-success/10 rounded-lg p-4 border border-success/20">
              <h3 className="font-semibold text-success mb-2">💡 Pro Tip</h3>
              <p className="text-muted-foreground">
                Kijk naar de "Benodigde Opposite Prijs" hieronder. Dit is de maximale prijs die je 
                voor de tegenovergestelde positie mag betalen om break-even of winst te maken.
              </p>
            </div>
          </div>
        </div>

        {/* Market Entry Analysis Table */}
        <div className="glass rounded-lg overflow-hidden">
          <div className="p-4 border-b border-border/50">
            <h2 className="font-semibold">Entry Prijzen per Markt</h2>
            <p className="text-xs text-muted-foreground">Eerste buy en gemiddelde entry na middelen</p>
          </div>

          {marketFirstBuys.length === 0 ? (
            <div className="p-8 text-center">
              <AlertCircle className="w-12 h-12 text-muted-foreground mx-auto mb-3" />
              <p className="text-muted-foreground">Geen trades gevonden</p>
              <p className="text-xs text-muted-foreground mt-1">Klik op "Refresh Data" op de arbitrage pagina</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-muted/30">
                  <tr className="text-xs text-muted-foreground">
                    <th className="text-left p-3">Markt</th>
                    <th className="text-center p-3">Positie</th>
                    <th className="text-right p-3">1e Buy</th>
                    <th className="text-right p-3">Gem. Entry</th>
                    <th className="text-right p-3">Shares</th>
                    <th className="text-right p-3">Max Opposite</th>
                    <th className="text-center p-3">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/30">
                  {marketFirstBuys.map((market, idx) => (
                    <tr key={idx} className="hover:bg-muted/10 transition-colors">
                      <td className="p-3">
                        <p className="font-medium text-sm truncate max-w-[200px]">{market.market}</p>
                      </td>
                      <td className="p-3 text-center">
                        <span className={`px-2 py-0.5 rounded text-xs font-mono ${
                          market.outcome === 'Yes' 
                            ? 'bg-success/20 text-success' 
                            : 'bg-destructive/20 text-destructive'
                        }`}>
                          {market.outcome}
                        </span>
                      </td>
                      <td className="p-3 text-right font-mono text-sm">
                        {(market.firstBuyPrice * 100).toFixed(1)}¢
                      </td>
                      <td className="p-3 text-right font-mono text-sm">
                        <span className={market.avgPrice < market.firstBuyPrice ? 'text-success' : ''}>
                          {(market.avgPrice * 100).toFixed(1)}¢
                        </span>
                      </td>
                      <td className="p-3 text-right font-mono text-sm text-muted-foreground">
                        {market.totalShares.toFixed(0)}
                      </td>
                      <td className="p-3 text-right">
                        <span className="font-mono text-sm text-warning">
                          ≤ {(market.requiredOppositePrice * 100).toFixed(1)}¢
                        </span>
                      </td>
                      <td className="p-3 text-center">
                        {market.currentSpread > 0 ? (
                          <span className={`px-2 py-0.5 rounded text-xs ${
                            market.status === 'profitable' 
                              ? 'bg-success/20 text-success'
                              : market.status === 'loss'
                              ? 'bg-destructive/20 text-destructive'
                              : 'bg-muted text-muted-foreground'
                          }`}>
                            {market.status === 'profitable' && '✓ Winst'}
                            {market.status === 'breakeven' && '— Breakeven'}
                            {market.status === 'loss' && '✗ Verlies'}
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground">Exposed</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="text-center py-4">
          <Link to="/arbitrage" className="text-sm text-primary hover:underline">
            ← Terug naar Arbitrage Analysis
          </Link>
        </div>
      </main>
    </div>
  );
};

export default EntryAnalysis;
