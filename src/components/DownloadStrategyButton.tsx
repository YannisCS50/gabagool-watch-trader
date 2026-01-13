import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { FileCode, Loader2 } from 'lucide-react';
import JSZip from 'jszip';

// V28 Strategy files - complete set for expert review
const V28_STRATEGY_FILES = [
  // V28 Core
  { folder: 'v28', name: 'index.ts', path: 'local-runner/src/v28/index.ts' },
  { folder: 'v28', name: 'runner.ts', path: 'local-runner/src/v28/runner.ts' },
  { folder: 'v28', name: 'config.ts', path: 'local-runner/src/v28/config.ts' },
  { folder: 'v28', name: 'pre-signed-orders.ts', path: 'local-runner/src/v28/pre-signed-orders.ts' },
  
  // V27 Delta Mispricing Strategy
  { folder: 'v27', name: 'index.ts', path: 'local-runner/src/v27/index.ts' },
  { folder: 'v27', name: 'config.ts', path: 'local-runner/src/v27/config.ts' },
  { folder: 'v27', name: 'runner.ts', path: 'local-runner/src/v27/runner.ts' },
  { folder: 'v27', name: 'shadow-runner.ts', path: 'local-runner/src/v27/shadow-runner.ts' },
  { folder: 'v27', name: 'mispricing-detector.ts', path: 'local-runner/src/v27/mispricing-detector.ts' },
  { folder: 'v27', name: 'entry-manager.ts', path: 'local-runner/src/v27/entry-manager.ts' },
  { folder: 'v27', name: 'correction-monitor.ts', path: 'local-runner/src/v27/correction-monitor.ts' },
  { folder: 'v27', name: 'hedge-manager.ts', path: 'local-runner/src/v27/hedge-manager.ts' },
  { folder: 'v27', name: 'adverse-selection-filter.ts', path: 'local-runner/src/v27/adverse-selection-filter.ts' },
  { folder: 'v27', name: 'cadence-controller.ts', path: 'local-runner/src/v27/cadence-controller.ts' },
  { folder: 'v27', name: 'shadow-engine.ts', path: 'local-runner/src/v27/shadow-engine.ts' },
  { folder: 'v27', name: 'shadow-position-manager.ts', path: 'local-runner/src/v27/shadow-position-manager.ts' },
  { folder: 'v27', name: 'logger.ts', path: 'local-runner/src/v27/logger.ts' },
  
  // Price feeds & WebSocket
  { folder: 'core', name: 'price-feed-ws-logger.ts', path: 'local-runner/src/price-feed-ws-logger.ts' },
  { folder: 'core', name: 'polymarket.ts', path: 'local-runner/src/polymarket.ts' },
  
  // Order management & rate limiting
  { folder: 'core', name: 'order-rate-limiter.ts', path: 'local-runner/src/order-rate-limiter.ts' },
  { folder: 'core', name: 'burst-limiter.ts', path: 'local-runner/src/burst-limiter.ts' },
  
  // Hard invariants & risk
  { folder: 'core', name: 'hard-invariants.ts', path: 'local-runner/src/hard-invariants.ts' },
  { folder: 'core', name: 'inventory-risk.ts', path: 'local-runner/src/inventory-risk.ts' },
  { folder: 'core', name: 'price-guard.ts', path: 'local-runner/src/price-guard.ts' },
  
  // State management
  { folder: 'core', name: 'market-state-manager.ts', path: 'local-runner/src/market-state-manager.ts' },
  { folder: 'core', name: 'position-cache.ts', path: 'local-runner/src/position-cache.ts' },
  { folder: 'core', name: 'positions-sync.ts', path: 'local-runner/src/positions-sync.ts' },
  
  // Configuration
  { folder: 'core', name: 'config.ts', path: 'local-runner/src/config.ts' },
  { folder: 'core', name: 'resolved-config.ts', path: 'local-runner/src/resolved-config.ts' },
  
  // Infrastructure
  { folder: 'core', name: 'backend.ts', path: 'local-runner/src/backend.ts' },
  { folder: 'core', name: 'authManager.ts', path: 'local-runner/src/authManager.ts' },
  { folder: 'core', name: 'chain.ts', path: 'local-runner/src/chain.ts' },
  { folder: 'core', name: 'telemetry.ts', path: 'local-runner/src/telemetry.ts' },
  { folder: 'core', name: 'logger.ts', path: 'local-runner/src/logger.ts' },
  
  // Documentation
  { folder: 'docs', name: 'v8-strategy.md', path: 'local-runner/docs/v8-strategy.md' },
  { folder: 'docs', name: 'strategy-spec-v7-revC.md', path: 'local-runner/docs/strategy-spec-v7-revC.md' },
];

