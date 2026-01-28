import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { FileText, Loader2, Download } from 'lucide-react';
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

// ============================================================
// FULL V35 CONFIG CODE (from local-runner/src/v35/config.ts)
// ============================================================
const V35_CONFIG_CODE = `// ============================================================
// V35 CONFIGURATION - GABAGOOL STRATEGY
// ============================================================
// Passive Dual-Outcome Market Maker for Polymarket 15-min options
// 
// STRATEGY: Place limit BUY orders on a grid for both UP and DOWN sides.
// When retail traders hit our orders, we accumulate both sides.
// At settlement: one side pays $1.00, other pays $0.00.
// If combined cost < $1.00 -> GUARANTEED profit.
//
// SOURCE: Reverse-engineered from gabagool22's proven strategy
// - 34,569 trades analyzed
// - $165,450 volume
// - 1.88% ROI, 93% win rate
// ============================================================

export type V35Mode = 'test' | 'moderate' | 'production';

export interface V35Config {
  mode: V35Mode;
  
  // GRID PARAMETERS
  gridMin: number;          // Lowest bid price (e.g., 0.15)
  gridMax: number;          // Highest bid price (e.g., 0.85)
  gridStep: number;         // Step between price levels (e.g., 0.05)
  
  // SIZING PARAMETERS
  sharesPerLevel: number;   // Shares per price level (min 3 for Polymarket)
  
  // RISK LIMITS
  maxUnpairedShares: number;    // Max directional exposure (50)
  maxUnpairedImbalance: number; // Alias for maxUnpairedShares
  maxImbalanceRatio: number;    // Max ratio UP:DOWN or DOWN:UP (2.5)
  maxLossPerMarket: number;     // Max $ loss per market before stopping
  maxConcurrentMarkets: number; // Max markets to trade simultaneously
  maxNotionalPerMarket: number; // Max $ notional per market
  maxTotalExposure: number;     // Max $ total exposure across all markets
  skewThreshold: number;        // Skew threshold for warning logs
  capitalPerMarket: number;     // $ allocated per market
  
  // TIMING PARAMETERS
  startDelayMs: number;         // Delay after market open
  stopBeforeExpirySec: number;  // Stop quoting X seconds before expiry
  refreshIntervalMs: number;    // Milliseconds between order updates
  
  // FEATURES - CRITICAL: KEEP DISABLED PER STRATEGY DOC
  enableMomentumFilter: boolean;  // MUST BE FALSE
  enableFillSync: boolean;        // MUST BE FALSE
  
  enabledAssets: string[];        // Which assets to trade
  clobUrl: string;
  chainId: number;
  dryRun: boolean;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

// =========================================================================
// TEST MODE - Current Active Configuration (V35.0.4)
// =========================================================================
export const TEST_CONFIG: V35Config = {
  mode: 'test',
  
  // Grid - 41 levels per side (2¢ step)
  gridMin: 0.10,
  gridMax: 0.90,
  gridStep: 0.02,           // 2¢ step = 41 levels per side
  sharesPerLevel: 5,        // Polymarket minimum is 5 shares per order
  
  // Risk limits
  maxUnpairedShares: 50,        // Max directional exposure
  maxUnpairedImbalance: 50,     // Alias
  maxImbalanceRatio: 2.5,       // Max ratio
  maxLossPerMarket: 25,         // $25 max loss per market
  maxConcurrentMarkets: 2,      // 2 markets max
  maxMarkets: 2,
  maxNotionalPerMarket: 150,    // $150 max per market
  maxTotalExposure: 300,        // $300 total
  skewThreshold: 20,            // 20 shares before warning
  capitalPerMarket: 100,        // $100 per market
  
  // Timing - V35.0.4: 500ms refresh for instant imbalance control
  startDelayMs: 5000,       // Wait 5s after market open
  stopBeforeExpirySec: 30,  // Stop 30s before expiry
  refreshIntervalMs: 500,   // 500ms for near-instant response
  
  // CRITICAL: DISABLED per strategy document
  enableMomentumFilter: false,
  enableFillSync: false,
  
  enabledAssets: ['BTC'],
  clobUrl: 'https://clob.polymarket.com',
  chainId: 137,
  dryRun: false,
  logLevel: 'info',
};`;

