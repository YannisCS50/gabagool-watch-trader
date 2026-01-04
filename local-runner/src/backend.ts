import { config } from './config.js';
import type { FillLog, SettlementLog, SnapshotLog } from './logger.js';

interface MarketToken {
  slug: string;
  asset: string;
  upTokenId: string;
  downTokenId: string;
  eventStartTime: string;
  eventEndTime: string;
  marketType: string;
}

interface Trade {
  market_slug: string;
  outcome: string;
  shares: number;
  total: number;
}

interface TradeInsert {
  market_slug: string;
  asset: string;
  outcome: string;
  shares: number;
  price: number;
  total: number;
  order_id?: string;
  status: string;
  reasoning: string;
  event_start_time: string;
  event_end_time: string;
  avg_fill_price: number;
}

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
}

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

export async function fetchMarkets(): Promise<{ success: boolean; markets?: MarketToken[] }> {
  try {
    const result = await callProxy<{ success: boolean; markets?: MarketToken[] }>('get-markets');
    return result;
  } catch (error) {
    console.error('❌ fetchMarkets error:', error);
    return { success: false };
  }
}

export async function fetchTrades(slugs: string[]): Promise<Trade[]> {
  if (slugs.length === 0) return [];
  
  try {
    const result = await callProxy<{ success: boolean; trades?: Trade[] }>('get-trades', { slugs });
    return result.trades || [];
  } catch (error) {
    console.error('❌ fetchTrades error:', error);
    return [];
  }
}

export async function saveTrade(trade: TradeInsert): Promise<boolean> {
  try {
    const result = await callProxy<{ success: boolean }>('save-trade', { trade });
    return result.success;
  } catch (error) {
    console.error('❌ saveTrade error:', error);
    return false;
  }
}

export async function sendHeartbeat(heartbeat: HeartbeatData): Promise<boolean> {
  try {
    const result = await callProxy<{ success: boolean }>('heartbeat', { heartbeat });
    return result.success;
  } catch (error) {
    console.error('❌ sendHeartbeat error:', error);
    return false;
  }
}

export async function sendOffline(runnerId: string): Promise<void> {
  try {
    await callProxy('offline', { runner_id: runnerId });
  } catch (error) {
    console.error('❌ sendOffline error:', error);
  }
}

interface PendingOrder {
  id: string;
  market_slug: string;
  asset: string;
  outcome: string;
  token_id: string;
  price: number;
  shares: number;
  order_type: string;
  reasoning: string | null;
  event_start_time: string | null;
  event_end_time: string | null;
}

export async function fetchPendingOrders(): Promise<PendingOrder[]> {
  try {
    const result = await callProxy<{ success: boolean; orders?: PendingOrder[] }>('get-pending-orders');
    return result.orders || [];
  } catch (error) {
    console.error('❌ fetchPendingOrders error:', error);
    return [];
  }
}

export async function updateOrder(
  orderId: string,
  status: 'filled' | 'failed' | 'cancelled' | 'placed' | 'partial',
  result?: { order_id?: string; avg_fill_price?: number; error?: string }
): Promise<boolean> {
  try {
    const response = await callProxy<{ success: boolean }>('update-order', {
      order_id: orderId,
      status,
      result,
    });
    return response.success;
  } catch (error) {
    console.error('❌ updateOrder error:', error);
    return false;
  }
}

interface PositionData {
  conditionId: string;
  market: string;
  outcome: string;
  size: number;
  avgPrice: number;
  currentValue: number;
  initialValue: number;
  eventSlug?: string;
}

/**
 * Sync positions with backend - reconciles pending orders with actual Polymarket positions
 */
export async function syncPositionsToBackend(
  wallet: string,
  positions: PositionData[]
): Promise<{ success: boolean; updated?: number; cancelled?: number }> {
  try {
    const result = await callProxy<{ success: boolean; updated?: number; cancelled?: number }>('sync-positions', {
      wallet,
      positions,
    });
    return result;
  } catch (error) {
    console.error('❌ syncPositionsToBackend error:', error);
    return { success: false };
  }
}

// ============================================
// PRICE TICK LOGGING
// ============================================

export interface PriceTick {
  asset: string;
  price: number;
  delta: number;
  delta_percent: number;
  source: string;
}

export async function savePriceTicks(ticks: PriceTick[]): Promise<boolean> {
  if (ticks.length === 0) return true;
  try {
    const result = await callProxy<{ success: boolean; count?: number }>('save-price-ticks', { ticks });
    return result.success;
  } catch (error) {
    // Fail silently – price-tick logging is non-critical
    console.error('❌ savePriceTicks error:', error);
    return false;
  }
}

// ============================================
// TELEMETRY LOGGING (SNAPSHOT/FILL/SETTLEMENT)
// ============================================

export async function saveSnapshotLogs(logs: SnapshotLog[]): Promise<boolean> {
  if (logs.length === 0) return true;
  try {
    const result = await callProxy<{ success: boolean; count?: number }>('save-snapshot-logs', { logs });
    return result.success;
  } catch (error) {
    console.error('❌ saveSnapshotLogs error:', error);
    return false;
  }
}

