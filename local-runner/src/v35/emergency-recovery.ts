// ============================================================
// V35 EMERGENCY RECOVERY MODE
// ============================================================
// Version: V35.5.0 - "Loss Minimization"
//
// KEY INSIGHT: The ProactiveRebalancer only hedges when PROFITABLE.
// But sometimes we're in a losing position and need to MINIMIZE LOSS
// rather than seek profit.
//
// EXAMPLE:
//   10 UP @ $0.465 = $4.65 cost
//   50 DOWN @ $0.44 = $22.00 cost
//   Total: $26.65 invested
//
//   If UP wins: $10 payout - $26.65 cost = -$16.65 LOSS
//   If DOWN wins: $50 payout - $26.65 cost = +$23.35 GAIN
//
//   Recovery: Buy 40 UP @ $0.70 = $28 extra cost
//   New total: $54.65 invested, 50 pairs
//
//   Both outcomes: $50 payout - $54.65 cost = -$4.65 LOSS
//
//   Result: Converted -$16.65 max loss into -$4.65 guaranteed loss
//
// WHEN TO USE:
// 1. Unpaired shares > recoveryThreshold (default: 25)
// 2. Leading side is "expensive" (likely winner) by >60%
// 3. Current max loss > locked loss after recovery
// ============================================================

import { getV35Config, V35_VERSION } from './config.js';
import type { V35Market, V35Side } from './types.js';
import { getV35SidePricing } from './market-pricing.js';
import { placeOrder, getOpenOrders, cancelOrder } from '../polymarket.js';
import { saveBotEvent, type BotEvent } from '../backend.js';
import { getErrorMessage } from './utils.js';

// ============================================================
// CONFIGURATION
// ============================================================

interface RecoveryConfig {
  enabled: boolean;
  minUnpairedForRecovery: number;   // Minimum unpaired shares to trigger (default: 25)
  minWinProbability: number;        // Minimum implied probability of leading side (default: 0.60)
  maxCombinedCostForRecovery: number; // Max combined cost we'll accept (default: 1.10 = 10% loss)
  recoveryOrderType: 'GTC' | 'IOC'; // Order type for recovery orders
}

const DEFAULT_RECOVERY_CONFIG: RecoveryConfig = {
  enabled: true,
  minUnpairedForRecovery: 25,      // Only trigger when 25+ shares imbalanced
  minWinProbability: 0.60,         // Leading side must be 60%+ to trigger
  maxCombinedCostForRecovery: 1.10, // Accept up to 10% loss to lock in
  recoveryOrderType: 'GTC',
};

let recoveryConfig = { ...DEFAULT_RECOVERY_CONFIG };

export function getRecoveryConfig(): RecoveryConfig {
  return recoveryConfig;
}

export function setRecoveryConfig(overrides: Partial<RecoveryConfig>): void {
  recoveryConfig = { ...recoveryConfig, ...overrides };
}

// ============================================================
// TYPES
// ============================================================

export interface RecoveryAnalysis {
  shouldRecover: boolean;
  reason: string;
  
  // Current state
  upQty: number;
  downQty: number;
  upCost: number;
  downCost: number;
  unpaired: number;
  leadingSide: V35Side;
  
  // Prices
  leadingPrice: number;        // Current price of leading side
  trailingPrice: number;       // Current price of trailing side
  
  // Projections
  currentMaxLoss: number;      // Max loss if leading side wins
  currentMaxGain: number;      // Max gain if trailing side wins
  
  // Recovery plan
  sharesToBuy: number;         // How many shares of trailing side to buy
  buyPrice: number;            // Expected price to pay
  recoveryCost: number;        // Total cost of recovery
  lockedLossAfterRecovery: number; // Guaranteed loss after recovery
  
  // Trade-off
  lossReduction: number;       // How much max loss is reduced
  gainSacrificed: number;      // How much potential gain is given up
}

export interface RecoveryResult {
  attempted: boolean;
  success: boolean;
  reason: string;
  analysis?: RecoveryAnalysis;
  orderId?: string;
  filledQty?: number;
}

// ============================================================
// ANALYSIS FUNCTIONS
// ============================================================

/**
 * Analyze whether emergency recovery is needed and calculate the plan
 */
