import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { FileCode, Loader2 } from 'lucide-react';
import JSZip from 'jszip';

// Import strategy files as raw text - automatically updated at build time
// Main strategy wrapper
// @ts-ignore - raw imports
import strategyTs from '../../local-runner/src/strategy.ts?raw';

// v7 Strategy modules
// @ts-ignore - raw imports
import v7TypesTs from '../../local-runner/src/strategy-v7/types.ts?raw';
// @ts-ignore - raw imports
import v7ConfigTs from '../../local-runner/src/strategy-v7/config.ts?raw';
// @ts-ignore - raw imports
import v7ReadinessTs from '../../local-runner/src/strategy-v7/readiness.ts?raw';
// @ts-ignore - raw imports
import v7InventoryTs from '../../local-runner/src/strategy-v7/inventory.ts?raw';
// @ts-ignore - raw imports
import v7IntentsTs from '../../local-runner/src/strategy-v7/intents.ts?raw';
// @ts-ignore - raw imports
import v7CircuitBreakerTs from '../../local-runner/src/strategy-v7/circuit-breaker.ts?raw';
// @ts-ignore - raw imports
import v7QueueTs from '../../local-runner/src/strategy-v7/queue.ts?raw';
// @ts-ignore - raw imports
import v7IndexTs from '../../local-runner/src/strategy-v7/index.ts?raw';

// Supporting modules
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
  // Main entry point
  { name: 'strategy.ts', content: strategyTs, folder: '' },
  
  // v7 Core modules
  { name: 'strategy-v7/index.ts', content: v7IndexTs, folder: 'strategy-v7' },
  { name: 'strategy-v7/types.ts', content: v7TypesTs, folder: 'strategy-v7' },
  { name: 'strategy-v7/config.ts', content: v7ConfigTs, folder: 'strategy-v7' },
  { name: 'strategy-v7/readiness.ts', content: v7ReadinessTs, folder: 'strategy-v7' },
  { name: 'strategy-v7/inventory.ts', content: v7InventoryTs, folder: 'strategy-v7' },
  { name: 'strategy-v7/intents.ts', content: v7IntentsTs, folder: 'strategy-v7' },
  { name: 'strategy-v7/circuit-breaker.ts', content: v7CircuitBreakerTs, folder: 'strategy-v7' },
  { name: 'strategy-v7/queue.ts', content: v7QueueTs, folder: 'strategy-v7' },
  
  // Supporting modules
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
      const rootFolder = zip.folder('polymarket-strategy-v7');
      
      if (!rootFolder) throw new Error('Failed to create zip folder');

      // Create v7 subfolder
      const v7Folder = rootFolder.folder('strategy-v7');
      if (!v7Folder) throw new Error('Failed to create v7 folder');

      // Add all strategy files
      for (const file of STRATEGY_FILES) {
        if (file.folder === 'strategy-v7') {
          v7Folder.file(file.name.replace('strategy-v7/', ''), file.content);
        } else {
          rootFolder.file(file.name, file.content);
        }
      }

      // Add a README with build timestamp
      const readme = `# Polymarket Trading Strategy v7.0

## Gabagool-style Inventory Arbitrage + Execution Hardening

## Architecture

### Main Entry Point:
- **strategy.ts**: Unified strategy wrapper with v7 re-exports and legacy compatibility

### v7 Core Modules (strategy-v7/):
- **index.ts**: Module exports
- **types.ts**: Type definitions (Intent, MarketSnapshot, InventoryState, etc.)
- **config.ts**: Unified configuration with DB > ENV > defaults priority
- **readiness.ts**: Orderbook readiness gates (no book = no order)
- **inventory.ts**: Inventory-first risk calculation, pair cost tracking
- **intents.ts**: Intent builder with mode selection (Normal/Survival/Panic)
- **circuit-breaker.ts**: Automatic trading halt on excessive failures
- **queue.ts**: Bounded intent queue with priority handling

### Supporting Modules:
- **hedge-escalator.ts**: Atomic hedge retry with price escalation
- **inventory-risk.ts**: Legacy risk management (being migrated)
- **order-rate-limiter.ts**: Rate limiting for order placement
- **config.ts**: Environment configuration
- **resolved-config.ts**: Runtime configuration resolution

## Key v7 Features:
1. **Readiness Gates**: No order if orderbook not ready
2. **Inventory-First Signals**: Unpaired shares & age are leading signals
3. **Micro-Hedge After Fills**: Hedge EXACT filled size
4. **Queue-Aware Throttling**: Stress mode stops entries, hedges continue
5. **Degraded Mode**: Block entries when risk score too high
6. **Circuit Breaker**: Stop all trading after too many failures

## Build Info
Generated: ${new Date().toISOString()}
Version: 7.0.0
`;
      rootFolder.file('README.md', readme);

      const blob = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `polymarket-strategy-v7-${new Date().toISOString().split('T')[0]}.zip`;
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
