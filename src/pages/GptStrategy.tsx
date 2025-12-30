import { ArrowLeft, Copy, Check, TrendingUp, Shield, Layers, Clock, AlertTriangle, FileDown, Loader2, Zap, Target, BarChart3, Activity, Gauge } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useState } from 'react';
import { toast } from 'sonner';
import jsPDF from 'jspdf';

const STRATEGY_CONFIG = `// v4.2.1: Gabagool Inspired Adaptive Edition
export const DEFAULT_CONFIG: StrategyConfig = {
  // Trade sizing
  tradeSizeUsd: { base: 25, min: 20, max: 50 },

  edge: {
    baseBuffer: 0.012,
    strongEdge: 0.04,
    allowOverpay: 0.01,
    feesBuffer: 0.002,
    slippageBuffer: 0.004,
    deepDislocationThreshold: 0.96,
  },

  // v4.2.1: Constant delta regime thresholds (NO time-shrinking)
  delta: {
    lowThreshold: 0.0030,     // LOW: delta < 0.30%
    midThreshold: 0.0070,     // MID: 0.30% - 0.70%
                              // HIGH: delta > 0.70%
    deepMaxDelta: 0.0040,     // DEEP only if delta < 0.40%
  },

  // v4.2.1: Time-scaled parameters (timeFactor adjusts these)
  timeScaled: {
    hedgeTimeoutBaseSec: 35,  // Scaled down by timeFactor
    maxSkewBase: 0.70,        // Scaled down by timeFactor
    bufferAddBase: 0.008,     // Scaled UP by (1 - timeFactor)
    deepMinTimeSec: 180,      // DEEP only if secondsRemaining > 180
  },

  // Deep mode conditions (v4.2.1)
  deep: {
    minTimeSec: 180,           // Only if > 180s remaining
    maxCombinedAsk: 0.95,      // Only if cheapestAsk + otherMid < 0.95
    maxDeltaPct: 0.0040,       // Only if delta < 0.40%
  },

  timing: {
    stopNewTradesSec: 60,
    hedgeMustBySec: 60,
    unwindStartSec: 45,
  },

  skew: {
    target: 0.50,
    rebalanceThreshold: 0.20,
    hardCap: 0.70,
  },

  limits: {
    maxTotalUsd: 500,
    maxPerSideUsd: 300,
    minTopDepthShares: 50,
    maxPendingOrders: 3,
    sideCooldownMs: 0,
  },

  execution: {
    tickFallback: 0.01,
    tickNiceSet: [0.01, 0.005, 0.002, 0.001],
    hedgeCushionTicks: 2,
    riskHedgeCushionTicks: 3,
    entryImproveTicks: 0,
  },

  profit: {
    lockPairCost: 0.99,
  },

  sizing: {
    edgeMultiplierHigh: 2.0,
    edgeMultiplierMedium: 1.5,
    edgeMultiplierLow: 1.0,
    lowLiquidityMultiplier: 0.5,
    nearExpiryMultiplier: 0.5,
    deepDislocMultiplier: 2.5,
  },
};`;

const DELTA_REGIME = `// v4.2.1: Delta Regime Calculation (CONSTANT thresholds)
export interface MarketSnapshot {
  marketId: string;
  ts: number;
  secondsRemaining: number;   // Time until settlement
  spotPrice: number;          // Current BTC price (Chainlink)
  strikePrice: number;        // Market strike price
  upTop: BookTop;
  downTop: BookTop;
}

// Compute delta percentage from strike
export function computeDeltaPct(
  spotPrice: number, 
  strikePrice: number
): number {
  if (!Number.isFinite(spotPrice) || 
      !Number.isFinite(strikePrice) || 
      strikePrice <= 0) return 0;
  return Math.abs(spotPrice - strikePrice) / strikePrice;
}

// v4.2.1: CONSTANT regime thresholds (no time-shrinking)
export function getDeltaRegime(deltaPct: number): "LOW" | "MID" | "HIGH" {
  if (deltaPct < 0.0030) return "LOW";   // < 0.30%
  if (deltaPct < 0.0070) return "MID";   // 0.30% - 0.70%
  return "HIGH";                          // > 0.70%
}

// v4.2.1: timeFactor only scales PARAMETERS, not regime thresholds
export function getTimeFactor(secondsRemaining: number): number {
  return Math.max(secondsRemaining, 60) / 900;  // 1.0 at 900s, 0.07 at 60s
}

// Time-scaled parameter calculations
export function getScaledHedgeTimeout(timeFactor: number, base: number): number {
  return Math.max(8, Math.floor(base * timeFactor));  // Min 8s
}

export function getScaledMaxSkew(timeFactor: number, base: number): number {
  return 0.50 + (base - 0.50) * timeFactor;  // Shrinks toward 50/50
}

export function getScaledBufferAdd(timeFactor: number, base: number): number {
  return base * (1 - timeFactor);  // Increases as time decreases
}`;

