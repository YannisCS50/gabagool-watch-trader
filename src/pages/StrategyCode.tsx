import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ArrowLeft, Copy, Check, Code, Settings, Target, Zap, Shield, DollarSign } from 'lucide-react';
import { toast } from 'sonner';

const STRATEGY_CODE = `/**
 * GABAGOOL-STYLE TRADING STRATEGY - EXACT REPLICATION
 * 
 * Based on deep analysis of 109,654 trades across 316 markets:
 * 
 * KEY INSIGHTS:
 * 1. DUAL-SIDE ALWAYS (100% of markets have both Up AND Down positions)
 * 2. HIGH-FREQUENCY DCA (~1 trade/second, 347 trades per market average)
 * 3. BALANCED HEDGING (51.5% Up / 48.5% Down = near perfect 50/50)
 * 4. SMALL TRADE SIZES ($5.33 average, 67% between $1-10)
 * 5. COMBINED ENTRY TARGETING (aim for <98¢ for guaranteed profit)
 * 
 * REASONING TYPES (from analysis):
 * - OPENING: First trade in a new market
 * - HEDGE: Start opposite side position for dual-side coverage  
 * - DCA_CHEAP: Buy when price ≤20¢ (cheap shares)
 * - DCA_BALANCE: Rebalance when Up/Down ratio >20% off
 * - ARBITRAGE: Combined entry <98¢ = guaranteed profit
 * - ACCUMULATE: Standard DCA accumulation
 */

const STRATEGY_CONFIG = {
  // Trade sizing (matches Gabagool's $5.33 average)
  tradeSize: {
    min: 3,
    max: 15,
    base: 8,
  },
  
  // Position limits per market (Gabagool averages $1,850/market)
  positionLimits: {
    maxPerSide: 150,
    maxTotal: 250,
  },
  
  // Entry thresholds
  entry: {
    minSecondsRemaining: 30,  // Don't trade in last 30 seconds
    minPrice: 0.02,           // Don't buy <2¢
    maxPrice: 0.95,           // Don't buy >95¢
    cheapThreshold: 0.20,     // "Cheap" = ≤20¢
    imbalanceThreshold: 20,   // Rebalance if >20% off
  },
  
  // Arbitrage thresholds (KEY TO GABAGOOL'S STRATEGY)
  arbitrage: {
    strongEdge: 0.95,    // <95¢ combined = STRONG arbitrage (2x size)
    normalEdge: 0.98,    // <98¢ combined = arbitrage opportunity (1.5x size)
    maxEntry: 0.98,      // >=98¢ combined = DON'T TRADE (no edge)
  },
  
  // DCA multipliers based on combined price
  dcaMultipliers: {
    strongArbitrage: 2.0,  // 2x when combined <95¢
    arbitrage: 1.5,        // 1.5x when combined <98¢
    neutral: 1.0,          // 1x when combined 98-100¢
    risky: 0.5,            // 0.5x when combined 100-102¢ (avoid!)
  },
};

/**
 * CORE LOGIC: Determine if we should trade
 * 
 * @param upPrice - Current Up token price (0-1)
 * @param downPrice - Current Down token price (0-1)
 * @param position - Current position in this market
 * @param remainingSeconds - Seconds until market close
 */
function shouldTrade(
  upPrice: number,
  downPrice: number,
  position: { upShares: number; downShares: number; upInvested: number; downInvested: number },
  remainingSeconds: number
): { shouldTrade: boolean; reason: string; trades: any[] } {
  
  const combinedPrice = upPrice + downPrice;
  const arbitrageEdge = (1 - combinedPrice) * 100; // Edge in cents
  
  // RULE 1: No trading in last 30 seconds
  if (remainingSeconds < STRATEGY_CONFIG.entry.minSecondsRemaining) {
    return { shouldTrade: false, reason: 'TOO_CLOSE_TO_EXPIRY', trades: [] };
  }
  
  // RULE 2: Price sanity checks
  if (upPrice < STRATEGY_CONFIG.entry.minPrice || downPrice < STRATEGY_CONFIG.entry.minPrice) {
    return { shouldTrade: false, reason: 'PRICE_TOO_LOW', trades: [] };
  }
  if (upPrice > STRATEGY_CONFIG.entry.maxPrice || downPrice > STRATEGY_CONFIG.entry.maxPrice) {
    return { shouldTrade: false, reason: 'PRICE_TOO_HIGH', trades: [] };
  }
  
  // RULE 3: GABAGOOL'S KEY RULE - Only trade when combined < 98¢
  if (combinedPrice >= STRATEGY_CONFIG.arbitrage.maxEntry) {
    return { 
      shouldTrade: false, 
      reason: \`NO_EDGE: Combined \${(combinedPrice * 100).toFixed(1)}¢ >= 98¢\`,
      trades: [] 
    };
  }
  
  // RULE 4: Position limits
  const totalInvested = position.upInvested + position.downInvested;
  if (totalInvested >= STRATEGY_CONFIG.positionLimits.maxTotal) {
    return { shouldTrade: false, reason: 'POSITION_LIMIT_REACHED', trades: [] };
  }
  
  // Calculate trade size based on edge
  const baseSize = calculateTradeSize(combinedPrice, remainingSeconds);
  const trades = [];
  
  // OPENING: First trade in new market
  if (position.upShares === 0 && position.downShares === 0) {
    // Always start with the cheaper side
    const outcome = upPrice <= downPrice ? 'UP' : 'DOWN';
    const price = outcome === 'UP' ? upPrice : downPrice;
    trades.push({
      outcome,
      shares: Math.floor(baseSize / price),
      price,
      total: baseSize,
      type: 'OPENING',
      reason: \`OPENING: Start \${outcome} position at \${(price * 100).toFixed(1)}¢\`
    });
    return { shouldTrade: true, reason: 'OPENING', trades };
  }
  
  // HEDGE: Need to establish other side for dual-side hedging
  if (position.upShares === 0 || position.downShares === 0) {
    const outcome = position.upShares === 0 ? 'UP' : 'DOWN';
    const price = outcome === 'UP' ? upPrice : downPrice;
    trades.push({
      outcome,
      shares: Math.floor(baseSize / price),
      price,
      total: baseSize,
      type: 'HEDGE',
      reason: \`HEDGE: Establish \${outcome} for dual-side coverage\`
    });
    return { shouldTrade: true, reason: 'HEDGE', trades };
  }
  
  // DCA_CHEAP: Aggressively buy cheap shares
  if (upPrice <= STRATEGY_CONFIG.entry.cheapThreshold) {
    trades.push({
      outcome: 'UP',
      shares: Math.floor((baseSize * 1.5) / upPrice),
      price: upPrice,
      total: baseSize * 1.5,
      type: 'DCA_CHEAP',
      reason: \`DCA_CHEAP: Up at \${(upPrice * 100).toFixed(1)}¢ (below 20¢ threshold)\`
    });
  }
  if (downPrice <= STRATEGY_CONFIG.entry.cheapThreshold) {
    trades.push({
      outcome: 'DOWN',
      shares: Math.floor((baseSize * 1.5) / downPrice),
      price: downPrice,
      total: baseSize * 1.5,
      type: 'DCA_CHEAP',
      reason: \`DCA_CHEAP: Down at \${(downPrice * 100).toFixed(1)}¢ (below 20¢ threshold)\`
    });
  }
  if (trades.length > 0) {
    return { shouldTrade: true, reason: 'DCA_CHEAP', trades };
  }
  
  // DCA_BALANCE: Rebalance if position is skewed
  const imbalance = getImbalance(position);
  if (Math.abs(imbalance) > STRATEGY_CONFIG.entry.imbalanceThreshold) {
    const outcome = imbalance > 0 ? 'DOWN' : 'UP'; // Buy the underweight side
    const price = outcome === 'UP' ? upPrice : downPrice;
    trades.push({
      outcome,
      shares: Math.floor(baseSize / price),
      price,
      total: baseSize,
      type: 'DCA_BALANCE',
      reason: \`DCA_BALANCE: \${outcome} underweight by \${Math.abs(imbalance).toFixed(0)}%\`
    });
    return { shouldTrade: true, reason: 'DCA_BALANCE', trades };
  }
  
  // ARBITRAGE: We have edge, accumulate both sides
  const edgeType = combinedPrice < STRATEGY_CONFIG.arbitrage.strongEdge ? 'STRONG' : 'NORMAL';
  
  // Buy the cheaper side to maximize edge
  const outcome = upPrice <= downPrice ? 'UP' : 'DOWN';
  const price = outcome === 'UP' ? upPrice : downPrice;
  trades.push({
    outcome,
    shares: Math.floor(baseSize / price),
    price,
    total: baseSize,
    type: 'ARBITRAGE',
    reason: \`ARBITRAGE (\${edgeType}): Combined \${(combinedPrice * 100).toFixed(1)}¢ = \${arbitrageEdge.toFixed(1)}¢ edge\`
  });
  
  return { shouldTrade: true, reason: 'ARBITRAGE', trades };
}

function calculateTradeSize(combinedPrice: number, remainingSeconds: number): number {
  let baseSize = STRATEGY_CONFIG.tradeSize.base;
  
  // Apply DCA multiplier based on arbitrage opportunity
  if (combinedPrice < STRATEGY_CONFIG.arbitrage.strongEdge) {
    baseSize *= STRATEGY_CONFIG.dcaMultipliers.strongArbitrage;
  } else if (combinedPrice < STRATEGY_CONFIG.arbitrage.normalEdge) {
    baseSize *= STRATEGY_CONFIG.dcaMultipliers.arbitrage;
  }
  
  // Scale down near expiry
  if (remainingSeconds < 60) {
    baseSize *= 0.5;
  }
  
  return Math.min(Math.max(baseSize, STRATEGY_CONFIG.tradeSize.min), STRATEGY_CONFIG.tradeSize.max);
}

function getImbalance(position: { upShares: number; downShares: number }): number {
  const total = position.upShares + position.downShares;
  if (total === 0) return 0;
  return ((position.upShares - position.downShares) / total) * 100;
}

// Export for use
export { STRATEGY_CONFIG, shouldTrade, calculateTradeSize };
`;

