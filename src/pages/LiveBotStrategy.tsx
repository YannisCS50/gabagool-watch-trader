import { ArrowLeft, Copy, Check, TrendingUp, Shield, Layers, Clock, AlertTriangle, FileDown, Loader2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useState } from 'react';
import { toast } from 'sonner';
import jsPDF from 'jspdf';

const STRATEGY_CONFIG = `const STRATEGY = {
  opening: {
    notional: 5,           // $5 initial trade
    maxPrice: 0.56,        // Only enter if price ≤ 56¢
  },
  hedge: {
    triggerCombined: 0.98, // Hedge when UP + DOWN < 98¢
    notional: 5,           // $5 per hedge
    cushionTicks: 3,       // Extra ticks above ask for fill guarantee
    tickSize: 0.01,        // 1¢ tick size
    forceTimeoutSec: 25,   // Force hedge after 25s if still one-sided
    maxPrice: 0.75,        // Max price for hedge (prevent overpaying)
  },
  accumulate: {
    triggerCombined: 0.97, // Accumulate when combined < 97¢
    notional: 5,           // $5 per accumulate trade
    maxPrice: 0.52,        // Max price per side for accumulate
    maxSharesPerSide: 200, // Stop accumulating at 200 shares per side
  },
  limits: {
    maxPendingOrders: 3,   // Max orders in queue
    orderCooldownMs: 2000, // 2s between orders same side
  },
};`;

const OPENING_LOGIC = `// OPENING + ANTICIPATORY HEDGE: First trade + immediate hedge order
function evaluateOpening(upPrice: number, downPrice: number) {
  const cheapestSide = upPrice <= downPrice ? 'UP' : 'DOWN';
  const cheapestPrice = Math.min(upPrice, downPrice);
  const otherSide = cheapestSide === 'UP' ? 'DOWN' : 'UP';
  const otherPrice = cheapestSide === 'UP' ? downPrice : upPrice;
  
  // Only enter if price is attractive enough
  if (cheapestPrice > STRATEGY.opening.maxPrice) {
    return null; // Price too high, skip
  }
  
  const shares = Math.floor(STRATEGY.opening.notional / cheapestPrice);
  const orders = [];
  
  // 1. Opening order
  orders.push({
    outcome: cheapestSide,
    price: cheapestPrice,
    shares: shares,
    reasoning: \`OPENING: \${cheapestSide} @ \${cheapestPrice}¢\`
  });
  
  // 2. ANTICIPATORY HEDGE: Place hedge order immediately!
  if (otherPrice <= STRATEGY.hedge.maxPrice) {
    const hedgePrice = otherPrice + (STRATEGY.hedge.cushionTicks * STRATEGY.hedge.tickSize);
    const projectedCombined = cheapestPrice + hedgePrice;
    
    if (projectedCombined < 1.0) { // Only if profitable
      orders.push({
        outcome: otherSide,
        price: hedgePrice,
        shares: shares,
        reasoning: \`ANTICIPATORY HEDGE: \${otherSide} @ \${hedgePrice}¢\`
      });
    }
  }
  
  return orders; // Returns 1-2 orders!
}`;

const HEDGE_LOGIC = `// HEDGE: Cover the other side after opening
function evaluateHedge(position: Position, upPrice: number, downPrice: number) {
  const combinedPrice = upPrice + downPrice;
  
  // Only hedge if there's still edge
  if (combinedPrice >= STRATEGY.hedge.triggerCombined) {
    return null; // No edge left
  }
  
  const needsUp = position.upShares === 0 && position.downShares > 0;
  const needsDown = position.downShares === 0 && position.upShares > 0;
  
  if (!needsUp && !needsDown) {
    return null; // Already hedged
  }
  
  const hedgeSide = needsUp ? 'UP' : 'DOWN';
  const hedgePrice = needsUp ? upPrice : downPrice;
  
  // Add cushion for guaranteed fill
  const fillPrice = hedgePrice + (STRATEGY.hedge.cushionTicks * STRATEGY.hedge.tickSize);
  
  if (fillPrice > STRATEGY.hedge.maxPrice) {
    return null; // Too expensive
  }
  
  const shares = Math.floor(STRATEGY.hedge.notional / fillPrice);
  
  return {
    outcome: hedgeSide,
    price: fillPrice,
    shares: shares,
    reasoning: \`HEDGE: \${hedgeSide} @ \${fillPrice}¢\`
  };
}`;