// ============================================================
// FULL QUOTING ENGINE CODE (from local-runner/src/v35/quoting-engine.ts)
// ============================================================
const V35_QUOTING_ENGINE_CODE = `// ============================================================
// V35 QUOTING ENGINE - GABAGOOL STRATEGY
// ============================================================
// Generates passive limit BUY orders on a grid for market making.
// Places orders on BOTH UP and DOWN sides simultaneously.
//
// KEY PRINCIPLES (from gabagool strategy document):
// 1. NEVER filter based on momentum - reduces fills
// 2. ALWAYS quote both sides - temporary imbalance is OK
// 3. Trust the mathematics - combined cost < $1 = profit
// ============================================================

export class QuotingEngine {
  private gridPrices: number[] = [];
  
  constructor() {
    this.updateGrid();
  }
  
  updateGrid(): void {
    const config = getV35Config();
    this.gridPrices = [];
    
    let price = config.gridMin;
    while (price <= config.gridMax + 0.001) {
      this.gridPrices.push(Math.round(price * 100) / 100);
      price += config.gridStep;
    }
    
    console.log(\`[QuotingEngine] Grid: \${this.gridPrices.length} levels\`);
  }
  
  /**
   * Generate quotes for one side of a market
   * SMART BALANCE RULE: "EXPENSIVE SIDE LEADS, CHEAP SIDE FOLLOWS"
   * 
   * Problem: If we accumulate more shares on the CHEAP side, and the EXPENSIVE
   * side wins (which is more likely), those cheap shares become worthless.
   * 
   * Solution: Only allow the EXPENSIVE side to have unpaired shares.
   * The cheap side must never exceed the expensive side's quantity.
   */
  generateQuotesWithReason(side: V35Side, market: V35Market): QuoteDecision {
    const config = getV35Config();
    const quotes: V35Quote[] = [];
    
    const {
      expensiveSide,
      cheapSide,
      expensiveQty,
      cheapQty,
    } = getV35SidePricing(market);
    
    const balanceBuffer = 5;      // Buffer to prevent flip-flopping
    const maxGap = 10;            // Max shares expensive side can lead by
    
    // Rule 1: Block cheap side if it's leading
    if (side === cheapSide && cheapQty >= expensiveQty + balanceBuffer) {
      return {
        quotes: [],
        blocked: true,
        blockReason: \`Cheap side (\${side}) cannot lead expensive side\`,
      };
    }
    
    // Rule 2: Block expensive side if gap is too large (reversal protection)
    const currentGap = expensiveQty - cheapQty;
    if (side === expensiveSide && currentGap >= maxGap) {
      return {
        quotes: [],
        blocked: true,
        blockReason: \`Gap too large: \${currentGap.toFixed(0)} shares\`,
      };
    }
    
    // Generate quotes - prioritize 35c-55c range (sweet spot)
    const sortedPrices = this.getPrioritizedPrices();
    
    for (const price of sortedPrices) {
      const bestAsk = side === 'UP' ? market.upBestAsk : market.downBestAsk;
      if (bestAsk > 0 && price >= bestAsk - 0.005) continue;
      
      const minSharesForNotional = Math.ceil(1.0 / price);
      const shares = Math.max(config.sharesPerLevel, minSharesForNotional);
      
      quotes.push({ price, size: shares });
    }
    
    return { quotes, blocked: false, blockReason: null };
  }
  
  /**
   * Calculate locked profit (guaranteed at settlement)
   * This is the core metric - paired shares × (1 - combined cost)
   */
  calculateLockedProfit(market: V35Market): { 
    pairedShares: number; 
    combinedCost: number; 
    lockedProfit: number;
    profitPct: number;
  } {
    const pairedShares = Math.min(market.upQty, market.downQty);
    
    if (pairedShares === 0) {
      return { pairedShares: 0, combinedCost: 0, lockedProfit: 0, profitPct: 0 };
    }
    
    const avgUpCost = market.upCost / market.upQty;
    const avgDownCost = market.downCost / market.downQty;
    const combinedCost = avgUpCost + avgDownCost;
    
    // Locked profit = paired shares × (1 - combined cost)
    const lockedProfit = pairedShares * (1 - combinedCost);
    const profitPct = (1 - combinedCost) * 100;
    
    return { pairedShares, combinedCost, lockedProfit, profitPct };
  }
  
  /**
   * Get grid prices sorted by priority (sweet spot 35c-55c first)
   */
  private getPrioritizedPrices(): number[] {
    const sweetSpotMin = 0.35;
    const sweetSpotMax = 0.55;
    
    const sweetSpot: number[] = [];
    const outer: number[] = [];
    
    for (const price of this.gridPrices) {
      if (price >= sweetSpotMin && price <= sweetSpotMax) {
        sweetSpot.push(price);
      } else {
        outer.push(price);
      }
    }
    
    // Sort sweet spot by distance from center (0.45 is optimal)
    sweetSpot.sort((a, b) => Math.abs(a - 0.45) - Math.abs(b - 0.45));
    
    return [...sweetSpot, ...outer];
  }
}`;

