import { ArrowLeft, Copy, Check, TrendingUp, Shield, Layers, Clock, AlertTriangle, FileDown, Loader2, Zap, Target, BarChart3 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useState } from 'react';
import { toast } from 'sonner';
import jsPDF from 'jspdf';

const STRATEGY_CONFIG = `// v3.2.1: Big Hedger Configuration
export const DEFAULT_CONFIG: StrategyConfig = {
  // Opening 50 shares, accumulate max 50, max position 300
  tradeSizeUsd: { base: 25, min: 20, max: 50 }, // ~50 shares at 50¢

  edge: {
    baseBuffer: 0.012,           // 1.2¢ minimum edge
    strongEdge: 0.04,            // 4¢ is strong edge
    allowOverpay: 0.01,          // Only allow 1¢ overpay
    feesBuffer: 0.002,           // 0.2¢ for fees
    slippageBuffer: 0.004,       // 0.4¢ for slippage
    deepDislocationThreshold: 0.96, // 96¢ triggers DEEP regime
  },

  timing: {
    stopNewTradesSec: 30,        // Stop new trades 30s before end
    hedgeTimeoutSec: 12,         // Force hedge after 12s
    hedgeMustBySec: 60,          // Must hedge by 60s remaining
    unwindStartSec: 45,          // Start unwinding at 45s
  },

  skew: {
    target: 0.50,                // 50% target allocation
    rebalanceThreshold: 0.20,    // Rebalance if 20% off
    hardCap: 0.70,               // Max 70% one side
    deepAllowedSkew: 0.70,       // Allowed in DEEP regime
  },

  limits: {
    maxTotalUsd: 500,            // Max $500 total position
    maxPerSideUsd: 300,          // 300 shares max per side
    minTopDepthShares: 50,       // Min liquidity required
    maxPendingOrders: 3,         // Max orders in queue
    sideCooldownMs: 0,           // NO cooldown for hedge
  },

  execution: {
    tickFallback: 0.01,
    tickNiceSet: [0.01, 0.005, 0.002, 0.001],
    hedgeCushionTicks: 2,        // 2 ticks above ask
    riskHedgeCushionTicks: 3,    // Risk/Unwind: aggressive
    entryImproveTicks: 0,
  },

  profit: {
    lockPairCost: 0.99,          // Stop if pair cost < 99¢
  },

  sizing: {
    edgeMultiplierHigh: 2.0,     // >= 5¢ edge -> 2x size
    edgeMultiplierMedium: 1.5,   // 2-5¢ edge -> 1.5x
    edgeMultiplierLow: 1.0,      // < 2¢ edge -> 1x
    lowLiquidityMultiplier: 0.5,
    nearExpiryMultiplier: 0.5,
    deepDislocMultiplier: 2.5,   // DEEP regime boost
  },
};`;

const EDGE_CALCULATION = `// v3.1: Execution-aware edge calculation
// expectedExecutedPairCost = cheapestSide.ask + otherSide.mid
// Entry allowed if: expectedExecutedPairCost <= 1 - dynamicEdgeBuffer

function executionAwareEdgeOk(
  snap: MarketSnapshot, 
  buffer: number
): { ok: boolean; entrySide: Side; expectedExecutedPairCost: number } {
  const entrySide = cheapestSideByAsk(snap);
  const cheapestAsk = entrySide === "UP" ? snap.upTop.ask : snap.downTop.ask;
  const otherMid = entrySide === "UP" ? snap.downTop.mid : snap.upTop.mid;
  
  // Use mid price for other side (more realistic execution estimate)
  const expectedExecutedPairCost = cheapestAsk + otherMid;
  const ok = expectedExecutedPairCost <= (1 - buffer);
  
  return { ok, entrySide, expectedExecutedPairCost };
}

// Dynamic edge buffer with penalties for execution issues
function dynamicEdgeBuffer(
  cfg: StrategyConfig, 
  noLiquidityStreak: number, 
  adverseStreak: number
): number {
  const liquidityPenalty = Math.min(0.01, noLiquidityStreak * 0.001);
  const adversePenalty = Math.min(0.01, adverseStreak * 0.0015);
  return cfg.edge.baseBuffer + cfg.edge.feesBuffer + 
         cfg.edge.slippageBuffer + liquidityPenalty + adversePenalty;
}`;

