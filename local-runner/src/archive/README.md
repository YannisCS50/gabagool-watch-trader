# Archived Strategies

This folder contains deprecated strategy versions that are no longer actively used.
They are preserved for reference and potential rollback scenarios.

## Archived Files:

### gpt-strat-v5.ts
Original GPT Strategy v5.2.4 - "Always Hedge Edition"
- Contains the original SURVIVAL/PANIC/HIGH_DELTA_CRITICAL mode logic
- ~1770 lines of legacy code
- Deprecated in favor of v7.0 unified strategy

### loveable-strat-v6.ts  
GPT Strategy v6.1.2 - "Micro-Hedge Execution"
- Gabagool-style micro-sizing and hedging
- ~2000 lines with extensive configuration
- Deprecated in favor of v7.0 unified strategy

## When to use:
- Emergency rollback if v7 has critical issues
- Reference for understanding historical trading logic
- Debugging historical trade decisions

## Migration Notes:
v7.0 consolidates all functionality into a cleaner architecture:
- Unified config (single source of truth)
- Readiness gates (no orderbook = no order)
- Inventory-first signals
- Micro-hedge after every fill (exact size)
- Degraded mode + circuit breaker