// ============================================================
// ORDER MANAGER CODE (from local-runner/src/v35/order-manager.ts)
// ============================================================
const V35_ORDER_MANAGER_CODE = `// ============================================================
// V35 ORDER MANAGER - ORDER LIFECYCLE MANAGEMENT
// ============================================================
// Handles order placement, cancellation, and synchronization.
// V35.0.5 includes robust cancellation with batching and throttling.
// ============================================================

const CANCEL_SIDE_COOLDOWN_MS = 1500;  // Prevent cancel storms
const MAX_CONCURRENT_ORDERS = 4;       // Max orders in parallel

export class OrderManager {
  private currentOrders = new Map<string, V35Order>();
  private lastCancelAttempt: { [side: string]: number } = {};
  
  /**
   * Sync orders with desired quotes
   * Cancels stale orders, places new ones
   */
  async syncOrders(
    market: V35Market,
    side: V35Side,
    desiredQuotes: V35Quote[]
  ): Promise<void> {
    const existingOrders = this.getOrdersForSide(market.slug, side);
    const desiredPriceSet = new Set(desiredQuotes.map(q => q.price));
    
    // Cancel orders not in desired set
    const toCancel = existingOrders.filter(o => !desiredPriceSet.has(o.price));
    
    if (toCancel.length > 0) {
      console.log(\`[OrderManager] Cancelling \${toCancel.length} stale \${side} orders\`);
      await this.cancelOrdersBatched(toCancel);
    }
    
    // Place missing orders
    const existingPrices = new Set(existingOrders.map(o => o.price));
    const toPlace = desiredQuotes.filter(q => !existingPrices.has(q.price));
    
    if (toPlace.length > 0) {
      console.log(\`[OrderManager] Placing \${toPlace.length} new \${side} orders\`);
      await this.placeOrdersBatched(market, side, toPlace);
    }
  }
  
  /**
   * Cancel all orders for a side (with throttling to prevent API overload)
   * V35.0.5 fix: Batched cancellation with delays to prevent rate limiting
   */
  async cancelSideOrders(marketSlug: string, side: V35Side): Promise<void> {
    const now = Date.now();
    const lastAttempt = this.lastCancelAttempt[side] || 0;
    
    // Throttle: prevent cancel storms when called repeatedly
    if (now - lastAttempt < CANCEL_SIDE_COOLDOWN_MS) {
      console.log(\`[OrderManager] ⏳ Cancel \${side} throttled, cooldown active\`);
      return;
    }
    
    this.lastCancelAttempt[side] = now;
    
    const orders = this.getOrdersForSide(marketSlug, side);
    if (orders.length === 0) return;
    
    console.log(\`[OrderManager] 🛑 Cancelling \${orders.length} \${side} orders\`);
    
    // Process in batches with delay between batches
    for (let i = 0; i < orders.length; i += MAX_CONCURRENT_ORDERS) {
      const batch = orders.slice(i, i + MAX_CONCURRENT_ORDERS);
      await Promise.all(batch.map(o => this.cancelOrder(o)));
      
      if (i + MAX_CONCURRENT_ORDERS < orders.length) {
        await sleep(150); // 150ms delay between batches
      }
    }
    
    // Clear state after cancellation attempt
    this.currentOrders.clear();
  }
  
  private async cancelOrdersBatched(orders: V35Order[]): Promise<void> {
    for (let i = 0; i < orders.length; i += MAX_CONCURRENT_ORDERS) {
      const batch = orders.slice(i, i + MAX_CONCURRENT_ORDERS);
      await Promise.all(batch.map(o => this.cancelOrder(o)));
      
      if (i + MAX_CONCURRENT_ORDERS < orders.length) {
        await sleep(150);
      }
    }
  }
}`;