export function analyzeRecovery(market: V35Market): RecoveryAnalysis {
  const upQty = market.upQty || 0;
  const downQty = market.downQty || 0;
  const upCost = market.upCost || 0;
  const downCost = market.downCost || 0;
  const totalCost = upCost + downCost;
  
  const unpaired = Math.abs(upQty - downQty);
  const leadingSide: V35Side = downQty > upQty ? 'DOWN' : 'UP';
  const trailingSide: V35Side = leadingSide === 'UP' ? 'DOWN' : 'UP';
  
  // Get current prices (using bids as the "value" of each side)
  const upPrice = market.upBestBid || market.upBestAsk || 0.50;
  const downPrice = market.downBestBid || market.downBestAsk || 0.50;
  
  const leadingPrice = leadingSide === 'UP' ? upPrice : downPrice;
  const trailingPrice = leadingSide === 'UP' ? downPrice : upPrice;
  
  // Current scenario analysis
  // If leading side wins: payout = leading shares × $1
  // If trailing side wins: payout = trailing shares × $1
  const leadingQty = leadingSide === 'UP' ? upQty : downQty;
  const trailingQty = trailingSide === 'UP' ? upQty : downQty;
  
  // Scenario A: Leading side wins (we lose on unpaired trailing shares)
  const payoutIfLeadingWins = leadingQty; // $1 per leading share
  const lossIfLeadingWins = totalCost - payoutIfLeadingWins;
  
  // Scenario B: Trailing side wins (we win on unpaired trailing shares)
  const payoutIfTrailingWins = trailingQty + leadingQty; // All trailing pay $1 + pairs
  // Wait, this is wrong. Let me recalculate.
  
  // If UP wins: all UP shares pay $1, DOWN pays $0
  // If DOWN wins: all DOWN shares pay $1, UP pays $0
  const payoutUpWins = upQty; // UP shares × $1
  const payoutDownWins = downQty; // DOWN shares × $1
  
  const pnlUpWins = payoutUpWins - totalCost;
  const pnlDownWins = payoutDownWins - totalCost;
  
  // Max loss is the worse scenario
  const currentMaxLoss = Math.min(pnlUpWins, pnlDownWins);
  const currentMaxGain = Math.max(pnlUpWins, pnlDownWins);
  
  // Recovery plan: Buy enough of trailing side to match leading side
  const sharesToBuy = unpaired;
  const buyPrice = trailingSide === 'UP' ? (market.upBestAsk || 0.70) : (market.downBestAsk || 0.70);
  const recoveryCost = sharesToBuy * buyPrice;
  
  // After recovery: both sides equal
  const newTotalCost = totalCost + recoveryCost;
  const pairedAfter = Math.max(upQty, downQty);
  const payoutAfter = pairedAfter; // Exactly pairedAfter shares of the winner
  const lockedLossAfterRecovery = payoutAfter - newTotalCost;
  
  // Trade-off calculation
  const lossReduction = currentMaxLoss - lockedLossAfterRecovery; // Negative = improvement
  const gainSacrificed = currentMaxGain - lockedLossAfterRecovery;
  
  // Calculate combined cost after recovery to see if it makes sense
  const avgLeadingCost = leadingQty > 0 
    ? (leadingSide === 'UP' ? upCost / upQty : downCost / downQty)
    : 0;
  const projectedCombinedCost = avgLeadingCost + buyPrice;
  
  // Decision logic
  let shouldRecover = false;
  let reason = '';
  
  if (!recoveryConfig.enabled) {
    reason = 'Recovery mode disabled';
  } else if (unpaired < recoveryConfig.minUnpairedForRecovery) {
    reason = `Unpaired ${unpaired} < threshold ${recoveryConfig.minUnpairedForRecovery}`;
  } else if (leadingPrice < recoveryConfig.minWinProbability) {
    reason = `Leading probability ${(leadingPrice * 100).toFixed(0)}% < ${(recoveryConfig.minWinProbability * 100).toFixed(0)}%`;
  } else if (projectedCombinedCost > recoveryConfig.maxCombinedCostForRecovery) {
    reason = `Combined cost ${projectedCombinedCost.toFixed(3)} > max ${recoveryConfig.maxCombinedCostForRecovery}`;
  } else if (lossReduction >= 0) {
    // lossReduction is negative when recovery REDUCES loss
    // If it's 0 or positive, recovery doesn't help
    reason = `Recovery doesn't reduce loss (reduction: ${lossReduction.toFixed(2)})`;
  } else {
    shouldRecover = true;
    reason = `Recovery would reduce max loss by $${(-lossReduction).toFixed(2)}`;
  }
  
  return {
    shouldRecover,
    reason,
    upQty,
    downQty,
    upCost,
    downCost,
    unpaired,
    leadingSide,
    leadingPrice,
    trailingPrice,
    currentMaxLoss,
    currentMaxGain,
    sharesToBuy,
    buyPrice,
    recoveryCost,
    lockedLossAfterRecovery,
    lossReduction,
    gainSacrificed,
  };
}

// ============================================================
// EXECUTION
// ============================================================

export class EmergencyRecovery {
  private lastAttempt = 0;
  private cooldownMs = 10000; // 10 second cooldown between attempts
  
  constructor() {}
  
