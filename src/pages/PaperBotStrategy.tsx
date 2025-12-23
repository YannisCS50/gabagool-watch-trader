import { useState } from "react";
import { Link } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Copy, Check, Code, Settings, Zap, Shield, Scale, TrendingUp, Clock, DollarSign } from "lucide-react";
import { toast } from "sonner";

// This is the ACTUAL strategy config from paper-trade-realtime edge function
const REALTIME_STRATEGY_CONFIG = `const DEFAULT_CONFIG: StrategyConfig = {
  tradeSize: { min: 5, max: 25, base: 10 },
  positionLimits: { maxPerSide: 200, maxTotal: 350 },
  entry: {
    minSecondsRemaining: 45,
    minPrice: 0.03,
    maxPrice: 0.92,  // More conservative - don't buy very expensive options
    cheapThreshold: 0.25,
    imbalanceThresholdPct: 30,  // Less aggressive rebalancing
    staleBookMs: 2000,
  },
  arbitrage: {
    strongEdge: 0.94,   // Combined < 94¢ = strong arb (6% edge)
    normalEdge: 0.97,   // Combined < 97¢ = normal arb (3% edge)
    maxReasonable: 0.995, // ONLY trade if combined < 99.5¢ (must have SOME edge)
  },
  multipliers: {
    strongArb: 2.5,
    arb: 1.5,
    neutral: 0.0,  // Disabled - don't trade neutral (no edge)
    pricey: 0.0,   // Disabled - never trade pricey
  },
  hf: {
    tickMinIntervalMs: 3000,  // Slower: only trade every 3 seconds per market
    minNotionalToTrade: 3.0,  // Higher minimum to reduce dust
  },
  split: {
    mode: "CHEAPER_BIAS",
    cheaperBiasPct: 0.60,  // More bias to cheaper side
  },
};`;

const DECISION_LOGIC = `function decideTrades(ctx: MarketContext, cfg: StrategyConfig): Decision {
  // 1. COOLDOWN CHECK - max 1 trade per 3 seconds
  if (nowMs - ctx.lastTradeAtMs < cfg.hf.tickMinIntervalMs) {
    return skip("COOLDOWN");
  }

  // 2. EXPIRY GUARD - no trades within 45s of expiry
  if (ctx.remainingSeconds < cfg.entry.minSecondsRemaining) {
    return skip("TOO_CLOSE_TO_EXPIRY");
  }

  // 3. BOOK FRESHNESS - skip if book data >2s old
  if (nowMs - ctx.book.updatedAtMs > cfg.entry.staleBookMs) {
    return skip("STALE_BOOK");
  }

  // 4. PRICE SANITY - must be between 3¢ and 92¢
  if (upAsk < cfg.entry.minPrice || upAsk > cfg.entry.maxPrice) {
    return skip("PRICE_OUT_OF_RANGE");
  }

  // 5. POSITION LIMITS - max $350 total, $200 per side
  if (totalInvested >= cfg.positionLimits.maxTotal) {
    return skip("POSITION_LIMIT_TOTAL");
  }

  // 6. EDGE REQUIREMENT - combined must be < 99.5¢
  const combined = upAsk + downAsk;
  if (combined >= cfg.arbitrage.maxReasonable) {
    return skip("NO_EDGE");  // ← This is why bot doesn't trade at 100¢!
  }

  // TRADE TYPES (in priority order):
  // - OPENING_DUAL: First trade in market, buy both sides
  // - HEDGE_MISSING_SIDE: Only have one side, buy the other
  // - DCA_CHEAP_DUAL: Price ≤25¢, buy both with 1.5x boost
  // - DCA_BALANCE: Position imbalance >30%, rebalance
  // - ARB_DUAL: Combined <97¢, accumulate both sides
  
  return { shouldTrade: true, trades };
}`;

