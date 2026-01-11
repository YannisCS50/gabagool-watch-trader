import { createClient } from '@supabase/supabase-js';
import { config } from './config.js';
import type { FillLog, SettlementLog, SnapshotLog } from './logger.js';

// Supabase client singleton for direct database access
let supabaseClient: ReturnType<typeof createClient> | null = null;

export function getSupabaseClient() {
  if (supabaseClient) return supabaseClient;
  
  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '';
  const supabaseKey =
    process.env.SUPABASE_ANON_KEY ||
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    '';

  if (!supabaseUrl || !supabaseKey) {
    console.warn(
      '[Backend] Database not configured - set SUPABASE_URL + SUPABASE_ANON_KEY (or VITE_SUPABASE_URL + VITE_SUPABASE_PUBLISHABLE_KEY)'
    );
    return null;
  }
  
  supabaseClient = createClient(supabaseUrl, supabaseKey);
  return supabaseClient;
}

interface MarketToken {
  slug: string;
  asset: string;
  conditionId?: string;  // v7.4.1: Added for position cache slug mapping
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

export async function fetchMarkets(options?: { v26?: boolean }): Promise<{ success: boolean; markets?: MarketToken[] }> {
  try {
    const result = await callProxy<{ success: boolean; markets?: MarketToken[] }>('get-markets', options);
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

// ============================================
// v7.4.0: STALE ORDER CLEANUP
// ============================================

export interface StalePlacedOrder {
  id: string;
  market_slug: string;
  asset: string;
  outcome: string;
  shares: number;
  price: number;
  order_id: string;
  intent_type: string | null;
  created_at: string;
  executed_at: string | null;
}

/**
 * v7.4.0: Fetch stale placed orders that need to be cancelled
 * Orders with status='placed' and order_id that are older than TTL
 */
export async function fetchStalePlacedOrders(
  ttlMs: number = 20_000,
  hedgeTtlMs: number = 10_000
): Promise<StalePlacedOrder[]> {
  try {
    const result = await callProxy<{ success: boolean; orders?: StalePlacedOrder[] }>(
      'get-stale-orders',
      { ttl_ms: ttlMs, hedge_ttl_ms: hedgeTtlMs }
    );
    return result.orders || [];
  } catch (error) {
    console.error('❌ fetchStalePlacedOrders error:', error);
    return [];
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
  // v6.2.0: Extended fields for ORDER_INTENT and ORDER_FAIL
  expected_notional?: number;    // For ORDER_INTENT: expected USD to reserve
  api_error_code?: string;       // For ORDER_FAIL: structured error code
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
// v6.3.0: Skew Allowed Reason enum
export type SkewAllowedReason = 
  | 'PAIR_COST_IMPROVING'
  | 'DELTA_LOW'
  | 'TIME_SUFFICIENT'
  | 'SURVIVAL_MODE'
  | 'EXECUTION_FAILURE'
  | 'UNKNOWN';

export interface InventorySnapshot {
  market_id: string;
  asset: string;
  up_shares: number;
  down_shares: number;
  avg_up_cost?: number;
  avg_down_cost?: number;
  pair_cost?: number;
  unpaired_shares?: number;
  unpaired_notional_usd?: number;  // v6.4.0: USD value of unpaired exposure
  paired_shares?: number;          // v6.4.0: explicit paired count
  paired_delay_sec?: number;       // v6.4.0: time to complete hedge
  state: string;
  state_age_ms?: number;
  hedge_lag_ms?: number;
  trigger_type?: string;
  skew_allowed_reason?: SkewAllowedReason;  // v6.3.0
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

// ============================================
// v6.3.0: HEDGE INTENT TRACKING (Skew Explainability)
// ============================================

// Hedge Intent Status enum
export type HedgeIntentStatus = 
  | 'PENDING'
  | 'FILLED'
  | 'ABORTED_NO_EDGE'
  | 'ABORTED_FUNDS'
  | 'ABORTED_NO_DEPTH'
  | 'ABORTED_TIMEOUT'
  | 'ABORTED_RATE_LIMIT'
  | 'ABORTED_PAIR_COST_WORSENING';

// Hedge Intent Type enum
export type HedgeIntentType = 'ENTRY_HEDGE' | 'REBAL_HEDGE' | 'PANIC_HEDGE';

export interface HedgeIntent {
  ts: number;
  correlation_id?: string;
  run_id?: string;
  market_id: string;
  asset: string;
  side: 'UP' | 'DOWN';
  intent_type: HedgeIntentType;
  intended_qty: number;
  filled_qty?: number;
  status: HedgeIntentStatus;
  abort_reason?: string;
  price_at_intent?: number;
  price_at_resolution?: number;
  resolution_ts?: number;
}

export async function saveHedgeIntent(intent: HedgeIntent): Promise<boolean> {
  try {
    const result = await callProxy<{ success: boolean }>('save-hedge-intent', { intent });
    return result.success;
  } catch (error) {
    console.error('❌ saveHedgeIntent error:', error);
    return false;
  }
}

export async function updateHedgeIntent(
  correlationId: string,
  marketId: string,
  update: Partial<Pick<HedgeIntent, 'status' | 'filled_qty' | 'abort_reason' | 'price_at_resolution' | 'resolution_ts'>>
): Promise<boolean> {
  try {
    const result = await callProxy<{ success: boolean }>('update-hedge-intent', { 
      correlation_id: correlationId,
      market_id: marketId,
      update 
    });
    return result.success;
  } catch (error) {
    console.error('❌ updateHedgeIntent error:', error);
    return false;
  }
}

// ============================================
// v7.5.0: GABAGOOL LOGGING - NEW DECISION LOGS
// ============================================

import type {
  DecisionSnapshot,
  AccountPositionSnapshot,
  StateReconciliationResult,
  FillAttribution,
  HedgeSkipExplained,
  MtmSnapshot,
} from './decision-logs.js';
import type { GabagoolMetricsSnapshot } from './gabagool-metrics.js';

export async function saveDecisionSnapshot(snapshot: DecisionSnapshot): Promise<boolean> {
  try {
    const result = await callProxy<{ success: boolean }>('save-decision-snapshot', { snapshot });
    return result.success;
  } catch (error) {
    console.error('❌ saveDecisionSnapshot error:', error);
    return false;
  }
}

export async function saveDecisionSnapshots(snapshots: DecisionSnapshot[]): Promise<boolean> {
  if (snapshots.length === 0) return true;
  try {
    const result = await callProxy<{ success: boolean; count?: number }>('save-decision-snapshots', { snapshots });
    return result.success;
  } catch (error) {
    console.error('❌ saveDecisionSnapshots error:', error);
    return false;
  }
}

export async function saveAccountPositionSnapshot(snapshot: AccountPositionSnapshot): Promise<boolean> {
  try {
    const result = await callProxy<{ success: boolean }>('save-account-position-snapshot', { snapshot });
    return result.success;
  } catch (error) {
    console.error('❌ saveAccountPositionSnapshot error:', error);
    return false;
  }
}

export async function saveStateReconciliationResult(result: StateReconciliationResult): Promise<boolean> {
  try {
    const response = await callProxy<{ success: boolean }>('save-state-reconciliation', { result });
    return response.success;
  } catch (error) {
    console.error('❌ saveStateReconciliationResult error:', error);
    return false;
  }
}

export async function saveFillAttribution(attribution: FillAttribution): Promise<boolean> {
  try {
    const result = await callProxy<{ success: boolean }>('save-fill-attribution', { attribution });
    return result.success;
  } catch (error) {
    console.error('❌ saveFillAttribution error:', error);
    return false;
  }
}

export async function saveHedgeSkipLog(skip: HedgeSkipExplained): Promise<boolean> {
  try {
    const result = await callProxy<{ success: boolean }>('save-hedge-skip', { skip });
    return result.success;
  } catch (error) {
    console.error('❌ saveHedgeSkipLog error:', error);
    return false;
  }
}

export async function saveHedgeSkipLogs(skips: HedgeSkipExplained[]): Promise<boolean> {
  if (skips.length === 0) return true;
  try {
    const result = await callProxy<{ success: boolean; count?: number }>('save-hedge-skip-logs', { skips });
    return result.success;
  } catch (error) {
    console.error('❌ saveHedgeSkipLogs error:', error);
    return false;
  }
}

export async function saveMtmSnapshot(snapshot: MtmSnapshot): Promise<boolean> {
  try {
    const result = await callProxy<{ success: boolean }>('save-mtm-snapshot', { snapshot });
    return result.success;
  } catch (error) {
    console.error('❌ saveMtmSnapshot error:', error);
    return false;
  }
}

export async function saveGabagoolMetrics(metrics: GabagoolMetricsSnapshot): Promise<boolean> {
  try {
    const result = await callProxy<{ success: boolean }>('save-gabagool-metrics', { metrics });
    return result.success;
  } catch (error) {
    console.error('❌ saveGabagoolMetrics error:', error);
    return false;
  }
}

