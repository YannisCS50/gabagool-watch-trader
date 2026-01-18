import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

// ============================================
// GABAGOOL HISTORICAL BACKTEST
// Uses actual tick data from settled markets
// ============================================

export interface HistoricalBacktestConfig {
  shares_per_side: number;
  max_entry_price: number;      // max price to buy first side (e.g., 0.50)
  max_cpp: number;              // max combined price (e.g., 0.97)
  min_delay_second_leg_ms: number;
  max_wait_second_leg_ms: number;
  entry_after_market_start_ms: number;  // wait this long after market start
}

export interface SimulatedTrade {
  market_slug: string;
  asset: string;
  strike_price: number;
  market_start_ts: number;
  market_end_ts: number;
  
  // First leg
  first_side: 'UP' | 'DOWN';
  first_entry_ts: number;
  first_price: number;
  first_shares: number;
  first_cost: number;
  
  // Second leg
  second_side: 'UP' | 'DOWN' | null;
  second_entry_ts: number | null;
  second_price: number | null;
  second_shares: number | null;
  second_cost: number | null;
  delay_ms: number | null;
  
  // Combined
  cpp: number | null;
  total_cost: number;
  paired_shares: number;
  
  // Outcome (based on final Binance price vs strike)
  final_binance_price: number;
  outcome: 'UP' | 'DOWN';
  
  // P&L calculation
  winning_side: 'UP' | 'DOWN';
  payout: number;
  pnl: number;
  pnl_percent: number;
  
  status: 'paired-win' | 'paired-loss' | 'single-win' | 'single-loss' | 'skipped';
  skip_reason?: string;
}

export interface HistoricalBacktestResult {
  config: HistoricalBacktestConfig;
  trades: SimulatedTrade[];
  summary: {
    total_markets: number;
    traded_markets: number;
    skipped_markets: number;
    paired_markets: number;
    single_sided_markets: number;
    
    total_cost: number;
    total_payout: number;
    total_pnl: number;
    win_rate: number;
    
    paired_wins: number;
    paired_losses: number;
    single_wins: number;
    single_losses: number;
    
    avg_cpp: number;
    avg_pnl_per_trade: number;
    roi_percent: number;
    
    by_asset: Record<string, {
      markets: number;
      traded: number;
      wins: number;
      losses: number;
      pnl: number;
      avg_cpp: number;
    }>;
  };
}

interface Tick {
  ts: number;
  binance_price: number;
  strike_price: number;
  up_best_ask: number | null;
  up_best_bid: number | null;
  down_best_ask: number | null;
  down_best_bid: number | null;
}

