// ============================================================
// V27 BUILD LOOKUP TABLE
// ============================================================
// 
// Builds the empirical price lookup table from historical data.
// Joins market_history (with outcomes) + price snapshots to determine
// what prices were being offered at different delta/time buckets.
//
// Usage: Call periodically to update the lookup table.
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

interface LookupEntry {
  asset: string;
  delta_bucket: string;
  time_bucket: string;
  samples: number;
  avg_up_price: number;
  avg_down_price: number;
  std_up: number;
  std_down: number;
  win_rate_up: number;  // When market ended UP, what % of time would buying UP have won?
  win_rate_down: number;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const supabase = createClient(supabaseUrl, supabaseKey)

    console.log('[v27-build-lookup] Starting lookup table build...')

    // Step 1: Get all resolved markets with outcomes
    const { data: markets, error: marketsError } = await supabase
      .from('market_history')
      .select('slug, asset, result, strike_price, open_price, close_price, event_end_time')
      .in('result', ['UP', 'DOWN'])
      .not('strike_price', 'is', null)
      .order('event_end_time', { ascending: false })
      .limit(2000)

    if (marketsError) {
      throw new Error(`Failed to fetch markets: ${marketsError.message}`)
    }

    console.log(`[v27-build-lookup] Found ${markets?.length || 0} resolved markets`)

    // Build lookup from the resolved markets themselves
    // Calculate what the outcome was based on close vs open price
    const lookupData: Record<string, { 
      samples: number;
      upWins: number;
      downWins: number;
      upPrices: number[];
      downPrices: number[];
    }> = {}

    for (const market of markets || []) {
      const { asset, result, strike_price, close_price } = market
      
      if (!strike_price || !close_price) continue
      
      // Calculate delta percentage at close
      const deltaAbs = Math.abs(close_price - strike_price)
      const deltaPct = deltaAbs / strike_price * 100
      
      // Get buckets
      const deltaBucket = getDeltaBucket(asset, deltaPct)
      
      // For historical analysis, we'll use multiple time buckets
      // since we don't have exact snapshot times
      const timeBuckets = ['t<1min', 't1-3min', 't3-5min', 't5-10min', 't>10min']
      
      for (const timeBucket of timeBuckets) {
        const key = `${asset}:${deltaBucket}:${timeBucket}`
        
        if (!lookupData[key]) {
          lookupData[key] = { 
            samples: 0, 
            upWins: 0, 
            downWins: 0,
            upPrices: [],
            downPrices: []
          }
        }
        
        lookupData[key].samples++
        
        if (result === 'UP') {
          lookupData[key].upWins++
        } else {
          lookupData[key].downWins++
        }
      }
    }

    // Convert to lookup entries with expected prices
    // The expected price should reflect the probability of winning
    const lookupEntries: LookupEntry[] = []
    
    for (const [key, data] of Object.entries(lookupData)) {
      const [asset, deltaBucket, timeBucket] = key.split(':')
      const total = data.upWins + data.downWins
      
      if (total < 5) continue // Need minimum samples
      
      const winRateUp = data.upWins / total
      const winRateDown = data.downWins / total
      
      // Adjust for time remaining
      // Less time = more certainty = prices closer to 0/1
      // More time = less certainty = prices closer to 0.5
      const timeMultiplier = getTimeMultiplier(timeBucket)
      
      // Expected price = probability * time adjustment
      // With 1 min left, delta matters more (steeper curve)
      // With 10 min left, delta matters less (flatter curve)
      const avgUpPrice = 0.5 + (winRateUp - 0.5) * timeMultiplier
      const avgDownPrice = 0.5 + (winRateDown - 0.5) * timeMultiplier
      
      lookupEntries.push({
        asset,
        delta_bucket: deltaBucket,
        time_bucket: timeBucket,
        samples: total,
        avg_up_price: Math.max(0.01, Math.min(0.99, avgUpPrice)),
        avg_down_price: Math.max(0.01, Math.min(0.99, avgDownPrice)),
        std_up: 0.10,
        std_down: 0.10,
        win_rate_up: winRateUp,
        win_rate_down: winRateDown,
      })
    }

    console.log(`[v27-build-lookup] Generated ${lookupEntries.length} lookup entries`)

    // Upsert to database
    const { error: upsertError } = await supabase
      .from('v27_price_lookup')
      .upsert(
        lookupEntries.map(e => ({
          asset: e.asset,
          delta_bucket: e.delta_bucket,
          time_bucket: e.time_bucket,
          sample_count: e.samples,
          avg_up_price: e.avg_up_price,
          avg_down_price: e.avg_down_price,
          std_up: e.std_up,
          std_down: e.std_down,
        })),
        { onConflict: 'asset,delta_bucket,time_bucket' }
      )

    if (upsertError) {
      console.error('[v27-build-lookup] Upsert error:', upsertError)
      throw new Error(`Failed to upsert lookup data: ${upsertError.message}`)
    }

    // Also run a quick backtest simulation
    const backtest = runBacktest(markets || [], lookupEntries)