export function DownloadStrategyButton() {
  const [isDownloading, setIsDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const downloadStrategy = async () => {
    setIsDownloading(true);
    setError(null);
    
    try {
      const zip = new JSZip();
      const rootFolder = zip.folder('polymarket-strategy-v28-review');
      
      if (!rootFolder) throw new Error('Failed to create zip folder');

      // Create subfolders
      const v28Folder = rootFolder.folder('v28');
      const v27Folder = rootFolder.folder('v27');
      const coreFolder = rootFolder.folder('core');
      const docsFolder = rootFolder.folder('docs');

      // Fetch all strategy files in parallel
      const fileContents = await Promise.all(
        V28_STRATEGY_FILES.map(async (file) => {
          try {
            const response = await fetch(`/${file.path}`, {
              headers: { 'Accept': 'text/plain' }
            });
            if (!response.ok) {
              console.warn(`Could not fetch ${file.path}: ${response.status}`);
              return { ...file, content: `// File not available in production build\n// Path: ${file.path}` };
            }
            const content = await response.text();
            return { ...file, content };
          } catch (err) {
            console.warn(`Error fetching ${file.path}:`, err);
            return { ...file, content: `// File not available\n// Path: ${file.path}` };
          }
        })
      );

      // Add files to appropriate folders
      for (const file of fileContents) {
        const folder = file.folder === 'v28' ? v28Folder :
                       file.folder === 'v27' ? v27Folder :
                       file.folder === 'docs' ? docsFolder : coreFolder;
        folder?.file(file.name, file.content);
      }

      // Add comprehensive README for expert review
      const readme = `# Polymarket Trading Strategy - Expert Review Package
Generated: ${new Date().toISOString()}

## Overview

This package contains the complete V27/V28 trading strategy for Polymarket 15-minute UP/DOWN markets.
The strategy exploits delta mispricing between spot prices (Binance/Chainlink) and Polymarket prices.

## Architecture

### V28 - Pre-Signed Order Strategy
The main runner that uses pre-signed orders for fast execution:
- \`v28/runner.ts\`: Main trading loop with market rotation
- \`v28/pre-signed-orders.ts\`: Order pre-signing for reduced latency
- \`v28/config.ts\`: V28-specific configuration

### V27 - Delta Mispricing Detection
Core signal generation based on spot vs Polymarket delta:
- \`v27/mispricing-detector.ts\`: Detects when Polymarket price diverges from expected fair value
- \`v27/entry-manager.ts\`: Decides when to enter based on mispricing signals
- \`v27/correction-monitor.ts\`: Monitors for price correction after entry
- \`v27/hedge-manager.ts\`: Determines when and how to hedge positions
- \`v27/adverse-selection-filter.ts\`: Filters out toxic flow (aggressive takers, book asymmetry)
- \`v27/cadence-controller.ts\`: Adaptive evaluation frequency (COLD/WARM/HOT)

### Price Feed System
- \`core/price-feed-ws-logger.ts\`: WebSocket connections to Binance and Polymarket CLOB
- Real-time orderbook updates with <50ms latency target
- Multi-source price aggregation (Binance, Chainlink, Polymarket)

### Order Execution
- \`core/order-rate-limiter.ts\`: Rate limiting per market/token
- \`core/burst-limiter.ts\`: Burst protection to avoid API blocks
- \`core/polymarket.ts\`: CLOB API wrapper with price improvement

### Risk Management
- \`core/hard-invariants.ts\`: Position caps, freeze rules, CPP limits
- \`core/inventory-risk.ts\`: Inventory skew management
- \`core/price-guard.ts\`: Price validation and sanity checks

## Key Concepts

### Delta Mispricing
When spot price is near strike price, the fair value of UP/DOWN should be ~50/50.
If Polymarket shows UP at 40c when fair value is 50c, we BUY UP expecting correction.

### Correction Phase
After entry, we wait for Polymarket to reprice toward fair value.
During this phase: NO hedging, NO adding, NO selling.

### Hedge Phase
Once correction is confirmed (price moved X% toward expected), we hedge the opposite side
to lock in profit regardless of final outcome.

### Adverse Selection Filters
Before entry, we check for:
1. Aggressive taker flow (large fills, high volume)
2. Book shape asymmetry (one side much deeper)
3. Spread expansion (widening spreads indicate uncertainty)

## Timing & Speed

### Cadence States
- COLD: Eval every 2000ms (nothing happening)
- WARM: Eval every 500ms (near signal detected)
- HOT: Eval every 100ms (active trading opportunity)

### Order Latency Targets
- Price feed: <50ms from Binance/Polymarket
- Signal to order: <100ms
- Order to fill confirmation: <500ms

## Configuration

Key parameters in \`v27/config.ts\`:
- \`deltaThreshold\`: Minimum delta % to trigger entry (e.g., 8%)
- \`correctionThresholdPct\`: % move toward expected to confirm correction
- \`maxNotionalPerTrade\`: Maximum USD per trade
- \`maxPositionsPerAsset\`: Concurrent position limit

## Files Structure

\`\`\`
├── v28/           # V28 Pre-signed order runner
├── v27/           # V27 Delta mispricing strategy
├── core/          # Shared infrastructure
└── docs/          # Strategy documentation
\`\`\`

## Questions for Review

1. Is the mispricing detection logic sound?
2. Are the adverse selection filters sufficient?
3. Is the correction detection reliable?
4. Are there edge cases in the hedge logic?
5. Is the rate limiting adequate?
6. Are there race conditions in the order flow?

---
Contact: [Your contact info]
`;
      rootFolder.file('README.md', readme);

      const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 9 } });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `polymarket-strategy-v28-review-${new Date().toISOString().split('T')[0]}.zip`;
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
      {isDownloading ? 'Creating...' : 'Strategy Export'}
    </Button>
  );
}