const REGIME_BEHAVIOR = `// v4.2.1: Regime-Aware Trading Behavior
// CONSTANT delta thresholds + TIME-SCALED parameters

// LOW Delta Regime (delta < 0.30%)
// ├── Price is close to strike, low directional risk
// ├── Gabagool mode: asymmetric inventory buildup allowed
// ├── DEEP mode: allowed if conditions met (see below)
// └── Most aggressive trading allowed

// MID Delta Regime (0.30% - 0.70%)
// ├── Moderate directional uncertainty
// ├── Conservative arbitrage only
// ├── DEEP mode: disabled
// └── Standard entry requirements

// HIGH Delta Regime (delta > 0.70%)
// ├── Price far from strike, high directional risk
// ├── NO new accumulation allowed
// ├── Focus on hedging existing positions
// └── Prepare for settlement

// TIME-SCALED PARAMETERS (via timeFactor):
// ├── hedgeTimeout ↓ (shorter as expiry approaches)
// ├── maxSkew ↓ (tighter as expiry approaches)
// ├── bufferAdd ↑ (stricter as expiry approaches)
// └── deepAllowed: only if secondsRemaining > 180s

// DEEP MODE CONDITIONS (v4.2.1):
// ├── secondsRemaining > 180 (not too close to expiry)
// ├── cheapestAsk + otherMid < 0.95 (strong dislocation)
// └── delta < 0.40% (price near strike)`;

const TICK_LOGIC = `// v4.2.1: Tick() Implementation with Time-Scaled Parameters

async tick(): Promise<void> {
  // 1. Fetch market snapshot
  const snap = await this.fetchSnapshot();
  
  // 2. Compute delta and CONSTANT regime
  const deltaPct = computeDeltaPct(snap.spotPrice, snap.strikePrice);
  const deltaRegime = getDeltaRegime(deltaPct);  // No time-decay!
  
  // 3. Compute timeFactor for parameter scaling
  const timeFactor = getTimeFactor(snap.secondsRemaining);
  
  this.log(\`📊 Delta: \${(deltaPct * 100).toFixed(3)}% | Regime: \${deltaRegime} | timeFactor: \${timeFactor.toFixed(2)} | T-\${snap.secondsRemaining}s\`);
  
  // 4. Time-scaled parameters
  const hedgeTimeout = getScaledHedgeTimeout(timeFactor, this.cfg.timeScaled.hedgeTimeoutBaseSec);
  const maxSkew = getScaledMaxSkew(timeFactor, this.cfg.timeScaled.maxSkewBase);
  const bufferAdd = getScaledBufferAdd(timeFactor, this.cfg.timeScaled.bufferAddBase);
  
  // 5. Entry buffer = base + time-scaled addition
  const buffer = dynamicEdgeBuffer(this.cfg) + bufferAdd;
  
  // 6. DEEP mode gating (v4.2.1 stricter rules)
  const deepAllowed = (
    snap.secondsRemaining > this.cfg.deep.minTimeSec &&           // > 180s
    deltaPct < this.cfg.deep.maxDeltaPct &&                       // < 0.40%
    (snap.upTop.ask + snap.downTop.mid) < this.cfg.deep.maxCombinedAsk  // combined < 0.95
  );
  
  // 7. Risk gating
  const allowNewRisk = deltaRegime !== "HIGH" && snap.secondsRemaining > 60;
  
  this.log(\`⚙️ hedgeTimeout: \${hedgeTimeout}s | maxSkew: \${(maxSkew*100).toFixed(0)}% | buffer: \${(buffer*100).toFixed(2)}% | DEEP: \${deepAllowed ? '✓' : '✗'}\`);
  
  // 8. Build order intents
  const intents: OrderIntent[] = [];
  
  // Entry: only if allowNewRisk and edge OK
  if (allowNewRisk && this.state === "FLAT") {
    const entryIntent = await this.buildEntryIntent(snap, buffer);
    if (entryIntent) intents.push(entryIntent);
  }
  
  // Hedge: always allowed, with time-scaled timeout
  if (this.state === "ONE_SIDED") {
    const hedgeIntent = await this.buildHedgeIntent(snap, hedgeTimeout);
    if (hedgeIntent) intents.push(hedgeIntent);
  }
  
  // Accumulate: only in LOW/MID and within skew limits
  if (allowNewRisk && this.state === "HEDGED") {
    const skew = upFraction(this.inventory);
    if (Math.abs(skew - 0.5) < (maxSkew - 0.5)) {
      const accumIntent = await this.buildAccumulateIntent(snap, buffer, deepAllowed);
      if (accumIntent) intents.push(accumIntent);
    }
  }
  
  // Execute intents
  for (const intent of intents) {
    await this.executeIntent(snap, intent);
  }
}`;

