import { SubgraphHealthPanel } from './SubgraphHealthPanel';
import { SubgraphPnLPanel } from './SubgraphPnLPanel';
import { SubgraphFillsTable } from './SubgraphFillsTable';
import { SubgraphPositionsTable } from './SubgraphPositionsTable';
import { SubgraphReconciliationPanel } from './SubgraphReconciliationPanel';
import { CashflowDiagnostics } from './CashflowDiagnostics';
import { CanonicalPnLDashboard } from './CanonicalPnLDashboard';
import { MarketLifecycleTable } from './MarketLifecycleTable';
import { useBotWallet } from '@/hooks/useSubgraphData';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { AlertCircle } from 'lucide-react';

export function SubgraphDashboard() {
  const { data: wallet, isLoading: walletLoading, error: walletError } = useBotWallet();

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
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <SubgraphHealthPanel />
      
      {/* CANONICAL PnL Dashboard - reads from database only */}
      <CanonicalPnLDashboard />
      
      {/* Cashflow Diagnostics - shows event type breakdown */}
      <CashflowDiagnostics />

      {/* Legacy PnL Panel for comparison */}
      <SubgraphPnLPanel />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <SubgraphPositionsTable />
        <SubgraphReconciliationPanel />
      </div>

      <MarketLifecycleTable />
      
      <SubgraphFillsTable />
    </div>
  );
}
