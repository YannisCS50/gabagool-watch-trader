# REV C.3 STRATEGY VALIDATION REPORT

**Periode:** 2026-01-05 15:45-16:00 UTC  
**Versie:** v7.2.4  
**Generated:** 2026-01-05T16:00:00Z

---

## 1. STATE LIFECYCLE PER MARKET

```json
{
  "markets": [
    {
      "marketId": "btc-updown-15m-1767627900",
      "asset": "BTC",
      "state_timeline": [
        {"timestamp": "15:48:25", "state": "ONE_SIDED_UP", "reason": "ENTRY 69sh UP filled", "inferred": true},
        {"timestamp": "15:48:40", "state": "PAIRING", "reason": "HEDGE 11sh DOWN filled", "inferred": true},
        {"timestamp": "~15:49:00", "state": "SKEWED", "reason": "unpaired=47, paired=122 (skew 58%)", "inferred": true}
      ],
      "final_position": {"up": 169, "down": 122, "unpaired": 47, "paired": 122}
    },
    {
      "marketId": "eth-updown-15m-1767627900",
      "asset": "ETH",
      "state_timeline": [
        {"timestamp": "unknown", "state": "SKEWED", "reason": "UP=220, DOWN=100 → skew 74.6%", "inferred": true},
        {"timestamp": "15:57:09", "state": "EMERGENCY_UNWIND", "reason": "SKEW_EMERGENCY: skew=74.6% >= 70% AND age=20s > 20s", "inferred": false}
      ],
      "final_position": {"up": 220, "down": 100, "unpaired": 120, "paired": 100},
      "violation_flag": "EXCESSIVE_SKEW"
    },
    {
      "marketId": "xrp-updown-15m-1767627900",
      "asset": "XRP",
      "state_timeline": [
        {"timestamp": "15:51:10", "state": "ONE_SIDED_DOWN", "reason": "ENTRY 12sh DOWN filled", "inferred": true},
        {"timestamp": "15:54:21", "state": "ONE_SIDED_DOWN", "reason": "ENTRY 15sh DOWN added (no UP)", "inferred": true}
      ],
      "final_position": {"up": 0, "down": 27, "unpaired": 27, "paired": 0},
      "violation_flag": "NO_HEDGE_ATTEMPTED"
    },
    {
      "marketId": "sol-updown-15m-1767627900",
      "asset": "SOL",
      "state_timeline": [
        {"timestamp": "15:48:17", "state": "ONE_SIDED_UP", "reason": "ENTRY 23sh UP filled", "inferred": true},
        {"timestamp": "15:48:55", "state": "SKEWED", "reason": "HEDGE 4sh DOWN filled (hedge_lag=37837ms)", "inferred": true}
      ],
      "final_position": {"up": 23, "down": 4, "unpaired": 19, "paired": 4}
    }
  ]
}
```

---

## 2. HEDGE INTENTS ANALYSIS

| Market | Time | State | Reason | Side | Size | Price Ref | Placed | Blocked |
|--------|------|-------|--------|------|------|-----------|--------|---------|
| BTC | 15:48:40 | PAIRING | PAIR_EDGE | DOWN | 11 | bestAsk | ✅ Yes | - |
| SOL | 15:48:55 | PAIRING | PAIR_EDGE | DOWN | 4 | bestAsk | ✅ Yes | - |
| ETH | 15:57:09 | EMERGENCY | SKEW_EMERGENCY | DOWN | ? | ? | ❌ No | `not enough balance` |

---

## 3. STRATEGY VIOLATIONS DETECTED