const CORE_INVARIANT = `// v4.2: Core Settlement Invariant

// ┌──────────────────────────────────────────────────────────────────┐
// │  INVARIANT: Bij settlement moet min(UP, DOWN) > 0               │
// │             en avgUpCost + avgDownCost ≤ 0.99 - 1.00             │
// └──────────────────────────────────────────────────────────────────┘

// Strategie: Trades zijn inventory-aanpassingen om de gezamenlijke
// kosten te verbeteren. NIET om elke markt "flat" te maken.

// Settlement scenario's:
//   - UP wint: payout = min(UP, DOWN) × $1 → profit als pairCost < $1
//   - DOWN wint: payout = min(UP, DOWN) × $1 → same profit

// Voorbeeld hedged positie:
//   - 50 UP @ 48¢ = $24.00
//   - 50 DOWN @ 47¢ = $23.50
//   - Total: $47.50
//   - Pair cost: 95¢
//   - Payout (either outcome): $50.00
//   - Profit: $2.50 (5.3%)

function checkSettlementReady(inventory: Inventory): {
  ready: boolean;
  pairCost: number;
  minShares: number;
  projectedProfit: number;
} {
  const minShares = Math.min(inventory.upShares, inventory.downShares);
  const avgUp = avgCost(inventory, "UP");
  const avgDown = avgCost(inventory, "DOWN");
  const pairCost = avgUp + avgDown;
  
  const projectedPayout = minShares * 1.00;
  const projectedCost = minShares * pairCost;
  const projectedProfit = projectedPayout - projectedCost;
  
  return {
    ready: minShares > 0 && pairCost <= 0.995,
    pairCost,
    minShares,
    projectedProfit,
  };
}`;

const ENTRY_LOGIC = `// v4.2: Entry Logic with Regime Awareness

async function buildEntryIntent(
  snap: MarketSnapshot, 
  buffer: number
): Promise<OrderIntent | null> {
  // 1. Timing gate - hard stop 60s before settlement
  if (snap.secondsRemaining < this.cfg.timing.stopNewTradesSec) {
    return null;
  }
  
  // 2. Execution-aware edge check
  const { ok, entrySide, expectedExecutedPairCost } = 
    executionAwareEdgeOk(snap, buffer);
  
  if (!ok) {
    return null; // Not enough edge after regime buffer
  }
  
  // 3. Liquidity check
  const sideTop = entrySide === "UP" ? snap.upTop : snap.downTop;
  if (sideTop.askSize < this.cfg.limits.minTopDepthShares) {
    return null;
  }
  
  // 4. Size calculation with edge scaling
  const edge = 1 - expectedExecutedPairCost;
  let sizeMultiplier = this.cfg.sizing.edgeMultiplierLow;
  if (edge >= 0.05) sizeMultiplier = this.cfg.sizing.edgeMultiplierHigh;
  else if (edge >= 0.02) sizeMultiplier = this.cfg.sizing.edgeMultiplierMedium;
  
  const baseQty = sharesFromUsd(this.cfg.tradeSizeUsd.base, sideTop.ask);
  const qty = Math.floor(baseQty * sizeMultiplier);
  
  return {
    side: entrySide,
    qty: Math.min(qty, 50),
    limitPrice: sideTop.ask,
    tag: "ENTRY",
    reason: \`ENTRY \${entrySide} @ \${(sideTop.ask*100).toFixed(0)}¢, edge=\${(edge*100).toFixed(1)}%\`
  };
}`;

