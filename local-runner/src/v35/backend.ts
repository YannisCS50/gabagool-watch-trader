// ============================================================
// V35 BACKEND LOGGING
// ============================================================
// Persists fills, positions, and heartbeats to the database.
// Uses the runner-proxy for all database operations.
// ============================================================

import { config } from '../config.js';
import type { V35Market, V35Fill, V35MarketMetrics, V35PortfolioMetrics } from './types.js';

const VERSION = 'V35.0.0';

async function callProxy<T>(action: string, data?: Record<string, unknown>): Promise<T> {
  const response = await fetch(config.backend.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Runner-Secret': config.backend.secret,
    },
    body: JSON.stringify({ action, data }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Backend error ${response.status}: ${text}`);
  }

  return response.json();
}

// ============================================================
// HEARTBEAT
// ============================================================

export interface V35HeartbeatData {
  runnerId: string;
  mode: string;
  dryRun: boolean;
  marketsCount: number;
  totalPaired: number;
  totalUnpaired: number;
  totalLockedProfit: number;
  balance: number;
}

export async function sendV35Heartbeat(data: V35HeartbeatData): Promise<boolean> {
  try {
    const result = await callProxy<{ success: boolean }>('heartbeat', {
      heartbeat: {
        runner_id: data.runnerId,
        runner_type: 'v35',
        last_heartbeat: new Date().toISOString(),
        status: 'online',
        markets_count: data.marketsCount,
        positions_count: data.totalPaired,
        trades_count: data.totalPaired + data.totalUnpaired,
        balance: data.balance,
        version: VERSION,
        metadata: {
          mode: data.mode,
          dry_run: data.dryRun,
          locked_profit: data.totalLockedProfit,
        },
      },
    });
    return result.success;
  } catch (err: any) {
    console.error('[V35Backend] Heartbeat failed:', err?.message);
    return false;
  }
}

// ============================================================
// FILL LOGGING
// ============================================================

export async function saveV35Fill(fill: V35Fill): Promise<boolean> {
  try {
    const result = await callProxy<{ success: boolean }>('save-v35-fill', {
      fill: {
        order_id: fill.orderId,
        token_id: fill.tokenId,
        side: fill.side,
        price: fill.price,
        size: fill.size,
        timestamp: fill.timestamp.toISOString(),
        market_slug: fill.marketSlug,
        asset: fill.asset,
      },
    });
    return result.success;
  } catch (err: any) {
    console.error('[V35Backend] Save fill failed:', err?.message);
    return false;
  }
}

// ============================================================
// POSITION SNAPSHOT
// ============================================================

export async function saveV35PositionSnapshot(
  market: V35Market,
  metrics: V35MarketMetrics
): Promise<boolean> {
  try {
    const result = await callProxy<{ success: boolean }>('save-v35-position', {
      position: {
        market_slug: market.slug,
        asset: market.asset,
        up_qty: metrics.upQty,
        down_qty: metrics.downQty,
        up_cost: metrics.upCost,
        down_cost: metrics.downCost,
        paired: metrics.paired,
        unpaired: metrics.unpaired,
        combined_cost: metrics.combinedCost,
        locked_profit: metrics.lockedProfit,
        seconds_to_expiry: metrics.secondsToExpiry,
        timestamp: new Date().toISOString(),
      },
    });
    return result.success;
  } catch (err: any) {
    console.error('[V35Backend] Save position snapshot failed:', err?.message);
    return false;
  }
}

// ============================================================
// SETTLEMENT LOGGING
// ============================================================

export interface V35SettlementData {
  marketSlug: string;
  asset: string;
  upQty: number;
  downQty: number;
  upCost: number;
  downCost: number;
  paired: number;
  unpaired: number;
  combinedCost: number;
  lockedProfit: number;
  winningSide: 'UP' | 'DOWN' | null;
  pnl: number;
}

export async function saveV35Settlement(data: V35SettlementData): Promise<boolean> {
  try {
    const result = await callProxy<{ success: boolean }>('save-v35-settlement', {
      settlement: {
        market_slug: data.marketSlug,
        asset: data.asset,
        up_qty: data.upQty,
        down_qty: data.downQty,
        up_cost: data.upCost,
        down_cost: data.downCost,
        paired: data.paired,
        unpaired: data.unpaired,
        combined_cost: data.combinedCost,
        locked_profit: data.lockedProfit,
        winning_side: data.winningSide,
        pnl: data.pnl,
        timestamp: new Date().toISOString(),
      },
    });
    return result.success;
  } catch (err: any) {
    console.error('[V35Backend] Save settlement failed:', err?.message);
    return false;
  }
}

// ============================================================
// OFFLINE NOTIFICATION
// ============================================================

export async function sendV35Offline(runnerId: string): Promise<void> {
  try {
    await callProxy('offline', { runner_id: runnerId });
  } catch (err: any) {
    console.error('[V35Backend] Offline notification failed:', err?.message);
  }
}