const FORCE_HEDGE_LOGIC = `// FORCE HEDGE: After timeout, hedge regardless of price
function evaluateForceHedge(position: Position, upPrice: number, downPrice: number) {
  const timeSinceOpen = Date.now() - position.openedAt;
  
  // Not yet time to force
  if (timeSinceOpen < STRATEGY.hedge.forceTimeoutSec * 1000) {
    return null;
  }
  
  const needsUp = position.upShares === 0 && position.downShares > 0;
  const needsDown = position.downShares === 0 && position.upShares > 0;
  
  if (!needsUp && !needsDown) {
    return null; // Already hedged
  }
  
  const hedgeSide = needsUp ? 'UP' : 'DOWN';
  const hedgePrice = needsUp ? upPrice : downPrice;
  const fillPrice = hedgePrice + (STRATEGY.hedge.cushionTicks * STRATEGY.hedge.tickSize);
  
  // Still respect max price even on force
  if (fillPrice > STRATEGY.hedge.maxPrice) {
    return null; // Even force won't overpay beyond 75¢
  }
  
  const shares = Math.floor(STRATEGY.hedge.notional / fillPrice);
  
  return {
    outcome: hedgeSide,
    price: fillPrice,
    shares: shares,
    reasoning: \`FORCE HEDGE (timeout): \${hedgeSide} @ \${fillPrice}¢\`
  };
}`;

const ACCUMULATE_LOGIC = `// ACCUMULATE: Add more shares when edge is good
function evaluateAccumulate(position: Position, upPrice: number, downPrice: number) {
  const combinedPrice = upPrice + downPrice;
  
  // Only accumulate if edge is really good
  if (combinedPrice >= STRATEGY.accumulate.triggerCombined) {
    return null;
  }
  
  // Must already be hedged
  if (position.upShares === 0 || position.downShares === 0) {
    return null;
  }
  
  // Check limits
  if (position.upShares >= STRATEGY.accumulate.maxSharesPerSide &&
      position.downShares >= STRATEGY.accumulate.maxSharesPerSide) {
    return null; // Position full
  }
  
  // Buy the cheaper side
  const buySide = upPrice <= downPrice ? 'UP' : 'DOWN';
  const buyPrice = Math.min(upPrice, downPrice);
  
  if (buyPrice > STRATEGY.accumulate.maxPrice) {
    return null; // Price too high for accumulate
  }
  
  const shares = Math.floor(STRATEGY.accumulate.notional / buyPrice);
  
  return {
    outcome: buySide,
    price: buyPrice,
    shares: shares,
    reasoning: \`ACCUMULATE: \${buySide} @ \${buyPrice}¢\`
  };
}`;

const PROFIT_LOGIC = `// PROFIT CALCULATION
// 
// Scenario 1: UP wint (prijs gaat boven strike)
//   - UP shares worden $1 waard
//   - DOWN shares worden $0 waard
//   - Winst = (upShares × $1) - totalInvested
//
// Scenario 2: DOWN wint (prijs blijft onder strike)  
//   - UP shares worden $0 waard
//   - DOWN shares worden $1 waard
//   - Winst = (downShares × $1) - totalInvested
//
// GEHEDGEDE POSITIE (beide kanten gekocht):
//   - Je wint ALTIJD de shares van de winnende kant
//   - Als combined < $1 betaald: GEGARANDEERDE WINST
//   
// Voorbeeld:
//   - 10 UP shares @ 50¢ = $5.00
//   - 10 DOWN shares @ 45¢ = $4.50
//   - Total invested: $9.50
//   - Als UP wint: 10 × $1 = $10 → Winst: $0.50 (5.3%)
//   - Als DOWN wint: 10 × $1 = $10 → Winst: $0.50 (5.3%)
//   - GEGARANDEERD 5.3% winst!`;