const HEDGE_LOGIC = `// v4.2: Hedge Logic with Regime-Adaptive Timeout

async function buildHedgeIntent(
  snap: MarketSnapshot,
  hedgeTimeoutSec: number  // From delta regime
): Promise<OrderIntent | null> {
  if (this.state !== "ONE_SIDED") return null;
  
  // Determine hedge side
  const needsUp = this.inventory.upShares === 0 && this.inventory.downShares > 0;
  const hedgeSide: Side = needsUp ? "UP" : "DOWN";
  const hedgeTop = hedgeSide === "UP" ? snap.upTop : snap.downTop;
  
  // Timing checks with regime-specific timeout
  const timeSinceOpen = Date.now() - (this.oneSidedStartTs || Date.now());
  const isTimeout = timeSinceOpen > hedgeTimeoutSec * 1000;
  const isMustHedge = snap.secondsRemaining < this.cfg.timing.hedgeMustBySec;
  
  // Determine hedge urgency
  let cushionTicks = this.cfg.execution.hedgeCushionTicks;
  let hedgeType = "NORMAL_HEDGE";
  
  if (isTimeout || isMustHedge) {
    cushionTicks = this.cfg.execution.riskHedgeCushionTicks;
    hedgeType = "RISK_HEDGE";
  }
  
  // Calculate hedge price with cushion
  const tick = this.tickInferer.getTick(this.marketId, hedgeSide, 
    hedgeSide === "UP" ? snap.upBook : snap.downBook, snap.ts);
  const hedgePrice = addTicks(hedgeTop.ask, tick, cushionTicks);
  
  // Profitability check
  const existingAvgCost = avgCost(this.inventory, 
    hedgeSide === "UP" ? "DOWN" : "UP");
  const projectedPairCost = existingAvgCost + hedgePrice;
  
  if (projectedPairCost > 1 + this.cfg.edge.allowOverpay) {
    return null; // Would lose money
  }
  
  // Match shares to existing position
  const existingShares = hedgeSide === "UP" 
    ? this.inventory.downShares 
    : this.inventory.upShares;
  
  return {
    side: hedgeSide,
    qty: existingShares,
    limitPrice: hedgePrice,
    tag: "HEDGE",
    reason: \`\${hedgeType}: \${hedgeSide} @ \${(hedgePrice*100).toFixed(0)}¢ (timeout=\${hedgeTimeoutSec}s)\`
  };
}`;

const ACCUMULATE_LOGIC = `// v4.2: Accumulate Logic with Skew Limits

async function buildAccumulateIntent(
  snap: MarketSnapshot,
  buffer: number
): Promise<OrderIntent | null> {
  if (this.state !== "HEDGED") return null;
  
  // Check position limits
  if (this.inventory.upShares >= 300 || this.inventory.downShares >= 300) {
    return null;
  }
  
  if (totalNotional(this.inventory) >= this.cfg.limits.maxTotalUsd) {
    return null;
  }
  
  // Edge check - must be strong for accumulate
  const combined = snap.upTop.ask + snap.downTop.ask;
  const edgeOk = combined <= (1 - buffer);
  
  if (!edgeOk) {
    return null;
  }
  
  // Buy cheaper side
  const buySide = cheapestSideByAsk(snap);
  const buyTop = buySide === "UP" ? snap.upTop : snap.downTop;
  
  const qty = Math.min(50, sharesFromUsd(25, buyTop.ask));
  
  return {
    side: buySide,
    qty,
    limitPrice: buyTop.ask,
    tag: "REBAL",
    reason: \`ACCUMULATE: \${buySide} @ \${(buyTop.ask*100).toFixed(0)}¢, combined=\${(combined*100).toFixed(0)}¢\`
  };
}`;

