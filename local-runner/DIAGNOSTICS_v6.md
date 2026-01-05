# v6.6.1 CPP Infinity Deadlock Fix - Diagnostics

## What's New in v6.6.1

### 1. CPP INFINITY DEADLOCK FIX
**Problem**: When paired=0 (one-sided state), cpp = totalCost/0 = Infinity, which triggered
COST_PER_PAIRED_EMERGENCY and blocked ALL trading - including the hedge needed to become paired.

**Solution**:
- `costPerPaired()` now returns `null` when paired=0 (not Infinity)
- CPP guardrails (EMERGENCY/STOP) only apply when `paired > 0`
- One-sided state is logged as `ONE_SIDED: CPP guards do not apply`

### 2. ONE-SIDED STATE HANDLING
When `paired == 0` (bot has only UP or only DOWN shares):
- **CPP guards**: Do NOT apply (would deadlock)
- **Entry guards**: Still apply (tail-entry, direction sanity, pair-edge)
- **Hedge**: ALWAYS allowed - this is how we exit one-sided state
- **Logging**: `📊 [v6.6.1] ONE_SIDED: CPP guards do not apply`

### 3. UPDATED INTERFACES
- `costPerPaired()`: Returns `number | null` (null when paired=0)
- `costPerPairedSafe()`: NEW - returns 0 when paired=0 (for display/logging)
- `V611GuardrailResult.costPerPaired`: Now `number | null`
- `V611GuardrailResult.isOneSided`: NEW - true when paired=0 but has shares

---

## What's in v6.6.0

### 1. SAFETY BLOCK (Invalid Book Detection)
When orderbook is invalid or suspicious:
- **Detection**: bestBid <= 0.02 AND bestAsk >= 0.98 with > 20 levels
- **Behavior**: Block ALL trading except CANCEL_ALL
- **Logging**: `SAFETY_BLOCK_ACTIVE` (logged once per state change)
- **Exit**: Automatically clears when book becomes valid

### 2. EMERGENCY UNWIND
Triggered when position is critically underwater:
- **CPP Emergency**: cost_per_paired >= 1.10 (ONLY when paired > 0)
- **CPP Implausible**: cost_per_paired > 1.50 (ONLY when paired > 0)
- **Skew Emergency**: skewRatio >= 70% AND unpairedAgeSec > 20s
- **Behavior**: Cancel all orders, attempt to reduce dominant side
- **Cooldown**: 10 minutes (600s) freeze on new entries after emergency

### 3. GUARDRAIL LOG THROTTLE
Stops guardrail log spam:
- **State-change only**: Logs on change or every 5s max
- **Format**: Single structured log with all metrics
- **Fields**: marketId, trigger, paired, unpaired, cpp, skewRatio, action

### 4. CPP SANITY CHECK
Detects implausible cost_per_paired values:
- **Threshold**: cpp > 1.50 = likely units bug (ONLY when paired > 0)
- **Action**: Force EMERGENCY_UNWIND, log CPP components for debugging
- **Fields logged**: upShares, downShares, upInvested, downInvested, paired, formula

---

## What's in v6.5.0 (Previous)

### 1. Inventory Risk Score (First-Class Metric)
Per-market runtime metric tracking:
- `unpaired_shares` = abs(up_shares - down_shares)
- `unpaired_notional_usd` = unpaired × avg_cost of unpaired side
- `unpaired_age_sec` = time since unpaired became non-zero
- `inventory_risk_score` = notional × age (higher = more exposure risk)

### 2. Degraded Mode (Hedge Infeasible)
When hedge is infeasible and unpaired risk grows:
- **Entry trigger**: (notional >= $15 AND age >= 20s) OR (hedge infeasible AND risk_score >= 300)
- **Behavior**: Block new entries (ADD/ACCUMULATE), only allow HEDGE/UNWIND
- **Exit**: hedge feasible AND notional reduced below threshold

### 3. Queue-Aware Throttling
When order queue is stressed (>= 6 pending):
- Block new entries (ADD/ACCUMULATE)
- Increase micro-hedge cooldowns
- Allow survival/hedge actions

### 4. ACTION_SKIPPED Events
Explicit logging when bot skips actions:
- Event type: `ACTION_SKIPPED`
- Reasons: PAIR_COST, COOLDOWN, QUEUE_STRESS, FUNDS, NO_DEPTH, RATE_LIMIT, DEGRADED_MODE, etc.
- Key metrics captured for debugging

---

## How to verify v6.6.0 is working

### 1. Safety Block (Invalid Book)

