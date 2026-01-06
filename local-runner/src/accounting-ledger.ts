/**
 * accounting-ledger.ts — v7.2.8 REV C.4.2 PNL ACCOUNTING
 * ========================================================
 * Single authoritative state for per-market PnL tracking.
 * 
 * Tracks:
 *   - Realized PnL: profit/loss locked in by SELLs and settlements
 *   - Unrealized PnL: mark-to-market value of OPEN shares minus cost basis
 *   - Total PnL: realized + unrealized
 * 
 * Uses AVERAGE-COST method for cost basis.
 * Only updated from FILLS (not intents).
 */

import { saveBotEvent } from './backend.js';

// ============================================================
// TYPES
// ============================================================

export type Side = 'UP' | 'DOWN';
export type TradeAction = 'BUY' | 'SELL';

export interface AccountingEntry {
  // Core position tracking
  openShares: number;           // Currently held shares
  openCostUsd: number;          // Cost basis for open shares only
  
  // PnL tracking
  realizedPnlUsd: number;       // Cumulative realized PnL from SELLs
  
  // Stats (optional but useful)
  buyNotionalUsd: number;       // Total $ spent buying
  sellNotionalUsd: number;      // Total $ received selling
  totalBuyShares: number;       // Total shares ever bought
  totalSellShares: number;      // Total shares ever sold
  
  // v7.2: Fee tracking
  totalFeesUsd: number;         // Total taker fees paid
  
  // Last update
  lastUpdateTs: number;
}

export interface MarketPnL {
  marketId: string;
  asset: string;
  
  // Per-outcome PnL
  upEntry: AccountingEntry;
  downEntry: AccountingEntry;
  
  // Aggregated
  totalRealizedPnlUsd: number;
  totalUnrealizedPnlUsd: number;
  totalPnlUsd: number;
  
  // Mark prices (for unrealized calc)
  upMarkPrice: number | null;
  downMarkPrice: number | null;
}

export interface GlobalPnL {
  totalRealizedPnlUsd: number;
  totalUnrealizedPnlUsd: number;
  totalPnlUsd: number;
  totalFeesUsd: number;           // v7.2: Total fees paid across all markets
  marketCount: number;
  lastSnapshotTs: number;
}

export interface FillEvent {
  marketId: string;
  asset: string;
  side: Side;
  action: TradeAction;
  qty: number;
  price: number;
  feeUsd?: number;              // v7.2: Taker fee paid (if any)
  orderId?: string;
  correlationId?: string;
  runId?: string;
}

// ============================================================
// LEDGER STORAGE (in-memory, keyed by "marketId:asset:side")
// ============================================================

const ledger = new Map<string, AccountingEntry>();
const markPrices = new Map<string, { up: number | null; down: number | null }>();

function key(marketId: string, asset: string, side: Side): string {
  return `${marketId}:${asset}:${side}`;
}

function marketKey(marketId: string, asset: string): string {
  return `${marketId}:${asset}`;
}

function getOrCreate(marketId: string, asset: string, side: Side): AccountingEntry {
  const k = key(marketId, asset, side);
  let entry = ledger.get(k);
  if (!entry) {
    entry = {
      openShares: 0,
      openCostUsd: 0,
      realizedPnlUsd: 0,
      buyNotionalUsd: 0,
      sellNotionalUsd: 0,
      totalBuyShares: 0,
      totalSellShares: 0,
      totalFeesUsd: 0,           // v7.2: Initialize fee tracking
      lastUpdateTs: Date.now(),
    };
    ledger.set(k, entry);
  }
  return entry;
}

// ============================================================
// FILL PROCESSING (Core accounting logic)
// ============================================================

/**
 * Process a confirmed fill.
 * This is THE ONLY way to update the accounting ledger.
 */
