import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { AlertTriangle, CheckCircle2, DollarSign, ArrowDownCircle, ArrowUpCircle, RefreshCw } from 'lucide-react';
import { useBotWallet } from '@/hooks/useSubgraphData';

interface CashflowSummary {
  type: string;
  count: number;
  total_amount: number;
}

export function CashflowDiagnostics() {
  const { data: wallet } = useBotWallet();

  const { data: cashflowStats, isLoading } = useQuery({
    queryKey: ['cashflow-diagnostics', wallet],
    queryFn: async () => {
      if (!wallet) return null;

      // Get cashflow type breakdown
      const { data: cashflows, error } = await supabase
        .from('polymarket_cashflows')
        .select('type, amount_usd')
        .eq('wallet', wallet.toLowerCase());

      if (error) throw error;

      // Group by type
      const byType = (cashflows || []).reduce((acc, cf) => {
        if (!acc[cf.type]) {
          acc[cf.type] = { count: 0, total: 0 };
        }
        acc[cf.type].count++;
        acc[cf.type].total += Number(cf.amount_usd) || 0;
        return acc;
      }, {} as Record<string, { count: number; total: number }>);

      // Get PnL summary
      const { data: pnlSummary } = await supabase
        .from('subgraph_pnl_summary')
        .select('*')
        .eq('wallet', wallet.toLowerCase())
        .single();

      // Get markets missing payouts
      const { data: missingPayouts } = await supabase
        .from('subgraph_pnl_markets')
        .select('market_id, market_slug, missing_payout_reason')
        .eq('wallet', wallet.toLowerCase())
        .not('missing_payout_reason', 'is', null);

      return {
        byType,
        totalCashflows: cashflows?.length || 0,
        pnlSummary,
        missingPayouts: missingPayouts || [],
      };
    },
    enabled: !!wallet,
    refetchInterval: 30000,
  });

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <DollarSign className="h-5 w-5" />
            Cashflow Diagnostics
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="animate-pulse space-y-2">
            <div className="h-4 bg-muted rounded w-3/4"></div>
            <div className="h-4 bg-muted rounded w-1/2"></div>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!wallet) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <DollarSign className="h-5 w-5" />
            Cashflow Diagnostics
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground">No wallet configured</p>
        </CardContent>
      </Card>
    );
  }

  const { byType, pnlSummary, missingPayouts } = cashflowStats || {};

  const typeConfig: Record<string, { icon: React.ReactNode; color: string; label: string }> = {
    FILL_BUY: { icon: <ArrowDownCircle className="h-4 w-4" />, color: 'text-red-500', label: 'Buy Fills' },
    FILL_SELL: { icon: <ArrowUpCircle className="h-4 w-4" />, color: 'text-green-500', label: 'Sell Fills' },
    REDEEM: { icon: <CheckCircle2 className="h-4 w-4" />, color: 'text-blue-500', label: 'Redemptions' },
    CLAIM: { icon: <CheckCircle2 className="h-4 w-4" />, color: 'text-purple-500', label: 'Claims' },
    MERGE: { icon: <RefreshCw className="h-4 w-4" />, color: 'text-amber-500', label: 'Merges' },
    SPLIT: { icon: <RefreshCw className="h-4 w-4" />, color: 'text-orange-500', label: 'Splits' },
    TRANSFER: { icon: <ArrowUpCircle className="h-4 w-4" />, color: 'text-gray-500', label: 'Transfers' },
  };

  const hasMissingPayouts = missingPayouts && missingPayouts.length > 0;
  // Use optional chaining for fields that may not exist in the DB type yet
  const pnlComplete = (pnlSummary as Record<string, unknown>)?.pnl_complete;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <DollarSign className="h-5 w-5" />
          Cashflow Diagnostics
          {pnlComplete ? (
            <Badge variant="outline" className="bg-green-100 text-green-800">Complete</Badge>
          ) : (
            <Badge variant="outline" className="bg-amber-100 text-amber-800">Incomplete</Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Event Type Breakdown */}
        <div>
          <h4 className="text-sm font-medium mb-2">Ingested Event Types</h4>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
            {Object.entries(byType || {}).map(([type, stats]) => {
              const config = typeConfig[type] || { icon: null, color: 'text-gray-500', label: type };
              return (
                <div key={type} className="flex items-center gap-2 p-2 bg-muted rounded-md">
                  <span className={config.color}>{config.icon}</span>
                  <div className="text-sm">
                    <span className="font-medium">{stats.count}</span>
                    <span className="text-muted-foreground ml-1">{config.label}</span>
                  </div>
                </div>
              );
            })}
          </div>

          {(!byType || Object.keys(byType).length === 0) && (
            <p className="text-muted-foreground text-sm">No cashflows ingested yet. Click "Sync Now" above.</p>
          )}
        </div>

        {/* PnL Completeness */}
        {pnlSummary && (
          <div className="border-t pt-4">
            <h4 className="text-sm font-medium mb-2">Lifecycle States</h4>
            <div className="grid grid-cols-4 gap-2 text-sm mb-4">
              <div className="p-2 bg-blue-50 dark:bg-blue-900/20 rounded text-center">
                <div className="text-lg font-bold text-blue-700 dark:text-blue-400">{(pnlSummary as Record<string, unknown>).markets_bought as number || 0}</div>
                <div className="text-xs text-blue-600 dark:text-blue-500">Bought</div>
              </div>
              <div className="p-2 bg-purple-50 dark:bg-purple-900/20 rounded text-center">
                <div className="text-lg font-bold text-purple-700 dark:text-purple-400">{(pnlSummary as Record<string, unknown>).markets_sold as number || 0}</div>
                <div className="text-xs text-purple-600 dark:text-purple-500">Sold</div>
              </div>
              <div className="p-2 bg-green-50 dark:bg-green-900/20 rounded text-center">
                <div className="text-lg font-bold text-green-700 dark:text-green-400">{(pnlSummary as Record<string, unknown>).markets_claimed as number || 0}</div>
                <div className="text-xs text-green-600 dark:text-green-500">Claimed</div>
              </div>
              <div className="p-2 bg-red-50 dark:bg-red-900/20 rounded text-center">
                <div className="text-lg font-bold text-red-700 dark:text-red-400">{(pnlSummary as Record<string, unknown>).markets_lost as number || 0}</div>
                <div className="text-xs text-red-600 dark:text-red-500">Lost</div>
              </div>
            </div>
            <h4 className="text-sm font-medium mb-2">PnL Completeness</h4>
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <span className="text-muted-foreground">Total Markets:</span>
                <span className="ml-2 font-medium">{pnlSummary.total_markets || 0}</span>
              </div>
              <div>
                <span className="text-muted-foreground">Settled:</span>
                <span className="ml-2 font-medium">{pnlSummary.settled_markets || 0}</span>
              </div>
              <div>
                <span className="text-muted-foreground">Synthetic Closures:</span>
                <span className="ml-2 font-medium">{(pnlSummary as Record<string, unknown>).synthetic_closures_count as number || 0}</span>
              </div>
              <div>
                <span className="text-muted-foreground">Missing Payouts:</span>
                <span className={`ml-2 font-medium ${((pnlSummary as Record<string, unknown>).missing_payouts_count as number) > 0 ? 'text-amber-600' : ''}`}>
                  {(pnlSummary as Record<string, unknown>).missing_payouts_count as number || 0}
                </span>
              </div>
            </div>
          </div>
        )}

        {/* Missing Payout Warning */}
        {hasMissingPayouts && (
          <div className="border-t pt-4">
            <div className="flex items-start gap-2 p-3 bg-amber-50 border border-amber-200 rounded-md">
              <AlertTriangle className="h-5 w-5 text-amber-600 flex-shrink-0 mt-0.5" />
              <div>
                <h4 className="font-medium text-amber-800">PnL Incomplete: Missing Payout Events</h4>
                <p className="text-sm text-amber-700 mt-1">
                  {missingPayouts.length} market(s) have closed positions but no payout/redemption events were found.
                </p>
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