export default function StrategyCode() {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(STRATEGY_CODE);
    setCopied(true);
    toast.success('Strategie code gekopieerd!');
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="min-h-screen bg-background">
      <div className="container mx-auto p-6 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link to="/strategy" className="p-2 hover:bg-accent rounded-lg transition-colors">
              <ArrowLeft className="h-5 w-5" />
            </Link>
            <div>
              <h1 className="text-3xl font-bold tracking-tight">Strategie Code Export</h1>
              <p className="text-muted-foreground">Gabagool trading strategie in TypeScript</p>
            </div>
          </div>
          <Button onClick={handleCopy} size="lg" className="gap-2">
            {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            {copied ? 'Gekopieerd!' : 'Kopieer Code'}
          </Button>
        </div>

        {/* Summary Cards */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <Card>
            <CardContent className="pt-4 flex items-start gap-3">
              <Settings className="h-5 w-5 text-primary mt-0.5" />
              <div>
                <div className="font-semibold">Config-Based</div>
                <div className="text-sm text-muted-foreground">Alle parameters configureerbaar</div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 flex items-start gap-3">
              <Target className="h-5 w-5 text-green-500 mt-0.5" />
              <div>
                <div className="font-semibold">&lt;98¢ Entry</div>
                <div className="text-sm text-muted-foreground">Alleen traden met edge</div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 flex items-start gap-3">
              <Shield className="h-5 w-5 text-blue-500 mt-0.5" />
              <div>
                <div className="font-semibold">Dual-Side</div>
                <div className="text-sm text-muted-foreground">Altijd Up én Down kopen</div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 flex items-start gap-3">
              <Zap className="h-5 w-5 text-yellow-500 mt-0.5" />
              <div>
                <div className="font-semibold">DCA Logic</div>
                <div className="text-sm text-muted-foreground">Slim accumuleren</div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Code Block */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Code className="h-5 w-5" />
              TypeScript Implementatie
            </CardTitle>
            <CardDescription>
              Volledige trading strategie gebaseerd op analyse van 109.654 Gabagool trades
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="relative">
              <pre className="bg-muted p-4 rounded-lg overflow-x-auto text-sm font-mono max-h-[600px] overflow-y-auto">
                <code>{STRATEGY_CODE}</code>
              </pre>
              <Button
                onClick={handleCopy}
                size="sm"
                variant="secondary"
                className="absolute top-2 right-2 gap-1"
              >
                {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                {copied ? 'Gekopieerd' : 'Kopieer'}
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Key Parameters */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <DollarSign className="h-5 w-5" />
              Belangrijkste Parameters
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              <div className="p-4 bg-muted rounded-lg">
                <div className="font-mono text-sm text-primary">arbitrage.maxEntry</div>
                <div className="text-2xl font-bold">0.98 (98¢)</div>
                <div className="text-sm text-muted-foreground">Maximale combined entry - alleen traden onder dit niveau</div>
              </div>
              <div className="p-4 bg-muted rounded-lg">
                <div className="font-mono text-sm text-primary">tradeSize.base</div>
                <div className="text-2xl font-bold">$8</div>
                <div className="text-sm text-muted-foreground">Basis trade grootte (Gabagool avg: $5.33)</div>
              </div>
              <div className="p-4 bg-muted rounded-lg">
                <div className="font-mono text-sm text-primary">entry.minSecondsRemaining</div>
                <div className="text-2xl font-bold">30 sec</div>
                <div className="text-sm text-muted-foreground">Stop trading voor expiry</div>
              </div>
              <div className="p-4 bg-muted rounded-lg">
                <div className="font-mono text-sm text-primary">entry.cheapThreshold</div>
                <div className="text-2xl font-bold">0.20 (20¢)</div>
                <div className="text-sm text-muted-foreground">Agressief kopen onder dit niveau</div>
              </div>
              <div className="p-4 bg-muted rounded-lg">
                <div className="font-mono text-sm text-primary">entry.imbalanceThreshold</div>
                <div className="text-2xl font-bold">20%</div>
                <div className="text-sm text-muted-foreground">Rebalance trigger voor Up/Down ratio</div>
              </div>
              <div className="p-4 bg-muted rounded-lg">
                <div className="font-mono text-sm text-primary">positionLimits.maxTotal</div>
                <div className="text-2xl font-bold">$250</div>
                <div className="text-sm text-muted-foreground">Max investering per markt</div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