**Check safety block events:**
```bash
grep "SAFETY_BLOCK" logs/*.log
# Should see:
🚨 [SAFETY_BLOCK_ACTIVE] market-slug
   Reason: SUSPICIOUS_BOOK_SHAPE: bid=0.02 ask=0.98
   → All trading blocked except CANCEL_ALL

# Clear event:
✅ [SAFETY_BLOCK_CLEARED] market-slug
   Previous reason: SUSPICIOUS_BOOK_SHAPE...
```

### 2. Emergency Unwind

**Check emergency unwind events:**
```bash
grep "EMERGENCY_UNWIND" logs/*.log
# Should see:
🚨 [EMERGENCY_UNWIND_START] market-slug
   Reason: CPP_EMERGENCY: cpp=1.12 >= 1.10
   Dominant: UP - will attempt to reduce
   Max duration: 45s

# End event:
✅ [EMERGENCY_UNWIND_END] market-slug
   Exit reason: conditions_improved
   Cooldown until: 2026-01-05T...
```

### 3. CPP Implausible Detection

**Check CPP implausible events:**
```bash
grep "CPP_IMPLAUSIBLE" logs/*.log
# Should see:
🚨 [CPP_IMPLAUSIBLE] market-slug
   cpp=2.175 (> 1.50)
   upShares=X, downShares=Y, paired=Z
   upInvested=$XX, downInvested=$YY
   Formula: cpp = (XX + YY) / Z = 2.175
```

### 4. Guardrail Throttle (No Spam)

**Verify throttled logging:**
```bash
# Count guardrail logs per market - should be max 1 per 5s
grep "GUARDRAIL" logs/*.log | cut -d' ' -f1-3 | uniq -c
# High counts = old spam behavior, low counts = throttle working
```

---

## How to verify v6.5.0 is working

### 1. Inventory Risk Tracking

**Check risk score in snapshots:**
```bash
# In snapshot logs, look for new fields:
head -1 logs/snapshot_$(date +%Y-%m-%d).jsonl | jq '{
  unpairedShares,
  unpairedNotionalUsd,
  unpairedAgeSec,
  inventoryRiskScore,
  degradedMode,
  queueStress
}'
```

### 2. Degraded Mode Events

**Check for mode transitions:**
```bash
# Enter degraded mode:
grep "DEGRADED_MODE_ENTER" logs/*.log
# Should see:
🔴 [DEGRADED_MODE_ENTER] market-slug
   Reason: Notional $X.XX >= $15 AND age Ys >= 20s

# Exit degraded mode:
grep "DEGRADED_MODE_EXIT" logs/*.log
# Should see:
🟢 [DEGRADED_MODE_EXIT] market-slug - hedge feasible, notional reduced
```

### 3. Queue Stress Events

**Check queue stress detection:**
```bash
grep "QUEUE_STRESS" logs/*.log
# Enter:
⚡ [QUEUE_STRESS_ENTER] Queue size N >= 6
# Exit:
✅ [QUEUE_STRESS_EXIT] Queue size N < 6
```

### 4. ACTION_SKIPPED Events

**Check skipped actions:**
```bash
grep "ACTION_SKIPPED" logs/*.log
# Should see:
⏭️ [ACTION_SKIPPED] ADD on market-slug
   Reason: DEGRADED_MODE
   Unpaired: X shares ($Y.YY)
   Risk Score: Z | Pair Cost: 0.XXXX
   Time Left: Ns | Degraded: true
```

### 5. Settlement Aggregations

**Check settlement logs include risk metrics:**
```bash
tail -1 logs/settlement_$(date +%Y-%m-%d).jsonl | jq '{
  pairedDelaySec,
  unpairedNotionalMax,
  unpairedAgeMaxSec,
  inventoryRiskScoreMax,
  degradedModeSecondsTotal,
  queueStressSecondsTotal,
  actionSkippedCountsByReason
}'
```

### 6. Reserve Manager (funding.ts)

**Check reserved notional accounting:**
```bash
# In the bot logs, look for:
💰 [RESERVE] +$X.XX for orderId... (market: slug)
💰 [RELEASE] -$X.XX for orderId... (market: slug)
💰 [PARTIAL] -$X.XX for orderId... (remaining: $Y.YY)
```

### 7. Rate Limiter (order-rate-limiter.ts)

**Check circuit breaker status:**
```bash
# Look for rate limit events:
⚡ [RATE_LIMIT_EXCEEDED] {"type": "order", "cancelCount": N}
⚡ [MARKET_PAUSED] {"marketId": "...", "pauseDurationMs": 30000}
⚡ [CIRCUIT_BREAKER_TRIGGERED] {"failures": N, "resetAfterMs": 120000}
```

