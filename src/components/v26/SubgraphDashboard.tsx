import { SubgraphSyncStatus } from './SubgraphSyncStatus';
import { SubgraphPnLPanel } from './SubgraphPnLPanel';
import { SubgraphFillsTable } from './SubgraphFillsTable';
import { SubgraphPositionsTable } from './SubgraphPositionsTable';
import { SubgraphReconciliationPanel } from './SubgraphReconciliationPanel';

export function SubgraphDashboard() {
  return (
    <div className="space-y-4">
      {/* Sync Status */}
      <SubgraphSyncStatus />

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
