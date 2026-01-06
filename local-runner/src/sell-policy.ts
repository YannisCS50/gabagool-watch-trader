/**
 * sell-policy.ts — v7.2.8 REV C.4.2 SELL POLICY
 * =============================================
 * Configurable sell policy to match gabagool22 trading style.
 * 
 * Default: Hold positions to expiry, only sell for safety/risk reasons.
 * 
 * Policy flags:
 *   - allowProactiveSells: Enable profit-taking / inventory shaping sells
 *   - allowEmergencySells: Enable sells for invariant breaches / skew emergencies
 *   - allowUnwindOnlySells: Enable sells during unwind phase (near expiry)
 *   - allowProfitTakingSells: Enable sells specifically for locking in profits
 */

import { saveBotEvent } from './backend.js';

// ============================================================
// SELL POLICY CONFIGURATION
// ============================================================

export interface SellPolicyConfig {
  /**
   * Master switch for proactive sells (profit-taking, inventory shaping).
   * If false, only emergency and unwind sells are allowed.
   * Default: false (gabagool style: hold to expiry)
   */
  allowProactiveSells: boolean;
  
  /**
   * Allow sells for safety reasons:
   * - Invariant breaches (cap exceeded)
   * - Skew emergencies (extreme imbalance)
   * - Risk limit violations
   * Default: true
   */
  allowEmergencySells: boolean;
  
  /**
   * Allow sells during unwind phase (near market expiry).
   * This is typically to reduce position before settlement.
   * Default: true
   */
  allowUnwindOnlySells: boolean;
  
  /**
   * Allow sells specifically to lock in profits.
   * Only applies if allowProactiveSells is also true.
   * Default: false
   */
  allowProfitTakingSells: boolean;
}

// ============================================================
// DEFAULT CONFIG (GABAGOOL STYLE)
// ============================================================

const DEFAULT_SELL_POLICY: SellPolicyConfig = {
  allowProactiveSells: false,    // No profit-taking / inventory shaping
  allowEmergencySells: true,     // Safety sells always allowed
  allowUnwindOnlySells: true,    // Unwind near expiry allowed
  allowProfitTakingSells: false, // No explicit profit-taking
};

// Active config (can be updated at runtime)
let activeSellPolicy: SellPolicyConfig = { ...DEFAULT_SELL_POLICY };

// ============================================================
// SELL REASONS
// ============================================================

export type SellReason = 
  | 'UNWIND_ONLY'          // Near expiry unwind
  | 'EMERGENCY_INVARIANT'  // Invariant breach (cap exceeded)
  | 'EMERGENCY_SKEW'       // Skew emergency
  | 'EMERGENCY_RISK'       // Risk limit violation
  | 'PROFIT_TAKING'        // Lock in profits
  | 'INVENTORY_SHAPE'      // Reduce imbalance
  | 'MANUAL'               // Manual override
  | 'BLOCKED';             // Sell not allowed

export interface SellDecision {
  allowed: boolean;
  reason: SellReason;
  policyFlag: keyof SellPolicyConfig | null;
  message: string;
}

// ============================================================
// POLICY CHECKS
// ============================================================

/**
 * Check if a sell is allowed based on the current policy.
 */
export function checkSellPolicy(params: {
  reason: SellReason;
  marketId: string;
  asset: string;
  side: 'UP' | 'DOWN';
  qty: number;
  runId?: string;
}): SellDecision {
  const { reason, marketId, asset, side, qty, runId } = params;
  
  let allowed = false;
  let policyFlag: keyof SellPolicyConfig | null = null;
  let message = '';
  
  switch (reason) {
    case 'UNWIND_ONLY':
      allowed = activeSellPolicy.allowUnwindOnlySells;
      policyFlag = 'allowUnwindOnlySells';
      message = allowed 
        ? 'Unwind sell allowed (near expiry)'
        : 'Unwind sells disabled by policy';
      break;
      
    case 'EMERGENCY_INVARIANT':
    case 'EMERGENCY_SKEW':
    case 'EMERGENCY_RISK':
      allowed = activeSellPolicy.allowEmergencySells;
      policyFlag = 'allowEmergencySells';
      message = allowed
        ? `Emergency sell allowed (${reason})`
        : 'Emergency sells disabled by policy (DANGEROUS!)';
      break;
      
    case 'PROFIT_TAKING':
      allowed = activeSellPolicy.allowProactiveSells && activeSellPolicy.allowProfitTakingSells;
      policyFlag = allowed ? 'allowProfitTakingSells' : 'allowProactiveSells';
      message = allowed
        ? 'Profit-taking sell allowed'
        : 'Profit-taking sells disabled by policy (gabagool style)';
      break;
      
    case 'INVENTORY_SHAPE':
      allowed = activeSellPolicy.allowProactiveSells;
      policyFlag = 'allowProactiveSells';
      message = allowed
        ? 'Inventory shaping sell allowed'
        : 'Inventory shaping sells disabled by policy (gabagool style)';
      break;
      
    case 'MANUAL':
      // Manual overrides always allowed
      allowed = true;
      policyFlag = null;
      message = 'Manual sell override';
      break;
      
    case 'BLOCKED':
      allowed = false;
      policyFlag = null;
      message = 'Sell explicitly blocked';
      break;
      
    default:
      allowed = false;
      policyFlag = null;
      message = `Unknown sell reason: ${reason}`;
  }
  
  // Log the decision
  const emoji = allowed ? '✅' : '🚫';
  console.log(
    `${emoji} [SELL_POLICY] ${reason}: ${side} ${asset} ${marketId.slice(-12)} qty=${qty} → ${allowed ? 'ALLOWED' : 'BLOCKED'}`
  );
  
  if (policyFlag) {
    console.log(`   Policy: ${policyFlag} = ${activeSellPolicy[policyFlag]}`);
  }
  
  // Log event
  saveBotEvent({
    event_type: allowed ? 'SELL_ALLOWED_BY_POLICY' : 'SELL_BLOCKED_BY_POLICY',
    asset,
    market_id: marketId,
    ts: Date.now(),
    run_id: runId,
    reason_code: reason,
    data: {
      side,
      qty,
      reason,
      policyFlag,
      allowed,
      message,
      currentPolicy: { ...activeSellPolicy },
    },
  }).catch(() => {});
  
  return {
    allowed,
    reason: allowed ? reason : 'BLOCKED',
    policyFlag,
    message,
  };
}