### 8. Hedge Escalator (hedge-escalator.ts)

**Check hedge escalation events:**
```bash
# Successful escalation:
🔄 [HEDGE_ATTEMPT] UP on marketId step=1 @ 52¢ × 25sh
❌ [HEDGE_FAILED] UP on marketId step=1 @ 52¢ × 25sh (insufficient funds)
🔄 [HEDGE_ESCALATE_STEP] UP on marketId step=2 @ 53¢ × 20sh (Price +1¢)
✅ [HEDGE_SUCCESS] UP on marketId step=2 @ 53¢ × 20sh

# Failed escalation:
🔄 [HEDGE_ATTEMPT] UP on marketId step=1...
❌ [HEDGE_FAILED] ...
🚨 [HEDGE_ABORTED] UP on marketId step=3 @ 55¢ × 16sh (Max retries exhausted)
```

---

## Acceptance Criteria Verification

| Metric | Target | How to Verify |
|--------|--------|---------------|
| Failed "balance/allowance" orders | -90% | `grep -c "not enough balance\|allowance" logs/*.log` |
| Ghost hedges | 0 | No HEDGED state after HEDGE_FAILED without HEDGE_SUCCESS |
| Inventory risk tracking | 100% | Every snapshot has `inventoryRiskScore` field |
| Degraded mode events | Logged | `grep -c "DEGRADED_MODE" logs/*.log` |
| Queue stress detection | Working | `grep -c "QUEUE_STRESS" logs/*.log` |
| ACTION_SKIPPED events | Logged | `grep -c "ACTION_SKIPPED" logs/*.log` |
| Settlement aggregations | Complete | Check settlement logs for new fields |
| **v6.6.0** Guardrail spam | STOPPED | Max 1 guardrail log per 5s per market |
| **v6.6.0** Safety block on bad book | Working | `grep -c "SAFETY_BLOCK" logs/*.log` |
| **v6.6.0** Emergency unwind | Working | `grep -c "EMERGENCY_UNWIND" logs/*.log` |
| **v6.6.0** CPP implausible detection | Working | `grep -c "CPP_IMPLAUSIBLE" logs/*.log` |

---

## Configuration Reference

### inventory-risk.ts
```typescript
INVENTORY_RISK_CONFIG = {
  // Degraded Mode
  degradedTriggerNotional: 15,    // USD
  degradedTriggerAgeSec: 20,      // seconds
  riskScoreTrigger: 300,          // risk score threshold
  
  // Queue Stress
  queueStressSize: 6,             // pending orders
  queueStressWindowMs: 5000,      // ms
  
  // v6.6.0: Emergency Unwind
  cppEmergency: 1.10,             // cpp >= this triggers emergency
  cppImplausible: 1.50,           // cpp > this = units bug
  hardSkewCap: 0.70,              // 70% skew cap
  skewAgeEmergencySec: 20,        // seconds before skew emergency
  emergencyUnwindMaxSec: 45,      // max time in emergency mode
  cooldownAfterEmergencySec: 600, // 10 min cooldown after emergency
  
  // v6.6.0: Safety Block
  safetyBlockOnInvalidBook: true, // block on bad book
}
```

### funding.ts
```typescript
FUNDING_CONFIG = {
  safetyBufferUsd: 10,
  minBalanceForTrading: 50,
  staleBalanceMs: 10_000,
  maxReservedPerMarket: 150,
  maxTotalReserved: 400,
}
```


---

## File Outputs

| File | Contents |
|------|----------|
| `logs/snapshot_YYYY-MM-DD.jsonl` | Per-market snapshots with risk metrics |
| `logs/fill_YYYY-MM-DD.jsonl` | Trade fills with enrichment |
| `logs/settlement_YYYY-MM-DD.jsonl` | Market settlement with aggregations |
| `logs/settlement_failure_YYYY-MM-DD.jsonl` | 100% loss events (should be empty!) |

---

## Troubleshooting

### Inventory risk score always 0?
1. Check if position is balanced (unpaired = 0)
2. Verify position tracking is working: `grep "upShares\|downShares" logs/*.log`

### Degraded mode never triggers?
1. Check thresholds match your trading size
2. Verify hedge feasibility checks are logging

### Queue stress not detecting?
1. Check order queue polling: `grep "fetchPendingOrders" logs/*.log`
2. Verify queue size threshold (default: 6)

### ACTION_SKIPPED not logging?
1. Rate limited to 1 log per 5 seconds per market
2. Check if actions are actually being evaluated