  /**
   * Check if recovery is needed and execute if so
   */
  async checkAndRecover(market: V35Market): Promise<RecoveryResult> {
    const config = getV35Config();
    const now = Date.now();
    
    // Cooldown
    if (now - this.lastAttempt < this.cooldownMs) {
      return { attempted: false, success: false, reason: 'cooldown' };
    }
    this.lastAttempt = now;
    
    // Analyze
    const analysis = analyzeRecovery(market);
    
    if (!analysis.shouldRecover) {
      return { 
        attempted: true, 
        success: false, 
        reason: analysis.reason,
        analysis,
      };
    }
    
    console.log('\n' + '🚨'.repeat(35));
    console.log('EMERGENCY RECOVERY MODE TRIGGERED');
    console.log('🚨'.repeat(35));
    console.log(`[Recovery] Current: ${analysis.upQty.toFixed(0)} UP / ${analysis.downQty.toFixed(0)} DOWN`);
    console.log(`[Recovery] Unpaired: ${analysis.unpaired.toFixed(0)} ${analysis.leadingSide} shares`);
    console.log(`[Recovery] Leading side: ${analysis.leadingSide} @ ${(analysis.leadingPrice * 100).toFixed(0)}%`);
    console.log(`[Recovery] Current max loss: $${analysis.currentMaxLoss.toFixed(2)}`);
    console.log(`[Recovery] Current max gain: $${analysis.currentMaxGain.toFixed(2)}`);
    console.log(`[Recovery] PLAN: Buy ${analysis.sharesToBuy.toFixed(0)} ${analysis.leadingSide === 'UP' ? 'DOWN' : 'UP'} @ $${analysis.buyPrice.toFixed(3)}`);
    console.log(`[Recovery] After recovery: LOCKED LOSS of $${analysis.lockedLossAfterRecovery.toFixed(2)}`);
    console.log(`[Recovery] Loss reduction: $${(-analysis.lossReduction).toFixed(2)}`);
    console.log('🚨'.repeat(35) + '\n');
    
    // Log the attempt
    await this.logEvent('emergency_recovery_triggered', market, {
      analysis,
    });
    
    if (config.dryRun) {
      console.log('[Recovery] [DRY RUN] Would execute recovery');
      return { 
        attempted: true, 
        success: true, 
        reason: 'dry_run',
        analysis,
      };
    }
    
    // Execute recovery order
    const trailingSide: V35Side = analysis.leadingSide === 'UP' ? 'DOWN' : 'UP';
    const tokenId = trailingSide === 'UP' ? market.upTokenId : market.downTokenId;
    
    try {
      const result = await placeOrder({
        tokenId,
        side: 'BUY',
        price: analysis.buyPrice,
        size: analysis.sharesToBuy,
        orderType: recoveryConfig.recoveryOrderType,
      });
      
      if (!result.success || !result.orderId) {
        await this.logEvent('emergency_recovery_failed', market, {
          reason: result.error || 'order_placement_failed',
        });
        return {
          attempted: true,
          success: false,
          reason: result.error || 'order_failed',
          analysis,
        };
      }
      
      console.log(`[Recovery] ✓ Recovery order placed: ${result.orderId.slice(0, 8)}...`);
      
      // Wait for fill
      await sleep(2000);
      
      const { orders, error } = await getOpenOrders();
      if (error) {
        return { 
          attempted: true, 
          success: false, 
          reason: `status_unknown: ${error}`,
          analysis,
          orderId: result.orderId,
        };
      }
      
      const open = orders.find(o => o.orderId === result.orderId);
      if (!open) {
        // Fully filled
        console.log('[Recovery] 🎉 RECOVERY COMPLETE - Position balanced!');
        await this.logEvent('emergency_recovery_success', market, {
          filled_qty: analysis.sharesToBuy,
          locked_loss: analysis.lockedLossAfterRecovery,
        });
        return {
          attempted: true,
          success: true,
          reason: 'filled',
          analysis,
          orderId: result.orderId,
          filledQty: analysis.sharesToBuy,
        };
      }
      
      // Partial or no fill - keep order open
      const filledQty = analysis.sharesToBuy - (open.size || 0);
      console.log(`[Recovery] Partial fill: ${filledQty.toFixed(0)} of ${analysis.sharesToBuy.toFixed(0)}`);
      
      return {
        attempted: true,
        success: filledQty > 0,
        reason: 'partial_fill',
        analysis,
        orderId: result.orderId,
        filledQty,
      };
      
    } catch (error) {
      const errMsg = getErrorMessage(error);
      console.error('[Recovery] Error:', errMsg);
      await this.logEvent('emergency_recovery_error', market, { error: errMsg });
      return {
        attempted: true,
        success: false,
        reason: `error: ${errMsg}`,
        analysis,
      };
    }
  }
  
  private async logEvent(
    eventType: string,
    market: V35Market,
    data: Record<string, unknown>
  ): Promise<void> {
    try {
      const event: BotEvent = {
        event_type: eventType,
        asset: market.asset,
        market_id: market.slug,
        ts: Date.now(),
        data: {
          ...data,
          version: V35_VERSION,
        },
      };
      await saveBotEvent(event);
    } catch (err) {
      console.error('[Recovery] Failed to log event:', getErrorMessage(err));
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================
// SINGLETON
// ============================================================

let instance: EmergencyRecovery | null = null;

export function getEmergencyRecovery(): EmergencyRecovery {
  if (!instance) {
    instance = new EmergencyRecovery();
  }
  return instance;
}

export function resetEmergencyRecovery(): void {
  instance = null;
}