export default function LiveBotStrategy() {
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
      
      const addSubtitle = (text: string) => {
        addNewPageIfNeeded(12);
        pdf.setFontSize(12);
        pdf.setFont('helvetica', 'bold');
        pdf.setTextColor(60, 60, 60);
        pdf.text(text, margin, y);
        y += 7;
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
        
        // Title
        pdf.setFontSize(10);
        pdf.setFont('helvetica', 'bold');
        pdf.setTextColor(100, 100, 100);
        pdf.text(title, margin, y);
        y += 6;
        
        // Code background
        pdf.setFillColor(245, 245, 245);
        const codeLines = lines.slice(0, 25);
        const boxHeight = codeLines.length * 4 + 6;
        pdf.rect(margin, y - 3, contentWidth, boxHeight, 'F');
        
        // Code text
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
      
      const addKeyValue = (key: string, value: string) => {
        addNewPageIfNeeded(8);
        pdf.setFontSize(10);
        pdf.setFont('helvetica', 'bold');
        pdf.setTextColor(60, 60, 60);
        pdf.text(`${key}: `, margin, y);
        const keyWidth = pdf.getTextWidth(`${key}: `);
        pdf.setFont('helvetica', 'normal');
        pdf.setTextColor(30, 30, 30);
        pdf.text(value, margin + keyWidth, y);
        y += 6;
      };
      
      const addBullet = (text: string) => {
        pdf.setFontSize(10);
        pdf.setFont('helvetica', 'normal');
        pdf.setTextColor(50, 50, 50);
        const lines = pdf.splitTextToSize(text, contentWidth - 8);
        addNewPageIfNeeded(lines.length * 5 + 2);
        pdf.text('•', margin, y);
        pdf.text(lines, margin + 5, y);
        y += lines.length * 5 + 2;
      };
      
      // === HEADER ===
      addTitle('Live Bot Strategie', 22);
      pdf.setFontSize(10);
      pdf.setFont('helvetica', 'normal');
      pdf.setTextColor(120, 120, 120);
      pdf.text(`Gegenereerd op: ${new Date().toLocaleDateString('nl-NL', { 
        year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' 
      })}`, margin, y);
      y += 10;
      
      // === STRATEGY OVERVIEW ===
      addTitle('Strategie Overzicht', 14);
      addKeyValue('Opening Max Prijs', '≤ 56¢');
      addKeyValue('Hedge Max Prijs', '≤ 75¢');
      addKeyValue('Force Timeout', '25 seconden');
      addKeyValue('Accumulate Max Prijs', '≤ 52¢');
      addKeyValue('Max Shares per Side', '200');
      y += 5;
      
      // === STRATEGY FLOW ===
      addTitle('Strategie Flow', 14);
      addSubtitle('1. Opening Trade');
      addParagraph('Koop de goedkoopste kant (UP of DOWN) als prijs ≤ 56¢. Plaats direct een anticipatory hedge order.');
      
      addSubtitle('2. Hedge Trade');
      addParagraph('Koop de andere kant als UP + DOWN < 98¢ en prijs ≤ 75¢. Voeg cushion ticks toe voor fill garantie.');
      
      addSubtitle('3. Force Hedge (25s timeout)');
      addParagraph('Als na 25s nog steeds one-sided, forceer hedge tot max 75¢.');
      
      addSubtitle('4. Accumulate');
      addParagraph('Als gehedged en UP + DOWN < 97¢, koop meer van goedkoopste kant (max 52¢, max 200 shares per kant).');
      y += 5;
      
      // === RISKS ===
      addTitle('Risico\'s', 14);
      addBullet('One-sided positie: Als hedge niet lukt binnen timeout en prijs > 75¢, blijft positie ongedekt');
      addBullet('Markt sluit snel: Bij hele korte markten kan de prijs te snel bewegen voor een goede hedge');
      addBullet('Order queue vol: Max 3 pending orders, daarna wacht de bot');
      y += 5;
      
      // === CODE SECTIONS ===
      addTitle('Code Implementatie', 14);
      
      addCodeBlock(STRATEGY_CONFIG, 'STRATEGY Configuration');
      addCodeBlock(OPENING_LOGIC, 'evaluateOpening()');
      addCodeBlock(HEDGE_LOGIC, 'evaluateHedge()');
      addCodeBlock(FORCE_HEDGE_LOGIC, 'evaluateForceHedge()');
      addCodeBlock(ACCUMULATE_LOGIC, 'evaluateAccumulate()');
      
      // === PROFIT CALCULATION ===
      addTitle('Winst Berekening', 14);
      addParagraph('Scenario 1: UP wint (prijs gaat boven strike) - UP shares worden $1 waard, DOWN shares $0.');
      addParagraph('Scenario 2: DOWN wint (prijs blijft onder strike) - DOWN shares worden $1 waard, UP shares $0.');
      y += 3;
      addSubtitle('Gehedgede Positie Voorbeeld:');
      addBullet('10 UP shares @ 50¢ = $5.00');
      addBullet('10 DOWN shares @ 45¢ = $4.50');
      addBullet('Total invested: $9.50');
      addBullet('Als UP wint: 10 × $1 = $10 → Winst: $0.50 (5.3%)');
      addBullet('Als DOWN wint: 10 × $1 = $10 → Winst: $0.50 (5.3%)');
      addParagraph('GEGARANDEERD 5.3% winst bij combined < $1!');
      
      // Footer on last page
      const totalPages = pdf.getNumberOfPages();
      for (let i = 1; i <= totalPages; i++) {
        pdf.setPage(i);
        pdf.setFontSize(8);
        pdf.setFont('helvetica', 'normal');
        pdf.setTextColor(150, 150, 150);
        pdf.text(`Pagina ${i} van ${totalPages}`, pageWidth / 2, pageHeight - 8, { align: 'center' });
        pdf.text('Live Bot Strategy Documentation', margin, pageHeight - 8);
      }
      
      pdf.save('live-bot-strategy.pdf');
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
      <div className="max-w-4xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Button variant="ghost" size="icon" onClick={() => navigate(-1)}>
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <div>
              <h1 className="text-2xl font-bold">Live Bot Strategie</h1>
              <p className="text-muted-foreground">Volledige documentatie en code</p>
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

        {/* Strategy Overview */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <Card className="bg-blue-500/10 border-blue-500/20">
            <CardContent className="pt-4">
              <div className="flex items-center gap-2 mb-2">
                <TrendingUp className="h-5 w-5 text-blue-500" />
                <span className="font-semibold">Opening</span>
              </div>
              <p className="text-2xl font-bold">≤ 56¢</p>
              <p className="text-sm text-muted-foreground">Max instapprijs</p>
            </CardContent>
          </Card>

          <Card className="bg-green-500/10 border-green-500/20">
            <CardContent className="pt-4">
              <div className="flex items-center gap-2 mb-2">
                <Shield className="h-5 w-5 text-green-500" />
                <span className="font-semibold">Hedge</span>
              </div>
              <p className="text-2xl font-bold">≤ 75¢</p>
              <p className="text-sm text-muted-foreground">Max hedge prijs</p>
            </CardContent>
          </Card>

          <Card className="bg-purple-500/10 border-purple-500/20">
            <CardContent className="pt-4">
              <div className="flex items-center gap-2 mb-2">
                <Clock className="h-5 w-5 text-purple-500" />
                <span className="font-semibold">Force Timeout</span>
              </div>
              <p className="text-2xl font-bold">25s</p>
              <p className="text-sm text-muted-foreground">Na opening</p>
            </CardContent>
          </Card>

          <Card className="bg-orange-500/10 border-orange-500/20">
            <CardContent className="pt-4">
              <div className="flex items-center gap-2 mb-2">
                <Layers className="h-5 w-5 text-orange-500" />
                <span className="font-semibold">Accumulate</span>
              </div>
              <p className="text-2xl font-bold">≤ 52¢</p>
              <p className="text-sm text-muted-foreground">Max per side</p>
            </CardContent>
          </Card>
        </div>

        {/* Strategy Flow */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <TrendingUp className="h-5 w-5" />
              Strategie Flow
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-start gap-4">
              <div className="w-8 h-8 rounded-full bg-blue-500 flex items-center justify-center text-white font-bold shrink-0">1</div>
              <div>
                <h3 className="font-semibold">Opening Trade</h3>
                <p className="text-muted-foreground">Koop de goedkoopste kant (UP of DOWN) als prijs ≤ 56¢</p>
              </div>
            </div>
            <div className="flex items-start gap-4">
              <div className="w-8 h-8 rounded-full bg-green-500 flex items-center justify-center text-white font-bold shrink-0">2</div>
              <div>
                <h3 className="font-semibold">Hedge Trade</h3>
                <p className="text-muted-foreground">Koop de andere kant als UP + DOWN {'<'} 98¢ en prijs ≤ 75¢</p>
              </div>
            </div>
            <div className="flex items-start gap-4">
              <div className="w-8 h-8 rounded-full bg-purple-500 flex items-center justify-center text-white font-bold shrink-0">3</div>
              <div>
                <h3 className="font-semibold">Force Hedge (25s timeout)</h3>
                <p className="text-muted-foreground">Als na 25s nog steeds one-sided, forceer hedge tot max 75¢</p>
              </div>
            </div>
            <div className="flex items-start gap-4">
              <div className="w-8 h-8 rounded-full bg-orange-500 flex items-center justify-center text-white font-bold shrink-0">4</div>
              <div>
                <h3 className="font-semibold">Accumulate</h3>
                <p className="text-muted-foreground">Als gehedged en UP + DOWN {'<'} 97¢, koop meer van goedkoopste kant (max 52¢, max 200 shares per kant)</p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Risks */}
        <Card className="border-yellow-500/30 bg-yellow-500/5">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-yellow-600">
              <AlertTriangle className="h-5 w-5" />
              Risico's
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2 text-sm">
              <li className="flex items-start gap-2">
                <span className="text-yellow-500">•</span>
                <span><strong>One-sided positie:</strong> Als hedge niet lukt binnen timeout en prijs {'>'} 75¢, blijft positie ongedekt</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-yellow-500">•</span>
                <span><strong>Markt sluit snel:</strong> Bij hele korte markten kan de prijs te snel bewegen voor een goede hedge</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-yellow-500">•</span>
                <span><strong>Order queue vol:</strong> Max 3 pending orders, daarna wacht de bot</span>
              </li>
            </ul>
          </CardContent>
        </Card>

        {/* Code Sections */}
        <Card>
          <CardHeader>
            <CardTitle>Configuratie</CardTitle>
          </CardHeader>
          <CardContent>
            <CodeBlock code={STRATEGY_CONFIG} section="config" title="STRATEGY object" />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Opening Logic</CardTitle>
          </CardHeader>
          <CardContent>
            <CodeBlock code={OPENING_LOGIC} section="opening" title="evaluateOpening()" />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Hedge Logic</CardTitle>
          </CardHeader>
          <CardContent>
            <CodeBlock code={HEDGE_LOGIC} section="hedge" title="evaluateHedge()" />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Force Hedge Logic</CardTitle>
          </CardHeader>
          <CardContent>
            <CodeBlock code={FORCE_HEDGE_LOGIC} section="forceHedge" title="evaluateForceHedge()" />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Accumulate Logic</CardTitle>
          </CardHeader>
          <CardContent>
            <CodeBlock code={ACCUMULATE_LOGIC} section="accumulate" title="evaluateAccumulate()" />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Winst Berekening</CardTitle>
          </CardHeader>
          <CardContent>
            <CodeBlock code={PROFIT_LOGIC} section="profit" title="Hoe winst werkt" />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