export function useGabagoolHistoricalBacktest(config: HistoricalBacktestConfig) {
  return useQuery({
    queryKey: ['gabagool-historical-backtest', config],
    queryFn: async (): Promise<HistoricalBacktestResult> => {
      // Get all unique settled markets
      const { data: markets, error: marketsError } = await supabase
        .from('v29_ticks_response')
        .select('market_slug, asset, strike_price')
        .gt('strike_price', 0)
        .order('market_slug', { ascending: false });

      if (marketsError) throw marketsError;

      // Get unique markets
      const uniqueMarkets = new Map<string, { asset: string; strike_price: number }>();
      for (const m of (markets || [])) {
        if (!uniqueMarkets.has(m.market_slug)) {
          uniqueMarkets.set(m.market_slug, { asset: m.asset, strike_price: m.strike_price });
        }
      }

      // Filter to only settled markets (end time < now - 5 min buffer)
      const now = Date.now();
      const settledMarkets: string[] = [];
      for (const [slug] of uniqueMarkets) {
        const parts = slug.split('-');
        const endEpoch = parseInt(parts[parts.length - 1]) * 1000;
        if (endEpoch < now - 5 * 60 * 1000) {
          settledMarkets.push(slug);
        }
      }

      // Limit to most recent 100 markets for performance
      const marketsToProcess = settledMarkets.slice(0, 100);
      
      const trades: SimulatedTrade[] = [];
      const byAsset: Record<string, { markets: number; traded: number; wins: number; losses: number; pnl: number; totalCpp: number; cppCount: number }> = {};

      // Process each market
      for (const marketSlug of marketsToProcess) {
        const marketInfo = uniqueMarkets.get(marketSlug)!;
        const asset = marketInfo.asset;
        const strikePrice = marketInfo.strike_price;

        // Initialize asset stats
        if (!byAsset[asset]) {
          byAsset[asset] = { markets: 0, traded: 0, wins: 0, losses: 0, pnl: 0, totalCpp: 0, cppCount: 0 };
        }
        byAsset[asset].markets++;

        // Get all ticks for this market
        const { data: ticks, error: ticksError } = await supabase
          .from('v29_ticks_response')
          .select('ts, binance_price, strike_price, up_best_ask, up_best_bid, down_best_ask, down_best_bid')
          .eq('market_slug', marketSlug)
          .gt('strike_price', 0)
          .order('ts', { ascending: true });

        if (ticksError || !ticks || ticks.length < 10) {
          trades.push(createSkippedTrade(marketSlug, asset, strikePrice, 'insufficient_data'));
          continue;
        }

        // Parse market times from slug
        const parts = marketSlug.split('-');
        const marketEndEpoch = parseInt(parts[parts.length - 1]) * 1000;
        const marketStartEpoch = marketEndEpoch - 15 * 60 * 1000; // 15 min market

        // Get final price for outcome determination
        const lastTick = ticks[ticks.length - 1] as Tick;
        const finalBinancePrice = lastTick.binance_price;
        const outcome: 'UP' | 'DOWN' = finalBinancePrice > strikePrice ? 'UP' : 'DOWN';

        // Simulate the strategy
        const trade = simulateGabagoolStrategy(
          marketSlug,
          asset,
          strikePrice,
          marketStartEpoch,
          marketEndEpoch,
          ticks as Tick[],
          finalBinancePrice,
          outcome,
          config
        );

        trades.push(trade);
        byAsset[asset].traded++;

        if (trade.status !== 'skipped') {
          byAsset[asset].pnl += trade.pnl;
          if (trade.pnl > 0) byAsset[asset].wins++;
          else byAsset[asset].losses++;
          if (trade.cpp) {
            byAsset[asset].totalCpp += trade.cpp;
            byAsset[asset].cppCount++;
          }
        }
      }

      // Calculate summary
      const tradedTrades = trades.filter(t => t.status !== 'skipped');
      const pairedTrades = tradedTrades.filter(t => t.status.startsWith('paired'));
      const singleTrades = tradedTrades.filter(t => t.status.startsWith('single'));
      const winningTrades = tradedTrades.filter(t => t.pnl > 0);

      const summary = {
        total_markets: trades.length,
        traded_markets: tradedTrades.length,
        skipped_markets: trades.filter(t => t.status === 'skipped').length,
        paired_markets: pairedTrades.length,
        single_sided_markets: singleTrades.length,
        
        total_cost: tradedTrades.reduce((sum, t) => sum + t.total_cost, 0),
        total_payout: tradedTrades.reduce((sum, t) => sum + t.payout, 0),
        total_pnl: tradedTrades.reduce((sum, t) => sum + t.pnl, 0),
        win_rate: tradedTrades.length > 0 ? winningTrades.length / tradedTrades.length : 0,
        
        paired_wins: pairedTrades.filter(t => t.pnl > 0).length,
        paired_losses: pairedTrades.filter(t => t.pnl <= 0).length,
        single_wins: singleTrades.filter(t => t.pnl > 0).length,
        single_losses: singleTrades.filter(t => t.pnl <= 0).length,
        
        avg_cpp: pairedTrades.length > 0 
          ? pairedTrades.reduce((sum, t) => sum + (t.cpp || 0), 0) / pairedTrades.length 
          : 0,
        avg_pnl_per_trade: tradedTrades.length > 0 
          ? tradedTrades.reduce((sum, t) => sum + t.pnl, 0) / tradedTrades.length 
          : 0,
        roi_percent: tradedTrades.length > 0 
          ? (tradedTrades.reduce((sum, t) => sum + t.pnl, 0) / tradedTrades.reduce((sum, t) => sum + t.total_cost, 0)) * 100 
          : 0,
        
        by_asset: Object.fromEntries(
          Object.entries(byAsset).map(([asset, stats]) => [
            asset,
            {
              markets: stats.markets,
              traded: stats.traded,
              wins: stats.wins,
              losses: stats.losses,
              pnl: stats.pnl,
              avg_cpp: stats.cppCount > 0 ? stats.totalCpp / stats.cppCount : 0,
            }
          ])
        ),
      };

      return { config, trades, summary };
    },
    staleTime: 10 * 60 * 1000, // 10 minutes - expensive query
  });
}

function createSkippedTrade(marketSlug: string, asset: string, strikePrice: number, reason: string): SimulatedTrade {
  return {
    market_slug: marketSlug,
    asset,
    strike_price: strikePrice,
    market_start_ts: 0,
    market_end_ts: 0,
    first_side: 'UP',
    first_entry_ts: 0,
    first_price: 0,
    first_shares: 0,
    first_cost: 0,
    second_side: null,
    second_entry_ts: null,
    second_price: null,
    second_shares: null,
    second_cost: null,
    delay_ms: null,
    cpp: null,
    total_cost: 0,
    paired_shares: 0,
    final_binance_price: 0,
    outcome: 'UP',
    winning_side: 'UP',
    payout: 0,
    pnl: 0,
    pnl_percent: 0,
    status: 'skipped',
    skip_reason: reason,
  };
}