const STATE_MACHINE = `// Bot State Machine
export type BotState = 
  | "FLAT"           // No position
  | "ONE_SIDED"      // Only UP or DOWN, needs hedge
  | "HEDGED"         // Both sides filled, profitable
  | "SKEWED"         // Unbalanced position
  | "UNWIND"         // Closing out position
  | "DEEP_DISLOCATION"; // Extreme edge opportunity

// State transitions:
// FLAT -> ONE_SIDED (on first fill)
// ONE_SIDED -> HEDGED (on hedge fill)
// ONE_SIDED -> UNWIND (on timeout without hedge)
// HEDGED -> SKEWED (if imbalanced)
// SKEWED -> HEDGED (on rebalance)
// ANY -> FLAT (on position close)

function determineState(inv: Inventory, snap: MarketSnapshot): BotState {
  const hasUp = inv.upShares > 0;
  const hasDown = inv.downShares > 0;
  
  if (!hasUp && !hasDown) return "FLAT";
  
  if (hasUp && !hasDown) return "ONE_SIDED";
  if (!hasUp && hasDown) return "ONE_SIDED";
  
  // Check if DEEP_DISLOCATION
  if (isDeepDislocation(snap, 0.96)) return "DEEP_DISLOCATION";
  
  // Check skew
  const frac = upFraction(inv);
  if (Math.abs(frac - 0.5) > 0.20) return "SKEWED";
  
  return "HEDGED";
}`;

const ENTRY_LOGIC = `// Entry Logic: When to open a new position
async function evaluateEntry(snap: MarketSnapshot): Promise<OrderIntent | null> {
  // 1. Check if already have position
  if (this.state !== "FLAT") return null;
  
  // 2. Check timing - don't enter too close to expiry
  if (snap.secondsRemaining < this.cfg.timing.stopNewTradesSec) {
    return null; // Too late
  }
  
  // 3. Calculate dynamic edge buffer
  const buffer = dynamicEdgeBuffer(
    this.cfg, 
    this.noLiquidityStreak, 
    this.adverseStreak
  );
  
  // 4. Check execution-aware edge
  const { ok, entrySide, expectedExecutedPairCost } = 
    executionAwareEdgeOk(snap, buffer);
  
  if (!ok) {
    return null; // Not enough edge
  }
  
  // 5. Check liquidity
  const sideTop = entrySide === "UP" ? snap.upTop : snap.downTop;
  if (sideTop.askSize < this.cfg.limits.minTopDepthShares) {
    return null; // Not enough liquidity
  }
  
  // 6. Calculate order size with edge-based scaling
  const edge = 1 - expectedExecutedPairCost;
  let sizeMultiplier = 1.0;
  if (edge >= 0.05) sizeMultiplier = this.cfg.sizing.edgeMultiplierHigh;
  else if (edge >= 0.02) sizeMultiplier = this.cfg.sizing.edgeMultiplierMedium;
  
  const baseQty = sharesFromUsd(this.cfg.tradeSizeUsd.base, sideTop.ask);
  const qty = Math.floor(baseQty * sizeMultiplier);
  
  return {
    side: entrySide,
    qty: Math.min(qty, 50), // v3.2.1: max 50 shares per trade
    limitPrice: sideTop.ask,
    tag: "ENTRY",
    reason: \`ENTRY \${entrySide} @ \${sideTop.ask}¢, edge=\${(edge*100).toFixed(1)}%\`
  };
}`;

const HEDGE_LOGIC = `// Hedge Logic: Cover the other side
async function evaluateHedge(snap: MarketSnapshot): Promise<OrderIntent | null> {
  if (this.state !== "ONE_SIDED") return null;
  
  // Determine which side needs hedging
  const needsUp = this.inventory.upShares === 0 && this.inventory.downShares > 0;
  const hedgeSide: Side = needsUp ? "UP" : "DOWN";
  const hedgeTop = hedgeSide === "UP" ? snap.upTop : snap.downTop;
  
  // Calculate hedge timing
  const timeSinceOpen = Date.now() - (this.oneSidedStartTs || Date.now());
  const isTimeout = timeSinceOpen > this.cfg.timing.hedgeTimeoutSec * 1000;
  const isMustHedge = snap.secondsRemaining < this.cfg.timing.hedgeMustBySec;
  
  // Determine hedge type
  let cushionTicks = this.cfg.execution.hedgeCushionTicks;
  let hedgeType = "NORMAL_HEDGE";
  
  if (isTimeout || isMustHedge) {
    cushionTicks = this.cfg.execution.riskHedgeCushionTicks;
    hedgeType = "RISK_HEDGE";
  }
  
  // Calculate hedge price with cushion for fill guarantee
  const tick = this.tickInferer.getTick(this.marketId, hedgeSide, 
    hedgeSide === "UP" ? snap.upBook : snap.downBook, snap.ts);
  const hedgePrice = addTicks(hedgeTop.ask, tick, cushionTicks);
  
  // Check if hedge is still profitable
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
    reason: \`\${hedgeType}: \${hedgeSide} @ \${hedgePrice}¢\`
  };
}`;

