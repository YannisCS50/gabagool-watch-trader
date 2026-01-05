/**
 * Strategy v7.0 Inventory Management
 * ============================================================
 * Inventory-first signals: unpaired shares & age are leading
 */

import type { InventoryState, MarketSnapshot, Side, InventoryLogEvent } from './types.js';
import { getConfig } from './config.js';

// ============================================================
// INVENTORY CALCULATIONS
// ============================================================

export function createEmptyInventory(): InventoryState {
  return {
    upShares: 0,
    downShares: 0,
    upInvested: 0,
    downInvested: 0,
    avgUpCost: 0,
    avgDownCost: 0,
    lastPairedTs: Date.now(),
    unpairedShares: 0,
    unpairedNotional: 0,
    unpairedAgeSec: 0,
    riskScore: 0,
    degradedMode: false,
    firstFillTs: undefined,
    lastFillTs: undefined,
    tradesCount: 0,
  };
}

export function updateInventoryOnFill(
  inv: InventoryState,
  side: Side,
  fillQty: number,
  fillPrice: number,
  ts: number
): InventoryState {
  const fillNotional = fillQty * fillPrice;
  const updated = { ...inv };
  
  if (side === 'UP') {
    const newTotalQty = inv.upShares + fillQty;
    const newTotalCost = inv.upInvested + fillNotional;
    updated.upShares = newTotalQty;
    updated.upInvested = newTotalCost;
    updated.avgUpCost = newTotalQty > 0 ? newTotalCost / newTotalQty : 0;
  } else {
    const newTotalQty = inv.downShares + fillQty;
    const newTotalCost = inv.downInvested + fillNotional;
    updated.downShares = newTotalQty;
    updated.downInvested = newTotalCost;
    updated.avgDownCost = newTotalQty > 0 ? newTotalCost / newTotalQty : 0;
  }
  
  updated.lastFillTs = ts;
  updated.tradesCount++;
  
  if (!updated.firstFillTs) {
    updated.firstFillTs = ts;
  }
  
  // Check if we just became paired
  const wasUnpaired = inv.unpairedShares > 0;
  const minShares = Math.min(updated.upShares, updated.downShares);
  const maxShares = Math.max(updated.upShares, updated.downShares);
  updated.unpairedShares = maxShares - minShares;
  
  if (wasUnpaired && updated.unpairedShares === 0) {
    updated.lastPairedTs = ts;
  }
  
  return updated;
}

// ============================================================
// RISK METRICS
// ============================================================

export function calculateInventoryRisk(
  inv: InventoryState,
  snap: MarketSnapshot
): InventoryState {
  const now = snap.ts;
  const unpaired = Math.abs(inv.upShares - inv.downShares);
  
  // Use mid price for dominant side to estimate notional
  const dominantIsUp = inv.upShares >= inv.downShares;
  const mid = dominantIsUp
    ? (snap.up.ask ?? snap.up.bid ?? 0.50)
    : (snap.down.ask ?? snap.down.bid ?? 0.50);
  
  const unpairedNotional = unpaired * mid;
  
  // Calculate age of unpaired state
  const unpairedAgeSec = unpaired === 0
    ? 0
    : Math.max(0, (now - inv.lastPairedTs) / 1000);
  
  // Risk score = notional × age (higher = worse)
  const riskScore = unpairedNotional * unpairedAgeSec;
  
  return {
    ...inv,
    unpairedShares: unpaired,
    unpairedNotional,
    unpairedAgeSec,
    riskScore,
  };
}

// ============================================================
// PAIR COST CALCULATIONS (core arbitrage metric)
// ============================================================

export function calculatePairCost(inv: InventoryState): number {
  const pairedShares = Math.min(inv.upShares, inv.downShares);
  if (pairedShares === 0) return 0;
  
  // Average cost per paired share = (upCost + downCost) / pairedShares
  const totalCost = inv.upInvested + inv.downInvested;
  return totalCost / pairedShares;
}

export function calculateAveragePairCost(inv: InventoryState): number {
  // Average cost per share on each side
  return inv.avgUpCost + inv.avgDownCost;
}

export function projectPairCostAfterBuy(
  inv: InventoryState,
  side: Side,
  qty: number,
  price: number
): number {
  // Simulate the purchase
  const simulated = { ...inv };
  const cost = qty * price;
  
  if (side === 'UP') {
    simulated.upShares = inv.upShares + qty;
    simulated.upInvested = inv.upInvested + cost;
    simulated.avgUpCost = simulated.upShares > 0
      ? simulated.upInvested / simulated.upShares
      : 0;
  } else {
    simulated.downShares = inv.downShares + qty;
    simulated.downInvested = inv.downInvested + cost;
    simulated.avgDownCost = simulated.downShares > 0
      ? simulated.downInvested / simulated.downShares
      : 0;
  }
  
  return calculateAveragePairCost(simulated);
}

// ============================================================
// SKEW CALCULATIONS
// ============================================================

export function calculateSkew(inv: InventoryState): number {
  const total = inv.upShares + inv.downShares;
  if (total === 0) return 0.50; // Perfectly balanced when empty
  
  return inv.upShares / total;
}

export function getDominantSide(inv: InventoryState): Side {
  return inv.upShares >= inv.downShares ? 'UP' : 'DOWN';
}

export function getWeakSide(inv: InventoryState): Side {
  return inv.upShares < inv.downShares ? 'UP' : 'DOWN';
}

// ============================================================
// DEGRADED MODE
// ============================================================

export function evaluateDegradedMode(
  inv: InventoryState,
  snap: MarketSnapshot
): InventoryState {
  const cfg = getConfig();
  
  const shouldEnter =
    (inv.unpairedNotional >= cfg.risk.degradedTriggerNotional &&
     inv.unpairedAgeSec >= cfg.risk.degradedTriggerAgeSec) ||
    inv.riskScore >= cfg.risk.degradedRiskScoreTrigger;
  
  const shouldExit = inv.unpairedShares === 0;
  
  if (!inv.degradedMode && shouldEnter) {
    console.log(`[v7] DEGRADED MODE ENTER: unpaired=$${inv.unpairedNotional.toFixed(2)}, age=${inv.unpairedAgeSec.toFixed(0)}s, riskScore=${inv.riskScore.toFixed(0)}`);
    return { ...inv, degradedMode: true };
  }
  
  if (inv.degradedMode && shouldExit) {
    console.log(`[v7] DEGRADED MODE EXIT: inventory is paired`);
    return { ...inv, degradedMode: false, lastPairedTs: snap.ts };
  }
  
  return inv;
}

// ============================================================
// LOGGING
// ============================================================

export function createInventoryLogEvent(
  inv: InventoryState,
  snap: MarketSnapshot
): InventoryLogEvent {
  return {
    type: 'INVENTORY',
    ts: snap.ts,
    marketId: snap.marketId,
    asset: snap.asset,
    upShares: inv.upShares,
    downShares: inv.downShares,
    avgUpCost: inv.avgUpCost,
    avgDownCost: inv.avgDownCost,
    unpairedShares: inv.unpairedShares,
    unpairedNotional: inv.unpairedNotional,
    unpairedAgeSec: inv.unpairedAgeSec,
    riskScore: inv.riskScore,
    degradedMode: inv.degradedMode,
    pairCost: calculateAveragePairCost(inv),
  };
}
