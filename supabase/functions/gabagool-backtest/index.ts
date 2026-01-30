import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface BacktestConfig {
  shares_per_side: number;
  max_entry_price: number;
  max_cpp: number;
  min_delay_second_leg_ms: number;
  max_wait_second_leg_ms: number;
  entry_after_market_start_ms: number;
}

interface Tick {
  ts: number;
  binance_price: number;
  strike_price: number;
  up_best_ask: number | null;
  down_best_ask: number | null;
}

interface SimulatedTrade {
  market_slug: string;
  asset: string;
  strike_price: number;
  first_side: 'UP' | 'DOWN';
  first_price: number;
  second_price: number | null;
  cpp: number | null;
  delay_ms: number | null;
  total_cost: number;
  outcome: 'UP' | 'DOWN';
  payout: number;
  pnl: number;
  status: 'paired-win' | 'paired-loss' | 'single-win' | 'single-loss' | 'skipped';
  skip_reason?: string;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const config: BacktestConfig = await req.json();
    console.log('[Backtest] Starting with config:', config);

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    // Fetch ALL ticks in batches (server-side is MUCH faster)
    console.log('[Backtest] Fetching all ticks...');
    const allTicks: any[] = [];
    let from = 0;
    const batchSize = 5000; // Larger batches on server

    while (true) {
      const { data, error } = await supabase
        .from('v29_ticks_response')
        .select('market_slug, asset, strike_price, ts, binance_price, up_best_ask, down_best_ask')
        .gt('strike_price', 0)
        .order('ts', { ascending: true })
        .range(from, from + batchSize - 1);

      if (error) throw error;
      if (!data || data.length === 0) break;

      allTicks.push(...data);
      console.log(`[Backtest] Fetched ${allTicks.length} ticks...`);

      if (data.length < batchSize) break;
      from += batchSize;
    }

    console.log(`[Backtest] Total ticks: ${allTicks.length}`);

    // Group by market
    const ticksByMarket = new Map<string, Tick[]>();
    const marketInfo = new Map<string, { asset: string; strike_price: number }>();

    for (const t of allTicks) {
      if (!ticksByMarket.has(t.market_slug)) {
        ticksByMarket.set(t.market_slug, []);
        marketInfo.set(t.market_slug, { asset: t.asset, strike_price: t.strike_price });
      }
      ticksByMarket.get(t.market_slug)!.push({
        ts: t.ts,
        binance_price: t.binance_price,
        strike_price: t.strike_price,
        up_best_ask: t.up_best_ask,
        down_best_ask: t.down_best_ask,
      });
    }

    console.log(`[Backtest] Unique markets: ${ticksByMarket.size}`);

    // Filter settled markets
    const now = Date.now();
    const settledMarkets: string[] = [];

    for (const [slug] of ticksByMarket) {
      const parts = slug.split('-');
      const endEpoch = parseInt(parts[parts.length - 1]) * 1000;
      if (endEpoch < now - 5 * 60 * 1000) {
        settledMarkets.push(slug);
      }
    }

    // Sort by end time descending
    settledMarkets.sort((a, b) => {
      const aEnd = parseInt(a.split('-').pop()!);
      const bEnd = parseInt(b.split('-').pop()!);
      return bEnd - aEnd;
    });

    console.log(`[Backtest] Settled markets: ${settledMarkets.length}`);

    // Process markets
    const trades: SimulatedTrade[] = [];
    const byAsset: Record<string, { markets: number; traded: number; wins: number; losses: number; pnl: number; totalCpp: number; cppCount: number }> = {};

