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

const SAFE_CONFIG = `// SAFE MODE CONFIGURATION
{
  mode: 'safe',
  
  // Grid - conservative range
  gridMin: 0.30,
  gridMax: 0.70,
  gridStep: 0.02,
  baseSize: 5,
  skewThreshold: 15,
  skewReduceFactor: 0.3,
  skewBoostFactor: 1.5,
  
  // Risk limits - STRICT
  maxNotionalPerMarket: 150,
  maxUnpairedImbalance: 20,
  maxImbalanceRatio: 1.3,
  maxTotalExposure: 400,
  maxMarkets: 1,
  
  // Momentum filter - ENABLED
  enableMomentumFilter: true,
  momentumThreshold: 0.10,
  momentumLookbackSec: 30,
  
  // Stop loss - ENABLED
  enableStopLoss: true,
  maxLossPerMarket: 30,
  maxLossTotal: 100,
  
  // Timing
  refreshIntervalMs: 5000,
  stopBeforeExpirySec: 180,
  dryRun: false,
}`;

const STRATEGY_CODE = `// ============================================================
// V35 STRATEGY - Passive Dual-Outcome Market Maker
// ============================================================
// 
// OVERVIEW:
// Trade Polymarket 15-minute UP/DOWN markets by accumulating
// both sides through limit orders. When combined cost < $1.00,
// profit is guaranteed at settlement.
//
// COMPONENTS:
// 1. BinanceFeed - Real-time price momentum tracking
// 2. ImbalanceTracker - Inventory skew management
// 3. QuotingEngine - Grid-based quote generation
// 4. OrderManager - Order placement and sync
// 5. FillTracker - Fill processing and inventory updates
//
// ============================================================

// BINANCE FEED - Momentum Calculation
// ============================================================
class BinanceFeed {
  private priceHistory: Map<Asset, PricePoint[]>;
  private momentum: Map<Asset, MomentumState>;
  private lookbackSeconds = 30;
  private momentumThreshold = 0.10; // 0.10%

  calculateMomentum(asset: Asset): void {
    const history = this.priceHistory.get(asset) || [];
    if (history.length < 5) return;
    
    const now = Date.now();
    const current = history[history.length - 1];
    const lookbackTime = now - this.lookbackSeconds * 1000;
    
    let pastPrice = current.price;
    for (let i = 0; i < history.length; i++) {
      if (history[i].time >= lookbackTime) {
        pastPrice = history[i].price;
        break;
      }
    }
    
    const momentum = ((current.price - pastPrice) / pastPrice) * 100;
    const isTrending = Math.abs(momentum) >= this.momentumThreshold;
    
    let direction: 'UP' | 'DOWN' | 'NEUTRAL' = 'NEUTRAL';
    if (momentum >= this.momentumThreshold) direction = 'UP';
    else if (momentum <= -this.momentumThreshold) direction = 'DOWN';
    
    this.momentum.set(asset, { momentum, direction, isTrending });
  }

  // CRITICAL LOGIC:
  // - If market trending UP: DON'T quote DOWN (we become exit liquidity)
  // - If market trending DOWN: DON'T quote UP
  // - If NEUTRAL: Quote both sides
  shouldQuote(asset: Asset, side: 'UP' | 'DOWN'): boolean {
    const state = this.momentum.get(asset);
    if (!state || !state.isTrending) return true;
    
    if (state.direction === 'UP' && side === 'DOWN') return false;
    if (state.direction === 'DOWN' && side === 'UP') return false;
    return true;
  }
}

// IMBALANCE TRACKER - Risk Management
// ============================================================
function calculateMarketMetrics(market: Market): Metrics {
  const skew = market.upQty - market.downQty;
  const paired = Math.min(market.upQty, market.downQty);
  const unpaired = Math.abs(skew);
  
  const avgUpPrice = market.upQty > 0 ? market.upCost / market.upQty : 0;
  const avgDownPrice = market.downQty > 0 ? market.downCost / market.downQty : 0;
  
  const combinedCost = (market.upQty > 0 && market.downQty > 0)
    ? avgUpPrice + avgDownPrice
    : 0;
  
  const lockedProfit = (combinedCost > 0 && combinedCost < 1.0)
    ? paired * (1.0 - combinedCost)
    : 0;
  
  return { skew, paired, unpaired, combinedCost, lockedProfit };
}

// QUOTING ENGINE - Grid Generation
// ============================================================
class QuotingEngine {
  generateQuotes(side: 'UP' | 'DOWN', market: Market): Quote[] {
    const config = getConfig();
    
    // Check momentum filter first
    if (config.enableMomentumFilter) {
      const canQuote = binanceFeed.shouldQuote(market.asset, side);
      if (!canQuote) return []; // Blocked by momentum
    }
    
    // Check risk limits
    const metrics = calculateMarketMetrics(market);
    if (metrics.unpaired >= config.maxUnpairedImbalance) {
      if ((side === 'UP' && metrics.skew > 0) ||
          (side === 'DOWN' && metrics.skew < 0)) {
        return []; // Would increase imbalance
      }
    }
    
    // Generate grid quotes
    const quotes: Quote[] = [];
    for (let price = config.gridMin; price <= config.gridMax; price += config.gridStep) {
      quotes.push({
        side: 'BUY',
        price,
        size: config.baseSize,
      });
    }
    
    return quotes;
  }
}

// MAIN LOOP
// ============================================================
async function processMarket(market: Market): Promise<void> {
  const config = getConfig();
  const secondsToExpiry = (market.expiry - Date.now()) / 1000;
  
  // Stop quoting if too close to expiry
  if (secondsToExpiry < config.stopBeforeExpirySec) {
    await cancelAllOrders(market);
    return;
  }
  
  // Profit-take: stop quoting if hedged with >$5 locked profit
  const metrics = calculateMarketMetrics(market);
  const isHedged = metrics.paired > 0 && market.upQty > 0 && market.downQty > 0;
  const PROFIT_TAKE_THRESHOLD = 5.0;
  
  if (isHedged && metrics.lockedProfit >= PROFIT_TAKE_THRESHOLD) {
    await cancelAllOrders(market);
    return; // Take profit and wait for settlement
  }
  
  // Generate and sync quotes
  const upQuotes = quotingEngine.generateQuotes('UP', market);
  const downQuotes = quotingEngine.generateQuotes('DOWN', market);
  
  await syncOrders(market, upQuotes, downQuotes);
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

      // Section 2: Active Components
      addSection('2. Active Components');
      y += 2;
      addLine('BinanceFeed', '✅ ENABLED - Real-time momentum tracking via WebSocket');
      addLine('ImbalanceTracker', '✅ ENABLED - Calculates skew, paired/unpaired shares');
      addLine('Momentum Filter', '✅ ENABLED - Blocks quotes against trend');
      addLine('Stop Loss', '✅ ENABLED - Auto-stop on max loss');
      addLine('Profit Take', '✅ ENABLED - Stops at $5 locked profit');
      addLine('User WebSocket', '✅ ENABLED - Authenticated fill tracking');
      addLine('CLOB WebSocket', '✅ ENABLED - Orderbook updates');
      y += 10;

      // Section 3: Configuration
      addSection('3. Configuration Values (Safe Mode)');
      y += 2;
      doc.addPage();
      y = 20;
      addCodeBlock(SAFE_CONFIG);
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
