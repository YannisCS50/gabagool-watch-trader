# Claim Debug & Reconciliation Guide

## Quick Start

```bash
cd /home/deploy/app/local-runner
npm run claim:debug
```

## What the Debug Script Does

1. **Lists wallet addresses** - Shows both the signer (EOA) and proxy wallet
2. **Fetches claimable positions** - From Polymarket Data API for both wallets
3. **Queries on-chain claims** - Parses `PayoutRedemption` events from last ~1 hour
4. **Compares API vs on-chain** - Identifies discrepancies
5. **Diagnoses issues** - Explains why positions might still show as claimable

## Understanding the Output

### Discrepancy Types

| Issue | Icon | Meaning | Action |
|-------|------|---------|--------|
| `indexer_delay` | ⏳ | Claimed on-chain but API not updated yet | Wait 5-10 minutes |
| `wrong_wallet` | 👤 | Position belongs to different wallet | Cannot claim with current signer |
| `not_claimed` | ❌ | Never claimed on-chain | Bot should claim this |

### Common Scenarios

#### "Bot says claimed but UI shows 2 pending"

Run `npm run claim:debug` and check:

1. **If `indexer_delay`**: Already claimed! Wait for Polymarket indexer to catch up
2. **If `wrong_wallet`**: The position was opened with a different wallet address
3. **If `not_claimed`**: The claim tx never included these conditionIds

#### "Nonce too low errors"

This indicates parallel claim attempts. The redeemer now has:
- **Mutex lock**: Only 1 claim loop runs at a time
- **Nonce manager**: Tracks and resets nonces from chain

## Architecture

```
scripts/claim-debug.ts  - Standalone debug tool
src/chain.ts           - Provider, event parsing, nonce helpers
src/reconcile.ts       - API vs on-chain comparison logic
src/redeemer.ts        - Main claimer with mutex + event confirmation
```

## Key Principles

1. **No optimistic accounting** - Claims only count after `PayoutRedemption` event in receipt
2. **Event-based confirmation** - Parse receipt logs, not just tx status
3. **Re-fetch verification** - After claiming, re-fetch API to verify claimables dropped
4. **Mutex protection** - Single claim loop at a time, no parallel tx sends

## Troubleshooting

### Script won't run

```bash
# Make sure you're in the right directory
cd /home/deploy/app/local-runner

# Make sure dependencies are installed
npm install

# Run the script
npm run claim:debug
```

### "Cannot find module" errors

```bash
# The project uses ESM modules - make sure tsx is installed
npm install tsx
```

### Provider errors

The script uses multiple RPC endpoints with fallback:
- polygon-rpc.com
- matic.quiknode.pro
- blastapi.io

If all fail, check network connectivity.

## Manual Verification

To verify a specific claim tx on-chain:

```bash
# Check tx on PolygonScan
https://polygonscan.com/tx/<TX_HASH>

# Look for PayoutRedemption event in "Logs" tab
# The conditionId in the event should match the position
```