export async function saveFillLogs(logs: FillLog[]): Promise<boolean> {
  if (logs.length === 0) return true;
  try {
    const result = await callProxy<{ success: boolean; count?: number }>('save-fill-logs', { logs });
    return result.success;
  } catch (error) {
    console.error('❌ saveFillLogs error:', error);
    return false;
  }
}

export async function saveSettlementLogs(logs: SettlementLog[]): Promise<boolean> {
  if (logs.length === 0) return true;
  try {
    const result = await callProxy<{ success: boolean; count?: number }>('save-settlement-logs', { logs });
    return result.success;
  } catch (error) {
    console.error('❌ saveSettlementLogs error:', error);
    return false;
  }
}

// ============================================
// v4.4: SETTLEMENT FAILURE LOGGING
// ============================================

export interface SettlementFailure {
  market_slug: string;
  asset: string;
  up_shares: number;
  down_shares: number;
  up_cost: number;
  down_cost: number;
  lost_side: 'UP' | 'DOWN';
  lost_cost: number;
  seconds_remaining: number;
  reason: string;
  panic_hedge_attempted: boolean;
  wallet_address?: string;
}

/**
 * v4.4: Log settlement failure to backend - THE critical metric
 * Optimize for settlement_failures = 0, not PnL
 */
export async function saveSettlementFailure(failure: SettlementFailure): Promise<boolean> {
  try {
    console.log('🚨 SAVING SETTLEMENT FAILURE TO BACKEND:', failure);
    const result = await callProxy<{ success: boolean }>('save-settlement-failure', { failure });
    return result.success;
  } catch (error) {
    console.error('❌ saveSettlementFailure error:', error);
    return false;
  }
}

// ============================================
// v6.1.0: OBSERVABILITY V1 - NEW TABLES
// ============================================

// --- Bot Events (canonical event log) ---
export interface BotEvent {
  event_type: string;
  asset: string;
  market_id?: string;
  correlation_id?: string;
  run_id?: string;
  reason_code?: string;
  data?: Record<string, unknown>;
  ts: number;
}

export async function saveBotEvent(event: BotEvent): Promise<boolean> {
  try {
    const result = await callProxy<{ success: boolean }>('save-bot-event', { event });
    return result.success;
  } catch (error) {
    console.error('❌ saveBotEvent error:', error);
    return false;
  }
}

export async function saveBotEvents(events: BotEvent[]): Promise<boolean> {
  if (events.length === 0) return true;
  try {
    const result = await callProxy<{ success: boolean; count?: number }>('save-bot-events', { events });
    return result.success;
  } catch (error) {
    console.error('❌ saveBotEvents error:', error);
    return false;
  }
}

// --- Order Lifecycle ---
export interface OrderLifecycle {
  client_order_id: string;
  market_id: string;
  asset: string;
  side: 'UP' | 'DOWN';
  intent_type: string;
  price: number;
  qty: number;
  status: string;
  exchange_order_id?: string;
  avg_fill_price?: number;
  filled_qty?: number;
  reserved_notional?: number;
  released_notional?: number;
  correlation_id?: string;
  created_ts: number;
  last_update_ts: number;
}

export async function saveOrderLifecycle(order: OrderLifecycle): Promise<boolean> {
  try {
    const result = await callProxy<{ success: boolean }>('save-order-lifecycle', { order });
    return result.success;
  } catch (error) {
    console.error('❌ saveOrderLifecycle error:', error);
    return false;
  }
}

// --- Inventory Snapshots ---
export interface InventorySnapshot {
  market_id: string;
  asset: string;
  up_shares: number;
  down_shares: number;
  avg_up_cost?: number;
  avg_down_cost?: number;
  pair_cost?: number;
  unpaired_shares?: number;
  state: string;
  state_age_ms?: number;
  hedge_lag_ms?: number;
  trigger_type?: string;
  ts: number;
}

export async function saveInventorySnapshot(snapshot: InventorySnapshot): Promise<boolean> {
  try {
    const result = await callProxy<{ success: boolean }>('save-inventory-snapshot', { snapshot });
    return result.success;
  } catch (error) {
    console.error('❌ saveInventorySnapshot error:', error);
    return false;
  }
}

export async function saveInventorySnapshots(snapshots: InventorySnapshot[]): Promise<boolean> {
  if (snapshots.length === 0) return true;
  try {
    const result = await callProxy<{ success: boolean; count?: number }>('save-inventory-snapshots', { snapshots });
    return result.success;
  } catch (error) {
    console.error('❌ saveInventorySnapshots error:', error);
    return false;
  }
}

// --- Funding Snapshots ---
export interface FundingSnapshot {
  balance_total: number;
  balance_available: number;
  reserved_total: number;
  reserved_by_market?: Record<string, number>;
  spendable?: number;
  allowance_remaining?: number;
  blocked_reason?: string;
  trigger_type?: string;
  ts: number;
}

export async function saveFundingSnapshot(snapshot: FundingSnapshot): Promise<boolean> {
  try {
    const result = await callProxy<{ success: boolean }>('save-funding-snapshot', { snapshot });
    return result.success;
  } catch (error) {
    console.error('❌ saveFundingSnapshot error:', error);
    return false;
  }
}

