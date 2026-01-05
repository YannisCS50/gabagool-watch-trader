import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { FileCode, Loader2 } from 'lucide-react';
import JSZip from 'jszip';

// Import strategy files as raw text - automatically updated at build time
// Main entry point
// @ts-ignore - raw imports
import indexTs from '../../local-runner/src/index.ts?raw';

// Core strategy modules
// @ts-ignore - raw imports
import strategyTs from '../../local-runner/src/strategy.ts?raw';
// @ts-ignore - raw imports
import v7PatchTs from '../../local-runner/src/v7-patch.ts?raw';

// API & Infrastructure
// @ts-ignore - raw imports
import polymarketTs from '../../local-runner/src/polymarket.ts?raw';
// @ts-ignore - raw imports
import hedgeEscalatorTs from '../../local-runner/src/hedge-escalator.ts?raw';
// @ts-ignore - raw imports
import inventoryRiskTs from '../../local-runner/src/inventory-risk.ts?raw';
// @ts-ignore - raw imports
import orderRateLimiterTs from '../../local-runner/src/order-rate-limiter.ts?raw';
// @ts-ignore - raw imports
import marketStateManagerTs from '../../local-runner/src/market-state-manager.ts?raw';
// @ts-ignore - raw imports
import positionsSyncTs from '../../local-runner/src/positions-sync.ts?raw';

// Configuration
// @ts-ignore - raw imports
import configTs from '../../local-runner/src/config.ts?raw';
// @ts-ignore - raw imports
import resolvedConfigTs from '../../local-runner/src/resolved-config.ts?raw';

// Supporting modules
// @ts-ignore - raw imports
import fundingTs from '../../local-runner/src/funding.ts?raw';
// @ts-ignore - raw imports
import telemetryTs from '../../local-runner/src/telemetry.ts?raw';
// @ts-ignore - raw imports
import loggerTs from '../../local-runner/src/logger.ts?raw';
// @ts-ignore - raw imports
import chainTs from '../../local-runner/src/chain.ts?raw';
// @ts-ignore - raw imports
import backendTs from '../../local-runner/src/backend.ts?raw';
// @ts-ignore - raw imports
import authManagerTs from '../../local-runner/src/authManager.ts?raw';
// @ts-ignore - raw imports
import redeemerTs from '../../local-runner/src/redeemer.ts?raw';
// @ts-ignore - raw imports
import reconcileTs from '../../local-runner/src/reconcile.ts?raw';

const STRATEGY_FILES = [
  // Main entry point
  { name: 'index.ts', content: indexTs, folder: '' },
  
  // Core strategy
  { name: 'strategy.ts', content: strategyTs, folder: '' },
  { name: 'v7-patch.ts', content: v7PatchTs, folder: '' },
  
  // API & Infrastructure
  { name: 'polymarket.ts', content: polymarketTs, folder: '' },
  { name: 'hedge-escalator.ts', content: hedgeEscalatorTs, folder: '' },
  { name: 'inventory-risk.ts', content: inventoryRiskTs, folder: '' },
  { name: 'order-rate-limiter.ts', content: orderRateLimiterTs, folder: '' },
  { name: 'market-state-manager.ts', content: marketStateManagerTs, folder: '' },
  { name: 'positions-sync.ts', content: positionsSyncTs, folder: '' },
  
  // Configuration
  { name: 'config.ts', content: configTs, folder: '' },
  { name: 'resolved-config.ts', content: resolvedConfigTs, folder: '' },
  
  // Supporting modules
  { name: 'funding.ts', content: fundingTs, folder: '' },
  { name: 'telemetry.ts', content: telemetryTs, folder: '' },
  { name: 'logger.ts', content: loggerTs, folder: '' },
  { name: 'chain.ts', content: chainTs, folder: '' },
  { name: 'backend.ts', content: backendTs, folder: '' },
  { name: 'authManager.ts', content: authManagerTs, folder: '' },
  { name: 'redeemer.ts', content: redeemerTs, folder: '' },
  { name: 'reconcile.ts', content: reconcileTs, folder: '' },
];

export function DownloadStrategyButton() {
  const [isDownloading, setIsDownloading] = useState(false);

  const downloadStrategy = async () => {
    setIsDownloading(true);
    
    try {
      const zip = new JSZip();
      const rootFolder = zip.folder('polymarket-strategy-v7.2.3');
      
      if (!rootFolder) throw new Error('Failed to create zip folder');

      // Add all strategy files
      for (const file of STRATEGY_FILES) {
        rootFolder.file(file.name, file.content);
      }

      // Add a README with build timestamp
      const readme = `# Polymarket Trading Strategy v7.2.3

## Complete Trading Bot with All Hotfixes

This is the COMPLETE trading bot with all recent hotfixes applied.

## Files Included

### Main Entry Point:
- **index.ts**: Main bot loop with all hotfixes (CPP_IMPLAUSIBLE, balance handling, etc.)

### Core Strategy:
- **strategy.ts**: v6.1.2 GPT Strategy with v7 patch exports
- **v7-patch.ts**: v7 Patch Layer with readiness gate, intent slots, etc.

### API & Infrastructure:
- **polymarket.ts**: Polymarket CLOB API wrapper with price improvement fixes
- **hedge-escalator.ts**: Atomic hedge retry with price escalation
- **inventory-risk.ts**: Inventory risk management with CPP_IMPLAUSIBLE handling
- **order-rate-limiter.ts**: Rate limiting for order placement
- **market-state-manager.ts**: Market state machine management
- **positions-sync.ts**: Position synchronization

### Configuration:
- **config.ts**: Environment configuration
- **resolved-config.ts**: Runtime configuration resolution

### Supporting Modules:
- **funding.ts**: Balance and funding management
- **telemetry.ts**: Logging to Supabase
- **logger.ts**: Console logging utilities
- **chain.ts**: Blockchain interaction
- **backend.ts**: Backend API communication
- **authManager.ts**: Authentication management
- **redeemer.ts**: Position redemption
- **reconcile.ts**: Order reconciliation

## Key Features (v7.2.3 REV C.3):
- REMOVED aggressive emergency hedge fallback (ask+0.03)
  → Partial pairs now remain in PAIRING state for standard hedge flow
- FIXED costPerPaired undefined bug → uses cppPairedOnly consistently
- State machine ENFORCES trading permissions (not just logging)
- PAIRING state must be explicitly entered via beginPairing()
- PAIRING timeout sets FREEZE_ADDS flag and blocks new entries
- CPP uses paired-only formula (avgUp + avgDown) not totalInvested/paired
- Micro-hedge only allowed in PAIRED state with time > 120s remaining
- Central gating point for all trade types (ENTRY, HEDGE, ACCUMULATE)

## Build Info
Generated: \${new Date().toISOString()}
Version: 7.2.3 REV C.3 (No Emergency Hedge Fallback)
`;
      rootFolder.file('README.md', readme);

      const blob = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `polymarket-strategy-v7.2.3-${new Date().toISOString().split('T')[0]}.zip`;
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