function simulateGabagoolStrategy(
  marketSlug: string,
  asset: string,
  strikePrice: number,
  marketStartTs: number,
  marketEndTs: number,
  ticks: Tick[],
  finalBinancePrice: number,
  outcome: 'UP' | 'DOWN',
  config: HistoricalBacktestConfig
): SimulatedTrade {
  const winningOutcome = outcome;
  
  // Find entry point - wait for entry_after_market_start_ms
  const entryWindowStart = marketStartTs + config.entry_after_market_start_ms;
  const entryWindowEnd = marketEndTs - 60000; // Stop 1 min before end
  
  // Find first valid entry tick
  let firstEntryTick: Tick | null = null;
  let firstSide: 'UP' | 'DOWN' | null = null;
  
  for (const tick of ticks) {
    if (tick.ts < entryWindowStart) continue;
    if (tick.ts > entryWindowEnd) break;
    
    // Check if we can enter on either side
    const upAsk = tick.up_best_ask;
    const downAsk = tick.down_best_ask;
    
    if (upAsk && upAsk <= config.max_entry_price) {
      firstEntryTick = tick;
      firstSide = 'UP';
      break;
    }
    if (downAsk && downAsk <= config.max_entry_price) {
      firstEntryTick = tick;
      firstSide = 'DOWN';
      break;
    }
  }
  
  if (!firstEntryTick || !firstSide) {
    return createSkippedTrade(marketSlug, asset, strikePrice, 'no_cheap_entry');
  }
  
  const firstPrice = firstSide === 'UP' 
    ? (firstEntryTick.up_best_ask || 0.5) 
    : (firstEntryTick.down_best_ask || 0.5);
  const firstShares = config.shares_per_side;
  const firstCost = firstPrice * firstShares;
  
  // Look for second leg
  const secondSide: 'UP' | 'DOWN' = firstSide === 'UP' ? 'DOWN' : 'UP';
  let secondEntryTick: Tick | null = null;
  let secondPrice: number | null = null;
  
  const minSecondTs = firstEntryTick.ts + config.min_delay_second_leg_ms;
  const maxSecondTs = Math.min(firstEntryTick.ts + config.max_wait_second_leg_ms, marketEndTs - 30000);
  
  for (const tick of ticks) {
    if (tick.ts < minSecondTs) continue;
    if (tick.ts > maxSecondTs) break;
    
    const ask = secondSide === 'UP' ? tick.up_best_ask : tick.down_best_ask;
    if (ask) {
      const potentialCpp = firstPrice + ask;
      if (potentialCpp <= config.max_cpp) {
        secondEntryTick = tick;
        secondPrice = ask;
        break;
      }
    }
  }
  
  // Calculate results
  if (secondEntryTick && secondPrice !== null) {
    // Paired trade
    const secondShares = config.shares_per_side;
    const secondCost = secondPrice * secondShares;
    const cpp = firstPrice + secondPrice;
    const totalCost = firstCost + secondCost;
    const pairedShares = Math.min(firstShares, secondShares);
    const delay = secondEntryTick.ts - firstEntryTick.ts;
    
    // Payout: winning side pays $1 per share
    const payout = pairedShares; // $1 per paired share
    const pnl = payout - totalCost;
    const pnlPercent = (pnl / totalCost) * 100;
    
    return {
      market_slug: marketSlug,
      asset,
      strike_price: strikePrice,
      market_start_ts: marketStartTs,
      market_end_ts: marketEndTs,
      first_side: firstSide,
      first_entry_ts: firstEntryTick.ts,
      first_price: firstPrice,
      first_shares: firstShares,
      first_cost: firstCost,
      second_side: secondSide,
      second_entry_ts: secondEntryTick.ts,
      second_price: secondPrice,
      second_shares: secondShares,
      second_cost: secondCost,
      delay_ms: delay,
      cpp,
      total_cost: totalCost,
      paired_shares: pairedShares,
      final_binance_price: finalBinancePrice,
      outcome,
      winning_side: winningOutcome,
      payout,
      pnl,
      pnl_percent: pnlPercent,
      status: pnl > 0 ? 'paired-win' : 'paired-loss',
    };
  } else {
    // Single-sided trade
    const totalCost = firstCost;
    const didWin = firstSide === winningOutcome;
    const payout = didWin ? firstShares : 0;
    const pnl = payout - totalCost;
    const pnlPercent = (pnl / totalCost) * 100;
    
    return {
      market_slug: marketSlug,
      asset,
      strike_price: strikePrice,
      market_start_ts: marketStartTs,
      market_end_ts: marketEndTs,
      first_side: firstSide,
      first_entry_ts: firstEntryTick.ts,
      first_price: firstPrice,
      first_shares: firstShares,
      first_cost: firstCost,
      second_side: null,
      second_entry_ts: null,
      second_price: null,
      second_shares: null,
      second_cost: null,
      delay_ms: null,
      cpp: null,
      total_cost: totalCost,
      paired_shares: 0,
      final_binance_price: finalBinancePrice,
      outcome,
      winning_side: winningOutcome,
      payout,
      pnl,
      pnl_percent: pnlPercent,
      status: pnl > 0 ? 'single-win' : 'single-loss',
    };
  }
}
