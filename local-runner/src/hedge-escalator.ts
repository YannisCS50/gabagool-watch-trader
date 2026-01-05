/**
 * hedge-escalator.ts - Atomic Hedge Retry with Escalation
 * ============================================================
 * v6.0.0 Reliability Patch
 * 
 * Purpose:
 * - Proper escalation logic for hedge failures
 * - Never assume hedge placed on failure
 * - Structured logging: HEDGE_ATTEMPT, HEDGE_FAILED, HEDGE_ESCALATE_STEP, HEDGE_ABORTED
 * - Return atomic result { ok: true, orderId } | { ok: false, errorCode }
 */

import { getOrderbookDepth, invalidateBalanceCache } from './polymarket.js';
import { placeOrderWithCaps, type OrderContext } from './hard-invariants.js';
import { canPlaceOrder, ReserveManager } from './funding.js';
import { OrderRateLimiter } from './order-rate-limiter.js';

// ============================================================
// CONFIGURATION
// ============================================================

export const HEDGE_ESCALATOR_CONFIG = {
  maxRetries: 3,                    // Max escalation steps
  retryDelayMs: 500,                // Delay between retries
  priceIncrementPerRetry: 0.01,     // +1¢ per retry
  maxHedgePrice: 0.85,              // Never pay > 85¢ for hedge
  survivalMaxPrice: 0.95,           // In survival mode, accept up to 95¢
  panicModeThresholdSec: 120,       // < 2 min = panic mode
  survivalModeThresholdSec: 60,     // < 1 min = survival mode
  minSharesForRetry: 5,             // Don't retry below 5 shares
  sizeReductionFactor: 0.8,         // Reduce size by 20% per retry
  logEvents: true,
  // v6.0.1: Pair-cost gate
  allowOverpay: 0.01,               // Max 1¢ overpay allowed
};

// ============================================================
// TYPES
// ============================================================

export interface HedgeAttemptResult {
  ok: boolean;
  orderId?: string;
  filledShares?: number;
  avgPrice?: number;
  errorCode?: 'NO_LIQUIDITY' | 'INSUFFICIENT_FUNDS' | 'RATE_LIMITED' | 'API_ERROR' | 'MAX_RETRIES' | 'ABORTED' | 'PAIR_COST_WORSENING';
  error?: string;
  attempts: number;
}

export interface HedgeEscalatorInput {
  marketId: string;
  tokenId: string;
  side: 'UP' | 'DOWN';
  targetShares: number;
  initialPrice: number;
  secondsRemaining: number;
  // v6.0.1: For pair-cost gate
  avgOtherSideCost?: number;  // Average cost of the other side
  currentPairCost?: number;   // Current total pair cost
  // v7.2.5: Required for hard cap enforcement
  asset: string;
  currentUpShares: number;
  currentDownShares: number;
  upCost?: number;
  downCost?: number;
  runId?: string;
}

export interface HedgeEvent {
  type: 'HEDGE_ATTEMPT' | 'HEDGE_FAILED' | 'HEDGE_ESCALATE_STEP' | 'HEDGE_ABORTED' | 'HEDGE_SUCCESS';
  ts: number;
  marketId: string;
  side: 'UP' | 'DOWN';
  step: number;
  price: number;
  shares: number;
  reason?: string;
  orderId?: string;
  filledShares?: number;
}

// ============================================================
// HEDGE ESCALATOR
// ============================================================

const hedgeEventLog: HedgeEvent[] = [];

function logHedgeEvent(event: HedgeEvent): void {
  hedgeEventLog.push(event);
  
  // Keep only last 500 events
  while (hedgeEventLog.length > 500) {
    hedgeEventLog.shift();
  }
  
  if (HEDGE_ESCALATOR_CONFIG.logEvents) {
    const prefix = event.type === 'HEDGE_SUCCESS' ? '✅' :
                   event.type === 'HEDGE_ABORTED' ? '🚨' :
                   event.type === 'HEDGE_FAILED' ? '❌' : '🔄';
    console.log(`${prefix} [${event.type}] ${event.side} on ${event.marketId} step=${event.step} @ ${(event.price * 100).toFixed(0)}¢ × ${event.shares}sh${event.reason ? ` (${event.reason})` : ''}`);
  }
}