const PaperBotStrategy = () => {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(REALTIME_STRATEGY_CONFIG + "\n\n" + DECISION_LOGIC);
    setCopied(true);
    toast.success("Strategy code gekopieerd!");
    setTimeout(() => setCopied(false), 2000);
  };

  const configParams = [
    { label: "Min Trade Size", value: "$5", icon: DollarSign, description: "Minimum notional per trade" },
    { label: "Max Trade Size", value: "$25", icon: DollarSign, description: "Maximum notional per trade" },
    { label: "Base Trade Size", value: "$10", icon: DollarSign, description: "Default trade size" },
    { label: "Max Per Side", value: "$200", icon: Scale, description: "Maximum investment per UP/DOWN" },
    { label: "Max Total", value: "$350", icon: Shield, description: "Maximum total position per market" },
    { label: "Min Seconds", value: "45s", icon: Clock, description: "Stop trading before expiry" },
    { label: "Max Price", value: "92¢", icon: TrendingUp, description: "Don't buy expensive options" },
    { label: "Cheap Threshold", value: "25¢", icon: Zap, description: "Boost buys below this price" },
    { label: "Strong Edge", value: "<94¢", icon: Zap, description: "2.5x multiplier zone" },
    { label: "Normal Edge", value: "<97¢", icon: TrendingUp, description: "1.5x multiplier zone" },
    { label: "Max Reasonable", value: "<99.5¢", icon: Shield, description: "ONLY trade with edge" },
    { label: "Trade Interval", value: "3000ms", icon: Clock, description: "Cooldown between trades" },
  ];

  const tradeTypes = [
    { type: "OPENING_DUAL", color: "bg-blue-500", description: "Eerste trade in markt - koop beide kanten" },
    { type: "HEDGE_MISSING_SIDE", color: "bg-purple-500", description: "Hedge - koop ontbrekende kant" },
    { type: "DCA_CHEAP_DUAL", color: "bg-green-500", description: "Goedkoop (<25¢) - extra inkopen" },
    { type: "DCA_BALANCE", color: "bg-yellow-500", description: "Herbalanceren bij >30% scheefstand" },
    { type: "ARB_DUAL", color: "bg-primary", description: "Arbitrage edge - accumuleer beide kanten" },
    { type: "SKIP", color: "bg-muted", description: "Geen trade - geen edge of limit bereikt" },
  ];

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border/50 bg-card/80 backdrop-blur-xl sticky top-0 z-50">
        <div className="container mx-auto px-4 py-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <Link to="/real-time-signals" className="text-muted-foreground hover:text-foreground transition-colors">
                <ArrowLeft className="w-5 h-5" />
              </Link>
              <div className="flex items-center gap-3">
                <Code className="w-5 h-5 text-primary" />
                <div>
                  <h1 className="font-semibold text-base">Paper Bot Strategy</h1>
                  <p className="text-xs text-muted-foreground">Actieve trading logica</p>
                </div>
              </div>
            </div>
            <Button variant="outline" size="sm" onClick={handleCopy}>
              {copied ? <Check className="w-4 h-4 mr-1.5" /> : <Copy className="w-4 h-4 mr-1.5" />}
              {copied ? "Gekopieerd" : "Copy Code"}
            </Button>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-6 space-y-6">
        {/* Key Principle */}
        <Card className="border-primary/30 bg-gradient-to-br from-primary/5 to-transparent">
          <CardContent className="p-4">
            <div className="flex items-start gap-3">
              <div className="p-2 rounded-lg bg-primary/10">
                <Shield className="w-5 h-5 text-primary" />
              </div>
              <div>
                <h3 className="font-semibold text-sm">Kern Principe: Alleen Traden met Edge</h3>
                <p className="text-xs text-muted-foreground mt-1">
                  De bot traded <strong>alleen</strong> wanneer combined price &lt; 99.5¢. 
                  Bij 100¢ of hoger is er geen edge en wordt er niet gehandeld.
                  Dit is de reden waarom je "NO_EDGE" ziet in de logs.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Config Parameters Grid */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Settings className="w-4 h-4" />
              Strategy Parameters
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
              {configParams.map((param) => (
                <div key={param.label} className="p-3 rounded-lg bg-muted/50 border border-border/50">
                  <div className="flex items-center gap-2 mb-1">
                    <param.icon className="w-3.5 h-3.5 text-muted-foreground" />
                    <span className="text-xs text-muted-foreground">{param.label}</span>
                  </div>
                  <div className="font-mono font-bold text-sm">{param.value}</div>
                  <div className="text-[10px] text-muted-foreground mt-0.5">{param.description}</div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Trade Types */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Zap className="w-4 h-4" />
              Trade Types
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid gap-2">
              {tradeTypes.map((tt) => (
                <div key={tt.type} className="flex items-center gap-3 p-2 rounded-lg hover:bg-muted/30">
                  <Badge className={`${tt.color} text-white font-mono text-xs`}>{tt.type}</Badge>
                  <span className="text-sm text-muted-foreground">{tt.description}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Strategy Config Code */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Code className="w-4 h-4" />
              DEFAULT_CONFIG (paper-trade-realtime)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="bg-muted/50 p-4 rounded-lg overflow-x-auto text-xs font-mono leading-relaxed">
              {REALTIME_STRATEGY_CONFIG}
            </pre>
          </CardContent>
        </Card>

        {/* Decision Logic Code */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Code className="w-4 h-4" />
              decideTrades() Logic (vereenvoudigd)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="bg-muted/50 p-4 rounded-lg overflow-x-auto text-xs font-mono leading-relaxed">
              {DECISION_LOGIC}
            </pre>
          </CardContent>
        </Card>

        {/* Edge Function Location */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Bronbestanden</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="p-3 rounded-lg bg-muted/50 border border-border/50">
              <div className="font-mono text-sm text-primary">supabase/functions/paper-trade-realtime/index.ts</div>
              <div className="text-xs text-muted-foreground mt-1">
                Realtime WebSocket versie - gebruikt voor live trading via CLOB
              </div>
            </div>
            <div className="p-3 rounded-lg bg-muted/50 border border-border/50">
              <div className="font-mono text-sm text-primary">supabase/functions/paper-trade-bot/index.ts</div>
              <div className="text-xs text-muted-foreground mt-1">
                HTTP polling versie - gebruikt voor cron-based trading
              </div>
            </div>
          </CardContent>
        </Card>
      </main>
    </div>
  );
};

export default PaperBotStrategy;
