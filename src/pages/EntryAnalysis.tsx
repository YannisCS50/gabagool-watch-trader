import { ArrowLeft, DollarSign, TrendingDown, Calculator, Target, AlertCircle, ChevronDown, ChevronUp } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useTrades } from '@/hooks/useTrades';
import { Trade } from '@/types/trade';
import { useMemo, useState } from 'react';
import { format } from 'date-fns';

interface OrderWithRunning {
  trade: Trade;
  orderNumber: number;
  runningShares: number;
  runningCost: number;
  runningAvgPrice: number;
}

interface MarketAnalysis {
  market: string;
  marketSlug: string;
  yesOrders: OrderWithRunning[];
  noOrders: OrderWithRunning[];
  yesAvgPrice: number;
  noAvgPrice: number;
  yesTotalShares: number;
  noTotalShares: number;
  combinedScore: number;
  status: 'profitable' | 'breakeven' | 'loss' | 'exposed';
}

const BetDetailCard = ({ analysis }: { analysis: MarketAnalysis }) => {
  const [expanded, setExpanded] = useState(false);

  const getScoreColor = (score: number) => {
    if (score === 0) return 'text-muted-foreground';
    if (score < 0.99) return 'text-success';
    if (score > 1.01) return 'text-destructive';
    return 'text-warning';
  };

  const getScoreBackground = (score: number) => {
    if (score === 0) return 'bg-muted/30';
    if (score < 0.99) return 'bg-success/20 border-success/30';
    if (score > 1.01) return 'bg-destructive/20 border-destructive/30';
    return 'bg-warning/20 border-warning/30';
  };

  return (
    <div className="glass rounded-lg overflow-hidden">
      {/* Header - clickable */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full p-4 flex items-center justify-between hover:bg-muted/10 transition-colors"
      >
        <div className="flex-1 text-left">
          <h3 className="font-semibold text-sm truncate pr-4">{analysis.market}</h3>
          <div className="flex items-center gap-4 mt-1 text-xs text-muted-foreground">
            {analysis.yesTotalShares > 0 && (
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-success" />
                YES: {analysis.yesTotalShares.toFixed(0)} @ {(analysis.yesAvgPrice * 100).toFixed(1)}¢
              </span>
            )}
            {analysis.noTotalShares > 0 && (
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-destructive" />
                NO: {analysis.noTotalShares.toFixed(0)} @ {(analysis.noAvgPrice * 100).toFixed(1)}¢
              </span>
            )}
          </div>
        </div>
        
        {/* Score badge */}
        <div className="flex items-center gap-3">
          <div className={`px-3 py-1.5 rounded-lg border ${getScoreBackground(analysis.combinedScore)}`}>
            <span className={`font-mono font-bold ${getScoreColor(analysis.combinedScore)}`}>
              {analysis.combinedScore === 0 
                ? 'EXPOSED' 
                : `${(analysis.combinedScore * 100).toFixed(1)}¢`}
            </span>
            {analysis.combinedScore > 0 && (
              <span className={`ml-2 text-xs ${getScoreColor(analysis.combinedScore)}`}>
                {analysis.combinedScore < 1 ? '< $1' : '> $1'}
              </span>
            )}
          </div>
          {expanded ? (
            <ChevronUp className="w-5 h-5 text-muted-foreground" />
          ) : (
            <ChevronDown className="w-5 h-5 text-muted-foreground" />
          )}
        </div>
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="border-t border-border/50 p-4 space-y-4">
          {/* YES Orders */}
          {analysis.yesOrders.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold text-success mb-2 flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-success" />
                YES Orders ({analysis.yesOrders.length})
              </h4>
              <div className="space-y-2">
                {analysis.yesOrders.map((order, idx) => (
                  <div key={order.trade.id} className="flex items-center justify-between bg-success/5 rounded-lg p-3">
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-mono text-muted-foreground">
                          #{order.orderNumber}
                        </span>
                        <span className="text-sm font-medium">
                          {order.trade.shares.toFixed(0)} shares @ {(order.trade.price * 100).toFixed(1)}¢
                        </span>
                        <span className="text-xs text-muted-foreground">
                          on YES
                        </span>
                      </div>
                      <div className="text-xs text-muted-foreground mt-0.5">
                        {format(new Date(order.trade.timestamp), 'MMM dd, HH:mm')}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-xs text-muted-foreground">Running avg:</div>
                      <div className="font-mono text-sm font-semibold text-success">
                        {(order.runningAvgPrice * 100).toFixed(1)}¢
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* NO Orders */}
          {analysis.noOrders.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold text-destructive mb-2 flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-destructive" />
                NO Orders ({analysis.noOrders.length})
              </h4>
              <div className="space-y-2">
                {analysis.noOrders.map((order, idx) => (
                  <div key={order.trade.id} className="flex items-center justify-between bg-destructive/5 rounded-lg p-3">
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-mono text-muted-foreground">
                          #{order.orderNumber}
                        </span>
                        <span className="text-sm font-medium">
                          {order.trade.shares.toFixed(0)} shares @ {(order.trade.price * 100).toFixed(1)}¢
                        </span>
                        <span className="text-xs text-muted-foreground">
                          on NO
                        </span>
                      </div>
                      <div className="text-xs text-muted-foreground mt-0.5">
                        {format(new Date(order.trade.timestamp), 'MMM dd, HH:mm')}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-xs text-muted-foreground">Running avg:</div>
                      <div className="font-mono text-sm font-semibold text-destructive">
                        {(order.runningAvgPrice * 100).toFixed(1)}¢
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Combined Score Analysis */}
          <div className={`rounded-lg p-4 border ${getScoreBackground(analysis.combinedScore)}`}>
            <h4 className="text-xs font-semibold mb-3">📊 Arbitrage Score Berekening</h4>
            <div className="space-y-2 font-mono text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">YES gem. entry:</span>
                <span className="text-success">
                  {analysis.yesAvgPrice > 0 ? `${(analysis.yesAvgPrice * 100).toFixed(1)}¢` : '—'}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">NO gem. entry:</span>
                <span className="text-destructive">
                  {analysis.noAvgPrice > 0 ? `${(analysis.noAvgPrice * 100).toFixed(1)}¢` : '—'}
                </span>
              </div>
              <div className="border-t border-border/50 pt-2 flex justify-between font-bold">
                <span>Totaal:</span>
                <span className={getScoreColor(analysis.combinedScore)}>
                  {analysis.combinedScore > 0 
                    ? `${(analysis.combinedScore * 100).toFixed(1)}¢`
                    : 'EXPOSED (alleen 1 kant)'}
                </span>
              </div>
              {analysis.combinedScore > 0 && (
                <div className="text-xs mt-2">
                  {analysis.combinedScore < 0.99 && (
                    <p className="text-success">
                      ✓ Gegarandeerde winst van {((1 - analysis.combinedScore) * 100).toFixed(1)}¢ per share!
                    </p>
                  )}
                  {analysis.combinedScore >= 0.99 && analysis.combinedScore <= 1.01 && (
                    <p className="text-warning">
                      ≈ Breakeven (rekening houden met fees)
                    </p>
                  )}
                  {analysis.combinedScore > 1.01 && (
                    <p className="text-destructive">
                      ✗ Verlies van {((analysis.combinedScore - 1) * 100).toFixed(1)}¢ per share
                    </p>
                  )}
                </div>
              )}
              {analysis.combinedScore === 0 && (
                <div className="text-xs mt-2 text-muted-foreground">
                  {analysis.yesAvgPrice > 0 && (
                    <p>→ Koop NO voor ≤ {((1 - analysis.yesAvgPrice) * 100).toFixed(1)}¢ voor arbitrage</p>
                  )}
                  {analysis.noAvgPrice > 0 && (
                    <p>→ Koop YES voor ≤ {((1 - analysis.noAvgPrice) * 100).toFixed(1)}¢ voor arbitrage</p>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

const EntryAnalysis = () => {
  const { trades } = useTrades('gabagool22');

  const marketAnalyses = useMemo(() => {
    // Groepeer trades per markt
    const marketMap = new Map<string, Trade[]>();
    
    trades
      .filter(t => t.side === 'buy' && t.status === 'filled')
      .forEach(trade => {
        if (!marketMap.has(trade.market)) {
          marketMap.set(trade.market, []);
        }
        marketMap.get(trade.market)!.push(trade);
      });

    const results: MarketAnalysis[] = [];

    marketMap.forEach((marketTrades, marketName) => {
      // Split YES en NO trades
      const yesTrades = marketTrades
        .filter(t => t.outcome === 'Yes')
        .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
      
      const noTrades = marketTrades
        .filter(t => t.outcome === 'No')
        .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

      // Build YES orders with running totals
      const yesOrders: OrderWithRunning[] = [];
      let yesRunningShares = 0;
      let yesRunningCost = 0;
      yesTrades.forEach((trade, idx) => {
        yesRunningShares += trade.shares;
        yesRunningCost += trade.total;
        yesOrders.push({
          trade,
          orderNumber: idx + 1,
          runningShares: yesRunningShares,
          runningCost: yesRunningCost,
          runningAvgPrice: yesRunningCost / yesRunningShares,
        });
      });

      // Build NO orders with running totals
      const noOrders: OrderWithRunning[] = [];
      let noRunningShares = 0;
      let noRunningCost = 0;
      noTrades.forEach((trade, idx) => {
        noRunningShares += trade.shares;
        noRunningCost += trade.total;
        noOrders.push({
          trade,
          orderNumber: idx + 1,
          runningShares: noRunningShares,
          runningCost: noRunningCost,
          runningAvgPrice: noRunningCost / noRunningShares,
        });
      });

      const yesAvgPrice = yesRunningShares > 0 ? yesRunningCost / yesRunningShares : 0;
      const noAvgPrice = noRunningShares > 0 ? noRunningCost / noRunningShares : 0;
      const combinedScore = yesAvgPrice > 0 && noAvgPrice > 0 ? yesAvgPrice + noAvgPrice : 0;

      let status: 'profitable' | 'breakeven' | 'loss' | 'exposed' = 'exposed';
      if (combinedScore > 0) {
        if (combinedScore < 0.99) status = 'profitable';
        else if (combinedScore > 1.01) status = 'loss';
        else status = 'breakeven';
      }

      results.push({
        market: marketName,
        marketSlug: marketTrades[0]?.marketSlug || '',
        yesOrders,
        noOrders,
        yesAvgPrice,
        noAvgPrice,
        yesTotalShares: yesRunningShares,
        noTotalShares: noRunningShares,
        combinedScore,
        status,
      });
    });

    // Sorteer: eerst profitable, dan exposed, dan breakeven, dan loss
    return results.sort((a, b) => {
      const order = { profitable: 0, exposed: 1, breakeven: 2, loss: 3 };
      return order[a.status] - order[b.status];
    });
  }, [trades]);

  const stats = useMemo(() => {
    const profitable = marketAnalyses.filter(m => m.status === 'profitable').length;
    const exposed = marketAnalyses.filter(m => m.status === 'exposed').length;
    const loss = marketAnalyses.filter(m => m.status === 'loss').length;
    return { profitable, exposed, loss, total: marketAnalyses.length };
  }, [marketAnalyses]);

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
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="glass rounded-lg p-4">
            <div className="flex items-center gap-2 mb-1">
              <Target className="w-4 h-4 text-primary" />
              <span className="text-xs text-muted-foreground">Totaal Bets</span>
            </div>
            <p className="text-2xl font-mono font-bold">{stats.total}</p>
          </div>
          
          <div className="glass rounded-lg p-4">
            <div className="flex items-center gap-2 mb-1">
              <DollarSign className="w-4 h-4 text-success" />
              <span className="text-xs text-muted-foreground">Winstgevend</span>
            </div>
            <p className="text-2xl font-mono font-bold text-success">{stats.profitable}</p>
          </div>

          <div className="glass rounded-lg p-4">
            <div className="flex items-center gap-2 mb-1">
              <AlertCircle className="w-4 h-4 text-warning" />
              <span className="text-xs text-muted-foreground">Exposed</span>
            </div>
            <p className="text-2xl font-mono font-bold text-warning">{stats.exposed}</p>
          </div>

          <div className="glass rounded-lg p-4">
            <div className="flex items-center gap-2 mb-1">
              <TrendingDown className="w-4 h-4 text-destructive" />
              <span className="text-xs text-muted-foreground">Verlies</span>
            </div>
            <p className="text-2xl font-mono font-bold text-destructive">{stats.loss}</p>
          </div>
        </div>

        {/* Legend */}
        <div className="glass rounded-lg p-4">
          <h3 className="text-sm font-semibold mb-2">📖 Score Uitleg</h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
            <div className="flex items-center gap-2">
              <span className="w-3 h-3 rounded bg-success/30 border border-success/50" />
              <span>&lt; 100¢ = Winst</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-3 h-3 rounded bg-warning/30 border border-warning/50" />
              <span>≈ 100¢ = Breakeven</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-3 h-3 rounded bg-destructive/30 border border-destructive/50" />
              <span>&gt; 100¢ = Verlies</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-3 h-3 rounded bg-muted/50 border border-muted" />
              <span>Exposed = 1 kant</span>
            </div>
          </div>
        </div>

        {/* Market Cards */}
        {marketAnalyses.length === 0 ? (
          <div className="glass rounded-lg p-8 text-center">
            <AlertCircle className="w-12 h-12 text-muted-foreground mx-auto mb-3" />
            <p className="text-muted-foreground">Geen trades gevonden</p>
            <p className="text-xs text-muted-foreground mt-1">
              Klik op "Refresh Data" op de arbitrage pagina
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            <h2 className="font-semibold">Alle Bets ({marketAnalyses.length})</h2>
            {marketAnalyses.map((analysis) => (
              <BetDetailCard key={analysis.market} analysis={analysis} />
            ))}
          </div>
        )}

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