export function V35StrategyPDFExport() {
  const [isExporting, setIsExporting] = useState(false);

  const generatePDF = async () => {
    setIsExporting(true);
    try {
      // Fetch current bot status with real config
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
      const mode = hb.metadata?.mode || hb.mode || 'test';
      const lockedProfit = hb.metadata?.locked_profit ?? hb.total_locked_profit ?? 0;

      // Create PDF
      const doc = new jsPDF();
      const pageWidth = doc.internal.pageSize.getWidth();
      const margin = 15;
      let y = 20;

      // Helper functions
      const addTitle = (text: string) => {
        doc.setFontSize(18);
        doc.setFont('helvetica', 'bold');
        doc.text(text, margin, y);
        y += 10;
      };

      const addSection = (text: string) => {
        if (y > 270) {
          doc.addPage();
          y = 20;
        }
        doc.setFontSize(12);
        doc.setFont('helvetica', 'bold');
        doc.text(text, margin, y);
        y += 7;
      };

      const addLine = (label: string, value: string) => {
        if (y > 280) {
          doc.addPage();
          y = 20;
        }
        doc.setFontSize(9);
        doc.setFont('helvetica', 'normal');
        doc.text(`${label}: ${value}`, margin + 3, y);
        y += 5;
      };

      const addCodeBlock = (code: string, fontSize = 7) => {
        doc.setFontSize(fontSize);
        doc.setFont('courier', 'normal');
        const lines = code.split('\n');
        for (const line of lines) {
          if (y > 280) {
            doc.addPage();
            y = 20;
          }
          doc.text(line.slice(0, 110), margin + 2, y);
          y += 3.5;
        }
      };

      // =========================================================================
      // HEADER
      // =========================================================================
      addTitle('V35 GABAGOOL STRATEGY - FULL EXPORT');
      doc.setFontSize(9);
      doc.setFont('helvetica', 'normal');
      doc.text(`Generated: ${now.toISOString()}`, margin, y);
      y += 4;
      doc.text(`Version: ${hb.version}`, margin, y);
      y += 10;

      // =========================================================================
      // SECTION 1: LIVE BOT STATUS
      // =========================================================================
      addSection('1. LIVE BOT STATUS');
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
      y += 8;

      // =========================================================================
      // SECTION 2: ACTIVE CONFIGURATION VALUES
      // =========================================================================
      addSection('2. ACTIVE CONFIGURATION (V35.0.4 TEST MODE)');
      y += 2;
      addLine('Grid Range', '$0.10 - $0.90');
      addLine('Grid Step', '$0.02 (41 levels per side)');
      addLine('Shares per Level', '5');
      addLine('Max Unpaired Shares', '50');
      addLine('Max Imbalance Ratio', '2.5:1');
      addLine('Max Loss per Market', '$25');
      addLine('Max Concurrent Markets', '2');
      addLine('Capital per Market', '$100');
      addLine('Start Delay', '5000ms');
      addLine('Stop Before Expiry', '30 seconds');
      addLine('Refresh Interval', '500ms (V35.0.4)');
      addLine('Momentum Filter', '❌ DISABLED (per gabagool)');
      addLine('Fill Sync', '❌ DISABLED (per gabagool)');
      addLine('Enabled Assets', 'BTC');
      addLine('CLOB URL', 'https://clob.polymarket.com');
      addLine('Chain ID', '137 (Polygon)');
      y += 8;

      // =========================================================================
      // SECTION 3: STRATEGY RULES
      // =========================================================================
      addSection('3. CRITICAL STRATEGY RULES (GABAGOOL)');
      y += 2;
      doc.setFontSize(9);
      doc.setFont('helvetica', 'normal');
      const rules = [
        '1. NEVER enable momentum filter - reduces fills, creates imbalance',
        '2. ALWAYS quote both sides simultaneously - imbalance is temporary',
        '3. Trust the mathematics - $1 settlement is guaranteed',
        '4. EXPENSIVE side leads, CHEAP side follows (smart balance)',
        '5. Combined cost < $1.00 = GUARANTEED profit at settlement',
        '6. Grid prioritizes 35c-55c sweet spot (lowest combined cost)',
        '7. Batch cancellations with 150ms delays to prevent API rate limits',
        '8. 500ms refresh for near-instant imbalance detection (V35.0.4)',
      ];
      for (const rule of rules) {
        if (y > 280) {
          doc.addPage();
          y = 20;
        }
        doc.text(rule, margin + 3, y);
        y += 5;
      }
      y += 8;

      // =========================================================================
      // SECTION 4: FULL CONFIG.TS CODE
      // =========================================================================
      doc.addPage();
      y = 20;
      addSection('4. FULL CONFIG CODE (config.ts)');
      y += 3;
      addCodeBlock(V35_CONFIG_CODE);

      // =========================================================================
      // SECTION 5: FULL QUOTING ENGINE CODE
      // =========================================================================
      doc.addPage();
      y = 20;
      addSection('5. FULL QUOTING ENGINE CODE (quoting-engine.ts)');
      y += 3;
      addCodeBlock(V35_QUOTING_ENGINE_CODE);

      // =========================================================================
      // SECTION 6: ORDER MANAGER CODE
      // =========================================================================
      doc.addPage();
      y = 20;
      addSection('6. ORDER MANAGER CODE (order-manager.ts)');
      y += 3;
      addCodeBlock(V35_ORDER_MANAGER_CODE);

      // =========================================================================
      // SECTION 7: EXPECTED PERFORMANCE
      // =========================================================================
      doc.addPage();
      y = 20;
      addSection('7. EXPECTED PERFORMANCE (based on gabagool22 data)');
      y += 2;
      addLine('Source', 'gabagool22 - 34,569 trades analyzed');
      addLine('Volume', '$165,450');
      addLine('Combined Cost Target', '< $0.98');
      addLine('Win Rate', '~93% of markets profitable');
      addLine('ROI per Market', '~1.9%');
      addLine('Strategy', 'Passive Dual-Outcome Market Making');
      y += 8;

      addSection('8. LOCKED PROFIT FORMULA');
      y += 2;
      doc.setFontSize(9);
      doc.text('paired_shares = min(up_qty, down_qty)', margin + 3, y); y += 5;
      doc.text('combined_cost = avg_up_cost + avg_down_cost', margin + 3, y); y += 5;
      doc.text('locked_profit = paired_shares × (1 - combined_cost)', margin + 3, y); y += 5;
      doc.text('', margin + 3, y); y += 5;
      doc.text('Example: 100 paired shares @ combined cost $0.96', margin + 3, y); y += 5;
      doc.text('         locked_profit = 100 × (1 - 0.96) = $4.00', margin + 3, y);

      // Save PDF
      const date = now.toISOString().split('T')[0];
      doc.save(`v35-strategy-full-export-${date}.pdf`);
      
      toast.success('Full strategy PDF exported!');
    } catch (error: unknown) {
      console.error('PDF export failed:', error);
      const message = error instanceof Error ? error.message : 'Unknown error';
      toast.error(`Export failed: ${message}`);
    } finally {
      setIsExporting(false);
    }
  };

  const downloadSourceCode = () => {
    // Download all strategy code as a single .ts file
    const fullCode = `// ============================================================
// V35 GABAGOOL STRATEGY - COMPLETE SOURCE CODE EXPORT
// Generated: ${new Date().toISOString()}
// ============================================================

// ============================================================
// PART 1: CONFIG.TS
// ============================================================
${V35_CONFIG_CODE}

// ============================================================
// PART 2: QUOTING ENGINE
// ============================================================
${V35_QUOTING_ENGINE_CODE}

// ============================================================
// PART 3: ORDER MANAGER
// ============================================================
${V35_ORDER_MANAGER_CODE}
`;

    const blob = new Blob([fullCode], { type: 'text/typescript' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `v35-strategy-source-${new Date().toISOString().split('T')[0]}.ts`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast.success('Source code downloaded!');
  };

  return (
    <div className="flex gap-2">
      <Button variant="outline" size="sm" onClick={generatePDF} disabled={isExporting}>
        {isExporting ? (
          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
        ) : (
          <FileText className="h-4 w-4 mr-2" />
        )}
        Strategy PDF
      </Button>
      <Button variant="outline" size="sm" onClick={downloadSourceCode}>
        <Download className="h-4 w-4 mr-2" />
        Source Code
      </Button>
    </div>
  );
}
