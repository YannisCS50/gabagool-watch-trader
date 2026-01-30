import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

// ============================================
// GABAGOOL BACKTEST HOOK
// Simulates the hedge strategy on historical fill data
// ============================================

export interface BacktestConfig {
  shares_per_side: number;
  max_entry_price: number;  // cents (e.g., 0.50 = 50¢)
  max_cpp: number;          // cents (e.g., 0.97 = 97¢)
  min_delay_second_leg_ms: number;
  max_wait_second_leg_ms: number;
}

export interface BacktestTrade {
  market_id: string;
  asset: string;
  first_side: 'UP' | 'DOWN';
  first_price: number;
  first_shares: number;
  first_cost: number;
  first_ts: number;
  second_side: 'UP' | 'DOWN' | null;
  second_price: number | null;
  second_shares: number | null;
  second_cost: number | null;
  second_ts: number | null;
  delay_ms: number | null;
  cpp: number | null;
  total_cost: number;
  paired_shares: number;
  unpaired_shares: number;
  pnl_if_paired: number;  // $1 - cpp per paired share
  status: 'paired' | 'partial' | 'single-sided';
}

export interface BacktestResult {
  config: BacktestConfig;
  trades: BacktestTrade[];
  summary: {
    total_markets: number;
    paired_markets: number;
    partial_markets: number;
    single_sided_markets: number;
    pair_rate: number;
    total_paired_shares: number;
    total_unpaired_shares: number;
    total_cost: number;
    total_pnl_paired: number;
    avg_cpp: number;
    avg_delay_ms: number;
    by_asset: Record<string, {
      markets: number;
      paired: number;
      pair_rate: number;
      avg_cpp: number;
      pnl: number;
    }>;
  };
}

interface FillLog {
  market_id: string;
  asset: string;
  side: string;
  fill_price: number;
  fill_qty: number;
  fill_notional: number;
  ts: number;
  created_at: string;
}