```json
{
  "violations": [
    {
      "marketId": "eth-updown-15m-1767627900",
      "type": "EXCESSIVE_POSITION_SIZE",
      "timestamp": "15:57:04",
      "details": "UP=220 shares exceeds maxSharesPerSide=100. Position was built without limit enforcement.",
      "confidence": "high"
    },
    {
      "marketId": "eth-updown-15m-1767627900", 
      "type": "CPP_DEFINITION_MISMATCH",
      "timestamp": "15:57:04",
      "details": "costPerPaired=2.093 calculated as totalInvested/paired (209.3/100). Should use paired-only CPP (avgUp+avgDown). False EMERGENCY trigger.",
      "confidence": "high"
    },
    {
      "marketId": "xrp-updown-15m-1767627900",
      "type": "ENTRY_WITHOUT_HEDGE",
      "timestamp": "15:51-15:54",
      "details": "Two ENTRY fills on DOWN side (12sh + 15sh) without any hedge attempt. No PAIRING state entered.",
      "confidence": "high"
    },
    {
      "marketId": "btc-updown-15m-1767627900",
      "type": "POSITION_OVER_LIMIT",
      "timestamp": "15:48",
      "details": "UP=169 shares exceeds maxSharesPerSide=100. Entry 69sh brought total over limit.",
      "confidence": "high"
    }
  ]
}
```

---

## 4. EMERGENCY_UNWIND ANALYSIS

```json
{
  "emergency_events": [
    {
      "marketId": "eth-updown-15m-1767627900",
      "timestamp": "15:57:09",
      "trigger": "SKEW_EMERGENCY",
      "cpp_value": 2.093,
      "cpp_definition_used": "totalInvested/paired (INCORRECT)",
      "state_at_trigger": "SKEWED",
      "orders_attempted": 1,
      "orders_placed": 0,
      "abort_reason": "not enough balance / allowance",
      "should_have_triggered": "MAYBE - skew was real (74.6%), but CPP was false positive"
    },
    {
      "marketId": "xrp-updown-15m-1767627900", 
      "timestamp": "15:56:51",
      "trigger": "CPP_EMERGENCY",
      "cpp_value": 1.556,
      "cpp_definition_used": "unknown",
      "orders_attempted": 1,
      "orders_placed": 0,
      "should_have_triggered": false
    }
  ]
}
```

---

## 5. FINAL SUMMARY

```json
{
  "rev_c3_compliance": "FAIL",
  "key_findings": [
    "⛔ maxSharesPerSide=100 limit NOT enforced: ETH=220, BTC=169",
    "⛔ CPP still uses totalInvested/paired instead of paired-only (avgUp+avgDown)",
    "⛔ XRP had 2 ENTRY fills with NO hedge - single-sided exposure built",
    "⛔ EMERGENCY_UNWIND triggered on ETH with CPP=2.093 (false positive from bad formula)",
    "✅ No aggressive hedge fallbacks detected (ask+0.03 removed)",
    "✅ GUARDRAIL_TRIGGERED correctly blocking adds on CPP emergency"
  ],
  "most_dangerous_remaining_path": "Position size limits are NOT enforced in index.ts. Multiple entries can exceed 100 shares per side.",
  "confidence_level": "high"
}
```

---

## 6. REQUIRED FIXES

### Critical (must fix before next run):

1. **Position Limit Bug**: v7.2.4 fix niet actief - herstart runner nodig
2. **CPP Formula Bug**: GUARDRAIL_TRIGGERED logt `totalInvested/paired` ipv `cppPairedOnly`
3. **XRP Single-Sided**: Entries zonder hedge - geen PAIRING state entered

### Code locations:

- Position limit: `index.ts` lines 1635-1683 (v7.2.4)
- CPP formula: `strategy.ts` checkV611Guardrails()
- Hedge pairing: `market-state-manager.ts` beginPairing()

---

## 7. RAW DATA SAMPLES

### BTC Position (15:48):
- ENTRY: 69sh UP @ 36¢ = $24.84
- HEDGE: 11sh DOWN @ 68¢ = $7.48
- Total UP: 169, Total DOWN: 122, Unpaired: 47

### ETH Position (15:57):
- Total UP: 220, Total DOWN: 100
- Paired: 100, Unpaired: 120
- CPP (logged): 2.093 (totalInvested/paired = 209.3/100)
- CPP (should be): avgUp + avgDown ≈ 0.50 + 0.43 = 0.93

### XRP Position (15:54):
- ENTRY 1: 12sh DOWN @ 69¢
- ENTRY 2: 15sh DOWN @ 44¢
- No UP fills, no hedge attempted

---

**Report generated by Lovable Rev C.3 Validator**