export async function executeHedgeWithEscalation(input: HedgeEscalatorInput): Promise<HedgeAttemptResult> {
  const { marketId, tokenId, side, targetShares, initialPrice, secondsRemaining, avgOtherSideCost, currentPairCost, asset, currentUpShares, currentDownShares, upCost, downCost, runId } = input;
  
  // Determine mode
  const isPanicMode = secondsRemaining < HEDGE_ESCALATOR_CONFIG.panicModeThresholdSec;
  const isSurvivalMode = secondsRemaining < HEDGE_ESCALATOR_CONFIG.survivalModeThresholdSec;
  
  const maxPrice = isSurvivalMode 
    ? HEDGE_ESCALATOR_CONFIG.survivalMaxPrice 
    : HEDGE_ESCALATOR_CONFIG.maxHedgePrice;
  
  let currentShares = targetShares;
  let currentPrice = Math.min(initialPrice, maxPrice);
  
  // v6.0.1: Extra logging
  console.log(`🔄 [HEDGE_ESCALATOR] Starting for ${side} on ${marketId}`);
  console.log(`   targetShares=${targetShares}, initialPrice=${(initialPrice * 100).toFixed(0)}¢`);
  console.log(`   avgOtherSideCost=${avgOtherSideCost ? (avgOtherSideCost * 100).toFixed(0) + '¢' : 'N/A'}`);
  console.log(`   currentPairCost=${currentPairCost ? (currentPairCost * 100).toFixed(0) + '¢' : 'N/A'}`);
  console.log(`   mode: ${isSurvivalMode ? 'SURVIVAL' : isPanicMode ? 'PANIC' : 'NORMAL'}`);
  
  for (let step = 1; step <= HEDGE_ESCALATOR_CONFIG.maxRetries; step++) {
    // v6.0.1: B) Pair-cost gate - check projected pair cost before each retry
    if (avgOtherSideCost !== undefined && !isSurvivalMode) {
      const projectedPairCost = avgOtherSideCost + currentPrice;
      const maxAllowed = 1 + HEDGE_ESCALATOR_CONFIG.allowOverpay;
      
      console.log(`   [Step ${step}] projectedPairCost=${(projectedPairCost * 100).toFixed(0)}¢ vs max=${(maxAllowed * 100).toFixed(0)}¢`);
      
      if (projectedPairCost > maxAllowed) {
        logHedgeEvent({
          type: 'HEDGE_ABORTED',
          ts: Date.now(),
          marketId,
          side,
          step,
          price: currentPrice,
          shares: currentShares,
          reason: `PAIR_COST_WORSENING: projected ${(projectedPairCost * 100).toFixed(0)}¢ > ${(maxAllowed * 100).toFixed(0)}¢ max`,
        });
        
        return {
          ok: false,
          errorCode: 'PAIR_COST_WORSENING',
          error: `Projected pair cost ${(projectedPairCost * 100).toFixed(0)}¢ exceeds max ${(maxAllowed * 100).toFixed(0)}¢`,
          attempts: step,
        };
      }
    }
    
    // Log attempt
    logHedgeEvent({
      type: 'HEDGE_ATTEMPT',
      ts: Date.now(),
      marketId,
      side,
      step,
      price: currentPrice,
      shares: currentShares,
    });
    
    // 1) Check rate limits
    const rateCheck = OrderRateLimiter.checkAllowed(marketId, 'order');
    if (!rateCheck.allowed) {
      logHedgeEvent({
        type: 'HEDGE_FAILED',
        ts: Date.now(),
        marketId,
        side,
        step,
        price: currentPrice,
        shares: currentShares,
        reason: `Rate limited: ${rateCheck.reason}`,
      });
      
      // In survival mode, wait and retry
      if (isSurvivalMode && rateCheck.waitMs && rateCheck.waitMs < 5000) {
        await sleep(rateCheck.waitMs);
        continue;
      }
      
      return {
        ok: false,
        errorCode: 'RATE_LIMITED',
        error: rateCheck.reason,
        attempts: step,
      };
    }

    // 2) Check balance/funds
    const notional = currentShares * currentPrice;
    const fundsCheck = await canPlaceOrder(marketId, side, notional);
    if (!fundsCheck.canProceed) {
      logHedgeEvent({
        type: 'HEDGE_FAILED',
        ts: Date.now(),
        marketId,
        side,
        step,
        price: currentPrice,
        shares: currentShares,
        reason: `Insufficient funds: ${fundsCheck.reason}`,
      });
      
      // Try with reduced size
      if (step < HEDGE_ESCALATOR_CONFIG.maxRetries) {
        currentShares = Math.floor(currentShares * HEDGE_ESCALATOR_CONFIG.sizeReductionFactor);
        if (currentShares < HEDGE_ESCALATOR_CONFIG.minSharesForRetry) {
          logHedgeEvent({
            type: 'HEDGE_ABORTED',
            ts: Date.now(),
            marketId,
            side,
            step,
            price: currentPrice,
            shares: currentShares,
            reason: 'Shares below minimum after size reduction',
          });
          return {
            ok: false,
            errorCode: 'INSUFFICIENT_FUNDS',
            error: 'Cannot reduce size further',
            attempts: step,
          };
        }
        
        logHedgeEvent({
          type: 'HEDGE_ESCALATE_STEP',
          ts: Date.now(),
          marketId,
          side,
          step,
          price: currentPrice,
          shares: currentShares,
          reason: 'Reduced size due to insufficient funds',
        });
        continue;
      }
      
      return {
        ok: false,
        errorCode: 'INSUFFICIENT_FUNDS',
        error: fundsCheck.reason,
        attempts: step,
      };
    }
    
    // 3) Check liquidity
    const depth = await getOrderbookDepth(tokenId);
    if (!depth.hasLiquidity || depth.askVolume < currentShares * 0.5) {
      logHedgeEvent({
        type: 'HEDGE_FAILED',
        ts: Date.now(),
        marketId,
        side,
        step,
        price: currentPrice,
        shares: currentShares,
        reason: `No liquidity (ask vol: ${depth.askVolume.toFixed(0)})`,
      });
      
      // In panic/survival, accept less shares
      if ((isPanicMode || isSurvivalMode) && depth.askVolume >= HEDGE_ESCALATOR_CONFIG.minSharesForRetry) {
        currentShares = Math.floor(depth.askVolume * 0.8);
        logHedgeEvent({
          type: 'HEDGE_ESCALATE_STEP',
          ts: Date.now(),
          marketId,
          side,
          step,
          price: currentPrice,
          shares: currentShares,
          reason: 'Reduced to available liquidity',
        });
        continue;
      }
      
      return {
        ok: false,
        errorCode: 'NO_LIQUIDITY',
        error: `Liquidity: ${depth.askVolume.toFixed(0)} shares`,
        attempts: step,
      };
    }
    
    // 4) Reserve notional
    const tempOrderId = `hedge_${marketId}_${side}_${Date.now()}`;
    ReserveManager.reserve(tempOrderId, marketId, notional, side);
    
    // 5) Place order with v7.2.5 hard cap enforcement via placeOrderWithCaps
    try {
      OrderRateLimiter.recordEvent(marketId, 'order');
      
      // Determine intent for price improvement
      const orderIntent = isSurvivalMode ? 'SURVIVAL' : 'HEDGE';
      
      // v7.2.5: Build order context for cap enforcement
      const orderCtx: OrderContext = {
        marketId,
        asset,
        outcome: side,
        currentUpShares,
        currentDownShares,
        upCost,
        downCost,
        intentType: 'HEDGE',
        runId,
      };
      
      const result = await placeOrderWithCaps({
        tokenId,
        side: 'BUY',
        price: currentPrice,
        size: currentShares,
        orderType: 'GTC',
        intent: orderIntent,
      }, orderCtx);
      
      if (result.success) {
        const filledShares = result.status === 'filled' ? currentShares : (result.filledSize ?? 0);
        
        // Release temp reservation, record actual fill
        ReserveManager.release(tempOrderId);
        if (result.orderId && filledShares < currentShares) {
          // Partial fill - reserve remaining
          const remainingNotional = (currentShares - filledShares) * currentPrice;
          ReserveManager.reserve(result.orderId, marketId, remainingNotional, side);
        }
        
        // Invalidate balance cache after trade
        invalidateBalanceCache();
        
        logHedgeEvent({
          type: 'HEDGE_SUCCESS',
          ts: Date.now(),
          marketId,
          side,
          step,
          price: result.avgPrice || currentPrice,
          shares: currentShares,
          orderId: result.orderId,
          filledShares,
        });
        
        return {
          ok: true,
          orderId: result.orderId,
          filledShares,
          avgPrice: result.avgPrice || currentPrice,
          attempts: step,
        };
      } else {
        // Order failed - release reservation
        ReserveManager.release(tempOrderId);
        OrderRateLimiter.recordFailure(marketId);
        
        logHedgeEvent({
          type: 'HEDGE_FAILED',
          ts: Date.now(),
          marketId,
          side,
          step,
          price: currentPrice,
          shares: currentShares,
          reason: result.error || 'Unknown error',
        });
        
        // Check if balance error
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
            logHedgeEvent({
              type: 'HEDGE_ABORTED',
              ts: Date.now(),
              marketId,
              side,
              step,
              price: currentPrice,
              shares: currentShares,
              reason: 'Shares below minimum after escalation',
            });
            return {
              ok: false,
              errorCode: 'MAX_RETRIES',
              error: 'Shares too low after escalation',
              attempts: step,
            };
          }
          
          logHedgeEvent({
            type: 'HEDGE_ESCALATE_STEP',
            ts: Date.now(),
            marketId,
            side,
            step,
            price: currentPrice,
            shares: currentShares,
            reason: `Price +${(HEDGE_ESCALATOR_CONFIG.priceIncrementPerRetry * 100).toFixed(0)}¢`,
          });
          
          await sleep(HEDGE_ESCALATOR_CONFIG.retryDelayMs);
          continue;
        }
      }
    } catch (error: any) {
      ReserveManager.release(tempOrderId);
      OrderRateLimiter.recordFailure(marketId);
      
      logHedgeEvent({
        type: 'HEDGE_FAILED',
        ts: Date.now(),
        marketId,
        side,
        step,
        price: currentPrice,
        shares: currentShares,
        reason: error?.message || 'Exception',
      });
      
      if (step < HEDGE_ESCALATOR_CONFIG.maxRetries) {
        await sleep(HEDGE_ESCALATOR_CONFIG.retryDelayMs);
        continue;
      }
    }
  }
  
  // All retries exhausted
  logHedgeEvent({
    type: 'HEDGE_ABORTED',
    ts: Date.now(),
    marketId,
    side,
    step: HEDGE_ESCALATOR_CONFIG.maxRetries,
    price: currentPrice,
    shares: currentShares,
    reason: 'Max retries exhausted',
  });
  
  return {
    ok: false,
    errorCode: 'MAX_RETRIES',
    error: 'All hedge attempts failed',
    attempts: HEDGE_ESCALATOR_CONFIG.maxRetries,
  };
}