const ACCUMULATE_LOGIC = `// Accumulate Logic: Add to hedged position when edge is good
async function evaluateAccumulate(snap: MarketSnapshot): Promise<OrderIntent | null> {
  // v3.2.1: Only accumulate when properly hedged
  if (this.state !== "HEDGED") return null;
  
  // Check skew - must be balanced
  const frac = upFraction(this.inventory);
  if (Math.abs(frac - 0.5) > 0.10) {
    return null; // Too skewed, don't add more
  }
  
  // Check position limits
  if (this.inventory.upShares >= 300 || this.inventory.downShares >= 300) {
    return null; // v3.2.1: max 300 shares per side
  }
  
  // Check total position limit
  if (totalNotional(this.inventory) >= this.cfg.limits.maxTotalUsd) {
    return null; // Position full
  }
  
  // Check edge - must be strong for accumulate
  const combined = snap.upTop.ask + snap.downTop.ask;
  if (combined >= 0.97) {
    return null; // Not enough edge
  }
  
  // Buy cheaper side
  const buySide = cheapestSideByAsk(snap);
  const buyTop = buySide === "UP" ? snap.upTop : snap.downTop;
  
  // v3.2.1: max 50 shares per accumulate trade
  const qty = Math.min(50, sharesFromUsd(25, buyTop.ask));
  
  return {
    side: buySide,
    qty,
    limitPrice: buyTop.ask,
    tag: "REBAL",
    reason: \`ACCUMULATE: \${buySide} @ \${buyTop.ask}¢, combined=\${combined}\`
  };
}`;

