// ============================================================
// V26 LOVEABLE STRATEGY - SIMPLE PRE-MARKET DOWN TRADER
// ============================================================
//
// Strategy: Buy 10 DOWN shares at $0.48 before each market opens
// - Place order 15 seconds before market start
// - Cancel if not filled within 30 seconds
// - Hold until settlement
//
// Expected: 50/50 win rate, profit from fill-rate edge at $0.48
// ============================================================

export const V26_VERSION = '26.0.0';
export const V26_NAME = 'Loveable V26 - Pre-Market DOWN Trader';

// Default Configuration (can be overridden by database)
export const V26_CONFIG = {
  // Which assets to trade
  assets: ['BTC', 'ETH', 'SOL', 'XRP'] as const,
  
  // Order parameters
  side: 'DOWN' as const,
  price: 0.48,
  shares: 10,
  
  // Timing (in seconds relative to market start)
  maxLeadTimeSec: 600, // Place order up to 10 minutes before market opens
  minLeadTimeSec: 60,  // Must place at least 1 minute before start (after this = too late)
  cancelAfterStartSec: 30, // Cancel 30s AFTER market start if not filled
  
  // Safety
  maxOrdersPerBar: 1, // Only 1 order per market per asset
  enabled: true,
};

// Re-export config loader
export { runtimeConfig, loadV26Config, getV26Config } from './config-loader.js';

// Types
export interface V26Market {
  id: string;
  slug: string;
  asset: string;
  eventStartTime: Date;
  eventEndTime: Date;
  downTokenId: string;
  upTokenId?: string;
}

export interface V26Trade {
  id?: string;
  asset: string;
  marketId: string;
  marketSlug: string;
  eventStartTime: Date;
  eventEndTime: Date;
  orderId?: string;
  side: 'UP' | 'DOWN';
  price: number;
  shares: number;
  status: 'pending' | 'placed' | 'filled' | 'partial' | 'cancelled' | 'expired';
  filledShares: number;
  avgFillPrice?: number;
  fillTimeMs?: number;
  result?: 'UP' | 'DOWN';
  pnl?: number;
  settledAt?: Date;
  runId?: string;
  errorMessage?: string;
}

export interface V26Stats {
  totalTrades: number;
  filledTrades: number;
  settledTrades: number;
  wins: number;
  losses: number;
  winRatePct: number;
  totalPnl: number;
  totalInvested: number;
  lastTradeAt?: Date;
}

// In-memory state for current run
const scheduledMarkets = new Map<string, NodeJS.Timeout>();
const activeOrders = new Map<string, V26Trade>();

/**
 * Calculate time until order should be placed
 */
export function getTimeUntilOrderPlacement(market: V26Market): number {
  const placeTime = new Date(market.eventStartTime.getTime() - V26_CONFIG.placeOrderBeforeStartSec * 1000);
  return placeTime.getTime() - Date.now();
}

/**
 * Check if market is eligible for V26 trading
 */
export function isMarketEligible(market: V26Market): boolean {
  // Must be an enabled asset
  if (!V26_CONFIG.assets.includes(market.asset as any)) {
    return false;
  }
  
  // Market must not have started yet
  if (market.eventStartTime.getTime() <= Date.now()) {
    return false;
  }
  
  // Must have DOWN token ID
  if (!market.downTokenId) {
    return false;
  }
  
  // Not already scheduled
  if (scheduledMarkets.has(market.id)) {
    return false;
  }
  
  return true;
}

/**
 * Schedule a V26 trade for a market
 */
export function scheduleV26Trade(
  market: V26Market,
  onPlaceOrder: (trade: V26Trade) => Promise<void>,
  onLog: (msg: string) => void
): void {
  const key = `${market.id}:${market.asset}`;
  
  if (scheduledMarkets.has(key)) {
    onLog(`[V26] Already scheduled: ${key}`);
    return;
  }
  
  const timeUntilPlace = getTimeUntilOrderPlacement(market);
  
  if (timeUntilPlace < 0) {
    onLog(`[V26] Too late to schedule: ${market.asset} ${market.slug}`);
    return;
  }
  
  onLog(`[V26] Scheduling ${market.asset} ${market.slug} in ${Math.round(timeUntilPlace / 1000)}s`);
  
  const timeout = setTimeout(async () => {
    scheduledMarkets.delete(key);
    
    const trade: V26Trade = {
      asset: market.asset,
      marketId: market.id,
      marketSlug: market.slug,
      eventStartTime: market.eventStartTime,
      eventEndTime: market.eventEndTime,
      side: 'DOWN',
      price: V26_CONFIG.price,
      shares: V26_CONFIG.shares,
      status: 'pending',
      filledShares: 0,
    };
    
    try {
      await onPlaceOrder(trade);
    } catch (err) {
      onLog(`[V26] Error placing order: ${err}`);
      trade.status = 'cancelled';
      trade.errorMessage = String(err);
    }
  }, timeUntilPlace);
  
  scheduledMarkets.set(key, timeout);
}

/**
 * Cancel all scheduled V26 trades
 */
export function cancelAllScheduled(): void {
  for (const timeout of scheduledMarkets.values()) {
    clearTimeout(timeout);
  }
  scheduledMarkets.clear();
}

/**
 * Get count of scheduled trades
 */
export function getScheduledCount(): number {
  return scheduledMarkets.size;
}

/**
 * Calculate PnL for a settled trade
 */
export function calculateV26Pnl(trade: V26Trade): number {
  if (!trade.result || trade.filledShares === 0) {
    return 0;
  }
  
  const cost = trade.filledShares * (trade.avgFillPrice ?? trade.price);
  
  if (trade.result === 'DOWN') {
    // WIN: Get $1 per share
    return trade.filledShares - cost;
  } else {
    // LOSS: Shares worth $0
    return -cost;
  }
}

/**
 * Log V26 status
 */
export function logV26Status(): void {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  🎯 V26 LOVEABLE STRATEGY STATUS                              ║');
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log(`║  Version:     ${V26_VERSION.padEnd(47)}║`);
  console.log(`║  Enabled:     ${V26_CONFIG.enabled ? 'YES' : 'NO'}`.padEnd(66) + '║');
  console.log(`║  Assets:      ${V26_CONFIG.assets.join(', ')}`.padEnd(66) + '║');
  console.log(`║  Side:        ${V26_CONFIG.side} @ $${V26_CONFIG.price}`.padEnd(66) + '║');
  console.log(`║  Shares:      ${V26_CONFIG.shares} per trade`.padEnd(66) + '║');
  console.log(`║  Scheduled:   ${scheduledMarkets.size} markets`.padEnd(66) + '║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');
}

export {
  scheduledMarkets,
  activeOrders,
};
