import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Download } from 'lucide-react';
import JSZip from 'jszip';

export const DownloadV26LogicButton = () => {
  const [downloading, setDownloading] = useState(false);

  const handleDownload = async () => {
    setDownloading(true);
    try {
      const zip = new JSZip();

      // Fetch the actual source files
      const files = [
        { path: 'src/pages/V26Dashboard.tsx', name: 'V26Dashboard.tsx' },
        { path: 'supabase/functions/v26-sync-csv/index.ts', name: 'v26-sync-csv.ts' },
      ];

      // Add explanation document
      const explanation = `
# V26 Dashboard P&L Logic Explanation
Generated: ${new Date().toISOString()}

## Current Win/Loss Calculation (V26Dashboard.tsx, lines 349-399)

The dashboard determines wins/losses in this priority order:

### PRIORITY 1: PnL from database (most reliable)
- If trade.pnl > 0 → WIN
- If trade.pnl < 0 → LOSS  
- If trade.pnl === 0 → PENDING (ambiguous)

### PRIORITY 2: Market not ended yet
- If event_end_time > now → LIVE

### PRIORITY 3: Backend stored market winning side
- If result is 'UP' or 'DOWN':
  - WIN if trade.side === result
  - LOSS if trade.side !== result

### PRIORITY 4: Fallback - infer from close vs strike delta
- delta = close_price - strike_price
- If delta > 0 → winner is 'UP'
- If delta < 0 → winner is 'DOWN'
- Compare with trade.side to determine win/loss

## P&L Calculation (lines 401-407)
- Only uses stored pnl from database
- Does NOT estimate -cost for losses anymore
- totalPnl = SUM of all trade.pnl values

## CSV Sync Logic (v26-sync-csv/index.ts)

### Buy rows → Fill data
- Extracts asset, event times from market name
- Stores: fill_matched_at, filled_shares, avg_fill_price, status='filled'

### Lost rows → Settlement (loss)
- Sets result to opposite of trade.side (normalized to UP/DOWN)
- pnl = -cost (full loss)

### Redeem rows → Settlement (win)
- IGNORES rows with usdcAmount=0 AND tokenAmount=0 (bogus redeems)
- Sets result to trade.side (we won, so market winner = our side)
- pnl = payout - cost

## Key Data Fields

| Field | Description |
|-------|-------------|
| side | Our bet: 'UP' or 'DOWN' |
| result | Market winning side: 'UP' or 'DOWN' (normalized) |
| pnl | Profit/loss in USD (positive = win, negative = loss) |
| status | 'placed', 'filled', 'settled' |
| notional | Cost = filled_shares * avg_fill_price |

## Known Issues Fixed
1. CSV sync was marking all Redeems as 'won' even with 0/0 amounts
2. result was storing 'won'/'lost' strings instead of 'UP'/'DOWN'
3. Dashboard was estimating -cost for losses, causing double-counting
4. Old imported trades from before V26 go-live were included

## Filter
Dashboard only shows trades with created_at >= '2026-01-07T21:00:00+00:00' (V26 go-live)
`;

      zip.file('README.md', explanation);

      // Add current database stats
      const dbStats = `
# Current Database State
Generated: ${new Date().toISOString()}

Query to check data quality:
\`\`\`sql
SELECT 
  COUNT(*) as total_trades,
  ROUND(SUM(pnl)::numeric, 2) as total_pnl,
  SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins,
  SUM(CASE WHEN pnl < 0 THEN 1 ELSE 0 END) as losses,
  SUM(CASE WHEN pnl IS NULL THEN 1 ELSE 0 END) as pending
FROM v26_trades
WHERE created_at >= '2026-01-07T21:00:00+00:00';
\`\`\`

Data quality checks:
\`\`\`sql
-- Should all be 0:
SELECT 'won_but_negative_pnl', COUNT(*) FROM v26_trades WHERE result IN ('won', 'WIN') AND pnl < 0
UNION ALL
SELECT 'lost_but_positive_pnl', COUNT(*) FROM v26_trades WHERE result IN ('lost', 'LOSS') AND pnl > 0
UNION ALL
SELECT 'invalid_side', COUNT(*) FROM v26_trades WHERE side NOT IN ('UP', 'DOWN');
\`\`\`
`;
      zip.file('database-queries.md', dbStats);

      // Fetch source files from the repo
      for (const file of files) {
        try {
          const response = await fetch(`https://raw.githubusercontent.com/lovable-dev/polymarket-trader/main/${file.path}`);
          if (response.ok) {
            const content = await response.text();
            zip.file(file.name, content);
          }
        } catch (e) {
          // If fetch fails, add placeholder
          zip.file(file.name, `// Could not fetch ${file.path} - check the file in your repo`);
        }
      }

      // Add inline copy of the key logic
      const keyLogic = `
// ===== WIN/LOSS CALCULATION LOGIC (from V26Dashboard.tsx lines 349-399) =====

if (!isFilled) {
  result = 'NOT_BOUGHT';
} else {
  const sideUpper = (trade.side ?? '').toUpperCase();
  const resultUpper = (tradeResult ?? '').toUpperCase();

  // PRIORITY 1: Use PnL if available (most reliable source of truth)
  if (tradePnl !== null) {
    if (tradePnl > 0) settleWin();
    else if (tradePnl < 0) settleLoss();
    else {
      // pnl === 0 is ambiguous, treat as pending unless market ended
      if (isEnded) {
        result = 'PENDING';
        totalPending++;
        addFilledAccounting();
      } else {
        result = 'LIVE';
        totalLive++;
        addFilledAccounting();
      }
    }
  }
  // PRIORITY 2: Market not ended yet -> LIVE
  else if (!isEnded) {
    result = 'LIVE';
    totalLive++;
    addFilledAccounting();
  }
  // PRIORITY 3: Backend stored market winning side (UP/DOWN)
  else if (resultUpper === 'UP' || resultUpper === 'DOWN') {
    if (sideUpper && sideUpper === resultUpper) settleWin();
    else settleLoss();
  }
  // PRIORITY 4: Fallback - infer winner from close-vs-strike delta
  else if (delta !== null) {
    if (delta === 0) {
      result = 'PENDING';
      totalPending++;
      addFilledAccounting();
    } else {
      const winningSide = delta < 0 ? 'DOWN' : 'UP';
      if (sideUpper && sideUpper === winningSide) settleWin();
      else settleLoss();
    }
  } else {
    result = 'PENDING';
    totalPending++;
    addFilledAccounting();
  }
}

// P&L: Only use stored value from database
let pnl: number | null = tradePnl;

if (pnl !== null) {
  totalPnl += pnl;
  perAsset[trade.asset].pnl += pnl;
}
`;
      zip.file('key-logic.ts', keyLogic);

      const blob = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `v26-logic-${new Date().toISOString().split('T')[0]}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Download failed:', error);
    } finally {
      setDownloading(false);
    }
  };

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={handleDownload}
      disabled={downloading}
      className="gap-2"
    >
      <Download className="h-4 w-4" />
      {downloading ? 'Downloading...' : 'Download Logic'}
    </Button>
  );
};
