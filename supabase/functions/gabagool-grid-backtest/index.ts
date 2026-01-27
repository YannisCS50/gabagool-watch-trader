import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// ============================================================
// GABAGOOL GRID MARKET MAKING BACKTEST
// ============================================================
// Simulates a passive market making strategy with limit orders
// placed across a wide price grid on BOTH UP and DOWN sides.
//
// Key differences from current V35:
// - Grid: 0.10 - 0.90 vs 0.30 - 0.70
// - No momentum filter
// - No fill sync limiting
// - Higher unpaired tolerance
// ============================================================

interface GridConfig {
  mode: 'safe' | 'gabagool' | 'custom';
  
  // Grid parameters
  gridMin: number;
  gridMax: number;
  gridStep: number;
  
  // Size per level
  baseSizeCore: number;      // Size in 0.30-0.70 range
  baseSizeOuter: number;     // Size in outer ranges
  
  // Risk limits
  maxUnpairedShares: number;
  maxImbalanceRatio: number;
  
  // Timing
  entryDelayMs: number;      // Delay after market start
  stopBeforeExpiryMs: number;
}

interface GridLevel {
  price: number;
  size: number;
}

interface SimulatedFill {
  ts: number;
  side: 'UP' | 'DOWN';
  price: number;
  size: number;
}

interface MarketResult {
  marketSlug: string;
  asset: string;
  strikePrice: number;
  
  // Fills
  upFills: SimulatedFill[];
  downFills: SimulatedFill[];
  totalUpQty: number;
  totalDownQty: number;
  totalUpCost: number;
  totalDownCost: number;
  
  // Metrics
  paired: number;
  unpaired: number;
  avgUpPrice: number;
  avgDownPrice: number;
  combinedCost: number;
  
  // Outcome
  outcome: 'UP' | 'DOWN';
  payout: number;
  pnl: number;
  lockedProfit: number;
  
  // Status
  status: 'profit' | 'loss' | 'skipped';
  skipReason?: string;
}

// Predefined configs
const SAFE_CONFIG: GridConfig = {
  mode: 'safe',
  gridMin: 0.30,
  gridMax: 0.70,
  gridStep: 0.05,
  baseSizeCore: 10,
  baseSizeOuter: 5,
  maxUnpairedShares: 20,
  maxImbalanceRatio: 1.3,
  entryDelayMs: 5000,
  stopBeforeExpiryMs: 180000,
};