export function useGabagoolBacktest(config: BacktestConfig) {
  return useQuery({
    queryKey: ['gabagool-backtest', config],
    queryFn: async (): Promise<BacktestResult> => {
      // Fetch all fill logs
      const { data: fills, error } = await supabase
        .from('fill_logs')
        .select('market_id, asset, side, fill_price, fill_qty, fill_notional, ts, created_at')
        .order('ts', { ascending: true });

      if (error) throw error;

      // Group fills by market
      const marketFills = new Map<string, FillLog[]>();
      for (const fill of (fills || [])) {
        const existing = marketFills.get(fill.market_id) || [];
        existing.push(fill as FillLog);
        marketFills.set(fill.market_id, existing);
      }

      const trades: BacktestTrade[] = [];
      const byAsset: Record<string, { markets: number; paired: number; totalCpp: number; cppCount: number; pnl: number }> = {};

      // Simulate strategy per market
      for (const [marketId, fills] of marketFills) {
        const asset = fills[0].asset;
        
        // Initialize asset stats
        if (!byAsset[asset]) {
          byAsset[asset] = { markets: 0, paired: 0, totalCpp: 0, cppCount: 0, pnl: 0 };
        }
        byAsset[asset].markets++;

        // Separate UP and DOWN fills
        const upFills = fills.filter(f => f.side === 'UP').sort((a, b) => a.ts - b.ts);
        const downFills = fills.filter(f => f.side === 'DOWN').sort((a, b) => a.ts - b.ts);

        // No fills for either side - skip
        if (upFills.length === 0 && downFills.length === 0) continue;

        // Determine first side (earliest fill)
        const firstUp = upFills[0];
        const firstDown = downFills[0];
        
        let firstSide: 'UP' | 'DOWN';
        let firstFill: FillLog;
        let secondFills: FillLog[];

        if (!firstDown || (firstUp && firstUp.ts <= firstDown.ts)) {
          firstSide = 'UP';
          firstFill = firstUp;
          secondFills = downFills;
        } else {
          firstSide = 'DOWN';
          firstFill = firstDown;
          secondFills = upFills;
        }

        // Check if first entry meets criteria
        const firstPrice = firstFill.fill_price;
        
        // Simulate: would we have entered at this price?
        const simFirstPrice = Math.min(firstPrice, config.max_entry_price);
        const simFirstShares = Math.min(firstFill.fill_qty, config.shares_per_side);
        const simFirstCost = simFirstPrice * simFirstShares;

        // Look for second leg within delay window
        let secondFill: FillLog | null = null;
        let delay_ms: number | null = null;

        for (const fill of secondFills) {
          const timeDiff = fill.ts - firstFill.ts;
          if (timeDiff >= config.min_delay_second_leg_ms && timeDiff <= config.max_wait_second_leg_ms) {
            secondFill = fill;
            delay_ms = timeDiff;
            break;
          }
        }

        // Calculate trade result
        let trade: BacktestTrade;

        if (secondFill) {
          const simSecondPrice = secondFill.fill_price;
          const simSecondShares = Math.min(secondFill.fill_qty, config.shares_per_side);
          const simSecondCost = simSecondPrice * simSecondShares;
          
          const cpp = simFirstPrice + simSecondPrice;
          const pairedShares = Math.min(simFirstShares, simSecondShares);
          const unpairedShares = Math.abs(simFirstShares - simSecondShares);
          const totalCost = simFirstCost + simSecondCost;
          const pnlIfPaired = cpp < 1 ? (1 - cpp) * pairedShares : (cpp - 1) * -pairedShares;

          // Check if CPP meets criteria
          const status = cpp <= config.max_cpp ? 'paired' : 'partial';

          trade = {
            market_id: marketId,
            asset,
            first_side: firstSide,
            first_price: simFirstPrice,
            first_shares: simFirstShares,
            first_cost: simFirstCost,
            first_ts: firstFill.ts,
            second_side: firstSide === 'UP' ? 'DOWN' : 'UP',
            second_price: simSecondPrice,
            second_shares: simSecondShares,
            second_cost: simSecondCost,
            second_ts: secondFill.ts,
            delay_ms,
            cpp,
            total_cost: totalCost,
            paired_shares: pairedShares,
            unpaired_shares: unpairedShares,
            pnl_if_paired: pnlIfPaired,
            status,
          };

          if (status === 'paired') {
            byAsset[asset].paired++;
            byAsset[asset].totalCpp += cpp;
            byAsset[asset].cppCount++;
            byAsset[asset].pnl += pnlIfPaired;
          }
        } else {
          // Single-sided - no hedge
          trade = {
            market_id: marketId,
            asset,
            first_side: firstSide,
            first_price: simFirstPrice,
            first_shares: simFirstShares,
            first_cost: simFirstCost,
            first_ts: firstFill.ts,
            second_side: null,
            second_price: null,
            second_shares: null,
            second_cost: null,
            second_ts: null,
            delay_ms: null,
            cpp: null,
            total_cost: simFirstCost,
            paired_shares: 0,
            unpaired_shares: simFirstShares,
            pnl_if_paired: 0,
            status: 'single-sided',
          };
        }

        trades.push(trade);
      }

      // Calculate summary
      const paired = trades.filter(t => t.status === 'paired');
      const partial = trades.filter(t => t.status === 'partial');
      const singleSided = trades.filter(t => t.status === 'single-sided');

      const summary = {
        total_markets: trades.length,
        paired_markets: paired.length,
        partial_markets: partial.length,
        single_sided_markets: singleSided.length,
        pair_rate: trades.length > 0 ? paired.length / trades.length : 0,
        total_paired_shares: trades.reduce((sum, t) => sum + t.paired_shares, 0),
        total_unpaired_shares: trades.reduce((sum, t) => sum + t.unpaired_shares, 0),
        total_cost: trades.reduce((sum, t) => sum + t.total_cost, 0),
        total_pnl_paired: paired.reduce((sum, t) => sum + t.pnl_if_paired, 0),
        avg_cpp: paired.length > 0 
          ? paired.reduce((sum, t) => sum + (t.cpp || 0), 0) / paired.length 
          : 0,
        avg_delay_ms: paired.filter(t => t.delay_ms).length > 0
          ? paired.reduce((sum, t) => sum + (t.delay_ms || 0), 0) / paired.filter(t => t.delay_ms).length
          : 0,
        by_asset: Object.fromEntries(
          Object.entries(byAsset).map(([asset, stats]) => [
            asset,
            {
              markets: stats.markets,
              paired: stats.paired,
              pair_rate: stats.markets > 0 ? stats.paired / stats.markets : 0,
              avg_cpp: stats.cppCount > 0 ? stats.totalCpp / stats.cppCount : 0,
              pnl: stats.pnl,
            }
          ])
        ),
      };

      return { config, trades, summary };
    },
    staleTime: 5 * 60 * 1000, // 5 minutes
  });
}