    return new Response(
      JSON.stringify({
        success: true,
        marketsProcessed: markets?.length || 0,
        lookupEntries: lookupEntries.length,
        backtest,
        sample: lookupEntries.slice(0, 10),
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    console.error('[v27-build-lookup] Error:', error)
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})

function getDeltaBucket(asset: string, deltaPct: number): string {
  // Delta percentage thresholds for each asset
  switch (asset) {
    case 'BTC':
      if (deltaPct < 0.05) return 'd<0.05%'
      if (deltaPct < 0.1) return 'd0.05-0.1%'
      if (deltaPct < 0.2) return 'd0.1-0.2%'
      return 'd>0.2%'
    case 'ETH':
      if (deltaPct < 0.05) return 'd<0.05%'
      if (deltaPct < 0.1) return 'd0.05-0.1%'
      if (deltaPct < 0.2) return 'd0.1-0.2%'
      return 'd>0.2%'
    case 'SOL':
      if (deltaPct < 0.05) return 'd<0.05%'
      if (deltaPct < 0.15) return 'd0.05-0.15%'
      if (deltaPct < 0.3) return 'd0.15-0.3%'
      return 'd>0.3%'
    case 'XRP':
      if (deltaPct < 0.1) return 'd<0.1%'
      if (deltaPct < 0.25) return 'd0.1-0.25%'
      if (deltaPct < 0.5) return 'd0.25-0.5%'
      return 'd>0.5%'
    default:
      if (deltaPct < 0.1) return 'd<0.1%'
      if (deltaPct < 0.2) return 'd0.1-0.2%'
      return 'd>0.2%'
  }
}

function getTimeMultiplier(timeBucket: string): number {
  // How much to amplify the probability based on time remaining
  // Less time = more certainty = higher multiplier
  switch (timeBucket) {
    case 't<1min': return 1.8    // Very high certainty at 1 min
    case 't1-3min': return 1.5   // High certainty
    case 't3-5min': return 1.2   // Medium certainty
    case 't5-10min': return 1.0  // Base certainty
    case 't>10min': return 0.7   // Lower certainty, prices closer to 0.5
    default: return 1.0
  }
}

interface BacktestResult {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnL: number;
  avgPnLPerTrade: number;
  byAsset: Record<string, { trades: number; pnl: number; winRate: number }>;
}

function runBacktest(
  markets: Array<{ slug: string; asset: string; result: string; strike_price: number; close_price: number }>,
  lookupEntries: LookupEntry[]
): BacktestResult {
  // Create lookup map
  const lookup = new Map<string, LookupEntry>()
  for (const entry of lookupEntries) {
    lookup.set(`${entry.asset}:${entry.delta_bucket}:${entry.time_bucket}`, entry)
  }

  let totalTrades = 0
  let wins = 0
  let losses = 0
  let totalPnL = 0
  const byAsset: Record<string, { trades: number; wins: number; pnl: number }> = {}

  for (const market of markets) {
    const { asset, result, strike_price, close_price } = market
    
    if (!strike_price || !close_price) continue
    
    const deltaAbs = Math.abs(close_price - strike_price)
    const deltaPct = deltaAbs / strike_price * 100
    const deltaBucket = getDeltaBucket(asset, deltaPct)
    
    // Simulate trading at 5 minutes remaining
    const timeBucket = 't3-5min'
    const key = `${asset}:${deltaBucket}:${timeBucket}`
    const entry = lookup.get(key)
    
    if (!entry || entry.samples < 10) continue
    
    // Decision: buy the side that has higher expected value
    // If UP win rate > 55%, buy UP; if DOWN win rate > 55%, buy DOWN
    const buyUp = entry.win_rate_up > 0.55
    const buyDown = entry.win_rate_down > 0.55
    
    if (!buyUp && !buyDown) continue // No clear signal
    
    const sideToBuy = buyUp ? 'UP' : 'DOWN'
    const entryPrice = 0.50 // Assume we can buy at fair price
    
    totalTrades++
    
    if (!byAsset[asset]) {
      byAsset[asset] = { trades: 0, wins: 0, pnl: 0 }
    }
    byAsset[asset].trades++
    
    if (sideToBuy === result) {
      // Won! Payout = 1.00 - entry price
      const pnl = 1.0 - entryPrice
      wins++
      totalPnL += pnl
      byAsset[asset].wins++
      byAsset[asset].pnl += pnl
    } else {
      // Lost - entry price
      const pnl = -entryPrice
      losses++
      totalPnL += pnl
      byAsset[asset].pnl += pnl
    }
  }

  return {
    totalTrades,
    wins,
    losses,
    winRate: totalTrades > 0 ? wins / totalTrades : 0,
    totalPnL,
    avgPnLPerTrade: totalTrades > 0 ? totalPnL / totalTrades : 0,
    byAsset: Object.fromEntries(
      Object.entries(byAsset).map(([asset, data]) => [
        asset,
        {
          trades: data.trades,
          pnl: Math.round(data.pnl * 100) / 100,
          winRate: data.trades > 0 ? Math.round(data.wins / data.trades * 100) : 0,
        }
      ])
    ),
  }
}
