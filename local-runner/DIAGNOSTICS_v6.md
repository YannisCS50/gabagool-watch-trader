# v6.0.0 Reliability & Observability Patch - Diagnostics

## How to verify the patch is working

### 1. Reserve Manager (funding.ts)

**Check reserved notional accounting:**
```bash
# In the bot logs, look for:
💰 [RESERVE] +$X.XX for orderId... (market: slug)
💰 [RELEASE] -$X.XX for orderId... (market: slug)
💰 [PARTIAL] -$X.XX for orderId... (remaining: $Y.YY)
```

**Verify blocked orders reduced:**
```bash
# Search logs for blocked orders:
grep "ORDER_BLOCKED" logs/*.log

# Should see far fewer than before patch
# Each blocked order will show:
🛑 [ORDER_BLOCKED] UP/DOWN on marketId
   Required: $X.XX
   Available: $Y.YY
   Reserved: $Z.ZZ
   Free: $W.WW
```

### 2. Rate Limiter (order-rate-limiter.ts)

**Check circuit breaker status:**
```bash
# Look for rate limit events:
⚡ [RATE_LIMIT_EXCEEDED] {"type": "order", "cancelCount": N}
⚡ [MARKET_PAUSED] {"marketId": "...", "pauseDurationMs": 30000}
⚡ [CIRCUIT_BREAKER_TRIGGERED] {"failures": N, "resetAfterMs": 120000}
```

**Verify cancel/replace churn is capped:**
- Max 10 cancel/replace per market per minute
- Max 50 total cancels per minute
- Markets pause for 30s when limit exceeded

### 3. Hedge Escalator (hedge-escalator.ts)

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
🔄 [HEDGE_ESCALATE_STEP] ...
❌ [HEDGE_FAILED] ...
🚨 [HEDGE_ABORTED] UP on marketId step=3 @ 55¢ × 16sh (Max retries exhausted)
```

**Key invariant:** Bot NEVER transitions to HEDGED state on failed hedge placement.

### 4. Snapshot Enrichment (telemetry.ts, logger.ts)

**Verify snapshots have all fields:**
```bash
# Check a snapshot log file:
head -1 logs/snapshot_$(date +%Y-%m-%d).jsonl | jq .

# Should include:
# - spotPrice (NOT null for most snapshots)
# - btcPrice / ethPrice
# - upBestAsk / downBestAsk
# - strikePrice
# - delta
```

**Verify fills have enrichment fields:**
```bash
# Check a fill log file:
head -1 logs/fill_$(date +%Y-%m-%d).jsonl | jq .

# Should include:
# - spotPrice (NOT null)
# - btcPrice / ethPrice
# - upBestAsk / downBestAsk / upBestBid / downBestBid
# - hedgeLagMs (for hedge fills)
```

### 5. Acceptance Criteria Verification

| Metric | Target | How to Verify |
|--------|--------|---------------|
| Failed "balance/allowance" orders | -90% | `grep -c "not enough balance\|allowance" logs/*.log` |
| Ghost hedges | 0 | `grep -c "HEDGED" logs/*.log` after HEDGE_FAILED without HEDGE_SUCCESS |
| fills_enriched snap_* fill rate | >95% | Check CSV for non-null snap_* columns |
| spot_price in TICK events | 100% | `grep "TICK" logs/*.jsonl \| jq '.spotPrice'` |
| Cancel/replace churn | Capped | `grep -c "RATE_LIMIT_EXCEEDED" logs/*.log` shows limits hit, not bypassed |

## Observability Dashboard

### Quick Stats Commands

```bash
# Blocked orders last hour:
grep "ORDER_BLOCKED" logs/$(date +%Y-%m-%d)*.log | wc -l

# Hedge escalation success rate:
success=$(grep -c "HEDGE_SUCCESS" logs/*.log)
total=$(grep -c "HEDGE_ATTEMPT.*step=1" logs/*.log)
echo "Hedge success rate: $((success * 100 / total))%"

# Rate limit triggers:
grep "RATE_LIMIT\|CIRCUIT_BREAKER" logs/*.log | tail -20

# Reserve manager reconciliation:
grep "RECONCILE" logs/*.log | tail -10
```

## File Outputs

| File | Contents |
|------|----------|
| `logs/snapshot_YYYY-MM-DD.jsonl` | Per-market snapshots (1/sec) |
| `logs/fill_YYYY-MM-DD.jsonl` | Trade fills with enrichment |
| `logs/settlement_YYYY-MM-DD.jsonl` | Market settlement summaries |
| `logs/settlement_failure_YYYY-MM-DD.jsonl` | 100% loss events (should be empty!) |

## Troubleshooting

### Still seeing "not enough balance" errors?

1. Check `FUNDING_CONFIG.safetyBufferUsd` (default $10)
2. Verify balance cache TTL (`staleBalanceMs`: 10s)
3. Look for reserve leaks: `grep "RECONCILE" logs/*.log`

### Hedge escalation always failing?

1. Check `HEDGE_ESCALATOR_CONFIG.maxHedgePrice` (default 0.85)
2. Verify liquidity: `grep "NO_LIQUIDITY" logs/*.log`
3. Check survival mode threshold: <60s = accepts up to 95¢

### Snapshots missing data?

1. Verify Chainlink price fetching: `grep "BTC\|ETH" logs/*.log | head`
2. Check market context cache: `grep "spotPrice" logs/snapshot*.jsonl | head`