// ============================================================
// POLICY MANAGEMENT
// ============================================================

/**
 * Get the current sell policy.
 */
export function getSellPolicy(): SellPolicyConfig {
  return { ...activeSellPolicy };
}

/**
 * Update the sell policy.
 */
export function updateSellPolicy(updates: Partial<SellPolicyConfig>): void {
  const before = { ...activeSellPolicy };
  activeSellPolicy = { ...activeSellPolicy, ...updates };
  
  console.log('🔧 [SELL_POLICY] Updated:');
  for (const [key, value] of Object.entries(updates)) {
    console.log(`   ${key}: ${before[key as keyof SellPolicyConfig]} → ${value}`);
  }
}

/**
 * Reset to default policy.
 */
export function resetSellPolicy(): void {
  activeSellPolicy = { ...DEFAULT_SELL_POLICY };
  console.log('🔧 [SELL_POLICY] Reset to defaults (gabagool style)');
}

/**
 * Enable aggressive trading (allow all sells).
 */
export function enableAggressiveMode(): void {
  updateSellPolicy({
    allowProactiveSells: true,
    allowEmergencySells: true,
    allowUnwindOnlySells: true,
    allowProfitTakingSells: true,
  });
  console.log('⚡ [SELL_POLICY] Aggressive mode enabled (all sells allowed)');
}

/**
 * Enable gabagool mode (hold to expiry, minimal sells).
 */
export function enableGabagoolMode(): void {
  resetSellPolicy();
  console.log('💎 [SELL_POLICY] Gabagool mode enabled (hold to expiry)');
}

// ============================================================
// STARTUP LOG
// ============================================================

export function logSellPolicyStatus(): void {
  console.log('\n┌────────────────────────────────────────────────────────────────┐');
  console.log('│  💎 SELL POLICY (Rev C.4.2)                                     │');
  console.log('├────────────────────────────────────────────────────────────────┤');
  console.log(`│  allowProactiveSells:    ${activeSellPolicy.allowProactiveSells ? '✅ YES' : '🚫 NO '}                               │`);
  console.log(`│  allowEmergencySells:    ${activeSellPolicy.allowEmergencySells ? '✅ YES' : '🚫 NO '}                               │`);
  console.log(`│  allowUnwindOnlySells:   ${activeSellPolicy.allowUnwindOnlySells ? '✅ YES' : '🚫 NO '}                               │`);
  console.log(`│  allowProfitTakingSells: ${activeSellPolicy.allowProfitTakingSells ? '✅ YES' : '🚫 NO '}                               │`);
  console.log('├────────────────────────────────────────────────────────────────┤');
  
  if (!activeSellPolicy.allowProactiveSells && !activeSellPolicy.allowProfitTakingSells) {
    console.log('│  Mode: 💎 GABAGOOL STYLE (hold to expiry)                       │');
  } else if (activeSellPolicy.allowProactiveSells && activeSellPolicy.allowProfitTakingSells) {
    console.log('│  Mode: ⚡ AGGRESSIVE (all sells allowed)                        │');
  } else {
    console.log('│  Mode: 🔀 CUSTOM                                                │');
  }
  
  console.log('└────────────────────────────────────────────────────────────────┘\n');
}
