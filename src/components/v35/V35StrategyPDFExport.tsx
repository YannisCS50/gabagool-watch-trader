import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { FileText, Loader2 } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import jsPDF from 'jspdf';

interface HeartbeatData {
  runner_id: string;
  runner_type: string;
  last_heartbeat: string;
  status: string;
  markets_count: number;
  positions_count: number;
  trades_count: number;
  balance: number;
  version: string;
  mode: string | null;
  dry_run: boolean;
  total_locked_profit: number;
  total_unpaired: number;
  metadata: {
    mode?: string;
    dry_run?: boolean;
    locked_profit?: number;
  } | null;
}

const GABAGOOL_CONFIG = `// ============================================================
// GABAGOOL STRATEGY CONFIGURATION
// ============================================================
// Reverse-engineered from gabagool22's proven strategy:
// - 34,569 trades analyzed
// - $165,450 volume
// - 1.88% ROI, 93% win rate
// ============================================================
{
  mode: 'test',
  
  // Grid - per gabagool document specs
  gridMin: 0.15,
  gridMax: 0.85,
  gridStep: 0.05,           // 15 levels per side
  sharesPerLevel: 5,        // Polymarket minimum is 5 shares per order
  
  // Risk limits - per gabagool document
  maxUnpairedShares: 30,    // Max directional exposure
  maxImbalanceRatio: 2.0,   // Max ratio UP:DOWN or DOWN:UP
  maxLossPerMarket: 10,     // Max $ loss per market before stopping
  maxConcurrentMarkets: 2,  // Max markets to trade simultaneously
  capitalPerMarket: 50,     // $ allocated per market
  
  // Timing - per gabagool document
  startDelayMs: 5000,       // Wait 5s after market open
  stopBeforeExpirySec: 120, // Stop 2 min before expiry
  refreshIntervalMs: 5000,
  
  // CRITICAL: DISABLED per gabagool strategy document
  // "RULE 1: Never enable momentum filtering"
  // "RULE 2: Always quote both sides simultaneously"
  enableMomentumFilter: false,
  enableFillSync: false,
  
  // Assets - start with BTC only for testing
  enabledAssets: ['BTC'],
  
  dryRun: false,
}`;

const STRATEGY_CODE = `// ============================================================
// V35 GABAGOOL STRATEGY - Passive Dual-Outcome Market Maker
// ============================================================
// Reverse-engineered from gabagool22 (34,569 trades, 93% win rate)
//
// CORE PRINCIPLE:
// Place limit BUY orders on a grid for BOTH UP and DOWN sides.
// When retail traders hit our orders, we accumulate both sides.
// At settlement: one side pays $1.00, other pays $0.00.
// If combined cost < $1.00 -> GUARANTEED profit.
//
// CRITICAL RULES (from gabagool document):
// 1. NEVER enable momentum filter - it reduces fills
// 2. ALWAYS quote both sides - imbalance is temporary
// 3. Trust the mathematics - $1 settlement is guaranteed
// ============================================================

// QUOTING ENGINE - Simple Grid Generation
// ============================================================
class QuotingEngine {
  generateQuotes(side: 'UP' | 'DOWN', market: Market): Quote[] {
    const config = getConfig();
    const quotes: Quote[] = [];
    
    // CHECK 1: Absolute unpaired limit (only hard stop)
    const skew = market.upQty - market.downQty;
    const unpaired = Math.abs(skew);
    
    if (unpaired > config.maxUnpairedShares) {
      // Only block the OVERWEIGHT side, keep quoting underweight
      const overweightSide = skew > 0 ? 'UP' : 'DOWN';
      if (side === overweightSide) {
        return []; // Blocked - would increase imbalance
      }
      // Allow underweight side - this helps rebalance!
    }
    
    // CHECK 2: Ratio limit (soft limit, 2.0)
    if (market.upQty >= 10 && market.downQty >= 10) {
      const ratio = market.upQty > market.downQty 
        ? market.upQty / market.downQty 
        : market.downQty / market.upQty;
      
      if (ratio > config.maxImbalanceRatio) {
        const overweightSide = market.upQty > market.downQty ? 'UP' : 'DOWN';
        if (side === overweightSide) {
          return []; // Blocked by ratio limit
        }
      }
    }
    
    // Generate grid quotes - uniform sizing per gabagool
    for (let price = config.gridMin; price <= config.gridMax; price += config.gridStep) {
      const minSharesForNotional = Math.ceil(1.0 / price);
      const shares = Math.max(config.sharesPerLevel, minSharesForNotional);
      
      quotes.push({
        side: 'BUY',
        price: Math.round(price * 100) / 100,
        size: shares,
      });
    }
    
    return quotes;
  }
}

// LOCKED PROFIT CALCULATION - Core Gabagool Metric
// ============================================================
function calculateLockedProfit(market: Market): LockedProfit {
  const pairedShares = Math.min(market.upQty, market.downQty);
  
  if (pairedShares === 0) {
    return { pairedShares: 0, combinedCost: 0, lockedProfit: 0, profitPct: 0 };
  }
  
  // Calculate average costs
  const avgUpCost = market.upCost / market.upQty;
  const avgDownCost = market.downCost / market.downQty;
  const combinedCost = avgUpCost + avgDownCost;
  
  // Locked profit = paired shares × (1 - combined cost)
  const lockedProfit = pairedShares * (1 - combinedCost);
  const profitPct = (1 - combinedCost) * 100;
  
  return { pairedShares, combinedCost, lockedProfit, profitPct };
}

// MAIN LOOP - Per Gabagool Strategy
// ============================================================
async function processMarket(market: Market): Promise<void> {
  const config = getConfig();
  const secondsToExpiry = (market.expiry - Date.now()) / 1000;
  
  // Stop quoting if too close to expiry
  if (secondsToExpiry < config.stopBeforeExpirySec) {
    await cancelAllOrders(market);
    return;
  }
  
  // Generate quotes for BOTH sides - per gabagool rule
  // NO momentum filter - we trust the grid!
  const upQuotes = quotingEngine.generateQuotes('UP', market);
  const downQuotes = quotingEngine.generateQuotes('DOWN', market);
  
  await syncOrders(market, upQuotes, downQuotes);
  
  // Log locked profit for monitoring
  const profit = calculateLockedProfit(market);
  console.log(\`Market: Paired=\${profit.pairedShares} Cost=\${profit.combinedCost.toFixed(4)} Locked=$\${profit.lockedProfit.toFixed(2)}\`);
}`;