export function processFill(fill: FillEvent): {
  realizedDelta: number;
  avgCostUsed: number;
  newOpenShares: number;
  newOpenCost: number;
  feeUsd: number;
} {
  const { marketId, asset, side, action, qty, price, feeUsd = 0, runId } = fill;
  
  if (!Number.isFinite(qty) || qty <= 0) {
    console.warn(`[ACCOUNTING] Invalid fill qty: ${qty}`);
    return { realizedDelta: 0, avgCostUsed: 0, newOpenShares: 0, newOpenCost: 0, feeUsd: 0 };
  }
  
  if (!Number.isFinite(price) || price < 0) {
    console.warn(`[ACCOUNTING] Invalid fill price: ${price}`);
    return { realizedDelta: 0, avgCostUsed: 0, newOpenShares: 0, newOpenCost: 0, feeUsd: 0 };
  }
  
  const entry = getOrCreate(marketId, asset, side);
  const notional = qty * price;
  let realizedDelta = 0;
  let avgCostUsed = 0;
  
  // v7.2: Track fees
  if (feeUsd > 0) {
    entry.totalFeesUsd += feeUsd;
  }
  
  if (action === 'BUY') {
    // BUY: Add to position (include fee in cost basis)
    const totalCost = notional + feeUsd;
    entry.openCostUsd += totalCost;
    entry.openShares += qty;
    entry.buyNotionalUsd += notional;
    entry.totalBuyShares += qty;
    
    const feeStr = feeUsd > 0 ? ` (fee: $${feeUsd.toFixed(4)})` : '';
    console.log(
      `📗 [ACCOUNTING] BUY ${side}: +${qty.toFixed(2)} @ ${(price * 100).toFixed(1)}¢ = $${totalCost.toFixed(2)}${feeStr} | ` +
      `Open: ${entry.openShares.toFixed(2)} shares, cost $${entry.openCostUsd.toFixed(2)}`
    );
    
  } else {
    // SELL: Reduce position and realize PnL
    // Guard: Never go negative
    if (qty > entry.openShares) {
      console.error(
        `🚨 [ACCOUNTING] SELL QTY EXCEEDS OPEN SHARES: ${qty} > ${entry.openShares} for ${side} ${asset} ${marketId.slice(-12)}`
      );
      // Clamp to available shares
      const actualQty = entry.openShares;
      if (actualQty <= 0) {
        console.warn(`[ACCOUNTING] No shares to sell, skipping`);
        return { realizedDelta: 0, avgCostUsed: 0, newOpenShares: 0, newOpenCost: 0, feeUsd: 0 };
      }
      
      // Use clamped qty
      avgCostUsed = entry.openShares > 0 ? entry.openCostUsd / entry.openShares : 0;
      realizedDelta = actualQty * price - actualQty * avgCostUsed;
      entry.realizedPnlUsd += realizedDelta;
      entry.openCostUsd -= actualQty * avgCostUsed;
      entry.openShares -= actualQty;
      entry.sellNotionalUsd += actualQty * price;
      entry.totalSellShares += actualQty;
    } else {
      // Normal sell
      avgCostUsed = entry.openShares > 0 ? entry.openCostUsd / entry.openShares : 0;
      realizedDelta = qty * price - qty * avgCostUsed;
      
      entry.realizedPnlUsd += realizedDelta;
      entry.openCostUsd -= qty * avgCostUsed;
      entry.openShares -= qty;
      entry.sellNotionalUsd += notional;
      entry.totalSellShares += qty;
    }
    
    // Guard: If shares hit 0, force cost to 0 to prevent drift
    if (entry.openShares <= 0) {
      entry.openShares = 0;
      entry.openCostUsd = 0;
    }
    
    const emoji = realizedDelta >= 0 ? '📗' : '📕';
    console.log(
      `${emoji} [ACCOUNTING] SELL ${side}: -${qty.toFixed(2)} @ ${(price * 100).toFixed(1)}¢ = $${notional.toFixed(2)} | ` +
      `AvgCost: ${(avgCostUsed * 100).toFixed(1)}¢ | Realized: $${realizedDelta >= 0 ? '+' : ''}${realizedDelta.toFixed(2)} | ` +
      `Remaining: ${entry.openShares.toFixed(2)} shares`
    );
    
    // Log realized PnL event
    saveBotEvent({
      event_type: 'REALIZED_PNL_EVENT',
      asset,
      market_id: marketId,
      ts: Date.now(),
      run_id: runId,
      data: {
        side,
        qty,
        sellPrice: price,
        avgCost: avgCostUsed,
        realizedDelta,
        realizedTotal: entry.realizedPnlUsd,
        remainingShares: entry.openShares,
        remainingCost: entry.openCostUsd,
      },
    }).catch(() => {});
  }
  
  entry.lastUpdateTs = Date.now();
  
  // Log position update
  saveBotEvent({
    event_type: 'OPEN_POSITION_UPDATE',
    asset,
    market_id: marketId,
    ts: Date.now(),
    run_id: runId,
    data: {
      side,
      action,
      openShares: entry.openShares,
      openCostUsd: entry.openCostUsd,
      realizedPnlUsd: entry.realizedPnlUsd,
      feeUsd,
      totalFeesUsd: entry.totalFeesUsd,
    },
  }).catch(() => {});
  
  return {
    realizedDelta,
    avgCostUsed,
    newOpenShares: entry.openShares,
    newOpenCost: entry.openCostUsd,
    feeUsd,
  };
}