// ============================================================
// HELPERS
// ============================================================

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================
// STATS
// ============================================================

export function getHedgeEscalatorStats(): {
  totalAttempts: number;
  successCount: number;
  failureCount: number;
  abortCount: number;
  avgAttempts: number;
} {
  const attempts = hedgeEventLog.filter(e => e.type === 'HEDGE_ATTEMPT').length;
  const successes = hedgeEventLog.filter(e => e.type === 'HEDGE_SUCCESS').length;
  const failures = hedgeEventLog.filter(e => e.type === 'HEDGE_FAILED').length;
  const aborts = hedgeEventLog.filter(e => e.type === 'HEDGE_ABORTED').length;
  
  // Calculate average attempts per hedge
  const hedgeSequences = new Map<string, number>();
  for (const event of hedgeEventLog) {
    if (event.type === 'HEDGE_ATTEMPT') {
      const key = `${event.marketId}_${event.side}_${Math.floor(event.ts / 60000)}`;
      hedgeSequences.set(key, (hedgeSequences.get(key) || 0) + 1);
    }
  }
  
  const avgAttempts = hedgeSequences.size > 0
    ? Array.from(hedgeSequences.values()).reduce((a, b) => a + b, 0) / hedgeSequences.size
    : 0;
  
  return {
    totalAttempts: attempts,
    successCount: successes,
    failureCount: failures,
    abortCount: aborts,
    avgAttempts,
  };
}

export function getRecentHedgeEvents(limit = 50): HedgeEvent[] {
  return hedgeEventLog.slice(-limit);
}
