/**
 * gabagool-metrics.ts — v8.0.0 SUCCESS METRICS (GABAGOOL STYLE)
 * ==============================================================
 * 
 * Defines success metrics according to the Gabagool22 strategy.
 * These are the ONLY metrics that matter for evaluating bot performance.
 * 
 * PRIMARY METRIC:
 * - % paired shares with CPP < 1.00
 * 
 * SECONDARY METRICS:
 * - Distribution shift of CPP leftward (more trades with lower CPP)
 * - Reduction in trades with CPP ≥ 1.05
 * - Maker fill ratio (higher = better)
 * 
 * EXPLICITLY NOT SUCCESS METRICS:
 * - Trade count (more trades ≠ better)
 * - Pairing speed (faster pairing ≠ better)
 * - Skew flatness (skew is acceptable, loss is not)
 * 
 * HARD ECONOMIC INVARIANTS:
 * 1. CPP DOMINANCE: If projected CPP ≥ 0.99 → DO NOTHING
 * 2. NO EXPENSIVE MINORITY BUYS: Never buy expensive side to reduce skew
 * 3. STATE TRUST GATE: Freeze market if inventory state is untrusted
 * 4. SELL IS NOT A DEFAULT TOOL: Only sell if CPP improves OR risk reduces
 */

// ============================================================
// SUCCESS METRICS TYPES
// ============================================================

export interface GabagoolMetrics {
  // PRIMARY: % paired shares with CPP < 1.00
  pairedSharesTotal: number;
  pairedSharesWithCppUnder100: number;
  pairedSharesWithCppUnder100Pct: number;  // THE key metric

  // SECONDARY: CPP distribution
  cppDistribution: {
    under95: number;    // Count of settlements with CPP < 0.95 (excellent)
    under97: number;    // Count of settlements with CPP < 0.97 (good)
    under99: number;    // Count of settlements with CPP < 0.99 (acceptable)
    under100: number;   // Count of settlements with CPP < 1.00 (breakeven+)
    under105: number;   // Count with 1.00 <= CPP < 1.05 (small loss)
    over105: number;    // Count with CPP >= 1.05 (significant loss - BAD)
  };

  // SECONDARY: Maker fill ratio
  totalFills: number;
  makerFills: number;
  takerFills: number;
  unknownFills: number;
  makerFillRatio: number;  // makerFills / totalFills

  // NOT SUCCESS METRICS (tracked for observability only)
  totalTradeCount: number;         // Not a success metric
  avgPairingTimeMs: number | null; // Not a success metric
  avgSkewPct: number | null;       // Not a success metric

  // Time period
  periodStart: number;
  periodEnd: number;
}

// ============================================================
// INVARIANT STATUS
// ============================================================

export interface InvariantStatus {
  // INVARIANT 1: CPP DOMINANCE
  cppDominanceActive: boolean;
  cppDominanceBlockCount: number;     // Orders blocked due to CPP >= 0.99

  // INVARIANT 2: NO EXPENSIVE MINORITY BUYS
  expensiveMinorityBlockActive: boolean;
  expensiveMinorityBlockCount: number; // Orders blocked due to expensive minority buy

  // INVARIANT 3: STATE TRUST GATE
  stateTrustGateActive: boolean;
  marketsFrozenCount: number;          // Markets frozen due to untrusted state
  marketsWithDriftCount: number;       // Markets with detected drift

  // INVARIANT 4: SELL POLICY
  sellPolicyActive: boolean;
  sellsBlockedCount: number;           // Sells blocked because they'd worsen CPP
}

// ============================================================
// GABAGOOL STRATEGY ALIGNMENT CHECKLIST
// ============================================================

export interface GabagoolAlignmentCheck {
  // ✓ Every order is evaluated as a NEW hedge opportunity
  evaluateAsNewHedgeOpportunity: boolean;

  // ✓ Hedge only when price is attractive, not because skew exists
  hedgeOnlyWhenAttractive: boolean;

  // ✓ Prefer small initial entries (5-15 shares)
  initialEntrySizeMin: number;
  initialEntrySizeMax: number;
  initialEntrySizeCompliant: boolean;

  // ✓ Accumulate slowly if prices improve
  accumulateOnlyOnImprovement: boolean;

  // ✓ Accept long-lived skew
  acceptLongLivedSkew: boolean;

  // ✓ Settlement is the primary exit, not selling
  settlementIsPrimaryExit: boolean;
  sellsAsExitCount: number;            // Should be close to 0

  // Overall alignment score (0-100)
  alignmentScore: number;
  alignmentIssues: string[];
}

// ============================================================
// CALCULATION HELPERS
// ============================================================

export function calculatePairedSharesPct(metrics: Pick<GabagoolMetrics, 'pairedSharesTotal' | 'pairedSharesWithCppUnder100'>): number {
  if (metrics.pairedSharesTotal === 0) return 0;
  return (metrics.pairedSharesWithCppUnder100 / metrics.pairedSharesTotal) * 100;
}

export function calculateMakerFillRatio(metrics: Pick<GabagoolMetrics, 'totalFills' | 'makerFills'>): number {
  if (metrics.totalFills === 0) return 0;
  return metrics.makerFills / metrics.totalFills;
}

export function calculateAlignmentScore(check: Omit<GabagoolAlignmentCheck, 'alignmentScore' | 'alignmentIssues'>): {
  score: number;
  issues: string[];
} {
  const issues: string[] = [];
  let score = 100;

  if (!check.evaluateAsNewHedgeOpportunity) {
    score -= 20;
    issues.push('Not evaluating each order as new hedge opportunity');
  }

  if (!check.hedgeOnlyWhenAttractive) {
    score -= 20;
    issues.push('Hedging based on skew, not price attractiveness');
  }

  if (!check.initialEntrySizeCompliant) {
    score -= 10;
    issues.push(`Initial entry size ${check.initialEntrySizeMin}-${check.initialEntrySizeMax} outside 5-15 range`);
  }

  if (!check.accumulateOnlyOnImprovement) {
    score -= 15;
    issues.push('Accumulating without price improvement');
  }

  if (!check.acceptLongLivedSkew) {
    score -= 10;
    issues.push('Not accepting long-lived skew');
  }

  if (!check.settlementIsPrimaryExit) {
    score -= 15;
    issues.push(`Using sells as exit (${check.sellsAsExitCount} times)`);
  }

  return { score: Math.max(0, score), issues };
}

// ============================================================
// EMPTY/DEFAULT METRICS
// ============================================================

export function createEmptyGabagoolMetrics(): GabagoolMetrics {
  return {
    pairedSharesTotal: 0,
    pairedSharesWithCppUnder100: 0,
    pairedSharesWithCppUnder100Pct: 0,
    cppDistribution: {
      under95: 0,
      under97: 0,
      under99: 0,
      under100: 0,
      under105: 0,
      over105: 0,
    },
    totalFills: 0,
    makerFills: 0,
    takerFills: 0,
    unknownFills: 0,
    makerFillRatio: 0,
    totalTradeCount: 0,
    avgPairingTimeMs: null,
    avgSkewPct: null,
    periodStart: Date.now(),
    periodEnd: Date.now(),
  };
}

export function createEmptyInvariantStatus(): InvariantStatus {
  return {
    cppDominanceActive: true,
    cppDominanceBlockCount: 0,
    expensiveMinorityBlockActive: true,
    expensiveMinorityBlockCount: 0,
    stateTrustGateActive: true,
    marketsFrozenCount: 0,
    marketsWithDriftCount: 0,
    sellPolicyActive: true,
    sellsBlockedCount: 0,
  };
}