/**
 * Process a settlement/redemption (market resolution).
 * Winning shares pay out $1 each, losing shares pay $0.
 */
export function processSettlement(params: {
  marketId: string;
  asset: string;
  winningSide: Side;
  runId?: string;
}): { realizedPnl: number } {
  const { marketId, asset, winningSide, runId } = params;
  const losingSide: Side = winningSide === 'UP' ? 'DOWN' : 'UP';
  
  const winEntry = getOrCreate(marketId, asset, winningSide);
  const loseEntry = getOrCreate(marketId, asset, losingSide);
  
  // Winning shares: redeem at $1.00
  const winPayout = winEntry.openShares * 1.0;
  const winRealizedPnl = winPayout - winEntry.openCostUsd;
  
  // Losing shares: worth $0
  const loseRealizedPnl = 0 - loseEntry.openCostUsd;
  
  const totalRealizedPnl = winRealizedPnl + loseRealizedPnl;
  
  // Update entries
  winEntry.realizedPnlUsd += winRealizedPnl;
  winEntry.sellNotionalUsd += winPayout;
  winEntry.totalSellShares += winEntry.openShares;
  winEntry.openShares = 0;
  winEntry.openCostUsd = 0;
  
  loseEntry.realizedPnlUsd += loseRealizedPnl;
  loseEntry.openShares = 0;
  loseEntry.openCostUsd = 0;
  
  const emoji = totalRealizedPnl >= 0 ? '✅' : '❌';
  console.log(
    `${emoji} [ACCOUNTING] SETTLEMENT ${asset} ${marketId.slice(-12)}: ${winningSide} won | ` +
    `Realized: $${totalRealizedPnl >= 0 ? '+' : ''}${totalRealizedPnl.toFixed(2)}`
  );
  
  saveBotEvent({
    event_type: 'SETTLEMENT_PNL',
    asset,
    market_id: marketId,
    ts: Date.now(),
    run_id: runId,
    data: {
      winningSide,
      winPayout,
      winRealizedPnl,
      loseRealizedPnl,
      totalRealizedPnl,
    },
  }).catch(() => {});
  
  return { realizedPnl: totalRealizedPnl };
}

// ============================================================
// MARK PRICES (for unrealized PnL calculation)
// ============================================================

/**
 * Update mark prices for unrealized PnL calculation.
 * Conservative: use bestBid (what you can actually sell at).
 */
export function updateMarkPrices(
  marketId: string,
  asset: string,
  upMark: number | null,
  downMark: number | null,
): void {
  const mk = marketKey(marketId, asset);
  markPrices.set(mk, { up: upMark, down: downMark });
}

// ============================================================
// PNL QUERIES
// ============================================================

/**
 * Get PnL for a specific market.
 */
export function getMarketPnL(marketId: string, asset: string): MarketPnL {
  const upEntry = getOrCreate(marketId, asset, 'UP');
  const downEntry = getOrCreate(marketId, asset, 'DOWN');
  const marks = markPrices.get(marketKey(marketId, asset)) || { up: null, down: null };
  
  // Unrealized PnL: (openShares * markPrice) - openCostUsd
  let upUnrealized = 0;
  let downUnrealized = 0;
  
  if (marks.up !== null && upEntry.openShares > 0) {
    upUnrealized = (upEntry.openShares * marks.up) - upEntry.openCostUsd;
  }
  if (marks.down !== null && downEntry.openShares > 0) {
    downUnrealized = (downEntry.openShares * marks.down) - downEntry.openCostUsd;
  }
  
  const totalRealized = upEntry.realizedPnlUsd + downEntry.realizedPnlUsd;
  const totalUnrealized = upUnrealized + downUnrealized;
  
  return {
    marketId,
    asset,
    upEntry: { ...upEntry },
    downEntry: { ...downEntry },
    totalRealizedPnlUsd: totalRealized,
    totalUnrealizedPnlUsd: totalUnrealized,
    totalPnlUsd: totalRealized + totalUnrealized,
    upMarkPrice: marks.up,
    downMarkPrice: marks.down,
  };
}

