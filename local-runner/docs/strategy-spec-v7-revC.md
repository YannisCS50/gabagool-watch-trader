# LOVEABLE STRATEGY FIX SPEC v7.x (REV C)
## PARTIAL-PAIR GUARDRAILS — FINE-TUNED FOR 15-MIN MARKETS

This is Revision C of the strategy-fix specification.
It incorporates final fine-tuning suggestions focused on:
- tighter timing for 15-minute markets
- explicit volatility scaling defaults
- improved observability of PAIRING lifecycle

All previous constraints and rules from Rev B remain in force unless explicitly modified here.

---

## UPDATED PARAMETERS (KEY)

### A) PAIRING STATE TIMEOUT (TIGHTENED)

**Update:**
- `pairingTimeoutSeconds = 45`

**Rationale:**
- 15-minute markets have fast regime changes
- Shorter timeout reduces risk of drifting toward expiry with partial exposure
- Leaves more buffer for UNWIND_ONLY behavior near expiry

**Rule (unchanged logic, new value):**
- If time in PAIRING >= pairingTimeoutSeconds AND market is not PAIRED:
  - → revert to ONE_SIDED_UP or ONE_SIDED_DOWN
  - → cancel unfilled hedge orders
  - → emit PAIRING_TIMEOUT_REVERT log

---

### B) DYNAMIC HEDGE SLIPPAGE CAPS (DEFAULTS ADDED)

Add explicit default for volatility scaling.

**Config additions:**
- `volatilityMultiplier = 50`
- `volatilityLookbackSeconds = 300`

**Dynamic cap formula (unchanged):**
```
recentVol = abs(midPriceNow - midPriceLookback) / midPriceLookback
dynamicCapCents = hedgeSlippageCapCentsBase + (recentVol * volatilityMultiplier * 100)
finalCapCents = min(dynamicCapCents, hedgeSlippageCapCentsMax)
```

**Interpretation:**
- A 0.1% move over 5 minutes adds ~5 cents * 0.01 = 0.5 cents
- Scaling is intentionally conservative

**Fallback:**
- If midPriceLookback unavailable → use base cap only

**Per-Asset Defaults:**
| Asset | Base Cap | Max Cap |
|-------|----------|---------|
| BTC   | 1.0¢     | 2.0¢    |
| ETH   | 1.5¢     | 2.5¢    |
| SOL   | 2.0¢     | 3.0¢    |
| XRP   | 2.0¢     | 4.0¢    |

---

### C) MIN HEDGE CHUNK WITH ABSOLUTE CAP (UPDATED)

**Problem:**
minHedgeChunkPct = 25% can become too large for big inventories (500+ shares),
forcing oversized hedges or blocking sensible partial pairing.

**Solution:**
Add an upper cap on hedge chunk size.

**Updated calculation:**
```typescript
oneSidedShares = max(upShares, downShares)
rawChunk = oneSidedShares * minHedgeChunkPct
boundedChunk = clamp(rawChunk, minHedgeChunkAbs, maxHedgeChunkAbs)
```

**Config:**
- `minHedgeChunkAbs = 25` shares
- `minHedgeChunkPct = 0.25`
- `maxHedgeChunkAbs = 100` shares (suggested start)

**Rule:**
- Hedge allowed only if intended hedge size >= boundedChunk

**Rationale:**
- Keeps hedges meaningful
- Avoids over-committing on large one-sided positions
- Maintains consistency across inventory scales

---

### D) PAIRING LIFECYCLE LOGGING (NEW)

Add explicit log on entry into PAIRING state.

**New log event: PAIRING_STARTED**

Emit when:
- State transitions from ONE_SIDED_* → PAIRING

Log fields:
- `marketId`
- `asset`
- `timestamp`
- `upShares`
- `downShares`
- `bestAskUp`
- `bestAskDown`
- `combinedAsk`
- `impliedPairCostCents` (if computable)
- `hedgeReason` enum: `PAIR_EDGE` | `EMERGENCY_SKEW`

**Existing logs (unchanged):**
- `PAIRING_TIMEOUT_REVERT`
- `HEDGE_BLOCKED_*`
- `HEDGE_PRICE_CAP_DYNAMIC`

**Rationale:**
Enables precise measurement of:
- how often pairing is attempted
- how often it succeeds vs times out
- whether timeouts correlate with price drift or volatility

---

## ACCEPTANCE CRITERIA (FINALIZED)

1. For 15-minute markets, PAIRING cannot persist longer than 45s.
2. Every PAIRING attempt must emit exactly one PAIRING_STARTED log.
3. Every failed PAIRING attempt must emit PAIRING_TIMEOUT_REVERT.
4. Volatility-based hedge caps use defined defaults and bounded max values.
5. Partial, unbalanced pairs must not persist beyond pairingTimeoutSeconds.
6. Bot behavior remains conservative and stable; no increase in forced trading.

---

## IMPLEMENTATION

Module: `local-runner/src/market-state-manager.ts`

### Key Exports:
- `MarketStateManager` class
- `getMarketStateManager(runId)` factory
- `MARKET_STATE_CONFIG` configuration object

### Integration Points:
1. Import in main strategy loop
2. Call `processTick()` per market tick
3. Use `isHedgePriceAllowed()` before placing hedge orders
4. Use `isHedgeSizeAllowed()` for chunk validation
5. Handle `shouldCancelUnfilledHedges` flag when PAIRING times out

---

## STATE MACHINE

```
FLAT → ONE_SIDED_UP/DOWN → PAIRING → PAIRED → UNWIND_ONLY
                              ↓
                    (timeout) → ONE_SIDED_UP/DOWN
```

### State Descriptions:
- **FLAT**: No inventory
- **ONE_SIDED_UP/DOWN**: Position on one side only, waiting for edge
- **PAIRING**: Actively attempting to hedge, max 45s dwell
- **PAIRED**: Both sides have inventory, balanced
- **UNWIND_ONLY**: Near expiry (<45s), no new entries

---

## CHANGELOG

### REV C (Current)
- Tightened `pairingTimeoutSeconds` from 60 → 45
- Added `volatilityMultiplier = 50` default
- Added `PAIRING_STARTED` log event
- Defined `hedgeReason` enum for observability

### REV B
- Added PAIRING state timeout concept (60s)
- Added dynamic hedge slippage caps with volatility scaling
- Added bounded hedge chunk sizing (min/max)
- Added `PAIRING_TIMEOUT_REVERT` and `HEDGE_PRICE_CAP_DYNAMIC` logs

### REV A (Original)
- State machine: FLAT → ONE_SIDED → PAIRING → PAIRED → UNWIND_ONLY
- "No partial pair without edge" rule
- Anti-dribble min chunk
- Late-expiry UNWIND_ONLY