export default function GptStrategy() {
  const navigate = useNavigate();
  const [copiedSection, setCopiedSection] = useState<string | null>(null);
  const [isExporting, setIsExporting] = useState(false);

  const handleExportPDF = async () => {
    setIsExporting(true);
    toast.info('PDF wordt gegenereerd...');
    
    try {
      const pdf = new jsPDF({
        orientation: 'portrait',
        unit: 'mm',
        format: 'a4',
      });
      
      const pageWidth = pdf.internal.pageSize.getWidth();
      const pageHeight = pdf.internal.pageSize.getHeight();
      const margin = 15;
      const contentWidth = pageWidth - (margin * 2);
      let y = margin;
      
      const addNewPageIfNeeded = (neededSpace: number) => {
        if (y + neededSpace > pageHeight - margin) {
          pdf.addPage();
          y = margin;
          return true;
        }
        return false;
      };
      
      const addTitle = (text: string, size: number = 18) => {
        addNewPageIfNeeded(15);
        pdf.setFontSize(size);
        pdf.setFont('helvetica', 'bold');
        pdf.setTextColor(30, 30, 30);
        pdf.text(text, margin, y);
        y += size * 0.5 + 4;
      };
      
      const addParagraph = (text: string) => {
        pdf.setFontSize(10);
        pdf.setFont('helvetica', 'normal');
        pdf.setTextColor(50, 50, 50);
        const lines = pdf.splitTextToSize(text, contentWidth);
        addNewPageIfNeeded(lines.length * 5 + 3);
        pdf.text(lines, margin, y);
        y += lines.length * 5 + 3;
      };
      
      const addCodeBlock = (code: string, title: string) => {
        const lines = code.split('\n');
        const blockHeight = lines.length * 4 + 15;
        addNewPageIfNeeded(Math.min(blockHeight, 80));
        
        pdf.setFontSize(10);
        pdf.setFont('helvetica', 'bold');
        pdf.setTextColor(100, 100, 100);
        pdf.text(title, margin, y);
        y += 6;
        
        pdf.setFillColor(245, 245, 245);
        const codeLines = lines.slice(0, 25);
        const boxHeight = codeLines.length * 4 + 6;
        pdf.rect(margin, y - 3, contentWidth, boxHeight, 'F');
        
        pdf.setFontSize(8);
        pdf.setFont('courier', 'normal');
        pdf.setTextColor(40, 40, 40);
        
        codeLines.forEach((line, i) => {
          const truncatedLine = line.length > 90 ? line.substring(0, 87) + '...' : line;
          pdf.text(truncatedLine, margin + 3, y + (i * 4));
        });
        
        if (lines.length > 25) {
          pdf.setFont('helvetica', 'italic');
          pdf.setTextColor(100, 100, 100);
          pdf.text(`... (${lines.length - 25} more lines)`, margin + 3, y + (25 * 4));
        }
        
        y += boxHeight + 5;
      };
      
      // Header
      addTitle('GPT Strategy v4.2.1 - Adaptive Edition', 22);
      pdf.setFontSize(10);
      pdf.setFont('helvetica', 'normal');
      pdf.setTextColor(120, 120, 120);
      pdf.text(`Gegenereerd op: ${new Date().toLocaleDateString('nl-NL', { 
        year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' 
      })}`, margin, y);
      y += 10;
      
      addTitle('Strategie Overzicht', 14);
      addParagraph('Gabagool Inspired Inventory Arbitrage Strategy v4.2.1 met CONSTANTE delta regimes en time-scaled parameters. Regimes blijven vast, alleen parameters (hedge timeout, skew, buffer) worden aangepast op basis van tijd.');
      y += 5;
      
      addCodeBlock(STRATEGY_CONFIG, 'Configuration');
      addCodeBlock(DELTA_REGIME, 'Delta Regime Calculation');
      addCodeBlock(REGIME_BEHAVIOR, 'Regime Behavior');
      addCodeBlock(TICK_LOGIC, 'Tick Implementation');
      addCodeBlock(CORE_INVARIANT, 'Core Invariant');
      addCodeBlock(ENTRY_LOGIC, 'Entry Logic');
      addCodeBlock(HEDGE_LOGIC, 'Hedge Logic');
      addCodeBlock(ACCUMULATE_LOGIC, 'Accumulate Logic');
      
      // Footer
      const totalPages = pdf.getNumberOfPages();
      for (let i = 1; i <= totalPages; i++) {
        pdf.setPage(i);
        pdf.setFontSize(8);
        pdf.setFont('helvetica', 'normal');
        pdf.setTextColor(150, 150, 150);
        pdf.text(`Pagina ${i} van ${totalPages}`, pageWidth / 2, pageHeight - 8, { align: 'center' });
      }
      
      pdf.save('gpt-strategy-v4.2.1.pdf');
      toast.success('PDF geëxporteerd!');
    } catch (error) {
      console.error('PDF export error:', error);
      toast.error('Fout bij exporteren PDF');
    } finally {
      setIsExporting(false);
    }
  };

  const handleCopy = async (code: string, section: string) => {
    await navigator.clipboard.writeText(code);
    setCopiedSection(section);
    toast.success('Code gekopieerd!');
    setTimeout(() => setCopiedSection(null), 2000);
  };

  const CodeBlock = ({ code, section, title }: { code: string; section: string; title: string }) => (
    <div className="relative">
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-medium text-muted-foreground">{title}</span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => handleCopy(code, section)}
          className="h-8"
        >
          {copiedSection === section ? (
            <Check className="h-4 w-4 text-green-500" />
          ) : (
            <Copy className="h-4 w-4" />
          )}
        </Button>
      </div>
      <pre className="bg-muted/50 p-4 rounded-lg overflow-x-auto text-sm font-mono">
        <code>{code}</code>
      </pre>
    </div>
  );

  return (
    <div className="min-h-screen bg-background p-6">
      <div className="max-w-5xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Button variant="ghost" size="icon" onClick={() => navigate(-1)}>
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <div>
              <h1 className="text-2xl font-bold">GPT Strategy v4.2.1</h1>
              <p className="text-muted-foreground">Gabagool Inspired - Constant Regimes + Time-Scaled Params</p>
            </div>
          </div>
          <Button 
            onClick={handleExportPDF} 
            disabled={isExporting}
            className="gap-2"
          >
            {isExporting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <FileDown className="h-4 w-4" />
            )}
            {isExporting ? 'Exporteren...' : 'Export PDF'}
          </Button>
        </div>

        {/* Core Concept */}
        <Card className="border-primary/30 bg-primary/5">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Target className="h-5 w-5 text-primary" />
              Core Invariant
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="bg-muted/50 p-4 rounded-lg font-mono text-sm">
              <p className="text-green-500">
                min(UP, DOWN) &gt; 0 &amp;&amp; avgUpCost + avgDownCost ≤ 0.99
              </p>
            </div>
            <p className="mt-3 text-sm text-muted-foreground">
              Trades zijn inventory-aanpassingen om de gezamenlijke kosten te verbeteren.
              NIET om elke markt &ldquo;flat&rdquo; te maken.
            </p>
          </CardContent>
        </Card>

        {/* Delta Regimes */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Activity className="h-5 w-5 text-primary" />
              Delta Regimes (CONSTANT) + Time-Scaled Parameters
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid md:grid-cols-3 gap-4">
              {/* LOW */}
              <div className="p-4 rounded-lg bg-green-500/10 border border-green-500/30">
                <div className="flex items-center gap-2 mb-2">
                  <Badge className="bg-green-500">LOW</Badge>
                  <span className="text-sm text-muted-foreground">&lt; 0.30% (vast)</span>
                </div>
                <ul className="text-sm space-y-1">
                  <li>✓ Gabagool mode toegestaan</li>
                  <li>✓ DEEP mode (als conditions OK)</li>
                  <li>✓ Meest agressieve trading</li>
                </ul>
              </div>
              
              {/* MID */}
              <div className="p-4 rounded-lg bg-amber-500/10 border border-amber-500/30">
                <div className="flex items-center gap-2 mb-2">
                  <Badge className="bg-amber-500">MID</Badge>
                  <span className="text-sm text-muted-foreground">0.30% - 0.70% (vast)</span>
                </div>
                <ul className="text-sm space-y-1">
                  <li>⚠️ Geen DEEP mode</li>
                  <li>✓ Conservatieve arbitrage</li>
                  <li>✓ Standaard entries</li>
                </ul>
              </div>
              
              {/* HIGH */}
              <div className="p-4 rounded-lg bg-red-500/10 border border-red-500/30">
                <div className="flex items-center gap-2 mb-2">
                  <Badge className="bg-red-500">HIGH</Badge>
                  <span className="text-sm text-muted-foreground">&gt; 0.70% (vast)</span>
                </div>
                <ul className="text-sm space-y-1">
                  <li>❌ Geen nieuwe risico</li>
                  <li>✓ Alleen hedgen</li>
                  <li>✓ Settlement prep</li>
                </ul>
              </div>
            </div>
            
            <div className="bg-muted/30 p-4 rounded-lg">
              <h4 className="font-semibold mb-2 flex items-center gap-2">
                <Clock className="h-4 w-4" />
                Time-Scaled Parameters (v4.2.1)
              </h4>
              <p className="text-sm text-muted-foreground mb-2">
                <code className="text-primary">timeFactor = max(secondsRemaining, 60) / 900</code>
              </p>
              <ul className="text-sm text-muted-foreground space-y-1">
                <li>• <strong>hedgeTimeout</strong> ↓ korter naarmate expiry nadert</li>
                <li>• <strong>maxSkew</strong> ↓ strakker naarmate expiry nadert</li>
                <li>• <strong>bufferAdd</strong> ↑ strenger naarmate expiry nadert</li>
              </ul>
            </div>
            
            <div className="bg-purple-500/10 border border-purple-500/30 p-4 rounded-lg">
              <h4 className="font-semibold mb-2 flex items-center gap-2 text-purple-400">
                <Zap className="h-4 w-4" />
                DEEP Mode Conditions (v4.2.1)
              </h4>
              <ul className="text-sm space-y-1">
                <li>✓ secondsRemaining &gt; <strong>180s</strong></li>
                <li>✓ cheapestAsk + otherMid &lt; <strong>0.95</strong></li>
                <li>✓ delta &lt; <strong>0.40%</strong></li>
              </ul>
            </div>
          </CardContent>
        </Card>

        {/* Strategy Overview Cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Card className="bg-green-500/10 border-green-500/20">
            <CardContent className="pt-4">
              <div className="flex items-center gap-2 mb-2">
                <Gauge className="h-5 w-5 text-green-500" />
                <span className="font-semibold">LOW Skew</span>
              </div>
              <p className="text-2xl font-bold">70/30</p>
              <p className="text-sm text-muted-foreground">max asymmetry</p>
            </CardContent>
          </Card>

          <Card className="bg-amber-500/10 border-amber-500/20">
            <CardContent className="pt-4">
              <div className="flex items-center gap-2 mb-2">
                <Clock className="h-5 w-5 text-amber-500" />
                <span className="font-semibold">LOW Hedge</span>
              </div>
              <p className="text-2xl font-bold">35s</p>
              <p className="text-sm text-muted-foreground">hedge timeout</p>
            </CardContent>
          </Card>

          <Card className="bg-red-500/10 border-red-500/20">
            <CardContent className="pt-4">
              <div className="flex items-center gap-2 mb-2">
                <AlertTriangle className="h-5 w-5 text-red-500" />
                <span className="font-semibold">Hard Stop</span>
              </div>
              <p className="text-2xl font-bold">60s</p>
              <p className="text-sm text-muted-foreground">voor settlement</p>
            </CardContent>
          </Card>

          <Card className="bg-purple-500/10 border-purple-500/20">
            <CardContent className="pt-4">
              <div className="flex items-center gap-2 mb-2">
                <Target className="h-5 w-5 text-purple-500" />
                <span className="font-semibold">DEEP Max</span>
              </div>
              <p className="text-2xl font-bold">0.40%</p>
              <p className="text-sm text-muted-foreground">delta threshold</p>
            </CardContent>
          </Card>
        </div>

        {/* Version History */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Zap className="h-5 w-5 text-primary" />
              v4.2.1 Changes
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2 text-sm">
              <li className="flex items-center gap-2">
                <Check className="h-4 w-4 text-green-500" />
                <strong>Constant regimes:</strong> LOW &lt;0.30%, MID 0.30-0.70%, HIGH &gt;0.70% (geen time-shrinking)
              </li>
              <li className="flex items-center gap-2">
                <Check className="h-4 w-4 text-green-500" />
                <strong>Time-scaled hedgeTimeout:</strong> Korter naarmate expiry nadert
              </li>
              <li className="flex items-center gap-2">
                <Check className="h-4 w-4 text-green-500" />
                <strong>Time-scaled maxSkew:</strong> Strakker naarmate expiry nadert
              </li>
              <li className="flex items-center gap-2">
                <Check className="h-4 w-4 text-green-500" />
                <strong>Time-scaled bufferAdd:</strong> Strenger naarmate expiry nadert
              </li>
              <li className="flex items-center gap-2">
                <Check className="h-4 w-4 text-green-500" />
                <strong>DEEP mode:</strong> Alleen als t&gt;180s, combined&lt;0.95, delta&lt;0.40%
              </li>
            </ul>
          </CardContent>
        </Card>

        {/* State Machine */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <BarChart3 className="h-5 w-5 text-primary" />
              Bot State Machine
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-3 mb-4">
              <span className="px-3 py-1 rounded-full bg-muted text-sm font-mono">FLAT</span>
              <span className="text-muted-foreground">→</span>
              <span className="px-3 py-1 rounded-full bg-amber-500/20 text-amber-500 text-sm font-mono">ONE_SIDED</span>
              <span className="text-muted-foreground">→</span>
              <span className="px-3 py-1 rounded-full bg-green-500/20 text-green-500 text-sm font-mono">HEDGED</span>
            </div>
            <div className="flex flex-wrap gap-3">
              <span className="px-3 py-1 rounded-full bg-purple-500/20 text-purple-500 text-sm font-mono">SKEWED</span>
              <span className="px-3 py-1 rounded-full bg-red-500/20 text-red-500 text-sm font-mono">UNWIND</span>
              <span className="px-3 py-1 rounded-full bg-blue-500/20 text-blue-500 text-sm font-mono">DEEP_DISLOCATION</span>
            </div>
          </CardContent>
        </Card>

        {/* Risks */}
        <Card className="border-amber-500/50">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-amber-500">
              <AlertTriangle className="h-5 w-5" />
              Risico&apos;s
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2 text-sm">
              <li className="flex items-start gap-2">
                <AlertTriangle className="h-4 w-4 text-amber-500 mt-0.5 flex-shrink-0" />
                <span><strong>HIGH delta regime:</strong> Als prijs ver van strike afwijkt, stopt de bot met accumuleren</span>
              </li>
              <li className="flex items-start gap-2">
                <AlertTriangle className="h-4 w-4 text-amber-500 mt-0.5 flex-shrink-0" />
                <span><strong>Time-decay:</strong> Bij lange tijd in MID/HIGH regime kan de bot te conservatief worden</span>
              </li>
              <li className="flex items-start gap-2">
                <AlertTriangle className="h-4 w-4 text-amber-500 mt-0.5 flex-shrink-0" />
                <span><strong>Snelle marktbewegingen:</strong> Delta regime kan snel wisselen bij volatiliteit</span>
              </li>
            </ul>
          </CardContent>
        </Card>

        {/* Code Sections */}
        <div className="space-y-6">
          <h2 className="text-xl font-semibold">Code Implementatie</h2>
          
          <CodeBlock 
            code={STRATEGY_CONFIG} 
            section="config" 
            title="Strategy Configuration (v4.2.1)" 
          />
          
          <CodeBlock 
            code={DELTA_REGIME} 
            section="delta" 
            title="Delta Regime Calculation" 
          />
          
          <CodeBlock 
            code={REGIME_BEHAVIOR} 
            section="behavior" 
            title="Regime Behavior Summary" 
          />
          
          <CodeBlock 
            code={TICK_LOGIC} 
            section="tick" 
            title="Tick() Implementation" 
          />
          
          <CodeBlock 
            code={CORE_INVARIANT} 
            section="invariant" 
            title="Core Settlement Invariant" 
          />
          
          <CodeBlock 
            code={ENTRY_LOGIC} 
            section="entry" 
            title="Entry Logic" 
          />
          
          <CodeBlock 
            code={HEDGE_LOGIC} 
            section="hedge" 
            title="Hedge Logic" 
          />
          
          <CodeBlock 
            code={ACCUMULATE_LOGIC} 
            section="accumulate" 
            title="Accumulate Logic" 
          />
        </div>

        {/* Footer */}
        <div className="text-center py-8 text-sm text-muted-foreground">
          <p>GPT Strategy v4.2.1 - Gabagool Inspired Adaptive Edition</p>
          <p>Constant Regimes + Time-Scaled Parameters</p>
        </div>
      </div>
    </div>
  );
}
