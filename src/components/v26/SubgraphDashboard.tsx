import { SubgraphHealthPanel } from './SubgraphHealthPanel';
import { SubgraphPnLPanel } from './SubgraphPnLPanel';
import { SubgraphFillsTable } from './SubgraphFillsTable';
import { SubgraphPositionsTable } from './SubgraphPositionsTable';
import { SubgraphReconciliationPanel } from './SubgraphReconciliationPanel';
import { useBotWallet } from '@/hooks/useSubgraphData';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { AlertCircle } from 'lucide-react';

export function SubgraphDashboard() {
  const { data: wallet, isLoading: walletLoading, error: walletError } = useBotWallet();

  // Show wallet loading/error state
  if (walletLoading) {
    return (
      <div className="space-y-4">
        <SubgraphHealthPanel />
        <div className="text-center text-muted-foreground py-8">
          Loading wallet configuration...
        </div>
      </div>
    );
  }

  if (walletError) {
    return (
      <div className="space-y-4">
        <SubgraphHealthPanel />
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Configuration Error</AlertTitle>
          <AlertDescription>
            Failed to load wallet configuration: {walletError instanceof Error ? walletError.message : 'Unknown error'}
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  if (!wallet) {
    return (
      <div className="space-y-4">
        <SubgraphHealthPanel />
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>No Wallet Configured</AlertTitle>
          <AlertDescription>
            Please configure a Polymarket wallet address in bot_config to enable subgraph data sync.
            The wallet address should be set in the `polymarket_address` column.
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Health Panel - Always visible, shows sync status and diagnostics */}
      <SubgraphHealthPanel />

      {/* PnL Panel */}
      <SubgraphPnLPanel />

      {/* Two-column layout for Positions and Reconciliation */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <SubgraphPositionsTable />
        <SubgraphReconciliationPanel />
      </div>

      {/* Fills Table */}
      <SubgraphFillsTable />
    </div>
  );
}