const GABAGOOL_CONFIG: GridConfig = {
  mode: 'gabagool',
  gridMin: 0.10,
  gridMax: 0.90,
  gridStep: 0.01,
  baseSizeCore: 15,
  baseSizeOuter: 8,
  maxUnpairedShares: 150,
  maxImbalanceRatio: 2.5,
  entryDelayMs: 3000,
  stopBeforeExpiryMs: 60000,
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const configMode = body.mode || 'gabagool';
    const customConfig = body.config as Partial<GridConfig> | undefined;
    
    // Select base config
    let config: GridConfig;
    if (configMode === 'safe') {
      config = { ...SAFE_CONFIG };
    } else if (configMode === 'gabagool') {
      config = { ...GABAGOOL_CONFIG };
    } else {
      config = { ...GABAGOOL_CONFIG, ...customConfig };
    }

    console.log(`[GridBacktest] Starting with mode: ${config.mode}`, config);

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    // Generate grid levels
    const gridLevels: GridLevel[] = [];
    for (let price = config.gridMin; price <= config.gridMax + 0.001; price += config.gridStep) {
      const roundedPrice = Math.round(price * 100) / 100;
      const isCore = roundedPrice >= 0.30 && roundedPrice <= 0.70;
      gridLevels.push({
        price: roundedPrice,
        size: isCore ? config.baseSizeCore : config.baseSizeOuter,
      });
    }
    console.log(`[GridBacktest] Grid: ${gridLevels.length} levels from ${config.gridMin} to ${config.gridMax}`);

    // Fetch ticks
    console.log('[GridBacktest] Fetching ticks...');
    const allTicks: any[] = [];
    let from = 0;
    const batchSize = 5000;

    while (true) {
      const { data, error } = await supabase
        .from('v29_ticks_response')
        .select('market_slug, asset, strike_price, ts, binance_price, up_best_ask, down_best_ask, up_best_bid, down_best_bid')
        .gt('strike_price', 0)
        .order('ts', { ascending: true })
        .range(from, from + batchSize - 1);

      if (error) throw error;
      if (!data || data.length === 0) break;

      allTicks.push(...data);
      if (data.length < batchSize) break;
      from += batchSize;
    }

    console.log(`[GridBacktest] Total ticks: ${allTicks.length}`);

    // Group by market
    const ticksByMarket = new Map<string, any[]>();
    const marketInfo = new Map<string, { asset: string; strike_price: number }>();

    for (const t of allTicks) {
      if (!ticksByMarket.has(t.market_slug)) {
        ticksByMarket.set(t.market_slug, []);
        marketInfo.set(t.market_slug, { asset: t.asset, strike_price: t.strike_price });
      }
      ticksByMarket.get(t.market_slug)!.push(t);
    }

    // Filter settled markets - use latest tick timestamp as reference
    const latestTs = Math.max(...allTicks.map(t => t.ts));
    const settledMarkets: string[] = [];

    for (const [slug] of ticksByMarket) {
      const parts = slug.split('-');
      const endEpoch = parseInt(parts[parts.length - 1]) * 1000;
      // Consider settled if market ended before the latest data point
      if (endEpoch < latestTs - 5 * 60 * 1000) {
        settledMarkets.push(slug);
      }
    }

    settledMarkets.sort((a, b) => {
      const aEnd = parseInt(a.split('-').pop()!);
      const bEnd = parseInt(b.split('-').pop()!);
      return bEnd - aEnd;
    });

    console.log(`[GridBacktest] Settled markets: ${settledMarkets.length}`);

    // Process each market
    const results: MarketResult[] = [];
    
    for (const marketSlug of settledMarkets) {
      const info = marketInfo.get(marketSlug)!;
      const ticks = ticksByMarket.get(marketSlug)!;

      if (ticks.length < 10) {
        results.push(createSkippedResult(marketSlug, info.asset, info.strike_price, 'insufficient_data'));
        continue;
      }

      const result = simulateGridMarketMaking(
        marketSlug,
        info.asset,
        info.strike_price,
        ticks,
        gridLevels,
        config
      );

      results.push(result);
    }

    // Calculate summary
    const tradedResults = results.filter(r => r.status !== 'skipped');
    const profitResults = results.filter(r => r.status === 'profit');
    const lossResults = results.filter(r => r.status === 'loss');

    const totalCost = tradedResults.reduce((sum, r) => sum + r.totalUpCost + r.totalDownCost, 0);
    const totalPayout = tradedResults.reduce((sum, r) => sum + r.payout, 0);
    const totalPnl = tradedResults.reduce((sum, r) => sum + r.pnl, 0);
    const totalLockedProfit = tradedResults.reduce((sum, r) => sum + r.lockedProfit, 0);

    const avgCpp = tradedResults.length > 0
      ? tradedResults.filter(r => r.paired > 0).reduce((sum, r) => sum + r.combinedCost, 0) / 
        tradedResults.filter(r => r.paired > 0).length
      : 0;

    const avgUpDown = tradedResults.length > 0
      ? tradedResults.reduce((sum, r) => sum + r.totalUpQty + r.totalDownQty, 0) / (tradedResults.length * 2)
      : 0;

    // By asset breakdown
    const byAsset: Record<string, { markets: number; traded: number; pnl: number; avgCpp: number; avgShares: number }> = {};
    for (const r of results) {
      if (!byAsset[r.asset]) {
        byAsset[r.asset] = { markets: 0, traded: 0, pnl: 0, avgCpp: 0, avgShares: 0 };
      }
      byAsset[r.asset].markets++;
      if (r.status !== 'skipped') {
        byAsset[r.asset].traded++;
        byAsset[r.asset].pnl += r.pnl;
        if (r.combinedCost > 0) {
          byAsset[r.asset].avgCpp = (byAsset[r.asset].avgCpp * (byAsset[r.asset].traded - 1) + r.combinedCost) / byAsset[r.asset].traded;
        }
        byAsset[r.asset].avgShares += (r.totalUpQty + r.totalDownQty) / 2;
      }
    }

    const summary = {
      config_mode: config.mode,
      grid_levels: gridLevels.length,
      grid_range: `${config.gridMin} - ${config.gridMax}`,
      
      total_markets: results.length,
      traded_markets: tradedResults.length,
      skipped_markets: results.filter(r => r.status === 'skipped').length,
      
      profit_markets: profitResults.length,
      loss_markets: lossResults.length,
      win_rate: tradedResults.length > 0 ? profitResults.length / tradedResults.length : 0,
      
      total_cost: totalCost,
      total_payout: totalPayout,
      total_pnl: totalPnl,
      total_locked_profit: totalLockedProfit,
      
      roi_percent: totalCost > 0 ? (totalPnl / totalCost) * 100 : 0,
      avg_pnl_per_market: tradedResults.length > 0 ? totalPnl / tradedResults.length : 0,
      avg_cpp: avgCpp,
      avg_shares_per_side: avgUpDown,
      
      by_asset: byAsset,
    };

    console.log(`[GridBacktest] Done! PnL: $${totalPnl.toFixed(2)}, ROI: ${summary.roi_percent.toFixed(2)}%`);

    return new Response(
      JSON.stringify({ 
        config,
        results: results.slice(0, 100), // Limit response size
        summary,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('[GridBacktest] Error:', error);
    return new Response(
      JSON.stringify({ error: String(error) }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});

function createSkippedResult(
  marketSlug: string,
  asset: string,
  strikePrice: number,
  reason: string
): MarketResult {
  return {
    marketSlug,
    asset,
    strikePrice,
    upFills: [],
    downFills: [],
    totalUpQty: 0,
    totalDownQty: 0,
    totalUpCost: 0,
    totalDownCost: 0,
    paired: 0,
    unpaired: 0,
    avgUpPrice: 0,
    avgDownPrice: 0,
    combinedCost: 0,
    outcome: 'UP',
    payout: 0,
    pnl: 0,
    lockedProfit: 0,
    status: 'skipped',
    skipReason: reason,
  };
}

function simulateGridMarketMaking(
  marketSlug: string,
  asset: string,
  strikePrice: number,
  ticks: any[],
  gridLevels: GridLevel[],
  config: GridConfig
): MarketResult {
  // Parse market times
  const parts = marketSlug.split('-');
  const marketEndTs = parseInt(parts[parts.length - 1]) * 1000;
  const marketStartTs = marketEndTs - 15 * 60 * 1000;
  
  const tradingStartTs = marketStartTs + config.entryDelayMs;
  const tradingEndTs = marketEndTs - config.stopBeforeExpiryMs;

  // Tracking
  const upFills: SimulatedFill[] = [];
  const downFills: SimulatedFill[] = [];
  let totalUpQty = 0;
  let totalDownQty = 0;
  let totalUpCost = 0;
  let totalDownCost = 0;

  // Track which grid levels have been filled (to avoid double-counting)
  const upFilledLevels = new Set<number>();
  const downFilledLevels = new Set<number>();

  // Process each tick
  for (const tick of ticks) {
    if (tick.ts < tradingStartTs) continue;
    if (tick.ts > tradingEndTs) break;

    const upAsk = tick.up_best_ask;
    const downAsk = tick.down_best_ask;

    // Check imbalance limits before accepting more fills
    const currentUnpaired = Math.abs(totalUpQty - totalDownQty);
    const currentRatio = totalUpQty > 0 && totalDownQty > 0
      ? Math.max(totalUpQty / totalDownQty, totalDownQty / totalUpQty)
      : 1;

    // Simulate fills: if market ask crosses our bid (grid level), we get filled
    for (const level of gridLevels) {
      // UP side: if market ask <= our bid price, we get filled
      if (upAsk && upAsk <= level.price) {
        const levelKey = Math.round(level.price * 100);
        if (!upFilledLevels.has(levelKey)) {
          // Check if we should accept this fill (imbalance check)
          const wouldBeUnpaired = Math.abs((totalUpQty + level.size) - totalDownQty);
          if (wouldBeUnpaired <= config.maxUnpairedShares) {
            upFilledLevels.add(levelKey);
            upFills.push({
              ts: tick.ts,
              side: 'UP',
              price: upAsk, // Fill at market price (taker gets better price)
              size: level.size,
            });
            totalUpQty += level.size;
            totalUpCost += upAsk * level.size;
          }
        }
      }

      // DOWN side: if market ask <= our bid price, we get filled
      if (downAsk && downAsk <= level.price) {
        const levelKey = Math.round(level.price * 100);
        if (!downFilledLevels.has(levelKey)) {
          const wouldBeUnpaired = Math.abs(totalUpQty - (totalDownQty + level.size));
          if (wouldBeUnpaired <= config.maxUnpairedShares) {
            downFilledLevels.add(levelKey);
            downFills.push({
              ts: tick.ts,
              side: 'DOWN',
              price: downAsk,
              size: level.size,
            });
            totalDownQty += level.size;
            totalDownCost += downAsk * level.size;
          }
        }
      }
    }
  }

  // Calculate metrics
  const paired = Math.min(totalUpQty, totalDownQty);
  const unpaired = Math.abs(totalUpQty - totalDownQty);
  
  const avgUpPrice = totalUpQty > 0 ? totalUpCost / totalUpQty : 0;
  const avgDownPrice = totalDownQty > 0 ? totalDownCost / totalDownQty : 0;
  const combinedCost = avgUpPrice + avgDownPrice;

  // Locked profit = profit guaranteed from paired shares if CPP < 1
  const lockedProfit = combinedCost > 0 && combinedCost < 1 
    ? paired * (1 - combinedCost) 
    : 0;

  // Determine outcome
  const lastTick = ticks[ticks.length - 1];
  const outcome: 'UP' | 'DOWN' = lastTick.binance_price > strikePrice ? 'UP' : 'DOWN';

  // Calculate payout and P&L
  // Paired shares: always win $1 per pair
  // Unpaired shares: win or lose based on outcome
  const pairedPayout = paired; // $1 per pair
  const unpairedPayout = outcome === 'UP' 
    ? (totalUpQty - paired) // Unpaired UP shares pay if UP
    : (totalDownQty - paired); // Unpaired DOWN shares pay if DOWN

  const totalPayout = pairedPayout + unpairedPayout;
  const totalCost = totalUpCost + totalDownCost;
  const pnl = totalPayout - totalCost;

  if (totalUpQty === 0 && totalDownQty === 0) {
    return createSkippedResult(marketSlug, asset, strikePrice, 'no_fills');
  }

  return {
    marketSlug,
    asset,
    strikePrice,
    upFills,
    downFills,
    totalUpQty,
    totalDownQty,
    totalUpCost,
    totalDownCost,
    paired,
    unpaired,
    avgUpPrice,
    avgDownPrice,
    combinedCost,
    outcome,
    payout: totalPayout,
    pnl,
    lockedProfit,
    status: pnl >= 0 ? 'profit' : 'loss',
  };
}
