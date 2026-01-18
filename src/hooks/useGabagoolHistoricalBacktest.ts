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

// Helper to fetch all rows with pagination
async function fetchAllRows<T>(
  tableName: string,
  selectCols: string,
  orderBy: string,
  filters?: (query: any) => any,
  batchSize = 1000
): Promise<T[]> {
  const allRows: T[] = [];
  let from = 0;
  
  while (true) {
    let query = (supabase as any)
      .from(tableName)
      .select(selectCols)
      .order(orderBy, { ascending: true })
      .range(from, from + batchSize - 1);
    
    if (filters) {
      query = filters(query);
    }
    
    const { data, error } = await query;
    
    if (error) throw error;
    if (!data || data.length === 0) break;
    
    allRows.push(...data);
    console.log(`[Backtest] Fetched ${allRows.length} rows from ${tableName}...`);
    
    if (data.length < batchSize) break;
    from += batchSize;
  }
  
  return allRows;
}

export function useGabagoolHistoricalBacktest(config: HistoricalBacktestConfig) {
  return useQuery({
    queryKey: ['gabagool-historical-backtest', config],
    queryFn: async (): Promise<HistoricalBacktestResult> => {
      console.log('[Backtest] Starting backtest with config:', config);
      
      // Fetch ALL ticks from v29_ticks_response in batches
      console.log('[Backtest] Fetching all ticks...');
      const allTicks = await fetchAllRows<{
        market_slug: string;
        asset: string;
        strike_price: number;
        ts: number;
        binance_price: number;
        up_best_ask: number | null;
        up_best_bid: number | null;
        down_best_ask: number | null;
        down_best_bid: number | null;
      }>(
        'v29_ticks_response',
        'market_slug, asset, strike_price, ts, binance_price, up_best_ask, up_best_bid, down_best_ask, down_best_bid',
        'ts',
        (q) => q.gt('strike_price', 0)
      );
      
      console.log(`[Backtest] Total ticks fetched: ${allTicks.length}`);
      
      // Group ticks by market
      const ticksByMarket = new Map<string, Tick[]>();
      const marketInfo = new Map<string, { asset: string; strike_price: number }>();
      
      for (const tick of allTicks) {
        if (!ticksByMarket.has(tick.market_slug)) {
          ticksByMarket.set(tick.market_slug, []);
          marketInfo.set(tick.market_slug, { 
            asset: tick.asset, 
            strike_price: tick.strike_price 
          });
        }
        ticksByMarket.get(tick.market_slug)!.push({
          ts: tick.ts,
          binance_price: tick.binance_price,
          strike_price: tick.strike_price,
          up_best_ask: tick.up_best_ask,
          up_best_bid: tick.up_best_bid,
          down_best_ask: tick.down_best_ask,
          down_best_bid: tick.down_best_bid,
        });
      }
      
      console.log(`[Backtest] Unique markets: ${ticksByMarket.size}`);
      
      // Filter to only settled markets (end time < now - 5 min buffer)
      const now = Date.now();
      const settledMarkets: string[] = [];
      
      for (const [slug] of ticksByMarket) {
        const parts = slug.split('-');
        const endEpoch = parseInt(parts[parts.length - 1]) * 1000;
        if (endEpoch < now - 5 * 60 * 1000) {
          settledMarkets.push(slug);
        }
      }
      
      console.log(`[Backtest] Settled markets: ${settledMarkets.length}`);
      
      // Sort by end time descending (most recent first)
      settledMarkets.sort((a, b) => {
        const aEnd = parseInt(a.split('-').pop()!);
        const bEnd = parseInt(b.split('-').pop()!);
        return bEnd - aEnd;
      });
      
      const trades: SimulatedTrade[] = [];
      const byAsset: Record<string, { 
        markets: number; traded: number; wins: number; losses: number; 
        pnl: number; totalCpp: number; cppCount: number 
      }> = {};

      // Process each market
      let processed = 0;
      for (const marketSlug of settledMarkets) {
        const info = marketInfo.get(marketSlug)!;
        const ticks = ticksByMarket.get(marketSlug)!;
        const asset = info.asset;
        const strikePrice = info.strike_price;

        // Initialize asset stats
        if (!byAsset[asset]) {
          byAsset[asset] = { markets: 0, traded: 0, wins: 0, losses: 0, pnl: 0, totalCpp: 0, cppCount: 0 };
        }
        byAsset[asset].markets++;

        if (ticks.length < 10) {
          trades.push(createSkippedTrade(marketSlug, asset, strikePrice, 'insufficient_data'));
          continue;
        }

        // Parse market times from slug
        const parts = marketSlug.split('-');
        const marketEndEpoch = parseInt(parts[parts.length - 1]) * 1000;
        const marketStartEpoch = marketEndEpoch - 15 * 60 * 1000; // 15 min market

        // Get final price for outcome determination
        const lastTick = ticks[ticks.length - 1];
        const finalBinancePrice = lastTick.binance_price;
        const outcome: 'UP' | 'DOWN' = finalBinancePrice > strikePrice ? 'UP' : 'DOWN';

        // Simulate the strategy
        const trade = simulateGabagoolStrategy(
          marketSlug,
          asset,
          strikePrice,
          marketStartEpoch,
          marketEndEpoch,
          ticks,
          finalBinancePrice,
          outcome,
          config
        );

        trades.push(trade);
        
        if (trade.status !== 'skipped') {
          byAsset[asset].traded++;
          byAsset[asset].pnl += trade.pnl;
          if (trade.pnl > 0) byAsset[asset].wins++;
          else byAsset[asset].losses++;
          if (trade.cpp) {
            byAsset[asset].totalCpp += trade.cpp;
            byAsset[asset].cppCount++;
          }
        }
        
        processed++;
        if (processed % 50 === 0) {
          console.log(`[Backtest] Processed ${processed}/${settledMarkets.length} markets...`);
        }
      }

      console.log(`[Backtest] Done! Processed ${trades.length} markets`);

      // Calculate summary
      const tradedTrades = trades.filter(t => t.status !== 'skipped');
      const pairedTrades = tradedTrades.filter(t => t.status.startsWith('paired'));
      const singleTrades = tradedTrades.filter(t => t.status.startsWith('single'));
      const winningTrades = tradedTrades.filter(t => t.pnl > 0);

      const totalCost = tradedTrades.reduce((sum, t) => sum + t.total_cost, 0);
      const totalPayout = tradedTrades.reduce((sum, t) => sum + t.payout, 0);
      const totalPnl = tradedTrades.reduce((sum, t) => sum + t.pnl, 0);

      const summary = {
        total_markets: trades.length,
        traded_markets: tradedTrades.length,
        skipped_markets: trades.filter(t => t.status === 'skipped').length,
        paired_markets: pairedTrades.length,
        single_sided_markets: singleTrades.length,
        
        total_cost: totalCost,
        total_payout: totalPayout,
        total_pnl: totalPnl,
        win_rate: tradedTrades.length > 0 ? winningTrades.length / tradedTrades.length : 0,
        
        paired_wins: pairedTrades.filter(t => t.pnl > 0).length,
        paired_losses: pairedTrades.filter(t => t.pnl <= 0).length,
        single_wins: singleTrades.filter(t => t.pnl > 0).length,
        single_losses: singleTrades.filter(t => t.pnl <= 0).length,
        
        avg_cpp: pairedTrades.length > 0 
          ? pairedTrades.reduce((sum, t) => sum + (t.cpp || 0), 0) / pairedTrades.length 
          : 0,
        avg_pnl_per_trade: tradedTrades.length > 0 
          ? totalPnl / tradedTrades.length 
          : 0,
        roi_percent: totalCost > 0 
          ? (totalPnl / totalCost) * 100 
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
    gcTime: 30 * 60 * 1000, // Keep in cache for 30 min
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
