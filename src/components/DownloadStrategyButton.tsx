import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { FileCode, Loader2 } from 'lucide-react';
import JSZip from 'jszip';

// Import strategy files as raw text - automatically updated at build time
// @ts-ignore - raw imports
import strategyTs from '../../local-runner/src/strategy.ts?raw';
// @ts-ignore - raw imports
import gptStratTs from '../../local-runner/src/gpt-strat.ts?raw';
// @ts-ignore - raw imports
import loveableStratTs from '../../local-runner/src/loveable-strat.ts?raw';
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
  { name: 'strategy.ts', content: strategyTs },
  { name: 'gpt-strat.ts', content: gptStratTs },
  { name: 'loveable-strat.ts', content: loveableStratTs },
  { name: 'hedge-escalator.ts', content: hedgeEscalatorTs },
  { name: 'inventory-risk.ts', content: inventoryRiskTs },
  { name: 'order-rate-limiter.ts', content: orderRateLimiterTs },
  { name: 'config.ts', content: configTs },
  { name: 'resolved-config.ts', content: resolvedConfigTs },
];

export function DownloadStrategyButton() {
  const [isDownloading, setIsDownloading] = useState(false);

  const downloadStrategy = async () => {
    setIsDownloading(true);
    
    try {
      const zip = new JSZip();
      const folder = zip.folder('polymarket-strategy-v7');
      
      if (!folder) throw new Error('Failed to create zip folder');

      // Add all strategy files
      for (const file of STRATEGY_FILES) {
        folder.file(file.name, file.content);
      }

      // Add a README with build timestamp
      const readme = `# Polymarket Trading Strategy v7

## Files included:
${STRATEGY_FILES.map(f => `- ${f.name}`).join('\n')}

## Build Info
Generated: ${new Date().toISOString()}

## Description
This is the complete trading strategy source code for the Polymarket 15-minute markets bot.

### Key Files:
- **strategy.ts**: Main strategy entry point and configuration
- **gpt-strat.ts**: Core bot logic with mode selection (Normal/Survival/Panic)
- **loveable-strat.ts**: Pure functions for edge calculation, hedging, and state management
- **hedge-escalator.ts**: Atomic hedge retry mechanism with escalation
- **inventory-risk.ts**: Position and inventory risk management
- **order-rate-limiter.ts**: Rate limiting for order placement
- **config.ts**: Configuration types and defaults
- **resolved-config.ts**: Runtime configuration resolution
`;
      folder.file('README.md', readme);

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
