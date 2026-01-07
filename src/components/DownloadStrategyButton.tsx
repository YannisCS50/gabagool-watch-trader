import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { FileCode, Loader2 } from 'lucide-react';
import JSZip from 'jszip';

// Strategy file list - files will be fetched dynamically
const STRATEGY_FILES = [
  // Main entry point
  { name: 'index.ts', path: 'local-runner/src/index.ts' },
  
  // Core strategy
  { name: 'strategy.ts', path: 'local-runner/src/strategy.ts' },
  { name: 'v7-patch.ts', path: 'local-runner/src/v7-patch.ts' },
  { name: 'hard-invariants.ts', path: 'local-runner/src/hard-invariants.ts' },
  
  // API & Infrastructure
  { name: 'polymarket.ts', path: 'local-runner/src/polymarket.ts' },
  { name: 'hedge-escalator.ts', path: 'local-runner/src/hedge-escalator.ts' },
  { name: 'inventory-risk.ts', path: 'local-runner/src/inventory-risk.ts' },
  { name: 'order-rate-limiter.ts', path: 'local-runner/src/order-rate-limiter.ts' },
  { name: 'market-state-manager.ts', path: 'local-runner/src/market-state-manager.ts' },
  { name: 'positions-sync.ts', path: 'local-runner/src/positions-sync.ts' },
  
  // Configuration
  { name: 'config.ts', path: 'local-runner/src/config.ts' },
  { name: 'resolved-config.ts', path: 'local-runner/src/resolved-config.ts' },
  
  // Supporting modules
  { name: 'funding.ts', path: 'local-runner/src/funding.ts' },
  { name: 'telemetry.ts', path: 'local-runner/src/telemetry.ts' },
  { name: 'logger.ts', path: 'local-runner/src/logger.ts' },
  { name: 'chain.ts', path: 'local-runner/src/chain.ts' },
  { name: 'backend.ts', path: 'local-runner/src/backend.ts' },
  { name: 'authManager.ts', path: 'local-runner/src/authManager.ts' },
  { name: 'redeemer.ts', path: 'local-runner/src/redeemer.ts' },
  { name: 'reconcile.ts', path: 'local-runner/src/reconcile.ts' },
];

export function DownloadStrategyButton() {
  const [isDownloading, setIsDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const downloadStrategy = async () => {
    setIsDownloading(true);
    setError(null);
    
    try {
      const zip = new JSZip();
      const rootFolder = zip.folder('polymarket-strategy-v7.2.4');
      
      if (!rootFolder) throw new Error('Failed to create zip folder');

      // Fetch all strategy files in parallel
      const fileContents = await Promise.all(
        STRATEGY_FILES.map(async (file) => {
          try {
            // Try to fetch the file as raw text
            const response = await fetch(`/${file.path}`, {
              headers: { 'Accept': 'text/plain' }
            });
            if (!response.ok) {
              console.warn(`Could not fetch ${file.path}: ${response.status}`);
              return { name: file.name, content: `// File not available in production build\n// Path: ${file.path}` };
            }
            const content = await response.text();
            return { name: file.name, content };
          } catch (err) {
            console.warn(`Error fetching ${file.path}:`, err);
            return { name: file.name, content: `// File not available\n// Path: ${file.path}` };
          }
        })
      );

      // Add all strategy files
      for (const file of fileContents) {
        rootFolder.file(file.name, file.content);
      }

      // Add a README with build timestamp
      const readme = `# Polymarket Trading Strategy v7.2.4

## Complete Trading Bot with Rev C.4 Hard Invariants

This is the COMPLETE trading bot with all hotfixes and Rev C.4 Hard Invariants applied.

## Files Included

### Main Entry Point:
- **index.ts**: Main bot loop with all hotfixes and hard invariant integration

### Core Strategy:
- **strategy.ts**: v6.1.2 GPT Strategy with v7 patch exports
- **v7-patch.ts**: v7 Patch Layer with readiness gate, intent slots, etc.
- **hard-invariants.ts**: v7.2.4 REV C.4 Hard Invariants (position caps, freeze adds, CPP paired-only)

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

## Key Features (v7.2.4 REV C.4):

### Hard Invariants (NEW):
- **clampOrderToCaps()**: Enforces maxSharesPerSide=100 and maxTotalSharesPerMarket=200
- **One-Sided Freeze Adds**: After first ONE_SIDED fill, no more BUY on dominant side
- **CPP Paired-Only**: cppPairedOnlyCents = avgUp + avgDown (null when paired=0)
- **Runtime Assertions**: INVARIANT_BREACH detection and market suspension

### State Machine (Rev C.3):
- REMOVED aggressive emergency hedge fallback (ask+0.03)
- Partial pairs remain in PAIRING state for standard hedge flow
- State machine ENFORCES trading permissions
- PAIRING timeout sets FREEZE_ADDS flag

## Build Info
Generated: ${new Date().toISOString()}
Version: 7.2.4 REV C.4 (Hard Invariants)

## Note
Some files may not be available in the production build. 
To get the complete source, clone the repository or download in development mode.
`;
      rootFolder.file('README.md', readme);

      const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 9 } });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `polymarket-strategy-v7.2.4-${new Date().toISOString().split('T')[0]}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Error downloading strategy:', err);
      setError('Download failed');
    } finally {
      setIsDownloading(false);
    }
  };

  return (
    <Button
      onClick={downloadStrategy}
      disabled={isDownloading}
      variant="outline"
      size="sm"
      className="font-mono text-xs"
      title={error || undefined}
    >
      {isDownloading ? (
        <Loader2 className="w-3 h-3 mr-2 animate-spin" />
      ) : (
        <FileCode className="w-3 h-3 mr-2" />
      )}
      {isDownloading ? 'Creating...' : 'Strategy'}
    </Button>
  );
}
