// ============================================================
// V26 BACKEND - Supabase integration for V26 trades
// ============================================================

// ============================================================
// V26 BACKEND - runner-proxy integration for V26 trades
// ============================================================

import { config } from '../config.js';
import type { V26Trade, V26Stats } from './index.js';

async function callRunnerProxy<T>(action: 'v26-save-trade' | 'v26-update-trade' | 'v26-has-trade' | 'v26-get-oracle', data?: Record<string, unknown>): Promise<T> {
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

/**
 * Save a V26 trade to the database
 */
export async function saveV26Trade(trade: V26Trade): Promise<string | null> {
  try {
    const payload = {
      asset: trade.asset,
      market_id: trade.marketId,
      market_slug: trade.marketSlug,
      event_start_time: trade.eventStartTime.toISOString(),
      event_end_time: trade.eventEndTime.toISOString(),
      order_id: trade.orderId,
      side: trade.side,
      price: trade.price,
      shares: trade.shares,
      status: trade.status,
      filled_shares: trade.filledShares,
      avg_fill_price: trade.avgFillPrice,
      fill_time_ms: trade.fillTimeMs,
      result: trade.result,
      pnl: trade.pnl,
      settled_at: trade.settledAt?.toISOString(),
      run_id: trade.runId,
      error_message: trade.errorMessage,
    };

    const result = await callRunnerProxy<{ success: boolean; id: string | null }>('v26-save-trade', { trade: payload });
    return result.id;
  } catch (err: any) {
    console.error(`[V26] Failed to save trade:`, err?.message ?? err);
    return null;
  }
}

/**
 * Update an existing V26 trade
 */
export async function updateV26Trade(id: string, updates: Partial<V26Trade>): Promise<boolean> {
  try {
    const dbUpdates: Record<string, any> = {};

    if (updates.orderId !== undefined) dbUpdates.order_id = updates.orderId;
    if (updates.status !== undefined) dbUpdates.status = updates.status;
    if (updates.filledShares !== undefined) dbUpdates.filled_shares = updates.filledShares;
    if (updates.avgFillPrice !== undefined) dbUpdates.avg_fill_price = updates.avgFillPrice;
    if (updates.fillTimeMs !== undefined) dbUpdates.fill_time_ms = updates.fillTimeMs;
    if (updates.result !== undefined) dbUpdates.result = updates.result;
    if (updates.pnl !== undefined) dbUpdates.pnl = updates.pnl;
    if (updates.settledAt !== undefined) dbUpdates.settled_at = updates.settledAt.toISOString();
    if (updates.errorMessage !== undefined) dbUpdates.error_message = updates.errorMessage;

    const result = await callRunnerProxy<{ success: boolean }>('v26-update-trade', { id, updates: dbUpdates });
    return result.success;
  } catch (err: any) {
    console.error(`[V26] Failed to update trade ${id}:`, err?.message ?? err);
    return false;
  }
}

/**
 * Get V26 stats from the database
 * (UI reads this directly; kept for compatibility)
 */
export async function getV26Stats(): Promise<V26Stats | null> {
  console.warn('[V26] getV26Stats is not supported via runner-proxy; the dashboard reads stats directly.');
  return null;
}

/**
 * Get recent V26 trades
 * (UI reads this directly; kept for compatibility)
 */
export async function getRecentV26Trades(_limit = 50): Promise<V26Trade[]> {
  console.warn('[V26] getRecentV26Trades is not supported via runner-proxy; the dashboard reads trades directly.');
  return [];
}

/**
 * Get oracle data for a market (strike + close).
 */
export async function getV26Oracle(marketSlug: string, asset: string): Promise<{
  market_slug: string;
  asset: string;
  strike_price: number | null;
  close_price: number | null;
  close_timestamp: number | null;
  quality: string | null;
} | null> {
  try {
    const result = await callRunnerProxy<{ success: boolean; oracle: any | null }>('v26-get-oracle', {
      market_slug: marketSlug,
      asset,
    });

    return result.oracle ?? null;
  } catch (err: any) {
    console.error(`[V26] Failed to fetch oracle for ${asset} ${marketSlug}:`, err?.message ?? err);
    return null;
  }
}

