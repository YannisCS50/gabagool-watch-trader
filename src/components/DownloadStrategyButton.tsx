import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { FileCode, Loader2 } from 'lucide-react';
import JSZip from 'jszip';

// Import strategy files as raw text - automatically updated at build time
// Main strategy (v6 + v7 patch exports)
// @ts-ignore - raw imports
import strategyTs from '../../local-runner/src/strategy.ts?raw';

// v7.0.1 Patch Layer
// @ts-ignore - raw imports
import v7PatchTs from '../../local-runner/src/v7-patch.ts?raw';

// Supporting modules (v6 infrastructure)
// @ts-ignore - raw imports
import hedgeEscalatorTs from '../../local-runner/src/hedge-escalator.ts?raw';
// @ts-ignore - raw imports
import inventoryRiskTs from '../../local-runner/src/inventory-risk.ts?raw';
// @ts-ignore - raw imports
import orderRateLimiterTs from '../../local-runner/src/order-rate-limiter.ts?raw';
// @ts-ignore - raw imports
import configTs from '../../local-runner/src/config.ts?raw';
// @ts-ignore - raw imports
import resolvedConfigTs from '../../local-runner/src/resolved-config.ts?raw';

const STRATEGY_FILES = [
  // Main entry point (v6 strategy + v7 patch exports)
  { name: 'strategy.ts', content: strategyTs, folder: '' },
  
  // v7.0.1 Patch Layer
  { name: 'v7-patch.ts', content: v7PatchTs, folder: '' },
  
  // v6 Infrastructure modules (preserved)
  { name: 'hedge-escalator.ts', content: hedgeEscalatorTs, folder: '' },
  { name: 'inventory-risk.ts', content: inventoryRiskTs, folder: '' },
  { name: 'order-rate-limiter.ts', content: orderRateLimiterTs, folder: '' },
  { name: 'config.ts', content: configTs, folder: '' },
  { name: 'resolved-config.ts', content: resolvedConfigTs, folder: '' },
];

export function DownloadStrategyButton() {
  const [isDownloading, setIsDownloading] = useState(false);

  const downloadStrategy = async () => {
    setIsDownloading(true);
    
    try {
      const zip = new JSZip();
      const rootFolder = zip.folder('polymarket-strategy-v7.0.1');
      
      if (!rootFolder) throw new Error('Failed to create zip folder');

      // Add all strategy files
      for (const file of STRATEGY_FILES) {
        rootFolder.file(file.name, file.content);
      }

      // Add a README with build timestamp
      const readme = `# Polymarket Trading Strategy v7.0.1

## v6 Infrastructure + v7.0.1 Patch Layer

This is a PATCH-ONLY update on top of proven v6 infrastructure.

## Architecture

### Main Strategy:
- **strategy.ts**: v6.1.2 GPT Strategy with v7.0.1 patch exports

### v7.0.1 Patch Layer:
- **v7-patch.ts**: Contains the 5 MUST patches:
  1. Readiness Gate + 12s Timeout
  2. Bounded Intent Slots (max 2 per market)
  3. Micro-Hedge Accumulator (min 5 shares)
  4. Degraded Mode via riskScore >= 400
  5. Queue-Stress Gating

### v6 Infrastructure (preserved):
- **hedge-escalator.ts**: Atomic hedge retry with price escalation
- **inventory-risk.ts**: Inventory risk management  
- **order-rate-limiter.ts**: Rate limiting for order placement
- **config.ts**: Environment configuration
- **resolved-config.ts**: Runtime configuration resolution

## Key v7.0.1 Features:
- No order placement unless BOTH token orderbooks are ready
- Market disabled after 12s if not ready (MARKET_DISABLED_NO_ORDERBOOK)
- Micro-hedge accumulator batches small fills (min 5 shares)
- riskScore triggers degraded mode (blocks ENTRY/ACCUMULATE)
- Queue stress blocks new entries but allows hedges

## Build Info
Generated: ${new Date().toISOString()}
Version: 7.0.1 (Patch Layer on v6)
`;
      rootFolder.file('README.md', readme);

      const blob = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `polymarket-strategy-v7.0.1-${new Date().toISOString().split('T')[0]}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Error downloading strategy:', error);
    } finally {
      setIsDownloading(false);
    }
  };

  return (
    <Button
      onClick={downloadStrategy}
      disabled={isDownloading}
      variant="ghost"
      className="w-full justify-start text-xs h-8"
    >
      {isDownloading ? (
        <Loader2 className="w-3 h-3 mr-2 animate-spin" />
      ) : (
        <FileCode className="w-3 h-3 mr-2" />
      )}
      {isDownloading ? 'Creating...' : 'Strategy Code'}
    </Button>
  );
}