/**
 * Get global PnL across all markets.
 */
export function getGlobalPnL(): GlobalPnL {
  let totalRealized = 0;
  let totalUnrealized = 0;
  let totalFees = 0;
  const marketsProcessed = new Set<string>();
  
  for (const [k, entry] of ledger) {
    totalRealized += entry.realizedPnlUsd;
    totalFees += entry.totalFeesUsd;
    
    // Parse key to get market info
    const parts = k.split(':');
    if (parts.length >= 3) {
      const marketId = parts[0];
      const asset = parts[1];
      const side = parts[2] as Side;
      
      const mk = marketKey(marketId, asset);
      marketsProcessed.add(mk);
      
      const marks = markPrices.get(mk);
      if (marks && entry.openShares > 0) {
        const mark = side === 'UP' ? marks.up : marks.down;
        if (mark !== null) {
          totalUnrealized += (entry.openShares * mark) - entry.openCostUsd;
        }
      }
    }
  }
  
  return {
    totalRealizedPnlUsd: totalRealized,
    totalUnrealizedPnlUsd: totalUnrealized,
    totalPnlUsd: totalRealized + totalUnrealized,
    totalFeesUsd: totalFees,
    marketCount: marketsProcessed.size,
    lastSnapshotTs: Date.now(),
  };
}

/**
 * Get entry for a specific side.
 */
export function getEntry(marketId: string, asset: string, side: Side): AccountingEntry {
  return { ...getOrCreate(marketId, asset, side) };
}

// ============================================================
// SYNC / RESET
// ============================================================

/**
 * Initialize position from external source (e.g., startup sync).
 * Only sets openShares and openCostUsd.
 */
export function initializePosition(
  marketId: string,
  asset: string,
  side: Side,
  shares: number,
  costUsd: number,
): void {
  const entry = getOrCreate(marketId, asset, side);
  entry.openShares = Math.max(0, shares);
  entry.openCostUsd = Math.max(0, costUsd);
  entry.lastUpdateTs = Date.now();
  
  console.log(
    `📊 [ACCOUNTING] INIT ${side}: ${shares.toFixed(2)} shares @ $${costUsd.toFixed(2)} cost`
  );
}

/**
 * Clear all data for a market (e.g., on market expiry cleanup).
 */
export function clearMarket(marketId: string, asset: string): void {
  ledger.delete(key(marketId, asset, 'UP'));
  ledger.delete(key(marketId, asset, 'DOWN'));
  markPrices.delete(marketKey(marketId, asset));
}

/**
 * Clear all data (e.g., on restart for fresh state).
 */
export function clearAll(): void {
  ledger.clear();
  markPrices.clear();
}

// ============================================================
// SNAPSHOT LOGGING
// ============================================================

let lastSnapshotTs = 0;
const SNAPSHOT_INTERVAL_MS = 30000; // 30 seconds

/**
 * Log a PnL snapshot (throttled).
 */
export function logPnLSnapshot(runId?: string): void {
  const now = Date.now();
  if (now - lastSnapshotTs < SNAPSHOT_INTERVAL_MS) return;
  lastSnapshotTs = now;
  
  const global = getGlobalPnL();
  
  if (global.marketCount === 0) return;
  
  const realizedEmoji = global.totalRealizedPnlUsd >= 0 ? '📈' : '📉';
  const unrealizedEmoji = global.totalUnrealizedPnlUsd >= 0 ? '📈' : '📉';
  const totalEmoji = global.totalPnlUsd >= 0 ? '✅' : '❌';
  
  console.log(
    `${totalEmoji} [PNL SNAPSHOT] ` +
    `Realized: ${realizedEmoji} $${global.totalRealizedPnlUsd >= 0 ? '+' : ''}${global.totalRealizedPnlUsd.toFixed(2)} | ` +
    `Unrealized: ${unrealizedEmoji} $${global.totalUnrealizedPnlUsd >= 0 ? '+' : ''}${global.totalUnrealizedPnlUsd.toFixed(2)} | ` +
    `Fees: $${global.totalFeesUsd.toFixed(2)} | ` +
    `Total: $${global.totalPnlUsd >= 0 ? '+' : ''}${global.totalPnlUsd.toFixed(2)} | ` +
    `Markets: ${global.marketCount}`
  );
  
  saveBotEvent({
    event_type: 'PNL_SNAPSHOT',
    asset: 'ALL',
    ts: now,
    run_id: runId,
    data: global,
  }).catch(() => {});
}
