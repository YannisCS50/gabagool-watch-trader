// ============================================================
// V26 BACKEND - Supabase integration for V26 trades
// ============================================================

import { config } from '../config.js';
import type { V26Trade, V26Stats } from './index.js';

const BACKEND_URL = config.backend.url;
const AUTH_HEADER = { 'Authorization': `Bearer ${config.backend.secret}` };

/**
 * Save a V26 trade to the database
 */
export async function saveV26Trade(trade: V26Trade): Promise<string | null> {
  try {
    const response = await fetch(`${BACKEND_URL}/rest/v1/v26_trades`, {
      method: 'POST',
      headers: {
        ...AUTH_HEADER,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation',
      },
      body: JSON.stringify({
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
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error(`[V26] Failed to save trade: ${response.status} ${text}`);
      return null;
    }

    const data = await response.json();
    return data[0]?.id ?? null;
  } catch (err) {
    console.error(`[V26] Error saving trade:`, err);
    return null;
  }
}

/**
 * Update an existing V26 trade
 */
export async function updateV26Trade(
  id: string,
  updates: Partial<V26Trade>
): Promise<boolean> {
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

    const response = await fetch(`${BACKEND_URL}/rest/v1/v26_trades?id=eq.${id}`, {
      method: 'PATCH',
      headers: {
        ...AUTH_HEADER,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(dbUpdates),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error(`[V26] Failed to update trade ${id}: ${response.status} ${text}`);
      return false;
    }

    return true;
  } catch (err) {
    console.error(`[V26] Error updating trade:`, err);
    return false;
  }
}

/**
 * Get V26 stats from the database
 */
export async function getV26Stats(): Promise<V26Stats | null> {
  try {
    const response = await fetch(`${BACKEND_URL}/rest/v1/v26_stats?select=*`, {
      headers: AUTH_HEADER,
    });

    if (!response.ok) {
      const text = await response.text();
      console.error(`[V26] Failed to fetch stats: ${response.status} ${text}`);
      return null;
    }

    const data = await response.json();
    const row = data[0];
    
    if (!row) {
      return {
        totalTrades: 0,
        filledTrades: 0,
        settledTrades: 0,
        wins: 0,
        losses: 0,
        winRatePct: 0,
        totalPnl: 0,
        totalInvested: 0,
      };
    }

    return {
      totalTrades: row.total_trades ?? 0,
      filledTrades: row.filled_trades ?? 0,
      settledTrades: row.settled_trades ?? 0,
      wins: row.wins ?? 0,
      losses: row.losses ?? 0,
      winRatePct: row.win_rate_pct ?? 0,
      totalPnl: row.total_pnl ?? 0,
      totalInvested: row.total_invested ?? 0,
      lastTradeAt: row.last_trade_at ? new Date(row.last_trade_at) : undefined,
    };
  } catch (err) {
    console.error(`[V26] Error fetching stats:`, err);
    return null;
  }
}

/**
 * Get recent V26 trades
 */
export async function getRecentV26Trades(limit = 50): Promise<V26Trade[]> {
  try {
    const response = await fetch(
      `${BACKEND_URL}/rest/v1/v26_trades?select=*&order=created_at.desc&limit=${limit}`,
      { headers: AUTH_HEADER }
    );

    if (!response.ok) {
      return [];
    }

    const data = await response.json();
    
    return data.map((row: any) => ({
      id: row.id,
      asset: row.asset,
      marketId: row.market_id,
      marketSlug: row.market_slug,
      eventStartTime: new Date(row.event_start_time),
      eventEndTime: new Date(row.event_end_time),
      orderId: row.order_id,
      side: row.side,
      price: parseFloat(row.price),
      shares: row.shares,
      status: row.status,
      filledShares: row.filled_shares ?? 0,
      avgFillPrice: row.avg_fill_price ? parseFloat(row.avg_fill_price) : undefined,
      fillTimeMs: row.fill_time_ms,
      result: row.result,
      pnl: row.pnl ? parseFloat(row.pnl) : undefined,
      settledAt: row.settled_at ? new Date(row.settled_at) : undefined,
      runId: row.run_id,
      errorMessage: row.error_message,
    }));
  } catch (err) {
    console.error(`[V26] Error fetching trades:`, err);
    return [];
  }
}

/**
 * Check if we already have a trade for this market
 */
export async function hasExistingTrade(marketId: string, asset: string): Promise<boolean> {
  try {
    const response = await fetch(
      `${BACKEND_URL}/rest/v1/v26_trades?market_id=eq.${marketId}&asset=eq.${asset}&select=id&limit=1`,
      { headers: AUTH_HEADER }
    );

    if (!response.ok) {
      return false;
    }

    const data = await response.json();
    return data.length > 0;
  } catch (err) {
    return false;
  }
}