export function V35StrategyPDFExport() {
  const [isExporting, setIsExporting] = useState(false);

  const generatePDF = async () => {
    setIsExporting(true);
    try {
      // Fetch current bot status
      const { data: heartbeat, error } = await supabase
        .from('runner_heartbeats')
        .select('*')
        .eq('runner_type', 'v35')
        .order('last_heartbeat', { ascending: false })
        .limit(1)
        .single();

      if (error) throw new Error(`Failed to fetch bot status: ${error.message}`);

      const hb = heartbeat as HeartbeatData;
      const now = new Date();
      const lastHeartbeat = new Date(hb.last_heartbeat);
      const isOnline = (now.getTime() - lastHeartbeat.getTime()) < 30000;
      const mode = hb.metadata?.mode || hb.mode || 'safe';
      const lockedProfit = hb.metadata?.locked_profit ?? hb.total_locked_profit ?? 0;

      // Create PDF
      const doc = new jsPDF();
      const pageWidth = doc.internal.pageSize.getWidth();
      const margin = 20;
      const contentWidth = pageWidth - margin * 2;
      let y = 20;

      // Helper functions
      const addTitle = (text: string) => {
        doc.setFontSize(20);
        doc.setFont('helvetica', 'bold');
        doc.text(text, margin, y);
        y += 12;
      };

      const addSection = (text: string) => {
        if (y > 270) {
          doc.addPage();
          y = 20;
        }
        doc.setFontSize(14);
        doc.setFont('helvetica', 'bold');
        doc.text(text, margin, y);
        y += 8;
      };

      const addLine = (label: string, value: string) => {
        if (y > 280) {
          doc.addPage();
          y = 20;
        }
        doc.setFontSize(10);
        doc.setFont('helvetica', 'normal');
        doc.text(`${label}: ${value}`, margin + 5, y);
        y += 6;
      };

      const addCodeBlock = (code: string) => {
        doc.setFontSize(8);
        doc.setFont('courier', 'normal');
        const lines = code.split('\n');
        for (const line of lines) {
          if (y > 280) {
            doc.addPage();
            y = 20;
          }
          doc.text(line.slice(0, 100), margin + 5, y);
          y += 4;
        }
      };

      // Header
      addTitle('V35 Strategy Report');
      doc.setFontSize(10);
      doc.setFont('helvetica', 'normal');
      doc.text(`Generated: ${now.toISOString()}`, margin, y);
      y += 15;

      // Section 1: Bot Status
      addSection('1. Current Bot Status');
      y += 2;
      addLine('Runner ID', hb.runner_id);
      addLine('Status', isOnline ? '🟢 ONLINE' : '🔴 OFFLINE');
      addLine('Version', hb.version);
      addLine('Mode', mode.toUpperCase());
      addLine('Dry Run', hb.dry_run ? 'Yes' : 'No');
      addLine('Last Heartbeat', lastHeartbeat.toISOString());
      addLine('Markets Count', String(hb.markets_count));
      addLine('Positions Count', String(hb.positions_count));
      addLine('Trades Count', String(hb.trades_count));
      addLine('Locked Profit', `$${lockedProfit.toFixed(4)}`);
      addLine('Total Unpaired', String(hb.total_unpaired));
      y += 10;

      // Section 2: Active Components (Gabagool Strategy)
      addSection('2. Active Components (Gabagool Strategy)');
      y += 2;
      addLine('QuotingEngine', '✅ ENABLED - Grid-based dual-side quoting');
      addLine('ImbalanceTracker', '✅ ENABLED - Calculates skew, paired/unpaired shares');
      addLine('Momentum Filter', '❌ DISABLED - Per gabagool rule: reduces fills');
      addLine('Fill Sync', '❌ DISABLED - Per gabagool rule: prevents natural balancing');
      addLine('Loss Limit', '✅ ENABLED - $10/market max loss');
      addLine('User WebSocket', '✅ ENABLED - Authenticated fill tracking');
      addLine('CLOB WebSocket', '✅ ENABLED - Orderbook updates');
      y += 10;

      // Section 3: Configuration
      addSection('3. Configuration Values (Gabagool Strategy)');
      y += 2;
      doc.addPage();
      y = 20;
      addCodeBlock(GABAGOOL_CONFIG);
      y += 10;

      // Section 4: Strategy Code
      doc.addPage();
      y = 20;
      addSection('4. Strategy Code (Simplified)');
      y += 5;
      addCodeBlock(STRATEGY_CODE);

      // Save PDF
      const date = now.toISOString().split('T')[0];
      doc.save(`v35-strategy-report-${date}.pdf`);
      
      toast.success('PDF exported successfully!');
    } catch (error: any) {
      console.error('PDF export failed:', error);
      toast.error(`Export failed: ${error.message}`);
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <Button variant="outline" size="sm" onClick={generatePDF} disabled={isExporting}>
      {isExporting ? (
        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
      ) : (
        <FileText className="h-4 w-4 mr-2" />
      )}
      Strategy PDF
    </Button>
  );
}
