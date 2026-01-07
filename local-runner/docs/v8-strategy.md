# v8 Strategy - State Mispricing

## Overview

v8 is a clean strategy rewrite that trades Polymarket 15-minute UP/DOWN markets by exploiting **state mispricing** - when market prices diverge from empirically learned fair values.

## Core Concept

1. **Learn fair prices** from observed mid prices using EWMA (Exponential Weighted Moving Average)
2. **Detect mispricing** when askUp < fairUp (we can buy cheap)
3. **Enter single-leg** on the underpriced side
4. **Wait for correction** (market reprices, edge shrinks, profit appears)
5. **Hedge opposite side** ONLY after correction

## Key Difference from v7

- v7 required YES+NO < 1.00 (combined price arbitrage)
- v8 does NOT require combined price < 1.00
- v8 enters based on single-side mispricing vs empirical fair value

## Invariants

| ID | Name | Description |
|----|------|-------------|
| INV-1 | STRATEGY ISOLATION | v7 must NOT run when v8 enabled |
| INV-2 | NO-CROSSING | BUY ≤ bestAsk - tick, SELL ≥ bestBid + tick |
| INV-3 | BOOK FRESHNESS | No orders if book age > 500ms |
| INV-4 | SINGLE ORDER | Max 1 open order per (market, token, intent) |
| INV-5 | HEDGE PRIORITY | Hedge actions pre-empt entry actions |
| INV-6 | FEE AWARENESS | Every fill must include liquidity + feeUsd |

## Configuration

Set `FEATURE_STRATEGY=v8` environment variable to enable.

Key parameters (see `config.ts`):
- `entry.edgeEntryMin`: 8¢ minimum edge for entry
- `correction.edgeCorrectedMax`: 3¢ max edge for correction trigger
- `correction.profitTriggerUsd`: $0.50 unrealized profit required
- `hedge.maxCppApprox`: 1.00 max combined cost for hedge

## Kill Switches

Entries disabled automatically when:
- `feeUsd` missing on fills
- Maker fill ratio < 50% over 50 fills
- Stale book skips > 15%

## Metrics to Watch

- Maker fill rate (target >80%)
- Correction frequency
- Hedge attempt success rate
- Unhedged positions at expiry
- Surface sample counts per bucket