const PROFIT_CALCULATION = `// PROFIT CALCULATION
// 
// At market expiry, shares resolve to $1 (winner) or $0 (loser)
//
// Example hedged position:
//   - 50 UP shares @ 48¢ = $24.00
//   - 50 DOWN shares @ 47¢ = $23.50
//   - Total invested: $47.50
//   - Pair cost: 48¢ + 47¢ = 95¢
//
// If UP wins:
//   - UP shares: 50 × $1 = $50.00
//   - DOWN shares: 50 × $0 = $0
//   - Payout: $50.00
//   - Profit: $50.00 - $47.50 = $2.50 (5.3%)
//
// If DOWN wins:
//   - UP shares: 50 × $0 = $0
//   - DOWN shares: 50 × $1 = $50.00
//   - Payout: $50.00
//   - Profit: $50.00 - $47.50 = $2.50 (5.3%)
//
// GUARANTEED 5.3% profit when pair cost < $1.00!
//
// The bot targets:
//   - Entry when combined < 98¢ (2% minimum edge)
//   - Accumulate when combined < 97¢ (3% edge)
//   - Lock profit at pair cost < 99¢`;

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
      addTitle('GPT Strategy v3.2.1 - Big Hedger', 22);
      pdf.setFontSize(10);
      pdf.setFont('helvetica', 'normal');
      pdf.setTextColor(120, 120, 120);
      pdf.text(`Gegenereerd op: ${new Date().toLocaleDateString('nl-NL', { 
        year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' 
      })}`, margin, y);
      y += 10;
      
      addTitle('Strategie Overzicht', 14);
      addParagraph('Polymarket 15m Hedge/Arbitrage Bot die automatisch UP en DOWN koopt om gegarandeerde winst te maken wanneer de gecombineerde prijs onder $1.00 is.');
      y += 5;
      
      addCodeBlock(STRATEGY_CONFIG, 'Configuration');
      addCodeBlock(EDGE_CALCULATION, 'Edge Calculation');
      addCodeBlock(STATE_MACHINE, 'State Machine');
      addCodeBlock(ENTRY_LOGIC, 'Entry Logic');
      addCodeBlock(HEDGE_LOGIC, 'Hedge Logic');
      addCodeBlock(ACCUMULATE_LOGIC, 'Accumulate Logic');
      addCodeBlock(PROFIT_CALCULATION, 'Profit Calculation');
      
      // Footer
      const totalPages = pdf.getNumberOfPages();
      for (let i = 1; i <= totalPages; i++) {
        pdf.setPage(i);
        pdf.setFontSize(8);
        pdf.setFont('helvetica', 'normal');
        pdf.setTextColor(150, 150, 150);
        pdf.text(`Pagina ${i} van ${totalPages}`, pageWidth / 2, pageHeight - 8, { align: 'center' });
      }
      
      pdf.save('gpt-strategy-v3.2.1.pdf');
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
              <h1 className="text-2xl font-bold">GPT Strategy v3.2.1</h1>
              <p className="text-muted-foreground">Big Hedger - Polymarket 15m Arbitrage Bot</p>
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

        {/* Strategy Overview Cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Card className="bg-blue-500/10 border-blue-500/20">
            <CardContent className="pt-4">
              <div className="flex items-center gap-2 mb-2">
                <TrendingUp className="h-5 w-5 text-blue-500" />
                <span className="font-semibold">Opening</span>
              </div>
              <p className="text-2xl font-bold">50</p>
              <p className="text-sm text-muted-foreground">shares per entry</p>
            </CardContent>
          </Card>

          <Card className="bg-green-500/10 border-green-500/20">
            <CardContent className="pt-4">
              <div className="flex items-center gap-2 mb-2">
                <Shield className="h-5 w-5 text-green-500" />
                <span className="font-semibold">Max Position</span>
              </div>
              <p className="text-2xl font-bold">300</p>
              <p className="text-sm text-muted-foreground">shares per side</p>
            </CardContent>
          </Card>

          <Card className="bg-amber-500/10 border-amber-500/20">
            <CardContent className="pt-4">
              <div className="flex items-center gap-2 mb-2">
                <Clock className="h-5 w-5 text-amber-500" />
                <span className="font-semibold">Hedge Timeout</span>
              </div>
              <p className="text-2xl font-bold">12s</p>
              <p className="text-sm text-muted-foreground">force hedge</p>
            </CardContent>
          </Card>

          <Card className="bg-purple-500/10 border-purple-500/20">
            <CardContent className="pt-4">
              <div className="flex items-center gap-2 mb-2">
                <Target className="h-5 w-5 text-purple-500" />
                <span className="font-semibold">Edge Buffer</span>
              </div>
              <p className="text-2xl font-bold">1.2¢</p>
              <p className="text-sm text-muted-foreground">minimum edge</p>
            </CardContent>
          </Card>
        </div>

        {/* Version History */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Zap className="h-5 w-5 text-primary" />
              v3.2.1 Changes (Big Hedger)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2 text-sm">
              <li className="flex items-center gap-2">
                <Check className="h-4 w-4 text-green-500" />
                Opening trade: <strong>50 shares</strong> (was 25)
              </li>
              <li className="flex items-center gap-2">
                <Check className="h-4 w-4 text-green-500" />
                Max position: <strong>300 shares</strong> per side (was 150)
              </li>
              <li className="flex items-center gap-2">
                <Check className="h-4 w-4 text-green-500" />
                Accumulate: max <strong>50 shares</strong> per trade
              </li>
              <li className="flex items-center gap-2">
                <Check className="h-4 w-4 text-green-500" />
                Accumulate only when hedged (skew &lt; 10%)
              </li>
              <li className="flex items-center gap-2">
                <Check className="h-4 w-4 text-green-500" />
                Exposure protection: no accumulate when one-sided
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
              Risico's
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2 text-sm">
              <li className="flex items-start gap-2">
                <AlertTriangle className="h-4 w-4 text-amber-500 mt-0.5 flex-shrink-0" />
                <span><strong>One-sided exposure:</strong> Als hedge niet lukt binnen timeout, blijft positie ongedekt</span>
              </li>
              <li className="flex items-start gap-2">
                <AlertTriangle className="h-4 w-4 text-amber-500 mt-0.5 flex-shrink-0" />
                <span><strong>Snelle markten:</strong> Bij hele korte markten kan prijs te snel bewegen</span>
              </li>
              <li className="flex items-start gap-2">
                <AlertTriangle className="h-4 w-4 text-amber-500 mt-0.5 flex-shrink-0" />
                <span><strong>Liquidity gaps:</strong> Bij lage liquiditeit kunnen orders niet gevuld worden</span>
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
            title="Strategy Configuration" 
          />
          
          <CodeBlock 
            code={EDGE_CALCULATION} 
            section="edge" 
            title="Edge Calculation (v3.1)" 
          />
          
          <CodeBlock 
            code={STATE_MACHINE} 
            section="state" 
            title="State Machine" 
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
            title="Accumulate Logic (v3.2.1)" 
          />
          
          <CodeBlock 
            code={PROFIT_CALCULATION} 
            section="profit" 
            title="Profit Calculation" 
          />
        </div>

        {/* Footer */}
        <div className="text-center py-8 text-sm text-muted-foreground">
          <p>GPT Strategy v3.2.1 - Big Hedger</p>
          <p>Polymarket 15m Hedge/Arbitrage Bot</p>
        </div>
      </div>
    </div>
  );
}