    for (const marketSlug of settledMarkets) {
      const info = marketInfo.get(marketSlug)!;
      const ticks = ticksByMarket.get(marketSlug)!;
      const asset = info.asset;
      const strikePrice = info.strike_price;

      if (!byAsset[asset]) {
        byAsset[asset] = { markets: 0, traded: 0, wins: 0, losses: 0, pnl: 0, totalCpp: 0, cppCount: 0 };
      }
      byAsset[asset].markets++;

      if (ticks.length < 10) {
        trades.push({
          market_slug: marketSlug,
          asset,
          strike_price: strikePrice,
          first_side: 'UP',
          first_price: 0,
          second_price: null,
          cpp: null,
          delay_ms: null,
          total_cost: 0,
          outcome: 'UP',
          payout: 0,
          pnl: 0,
          status: 'skipped',
          skip_reason: 'insufficient_data',
        });
        continue;
      }

      // Parse market times
      const parts = marketSlug.split('-');
      const marketEndEpoch = parseInt(parts[parts.length - 1]) * 1000;
      const marketStartEpoch = marketEndEpoch - 15 * 60 * 1000;

      // Get outcome
      const lastTick = ticks[ticks.length - 1];
      const finalBinancePrice = lastTick.binance_price;
      const outcome: 'UP' | 'DOWN' = finalBinancePrice > strikePrice ? 'UP' : 'DOWN';

      // Simulate strategy
      const trade = simulateStrategy(
        marketSlug, asset, strikePrice, marketStartEpoch, marketEndEpoch,
        ticks, outcome, config
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
    }

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
      avg_pnl_per_trade: tradedTrades.length > 0 ? totalPnl / tradedTrades.length : 0,
      roi_percent: totalCost > 0 ? (totalPnl / totalCost) * 100 : 0,
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

    console.log(`[Backtest] Done! ${summary.total_markets} markets, ${summary.traded_markets} traded, PnL: $${summary.total_pnl.toFixed(2)}`);

    return new Response(
      JSON.stringify({ config, trades, summary }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('[Backtest] Error:', error);
    return new Response(
      JSON.stringify({ error: String(error) }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});

function simulateStrategy(
  marketSlug: string,
  asset: string,
  strikePrice: number,
  marketStartTs: number,
  marketEndTs: number,
  ticks: Tick[],
  outcome: 'UP' | 'DOWN',
  config: BacktestConfig
): SimulatedTrade {
  const entryWindowStart = marketStartTs + config.entry_after_market_start_ms;
  const entryWindowEnd = marketEndTs - 60000;

  // Find first entry
  let firstEntryTick: Tick | null = null;
  let firstSide: 'UP' | 'DOWN' | null = null;

  for (const tick of ticks) {
    if (tick.ts < entryWindowStart) continue;
    if (tick.ts > entryWindowEnd) break;

    const upAsk = tick.up_best_ask;
    const downAsk = tick.down_best_ask;

    // Buy the CHEAPER side first (Gabagool style)
    if (upAsk && downAsk) {
      if (upAsk <= config.max_entry_price && upAsk <= downAsk) {
        firstEntryTick = tick;
        firstSide = 'UP';
        break;
      }
      if (downAsk <= config.max_entry_price && downAsk < upAsk) {
        firstEntryTick = tick;
        firstSide = 'DOWN';
        break;
      }
    } else if (upAsk && upAsk <= config.max_entry_price) {
      firstEntryTick = tick;
      firstSide = 'UP';
      break;
    } else if (downAsk && downAsk <= config.max_entry_price) {
      firstEntryTick = tick;
      firstSide = 'DOWN';
      break;
    }
  }

  if (!firstEntryTick || !firstSide) {
    return {
      market_slug: marketSlug,
      asset,
      strike_price: strikePrice,
      first_side: 'UP',
      first_price: 0,
      second_price: null,
      cpp: null,
      delay_ms: null,
      total_cost: 0,
      outcome,
      payout: 0,
      pnl: 0,
      status: 'skipped',
      skip_reason: 'no_cheap_entry',
    };
  }

  const firstPrice = firstSide === 'UP' 
    ? (firstEntryTick.up_best_ask || 0.5) 
    : (firstEntryTick.down_best_ask || 0.5);
  const firstCost = firstPrice * config.shares_per_side;

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

  if (secondEntryTick && secondPrice !== null) {
    // Paired trade
    const secondCost = secondPrice * config.shares_per_side;
    const cpp = firstPrice + secondPrice;
    const totalCost = firstCost + secondCost;
    const delay = secondEntryTick.ts - firstEntryTick.ts;
    const payout = config.shares_per_side; // $1 per paired share
    const pnl = payout - totalCost;

    return {
      market_slug: marketSlug,
      asset,
      strike_price: strikePrice,
      first_side: firstSide,
      first_price: firstPrice,
      second_price: secondPrice,
      cpp,
      delay_ms: delay,
      total_cost: totalCost,
      outcome,
      payout,
      pnl,
      status: pnl > 0 ? 'paired-win' : 'paired-loss',
    };
  } else {
    // Single-sided
    const didWin = firstSide === outcome;
    const payout = didWin ? config.shares_per_side : 0;
    const pnl = payout - firstCost;

    return {
      market_slug: marketSlug,
      asset,
      strike_price: strikePrice,
      first_side: firstSide,
      first_price: firstPrice,
      second_price: null,
      cpp: null,
      delay_ms: null,
      total_cost: firstCost,
      outcome,
      payout,
      pnl,
      status: pnl > 0 ? 'single-win' : 'single-loss',
    };
  }
}
