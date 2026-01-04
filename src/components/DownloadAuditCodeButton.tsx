import { useState } from 'react';
import { FileCode, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';

/**
 * DownloadAuditCodeButton
 * 
 * Generates a read-only code export for audit of:
 * 1. Order placement & lifecycle
 * 2. Hedge logic
 * 3. Balance / allowance / funds checks
 * 4. Partial fills & state transitions
 * 5. Cancel/replace logic & rate limiting
 * 
 * No secrets, no API keys. Comments preserved.
 */

// ============================================================
// CODE SECTIONS FOR AUDIT EXPORT
// ============================================================

const AUDIT_SECTIONS = {
  // ==========================================================
  // 1️⃣ ORDER PLACEMENT & LIFECYCLE
  // ==========================================================
  orderPlacement: `
// ============================================================
// ORDER PLACEMENT & LIFECYCLE
// Source: local-runner/src/polymarket.ts
// ============================================================

interface OrderRequest {
  tokenId: string;
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
  orderType?: 'GTC' | 'GTD' | 'FOK';
}

interface OrderResponse {
  success: boolean;
  orderId?: string;
  avgPrice?: number;
  filledSize?: number;
  error?: string;
  status?: 'filled' | 'partial' | 'open' | 'pending' | 'unknown';
  failureReason?: 'no_liquidity' | 'cloudflare' | 'auth' | 'balance' | 'no_orderbook' | 'unknown';
}

// Simple in-process throttling/backoff to reduce WAF triggers
let lastOrderAttemptAtMs = 0;
let blockedUntilMs = 0;

// Exponential backoff state (to stop endless spam when API returns null/no orderId)
let invalidPayloadStreak = 0;
let noOrderIdStreak = 0;

function computeBackoffMs(baseMs: number, streak: number, maxMs: number): number {
  const s = Math.max(1, streak);
  const pow = Math.min(6, s - 1);
  return Math.min(maxMs, Math.floor(baseMs * Math.pow(2, pow)));
}

function applyBackoff(reason: 'invalid_payload' | 'no_order_id' | 'cloudflare', baseMs: number): number {
  const maxMs = Math.max(5_000, config.trading.cloudflareBackoffMs || 60_000);
  if (reason === 'invalid_payload' || reason === 'cloudflare') {
    invalidPayloadStreak = Math.min(50, invalidPayloadStreak + 1);
    noOrderIdStreak = 0;
    const ms = computeBackoffMs(baseMs, invalidPayloadStreak, maxMs);
    blockedUntilMs = Date.now() + ms;
    return ms;
  }
  noOrderIdStreak = Math.min(50, noOrderIdStreak + 1);
  invalidPayloadStreak = 0;
  const ms = computeBackoffMs(baseMs, noOrderIdStreak, maxMs);
  blockedUntilMs = Date.now() + ms;
  return ms;
}

// Main order placement function
async function placeOrder(order: OrderRequest): Promise<OrderResponse> {
  const nowMs = Date.now();

  // Validate price before proceeding
  if (!Number.isFinite(order.price) || order.price < 0.01 || order.price > 0.99) {
    return {
      success: false,
      error: \`Invalid price (\${order.price}), min: 0.01 - max: 0.99\`,
      failureReason: 'invalid_price' as any,
    };
  }

  // Hard backoff after Cloudflare/WAF blocks
  if (blockedUntilMs && nowMs < blockedUntilMs) {
    const remainingMs = blockedUntilMs - nowMs;
    return {
      success: false,
      error: \`Cloudflare blocked (cooldown \${Math.ceil(remainingMs / 1000)}s)\`,
    };
  }

  // Throttle order attempts to avoid spamming WAF
  const minIntervalMs = Math.max(0, config.trading.minOrderIntervalMs || 0);
  const sinceLastMs = nowMs - lastOrderAttemptAtMs;
  if (lastOrderAttemptAtMs > 0 && sinceLastMs < minIntervalMs) {
    const waitMs = minIntervalMs - sinceLastMs;
    await sleep(waitMs);
  }
  lastOrderAttemptAtMs = Date.now();

  // Price improvement: add 1-2¢ to increase fill probability
  const priceImprovement = order.price > 0.50 ? 0.02 : 0.01;
  const adjustedPrice = Math.min(order.price + priceImprovement, 0.99);

  // Check liquidity before placing
  const depth = await getOrderbookDepth(order.tokenId);
  if (!depth.hasLiquidity) {
    return { 
      success: false, 
      error: \`Insufficient liquidity (only \${depth.askVolume.toFixed(0)} shares available)\`,
      failureReason: 'no_liquidity',
    };
  }

  try {
    const client = await getClient();
    const side = order.side === 'BUY' ? Side.BUY : Side.SELL;
    
    const response = await client.createAndPostOrder(
      { tokenID: order.tokenId, price: adjustedPrice, size: order.size, side },
      { tickSize: '0.01', negRisk: false },
      OrderType.GTC
    );

    // Handle response validation...
    const resp = (response as any)?.data ?? response;
    
    if (resp == null || (typeof resp === 'object' && Object.keys(resp).length === 0)) {
      const backoffMs = applyBackoff('invalid_payload', 10_000);
      return { success: false, error: \`Empty response (cooldown \${Math.ceil(backoffMs / 1000)}s)\` };
    }

    if (resp?.success === false || resp?.errorMsg || resp?.error) {
      return { success: false, error: String(resp?.errorMsg || resp?.error) };
    }

    const orderId = resp?.orderID || resp?.orderId || resp?.order_id || resp?.id;
    
    if (!orderId) {
      applyBackoff('no_order_id', 5_000);
      return { success: false, error: 'No order ID returned' };
    }

    // Success - reset backoff streaks
    invalidPayloadStreak = 0;
    noOrderIdStreak = 0;

    return {
      success: true,
      orderId,
      avgPrice: resp?.average_price || resp?.avgPrice || order.price,
      filledSize: resp?.size_matched || resp?.filledSize,
      status: resp?.status || 'pending',
    };
  } catch (error: any) {
    return { success: false, error: error?.message || 'Unknown error' };
  }
}
`,

  // ==========================================================
  // 2️⃣ HEDGE LOGIC
  // ==========================================================
  hedgeLogic: `
// ============================================================
// HEDGE LOGIC
// Source: local-runner/src/hedge-escalator.ts + index.ts
// ============================================================

// HEDGE ESCALATOR CONFIGURATION
const HEDGE_ESCALATOR_CONFIG = {
  maxRetries: 3,
  retryDelayMs: 500,
  priceIncrementPerRetry: 0.01,     // +1¢ per retry
  maxHedgePrice: 0.85,              // Never pay > 85¢
  survivalMaxPrice: 0.95,           // In survival mode, accept up to 95¢
  panicModeThresholdSec: 120,       // < 2 min = panic mode
  survivalModeThresholdSec: 60,     // < 1 min = survival mode
  minSharesForRetry: 5,
  sizeReductionFactor: 0.8,         // Reduce size by 20% per retry
};

interface HedgeAttemptResult {
  ok: boolean;
  orderId?: string;
  filledShares?: number;
  avgPrice?: number;
  errorCode?: 'NO_LIQUIDITY' | 'INSUFFICIENT_FUNDS' | 'RATE_LIMITED' | 'API_ERROR' | 'MAX_RETRIES' | 'ABORTED';
  error?: string;
  attempts: number;
}

interface HedgeEscalatorInput {
  marketId: string;
  tokenId: string;
  side: 'UP' | 'DOWN';
  targetShares: number;
  initialPrice: number;
  secondsRemaining: number;
}

// Main hedge escalation function
async function executeHedgeWithEscalation(input: HedgeEscalatorInput): Promise<HedgeAttemptResult> {
  const { marketId, tokenId, side, targetShares, initialPrice, secondsRemaining } = input;
  
  // Determine mode based on time remaining
  const isPanicMode = secondsRemaining < HEDGE_ESCALATOR_CONFIG.panicModeThresholdSec;
  const isSurvivalMode = secondsRemaining < HEDGE_ESCALATOR_CONFIG.survivalModeThresholdSec;
  
  const maxPrice = isSurvivalMode 
    ? HEDGE_ESCALATOR_CONFIG.survivalMaxPrice 
    : HEDGE_ESCALATOR_CONFIG.maxHedgePrice;
  
  let currentShares = targetShares;
  let currentPrice = Math.min(initialPrice, maxPrice);
  
  for (let step = 1; step <= HEDGE_ESCALATOR_CONFIG.maxRetries; step++) {
    // Log attempt
    logHedgeEvent({ type: 'HEDGE_ATTEMPT', ts: Date.now(), marketId, side, step, price: currentPrice, shares: currentShares });
    
    // 1) Check rate limits
    const rateCheck = OrderRateLimiter.checkAllowed(marketId, 'order');
    if (!rateCheck.allowed) {
      if (isSurvivalMode && rateCheck.waitMs && rateCheck.waitMs < 5000) {
        await sleep(rateCheck.waitMs);
        continue;
      }
      return { ok: false, errorCode: 'RATE_LIMITED', error: rateCheck.reason, attempts: step };
    }
    
    // 2) Check balance/funds
    const notional = currentShares * currentPrice;
    const fundsCheck = await canPlaceOrder(marketId, side, notional);
    if (!fundsCheck.canProceed) {
      if (step < HEDGE_ESCALATOR_CONFIG.maxRetries) {
        currentShares = Math.floor(currentShares * HEDGE_ESCALATOR_CONFIG.sizeReductionFactor);
        if (currentShares < HEDGE_ESCALATOR_CONFIG.minSharesForRetry) {
          return { ok: false, errorCode: 'INSUFFICIENT_FUNDS', error: 'Shares below minimum', attempts: step };
        }
        continue;
      }
      return { ok: false, errorCode: 'INSUFFICIENT_FUNDS', error: fundsCheck.reason, attempts: step };
    }
    
    // 3) Check liquidity
    const depth = await getOrderbookDepth(tokenId);
    if (!depth.hasLiquidity || depth.askVolume < currentShares * 0.5) {
      if ((isPanicMode || isSurvivalMode) && depth.askVolume >= HEDGE_ESCALATOR_CONFIG.minSharesForRetry) {
        currentShares = Math.floor(depth.askVolume * 0.8);
        continue;
      }
      return { ok: false, errorCode: 'NO_LIQUIDITY', error: \`Liquidity: \${depth.askVolume.toFixed(0)} shares\`, attempts: step };
    }
    
    // 4) Reserve notional
    const tempOrderId = \`hedge_\${marketId}_\${side}_\${Date.now()}\`;
    ReserveManager.reserve(tempOrderId, marketId, notional, side);
    
    // 5) Place order
    try {
      OrderRateLimiter.recordEvent(marketId, 'order');
      
      const result = await placeOrder({
        tokenId,
        side: 'BUY',
        price: currentPrice,
        size: currentShares,
        orderType: 'GTC',
      });
      
      if (result.success) {
        const filledShares = result.status === 'filled' ? currentShares : (result.filledSize ?? 0);
        ReserveManager.release(tempOrderId);
        
        if (result.orderId && filledShares < currentShares) {
          const remainingNotional = (currentShares - filledShares) * currentPrice;
          ReserveManager.reserve(result.orderId, marketId, remainingNotional, side);
        }
        
        invalidateBalanceCache();
        logHedgeEvent({ type: 'HEDGE_SUCCESS', ts: Date.now(), marketId, side, step, price: result.avgPrice || currentPrice, shares: currentShares, orderId: result.orderId, filledShares });
        
        return { ok: true, orderId: result.orderId, filledShares, avgPrice: result.avgPrice || currentPrice, attempts: step };
      } else {
        ReserveManager.release(tempOrderId);
        OrderRateLimiter.recordFailure(marketId);
        
        if (result.error?.includes('balance') || result.error?.includes('allowance')) {
          invalidateBalanceCache();
        }
        
        // Escalate: increase price, possibly reduce size
        if (step < HEDGE_ESCALATOR_CONFIG.maxRetries) {
          currentPrice = Math.min(maxPrice, currentPrice + HEDGE_ESCALATOR_CONFIG.priceIncrementPerRetry);
          if (!isSurvivalMode) {
            currentShares = Math.floor(currentShares * HEDGE_ESCALATOR_CONFIG.sizeReductionFactor);
          }
          if (currentShares < HEDGE_ESCALATOR_CONFIG.minSharesForRetry) {
            return { ok: false, errorCode: 'MAX_RETRIES', error: 'Shares too low', attempts: step };
          }
          await sleep(HEDGE_ESCALATOR_CONFIG.retryDelayMs);
          continue;
        }
      }
    } catch (error: any) {
      ReserveManager.release(tempOrderId);
      OrderRateLimiter.recordFailure(marketId);
      if (step < HEDGE_ESCALATOR_CONFIG.maxRetries) {
        await sleep(HEDGE_ESCALATOR_CONFIG.retryDelayMs);
        continue;
      }
    }
  }
  
  // All retries exhausted
  logHedgeEvent({ type: 'HEDGE_ABORTED', ts: Date.now(), marketId, side, step: HEDGE_ESCALATOR_CONFIG.maxRetries, price: currentPrice, shares: currentShares, reason: 'Max retries exhausted' });
  
  return { ok: false, errorCode: 'MAX_RETRIES', error: 'All hedge attempts failed', attempts: HEDGE_ESCALATOR_CONFIG.maxRetries };
}

// ============================================================
// HEDGE BUILDING (from strategy)
// ============================================================

function buildHedge(side: Outcome, ask: number, tick: number, qty: number): TradeSignal {
  const cushion = STRATEGY.tick.hedgeCushion;  // 3 ticks
  const limit = roundUp(ask + cushion * tick, tick);
  const cappedLimit = Math.min(limit, STRATEGY.hedge.maxPrice);
  
  return {
    outcome: side,
    price: cappedLimit,
    shares: qty,
    reasoning: \`Hedge \${side} @ \${(cappedLimit * 100).toFixed(1)}¢\`,
    type: 'hedge',
    isMarketable: true,
    cushionTicks: cushion,
  };
}

function buildForceHedge(side: Outcome, ask: number, tick: number, qty: number, existingAvg: number): TradeSignal | null {
  const cushion = STRATEGY.tick.hedgeCushion;
  const limit = roundUp(ask + cushion * tick, tick);
  const cappedLimit = Math.min(limit, STRATEGY.hedge.maxPrice);
  
  const projectedCombined = existingAvg + cappedLimit;
  const maxAllowed = 1 + STRATEGY.edge.allowOverpay;  // 1.01 = max 1¢ overpay
  
  if (projectedCombined > maxAllowed) {
    return null;  // Would lose too much
  }
  
  return {
    outcome: side,
    price: cappedLimit,
    shares: qty,
    reasoning: \`FORCE Hedge \${side} @ \${(cappedLimit * 100).toFixed(0)}¢\`,
    type: 'hedge',
    isMarketable: true,
  };
}

// ============================================================
// PAIRING LOGIC - How hedge success is determined
// ============================================================

// A hedge is considered "successful" when:
// 1. Order is placed and fills (fully or partially)
// 2. The combined cost (opening + hedge) is <= $1.00 + allowOverpay
// 3. Both sides have shares (position.upShares > 0 && position.downShares > 0)

function determineState(inv: Inventory, pendingHedge: PendingHedge, upAsk?: number, downAsk?: number): State {
  const hasUp = inv.upShares > 0;
  const hasDown = inv.downShares > 0;
  
  if (!hasUp && !hasDown) return 'FLAT';
  if ((hasUp && !hasDown) || (!hasUp && hasDown)) return 'ONE_SIDED';
  
  // Both sides have shares = hedged
  if (upAsk !== undefined && downAsk !== undefined) {
    const combined = upAsk + downAsk;
    if (combined <= STRATEGY.edge.deepDislocationThreshold) {
      return 'DEEP_DISLOCATION';  // Very good edge
    }
  }
  
  const skew = Math.abs(calculateSkew(inv));
  if (skew > STRATEGY.skew.rebalanceThreshold) return 'SKEWED';
  
  return 'HEDGED';  // Success state
}
`,

  // ==========================================================
  // 3️⃣ BALANCE / ALLOWANCE / FUNDS CHECKS
  // ==========================================================
  fundingChecks: `
// ============================================================
// BALANCE / ALLOWANCE / FUNDS CHECKS
// Source: local-runner/src/funding.ts
// ============================================================

const FUNDING_CONFIG = {
  safetyBufferUsd: 10,          // Keep $10 buffer
  minBalanceForTrading: 50,     // Minimum $50 to start
  staleBalanceMs: 10_000,       // Balance cache TTL 10 seconds
};

interface ReservedOrder {
  orderId: string;
  marketId: string;
  notional: number;
  side: 'UP' | 'DOWN';
  createdAt: number;
}

interface BalanceCheckResult {
  canProceed: boolean;
  availableBalance: number;
  reservedNotional: number;
  freeBalance: number;
  requiredNotional: number;
  reasonCode?: 'INSUFFICIENT_BALANCE' | 'INSUFFICIENT_ALLOWANCE' | 'BELOW_MIN_BALANCE' | 'OK';
  reason?: string;
}

// ============================================================
// RESERVE MANAGER - Track reserved notional for open orders
// ============================================================

class ReserveManagerImpl {
  private reserves = new Map<string, ReservedOrder>();
  private marketReserves = new Map<string, number>();

  // Reserve notional for a new order
  reserve(orderId: string, marketId: string, notional: number, side: 'UP' | 'DOWN'): void {
    const order: ReservedOrder = { orderId, marketId, notional, side, createdAt: Date.now() };
    this.reserves.set(orderId, order);
    
    const current = this.marketReserves.get(marketId) || 0;
    this.marketReserves.set(marketId, current + notional);
  }

  // Release reservation when order is cancelled or fails
  release(orderId: string): void {
    const order = this.reserves.get(orderId);
    if (!order) return;
    
    this.reserves.delete(orderId);
    const current = this.marketReserves.get(order.marketId) || 0;
    this.marketReserves.set(order.marketId, Math.max(0, current - order.notional));
  }

  // Decrement reservation on partial/full fill
  onFill(orderId: string, filledNotional: number): void {
    const order = this.reserves.get(orderId);
    if (!order) return;
    
    const newNotional = Math.max(0, order.notional - filledNotional);
    if (newNotional <= 0) {
      this.release(orderId);
    } else {
      const reduction = order.notional - newNotional;
      order.notional = newNotional;
      const current = this.marketReserves.get(order.marketId) || 0;
      this.marketReserves.set(order.marketId, Math.max(0, current - reduction));
    }
  }

  getTotalReserved(): number {
    let total = 0;
    for (const order of this.reserves.values()) {
      total += order.notional;
    }
    return total;
  }

  // Reconcile reserves with actual open orders
  reconcile(activeOrderIds: Set<string>): void {
    const staleOrders: string[] = [];
    for (const orderId of this.reserves.keys()) {
      if (!activeOrderIds.has(orderId)) {
        staleOrders.push(orderId);
      }
    }
    for (const orderId of staleOrders) {
      this.release(orderId);
    }
  }
}

const ReserveManager = new ReserveManagerImpl();

// ============================================================
// BALANCE CACHE
// ============================================================

let cachedBalance: { usdc: number; fetchedAt: number } | null = null;

async function getAvailableBalance(forceRefresh = false): Promise<number> {
  const now = Date.now();
  
  if (!forceRefresh && cachedBalance && now - cachedBalance.fetchedAt < FUNDING_CONFIG.staleBalanceMs) {
    return cachedBalance.usdc;
  }
  
  try {
    const result = await getBalance();  // From polymarket.ts
    cachedBalance = { usdc: result.usdc ?? 0, fetchedAt: now };
    return cachedBalance.usdc;
  } catch (error) {
    return cachedBalance?.usdc ?? 0;
  }
}

function invalidateBalanceCacheNow(): void {
  cachedBalance = null;
}

// ============================================================
// ORDER PLACEMENT CHECK
// ============================================================

async function canPlaceOrder(
  marketId: string,
  side: 'UP' | 'DOWN',
  requiredNotional: number,
  forceRefresh = false
): Promise<BalanceCheckResult> {
  const availableBalance = await getAvailableBalance(forceRefresh);
  const reservedNotional = ReserveManager.getTotalReserved();
  const freeBalance = availableBalance - reservedNotional - FUNDING_CONFIG.safetyBufferUsd;
  
  // Check minimum balance for trading
  if (availableBalance < FUNDING_CONFIG.minBalanceForTrading) {
    return {
      canProceed: false,
      availableBalance,
      reservedNotional,
      freeBalance,
      requiredNotional,
      reasonCode: 'BELOW_MIN_BALANCE',
      reason: \`Balance $\${availableBalance.toFixed(2)} < minimum $\${FUNDING_CONFIG.minBalanceForTrading}\`,
    };
  }
  
  // Check if we have enough free balance
  if (freeBalance < requiredNotional) {
    return {
      canProceed: false,
      availableBalance,
      reservedNotional,
      freeBalance,
      requiredNotional,
      reasonCode: 'INSUFFICIENT_BALANCE',
      reason: \`Free balance $\${freeBalance.toFixed(2)} < required $\${requiredNotional.toFixed(2)}\`,
    };
  }
  
  return {
    canProceed: true,
    availableBalance,
    reservedNotional,
    freeBalance,
    requiredNotional,
    reasonCode: 'OK',
  };
}

// ============================================================
// BALANCE CHECK FOR OPENING (Strategy level)
// ============================================================

function checkBalanceForOpening(
  availableBalance: number,
  requiredNotional: number
): { canProceed: boolean; reason?: string } {
  const minRequired = requiredNotional * 2;  // Need 2x for opening + hedge
  
  if (availableBalance < minRequired) {
    return {
      canProceed: false,
      reason: \`Insufficient balance: $\${availableBalance.toFixed(2)} < $\${minRequired.toFixed(2)}\`,
    };
  }
  
  return { canProceed: true };
}
`,

  // ==========================================================
  // 4️⃣ PARTIAL FILLS & STATE TRANSITIONS
  // ==========================================================
  partialFillsAndState: `
// ============================================================
// PARTIAL FILLS & STATE TRANSITIONS
// Source: local-runner/src/index.ts + loveable-strat.ts
// ============================================================

// ============================================================
// HOW PARTIAL FILLS ARE PROCESSED
// ============================================================

// In executeTrade() - main order execution function:
async function executeTrade(
  ctx: MarketContext,
  outcome: Outcome,
  price: number,
  shares: number,
  reasoning: string,
  intent: TradeIntent = 'ENTRY'
): Promise<boolean> {
  
  // ... order placement ...
  
  const result = await placeOrder({ tokenId, side: 'BUY', price, size: shares, orderType: 'GTC' });
  
  if (!result.success) {
    ReserveManager.release(tempOrderId);
    recordOrderFailure(ctx.slug);
    
    // HEDGE ESCALATION on failure
    if (intent === 'HEDGE' && result.error) {
      const isBalanceError = result.error.includes('balance') || result.error.includes('allowance');
      const isLiquidityError = result.error.includes('liquidity');
      
      if (isBalanceError || isLiquidityError) {
        const escalationResult = await executeHedgeWithEscalation({ ... });
        
        if (escalationResult.ok) {
          // Update position with escalation result
          const filledShares = escalationResult.filledShares ?? shares;
          const avgPrice = escalationResult.avgPrice ?? price;
          
          if (outcome === 'UP') {
            ctx.position.upShares += filledShares;
            ctx.position.upInvested += filledShares * avgPrice;
          } else {
            ctx.position.downShares += filledShares;
            ctx.position.downInvested += filledShares * avgPrice;
          }
          return true;
        }
      }
    }
    return false;
  }

  // ============================================================
  // PARTIAL FILL HANDLING
  // ============================================================
  
  const status = result.status ?? 'unknown';
  const filledShares =
    status === 'filled'
      ? shares
      : status === 'partial'
        ? (result.filledSize ?? 0)
        : 0;

  // Update reserve based on fill
  if (result.orderId) {
    ReserveManager.release(tempOrderId);
    if (filledShares < shares) {
      // PARTIAL FILL - reserve remaining notional
      const remainingNotional = (shares - filledShares) * price;
      ReserveManager.reserve(result.orderId, ctx.slug, remainingNotional, outcome);
    }
    // If fully filled, reservation is released via onFill
    if (filledShares > 0) {
      ReserveManager.onFill(result.orderId, filledShares * price);
    }
  }

  // Update local position with filled shares
  if (filledShares > 0) {
    if (outcome === 'UP') {
      ctx.position.upShares += filledShares;
      ctx.position.upInvested += filledShares * price;
    } else {
      ctx.position.downShares += filledShares;
      ctx.position.downInvested += filledShares * price;
    }
    
    // Record fill for telemetry
    recordFill({
      marketId: ctx.slug,
      asset: ctx.market.asset as 'BTC' | 'ETH',
      side: outcome,
      orderId: result.orderId || null,
      fillQty: filledShares,
      fillPrice: result.avgPrice || price,
      intent,
      secondsRemaining: remainingSeconds,
      spotPrice: ctx.spotPrice,
      strikePrice: ctx.strikePrice,
      btcPrice: lastBtcPrice,
      ethPrice: lastEthPrice,
      upBestAsk: ctx.book.up.ask,
      downBestAsk: ctx.book.down.ask,
    });
  }

  // Save to database (with appropriate status)
  await saveTrade({
    market_slug: ctx.slug,
    asset: ctx.market.asset,
    outcome,
    shares: filledShares > 0 ? filledShares : shares,
    price,
    total: (filledShares > 0 ? filledShares : shares) * price,
    order_id: result.orderId,
    status: filledShares > 0 ? (status === 'partial' ? 'partial' : 'filled') : 'pending',
    reasoning,
    event_start_time: ctx.market.eventStartTime,
    event_end_time: ctx.market.eventEndTime,
    avg_fill_price: result.avgPrice || price,
  });

  invalidateBalanceCache();
  return true;
}

// ============================================================
// STATE TRANSITIONS
// ============================================================

type State = 'FLAT' | 'ONE_SIDED' | 'HEDGED' | 'SKEWED' | 'DEEP_DISLOCATION' | 'UNWIND';

// State determination based on inventory
function determineState(
  inv: Inventory,
  pendingHedge: PendingHedge,
  upAsk?: number,
  downAsk?: number
): State {
  const hasUp = inv.upShares > 0;
  const hasDown = inv.downShares > 0;
  
  // FLAT → no position
  if (!hasUp && !hasDown) return 'FLAT';
  
  // ONE_SIDED → only one side has shares (needs hedge)
  if ((hasUp && !hasDown) || (!hasUp && hasDown)) return 'ONE_SIDED';
  
  // Both sides have shares - check for DEEP_DISLOCATION
  if (upAsk !== undefined && downAsk !== undefined) {
    const combined = upAsk + downAsk;
    if (combined <= STRATEGY.edge.deepDislocationThreshold) {  // 0.96
      return 'DEEP_DISLOCATION';  // Very good edge - accumulate more
    }
  }
  
  // Check skew level
  const skew = Math.abs(calculateSkew(inv));
  if (skew > STRATEGY.skew.rebalanceThreshold) {  // 0.20
    return 'SKEWED';  // Imbalanced position
  }
  
  return 'HEDGED';  // Balanced position
}

// Events that trigger state changes:
// 1. ENTRY fill → FLAT → ONE_SIDED
// 2. HEDGE fill → ONE_SIDED → HEDGED
// 3. Market price change → HEDGED → DEEP_DISLOCATION (if combined < 96¢)
// 4. Skew accumulation → HEDGED → SKEWED (if imbalance > 20%)
// 5. Time running out → Any → UNWIND

function shouldUnwind(
  secondsRemaining: number,
  hedgeLagSec: number,
  noLiquidityStreak: number
): { unwind: boolean; reason: string } {
  if (secondsRemaining < STRATEGY.timing.unwindStartSec) {  // 45s
    return { unwind: true, reason: \`Time critical: \${secondsRemaining}s remaining\` };
  }
  if (hedgeLagSec > STRATEGY.timing.hedgeTimeoutSec) {  // 12s
    return { unwind: true, reason: \`Hedge timeout: \${hedgeLagSec}s lag\` };
  }
  if (noLiquidityStreak >= 6) {
    return { unwind: true, reason: \`No liquidity streak: \${noLiquidityStreak}\` };
  }
  return { unwind: false, reason: '' };
}

// Inventory update on fill (strategy level)
function onFill(
  side: Outcome,
  qty: number,
  price: number,
  inv: Inventory,
  pendingHedge: PendingHedge
): void {
  const now = Date.now();
  inv.lastFillTs = now;
  inv.firstFillTs ??= now;

  if (side === 'UP') {
    inv.upShares += qty;
    inv.upCost += qty * price;
    pendingHedge.down += qty;  // Need to hedge DOWN
  } else {
    inv.downShares += qty;
    inv.downCost += qty * price;
    pendingHedge.up += qty;  // Need to hedge UP
  }
}
`,

  // ==========================================================
  // 5️⃣ CANCEL/REPLACE LOGIC & RATE LIMITING
  // ==========================================================
  cancelReplaceLogic: `
// ============================================================
// CANCEL/REPLACE LOGIC & RATE LIMITING
// Source: local-runner/src/order-rate-limiter.ts
// ============================================================

// RATE LIMIT CONFIGURATION
const RATE_LIMIT_CONFIG = {
  // Per market limits
  maxCancelReplacePerMarketPerMinute: 10,
  maxOrdersPerMarketPerMinute: 15,
  
  // Global limits
  maxTotalCancelsPerMinute: 50,
  maxTotalOrdersPerMinute: 100,
  
  // Pause duration when limit exceeded
  marketPauseDurationMs: 30_000,  // 30 seconds
  globalPauseDurationMs: 60_000,  // 60 seconds
  
  // Circuit breaker thresholds
  consecutiveFailuresBeforeBreak: 5,
  circuitBreakerResetMs: 120_000,  // 2 minutes
};

interface RateLimitEvent {
  type: 'order' | 'cancel' | 'replace';
  marketId: string;
  ts: number;
}

interface MarketState {
  marketId: string;
  events: RateLimitEvent[];
  pausedUntil: number;
  consecutiveFailures: number;
  lastFailureTs: number;
}

interface RateLimitResult {
  allowed: boolean;
  reason?: string;
  pausedUntilMs?: number;
  waitMs?: number;
}

interface CircuitBreakerState {
  isOpen: boolean;
  openedAt: number;
  failures: number;
  lastFailure: number;
}

// ============================================================
// RATE LIMITER IMPLEMENTATION
// ============================================================

class OrderRateLimiterImpl {
  private marketStates = new Map<string, MarketState>();
  private globalEvents: RateLimitEvent[] = [];
  private globalPausedUntil = 0;
  private circuitBreaker: CircuitBreakerState = {
    isOpen: false,
    openedAt: 0,
    failures: 0,
    lastFailure: 0,
  };

  // Check if an operation is allowed for a market
  checkAllowed(marketId: string, type: 'order' | 'cancel' | 'replace'): RateLimitResult {
    const now = Date.now();
    
    // Check circuit breaker first
    if (this.circuitBreaker.isOpen) {
      if (now - this.circuitBreaker.openedAt > RATE_LIMIT_CONFIG.circuitBreakerResetMs) {
        this.resetCircuitBreaker();
      } else {
        const waitMs = RATE_LIMIT_CONFIG.circuitBreakerResetMs - (now - this.circuitBreaker.openedAt);
        return { allowed: false, reason: 'CIRCUIT_BREAKER_OPEN', waitMs };
      }
    }
    
    // Check global pause
    if (now < this.globalPausedUntil) {
      return { allowed: false, reason: 'GLOBAL_PAUSE', pausedUntilMs: this.globalPausedUntil, waitMs: this.globalPausedUntil - now };
    }
    
    // Check global rate limits
    this.pruneOldEvents();
    
    const cancelReplaceEvents = this.globalEvents.filter(e => e.type === 'cancel' || e.type === 'replace');
    if (cancelReplaceEvents.length >= RATE_LIMIT_CONFIG.maxTotalCancelsPerMinute) {
      this.globalPausedUntil = now + RATE_LIMIT_CONFIG.globalPauseDurationMs;
      return { allowed: false, reason: 'GLOBAL_CANCEL_LIMIT', pausedUntilMs: this.globalPausedUntil, waitMs: RATE_LIMIT_CONFIG.globalPauseDurationMs };
    }
    
    if (this.globalEvents.length >= RATE_LIMIT_CONFIG.maxTotalOrdersPerMinute) {
      this.globalPausedUntil = now + RATE_LIMIT_CONFIG.globalPauseDurationMs;
      return { allowed: false, reason: 'GLOBAL_ORDER_LIMIT', pausedUntilMs: this.globalPausedUntil, waitMs: RATE_LIMIT_CONFIG.globalPauseDurationMs };
    }
    
    // Check market-specific limits
    const state = this.getOrCreateMarketState(marketId);
    
    if (now < state.pausedUntil) {
      return { allowed: false, reason: 'MARKET_PAUSED', pausedUntilMs: state.pausedUntil, waitMs: state.pausedUntil - now };
    }
    
    // Prune old market events
    const oneMinuteAgo = now - 60_000;
    state.events = state.events.filter(e => e.ts > oneMinuteAgo);
    
    // Check cancel/replace limit
    const marketCancelReplace = state.events.filter(e => e.type === 'cancel' || e.type === 'replace');
    if ((type === 'cancel' || type === 'replace') && 
        marketCancelReplace.length >= RATE_LIMIT_CONFIG.maxCancelReplacePerMarketPerMinute) {
      state.pausedUntil = now + RATE_LIMIT_CONFIG.marketPauseDurationMs;
      return { allowed: false, reason: 'MARKET_CANCEL_LIMIT', pausedUntilMs: state.pausedUntil, waitMs: RATE_LIMIT_CONFIG.marketPauseDurationMs };
    }
    
    // Check order limit
    if (state.events.length >= RATE_LIMIT_CONFIG.maxOrdersPerMarketPerMinute) {
      state.pausedUntil = now + RATE_LIMIT_CONFIG.marketPauseDurationMs;
      return { allowed: false, reason: 'MARKET_ORDER_LIMIT', pausedUntilMs: state.pausedUntil, waitMs: RATE_LIMIT_CONFIG.marketPauseDurationMs };
    }
    
    return { allowed: true };
  }

  // Record an operation (call after successful check)
  recordEvent(marketId: string, type: 'order' | 'cancel' | 'replace'): void {
    const now = Date.now();
    const event: RateLimitEvent = { type, marketId, ts: now };
    
    this.globalEvents.push(event);
    const state = this.getOrCreateMarketState(marketId);
    state.events.push(event);
    state.consecutiveFailures = 0;  // Reset on success
  }

  // Record a failure (for circuit breaker)
  recordFailure(marketId: string): void {
    const now = Date.now();
    const state = this.getOrCreateMarketState(marketId);
    
    state.consecutiveFailures++;
    state.lastFailureTs = now;
    this.circuitBreaker.failures++;
    this.circuitBreaker.lastFailure = now;
    
    // Trip circuit breaker if too many consecutive failures
    if (state.consecutiveFailures >= RATE_LIMIT_CONFIG.consecutiveFailuresBeforeBreak) {
      this.tripCircuitBreaker();
    }
  }

  private tripCircuitBreaker(): void {
    if (this.circuitBreaker.isOpen) return;
    
    this.circuitBreaker.isOpen = true;
    this.circuitBreaker.openedAt = Date.now();
    console.log(\`⚡ [CIRCUIT_BREAKER_TRIGGERED] failures=\${this.circuitBreaker.failures}\`);
  }

  private resetCircuitBreaker(): void {
    this.circuitBreaker.isOpen = false;
    this.circuitBreaker.failures = 0;
  }

  private getOrCreateMarketState(marketId: string): MarketState {
    let state = this.marketStates.get(marketId);
    if (!state) {
      state = { marketId, events: [], pausedUntil: 0, consecutiveFailures: 0, lastFailureTs: 0 };
      this.marketStates.set(marketId, state);
    }
    return state;
  }

  private pruneOldEvents(): void {
    const oneMinuteAgo = Date.now() - 60_000;
    this.globalEvents = this.globalEvents.filter(e => e.ts > oneMinuteAgo);
  }
}

const OrderRateLimiter = new OrderRateLimiterImpl();

// Convenience functions
function canPlaceOrderRateLimited(marketId: string): RateLimitResult {
  return OrderRateLimiter.checkAllowed(marketId, 'order');
}

function canCancelOrderRateLimited(marketId: string): RateLimitResult {
  return OrderRateLimiter.checkAllowed(marketId, 'cancel');
}

function recordOrderPlaced(marketId: string): void {
  OrderRateLimiter.recordEvent(marketId, 'order');
}

function recordOrderFailure(marketId: string): void {
  OrderRateLimiter.recordFailure(marketId);
}
`,
};

export function DownloadAuditCodeButton() {
  const [isDownloading, setIsDownloading] = useState(false);

  const downloadAuditCode = async () => {
    setIsDownloading(true);
    
    try {
      toast.info('Generating audit export...');

      // Build full document
      const timestamp = new Date().toISOString();
      const header = `
// ============================================================
// EXECUTION & ORDER LIFECYCLE AUDIT EXPORT
// Generated: ${timestamp}
// Version: 6.0.0
// ============================================================
//
// This is a READ-ONLY export for audit purposes.
// No secrets, no API keys. Comments preserved.
//
// Sections:
// 1️⃣ Order Placement & Lifecycle
// 2️⃣ Hedge Logic
// 3️⃣ Balance / Allowance / Funds Checks
// 4️⃣ Partial Fills & State Transitions
// 5️⃣ Cancel/Replace Logic & Rate Limiting
//
// Purpose:
// - Correctness audit
// - Execution reliability
// - Race condition detection
// - State/execution consistency
// ============================================================

`;

      const fullDocument = [
        header,
        AUDIT_SECTIONS.orderPlacement,
        AUDIT_SECTIONS.hedgeLogic,
        AUDIT_SECTIONS.fundingChecks,
        AUDIT_SECTIONS.partialFillsAndState,
        AUDIT_SECTIONS.cancelReplaceLogic,
      ].join('\n\n');

      // Create and download file
      const blob = new Blob([fullDocument], { type: 'text/typescript;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `execution_audit_v6.0.0_${new Date().toISOString().slice(0, 10)}.ts`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);

      const sizeKB = (fullDocument.length / 1024).toFixed(1);
      toast.success(`Downloaded audit export (${sizeKB} KB)`, {
        description: '5 sections: Order Placement, Hedge Logic, Funding, State Transitions, Rate Limiting',
      });
    } catch (error) {
      console.error('Download error:', error);
      toast.error('Failed to generate audit export');
    } finally {
      setIsDownloading(false);
    }
  };

  return (
    <Button
      onClick={downloadAuditCode}
      disabled={isDownloading}
      variant="outline"
      size="sm"
      className="font-mono text-xs"
    >
      {isDownloading ? (
        <Loader2 className="w-3 h-3 mr-2 animate-spin" />
      ) : (
        <FileCode className="w-3 h-3 mr-2" />
      )}
      {isDownloading ? 'Generating...' : 'Audit Export'}
    </Button>
  );
}
