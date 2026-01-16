import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);
    const asset = url.searchParams.get("asset") || "all";

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    // Server-side aggregation (avoid pulling 300k+ rows to the browser)
    const result = await simpleAnalysis(supabase, asset);

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Error:", message);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

async function analyzeWithRawQueries(supabase: any, asset: string) {
  const assetFilter = asset !== "all" ? `AND t.asset = '${asset}'` : "";

  // Get all signal ticks with their followup data in one query
  const query = `
    WITH signal_ticks AS (
      SELECT 
        t.id,
        t.ts,
        t.signal_direction,
        t.binance_delta,
        t.chainlink_price,
        t.up_best_bid,
        t.down_best_bid,
        t.market_slug,
        t.asset,
        -- Parse market end time: slug format is "asset-updown-Xm-STARTTIMESTAMP"
        -- e.g., btc-updown-15m-1768402800
        CASE 
          WHEN t.market_slug ~ '-([0-9]+)m-([0-9]+)$' THEN
            (REGEXP_MATCH(t.market_slug, '-([0-9]+)m-([0-9]+)$'))[2]::bigint * 1000 +
            (REGEXP_MATCH(t.market_slug, '-([0-9]+)m-([0-9]+)$'))[1]::int * 60 * 1000
          ELSE NULL
        END as market_end_ms
      FROM v29_ticks t
      WHERE t.signal_direction IS NOT NULL
      ${assetFilter}
    ),
    followup_analysis AS (
      SELECT 
        s.signal_direction,
        s.binance_delta,
        s.chainlink_price as signal_chainlink,
        s.up_best_bid as signal_up_bid,
        s.down_best_bid as signal_down_bid,
        s.market_end_ms,
        s.ts as signal_ts,
        -- Calculate seconds remaining at signal time
        CASE WHEN s.market_end_ms IS NOT NULL 
          THEN (s.market_end_ms - s.ts) / 1000 
          ELSE NULL 
        END as seconds_remaining,
        f.ts as followup_ts,
        f.chainlink_price as followup_chainlink,
        f.up_best_bid as followup_up_bid,
        f.down_best_bid as followup_down_bid,
        -- Time bucket (1-9 seconds after signal)
        FLOOR((f.ts - s.ts + 500) / 1000) as time_bucket
      FROM signal_ticks s
      JOIN v29_ticks f ON f.market_slug = s.market_slug
        AND f.ts > s.ts
        AND f.ts < s.ts + 10000
      WHERE FLOOR((f.ts - s.ts + 500) / 1000) BETWEEN 1 AND 9
    ),
    first_per_bucket AS (
      SELECT DISTINCT ON (signal_ts, time_bucket)
        signal_direction,
        binance_delta,
        signal_chainlink,
        signal_up_bid,
        signal_down_bid,
        seconds_remaining,
        time_bucket,
        followup_chainlink,
        followup_up_bid,
        followup_down_bid,
        -- Price change %
        (followup_chainlink - signal_chainlink) / signal_chainlink * 100 as price_change_pct,
        -- Share price change in cents (for UP signals use up_best_bid, for DOWN use down_best_bid)
        CASE 
          WHEN signal_direction = 'UP' AND signal_up_bid IS NOT NULL AND followup_up_bid IS NOT NULL
          THEN (followup_up_bid - signal_up_bid) * 100
          WHEN signal_direction = 'DOWN' AND signal_down_bid IS NOT NULL AND followup_down_bid IS NOT NULL
          THEN (followup_down_bid - signal_down_bid) * 100
          ELSE NULL
        END as share_change_cents
      FROM followup_analysis
      ORDER BY signal_ts, time_bucket, (followup_ts - signal_ts)
    ),
    -- Aggregate by direction, time bucket, and seconds_remaining bucket
    stats AS (
      SELECT
        signal_direction,
        time_bucket,
        CASE 
          WHEN seconds_remaining < 60 THEN '0-60s'
          WHEN seconds_remaining < 120 THEN '60-120s'
          WHEN seconds_remaining < 300 THEN '120-300s'
          WHEN seconds_remaining < 600 THEN '300-600s'
          ELSE '600s+'
        END as time_remaining_bucket,
        COUNT(*) as sample_count,
        AVG(ABS(binance_delta)) as avg_signal_size,
        AVG(price_change_pct) as avg_price_change_pct,
        COUNT(*) FILTER (WHERE price_change_pct > 0) as price_up_count,
        COUNT(*) FILTER (WHERE price_change_pct < 0) as price_down_count,
        AVG(share_change_cents) FILTER (WHERE share_change_cents IS NOT NULL) as avg_share_change_cents,
        COUNT(*) FILTER (WHERE share_change_cents > 0) as share_up_count,
        COUNT(*) FILTER (WHERE share_change_cents < 0) as share_down_count,
        COUNT(*) FILTER (WHERE share_change_cents IS NOT NULL) as share_sample_count
      FROM first_per_bucket
      GROUP BY signal_direction, time_bucket, time_remaining_bucket
    )
    SELECT * FROM stats ORDER BY signal_direction, time_remaining_bucket, time_bucket
  `;

  const { data: rawStats, error } = await supabase.rpc('exec_sql', { query_text: query });
  
  if (error) {
    // Can't use exec_sql, let's do a simpler approach with multiple queries
    console.log("exec_sql not available, using simple aggregation");
    return await simpleAnalysis(supabase, asset);
  }

  return formatResults(rawStats);
}

async function simpleAnalysis(supabase: any, asset: string) {
  // Fetch all signal ticks (paginate; PostgREST max-rows is typically 1000)
  const signals: any[] = [];
  let offset = 0;
  const pageSize = 1000;
  const maxPages = 50; // 50k signals safety

  for (let page = 0; page < maxPages; page++) {
    let q = supabase
      .from('v29_ticks')
      .select('ts, signal_direction, binance_delta, chainlink_price, up_best_bid, down_best_bid, market_slug, asset')
      .not('signal_direction', 'is', null)
      .order('ts', { ascending: true })
      .range(offset, offset + pageSize - 1);

    if (asset !== 'all') q = q.eq('asset', asset);

    const { data, error } = await q;
    if (error) throw error;
    if (!data || data.length === 0) break;

    signals.push(...data);

    if (data.length < pageSize) break;
    offset += pageSize;
  }

  // Group signals by market
  const signalsByMarket = new Map<string, any[]>();
  for (const s of signals || []) {
    if (!signalsByMarket.has(s.market_slug)) {
      signalsByMarket.set(s.market_slug, []);
    }
    signalsByMarket.get(s.market_slug)!.push(s);
  }

  // Fetch all ticks for markets that have signals (in batches)
  const marketSlugs = Array.from(signalsByMarket.keys());
  const allFollowups = new Map<string, any[]>();
  
  // Batch fetch (paginate because of max-rows)
  const batchSize = 50;
  const pageSizeTicks = 1000;
  const maxPagesTicks = 1000; // safety

  for (let i = 0; i < marketSlugs.length; i += batchSize) {
    const batch = marketSlugs.slice(i, i + batchSize);

    let offsetTicks = 0;
    for (let page = 0; page < maxPagesTicks; page++) {
      const { data: ticks, error: tickError } = await supabase
        .from('v29_ticks')
        .select('ts, chainlink_price, up_best_bid, down_best_bid, market_slug')
        .in('market_slug', batch)
        .order('ts', { ascending: true })
        .range(offsetTicks, offsetTicks + pageSizeTicks - 1);

      if (tickError) throw tickError;
      if (!ticks || ticks.length === 0) break;

      for (const t of ticks) {
        if (!allFollowups.has(t.market_slug)) {
          allFollowups.set(t.market_slug, []);
        }
        allFollowups.get(t.market_slug)!.push(t);
      }

      if (ticks.length < pageSizeTicks) break;
      offsetTicks += pageSizeTicks;
    }
  }

  // Now analyze
  const results = {
    overall: { up: analyzeDirection(signals.filter((s: any) => s.signal_direction === 'UP'), allFollowups, 'UP'),
               down: analyzeDirection(signals.filter((s: any) => s.signal_direction === 'DOWN'), allFollowups, 'DOWN') },
    byBucket: [] as any[]
  };

  // Parse seconds remaining and bucket
  const TIME_BUCKETS = [
    { label: '0-60s', min: 0, max: 60 },
    { label: '60-120s', min: 60, max: 120 },
    { label: '120-300s', min: 120, max: 300 },
    { label: '300-600s', min: 300, max: 600 },
    { label: '600s+', min: 600, max: Infinity },
  ];

  const signalsWithRemaining = (signals || []).map((s: any) => {
    const m = s.market_slug?.match(/-(\d+)([smhd])-([0-9]+)$/);
    if (!m) return { ...s, secondsRemaining: null };
    const durationValue = parseInt(m[1]);
    const durationUnit = m[2];
    const startUnixSec = parseInt(m[3]);
    const unitToSec: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };
    const durationSec = durationValue * (unitToSec[durationUnit] || 60);
    const endTimeMs = (startUnixSec + durationSec) * 1000;
    return { ...s, secondsRemaining: Math.floor((endTimeMs - s.ts) / 1000) };
  });

  for (const bucket of TIME_BUCKETS) {
    const filtered = signalsWithRemaining.filter((s: any) => 
      s.secondsRemaining !== null && 
      s.secondsRemaining >= bucket.min && 
      s.secondsRemaining < bucket.max
    );
    results.byBucket.push({
      bucket_label: bucket.label,
      up: analyzeDirection(filtered.filter((s: any) => s.signal_direction === 'UP'), allFollowups, 'UP'),
      down: analyzeDirection(filtered.filter((s: any) => s.signal_direction === 'DOWN'), allFollowups, 'DOWN'),
    });
  }

  return results;
}

function analyzeDirection(signals: any[], ticksByMarket: Map<string, any[]>, direction: 'UP' | 'DOWN') {
  const statsBySecond = new Map<number, {
    price_changes: number[];
    share_changes: number[];
    price_up: number;
    price_down: number;
    share_up: number;
    share_down: number;
  }>();

  for (let s = 1; s <= 9; s++) {
    statsBySecond.set(s, { price_changes: [], share_changes: [], price_up: 0, price_down: 0, share_up: 0, share_down: 0 });
  }

  let totalDelta = 0;

  for (const signal of signals) {
    totalDelta += Math.abs(signal.binance_delta || 0);
    const ticks = ticksByMarket.get(signal.market_slug) || [];
    const counted = new Set<number>();

    for (const tick of ticks) {
      const diffMs = tick.ts - signal.ts;
      if (diffMs < 0 || diffMs >= 10000) continue;
      const bucket = Math.floor((diffMs + 500) / 1000);
      if (bucket < 1 || bucket > 9 || counted.has(bucket)) continue;
      counted.add(bucket);

      const stats = statsBySecond.get(bucket)!;
      const priceChange = ((tick.chainlink_price - signal.chainlink_price) / signal.chainlink_price) * 100;
      stats.price_changes.push(priceChange);
      if (priceChange > 0) stats.price_up++;
      if (priceChange < 0) stats.price_down++;

      const sigShare = direction === 'UP' ? signal.up_best_bid : signal.down_best_bid;
      const followShare = direction === 'UP' ? tick.up_best_bid : tick.down_best_bid;
      if (sigShare != null && followShare != null) {
        const shareChange = (followShare - sigShare) * 100;
        stats.share_changes.push(shareChange);
        if (shareChange > 0) stats.share_up++;
        if (shareChange < 0) stats.share_down++;
      }
    }
  }

  const statsArray = [];
  for (let s = 1; s <= 9; s++) {
    const d = statsBySecond.get(s)!;
    const n = d.price_changes.length;
    const ns = d.share_changes.length;
    statsArray.push({
      seconds_after: s,
      sample_count: n,
      avg_price_change_pct: n > 0 ? d.price_changes.reduce((a, b) => a + b, 0) / n : 0,
      up_tick_pct: n > 0 ? (d.price_up / n) * 100 : 0,
      down_tick_pct: n > 0 ? (d.price_down / n) * 100 : 0,
      avg_share_change_cents: ns > 0 ? d.share_changes.reduce((a, b) => a + b, 0) / ns : 0,
      up_share_pct: ns > 0 ? (d.share_up / ns) * 100 : 0,
      down_share_pct: ns > 0 ? (d.share_down / ns) * 100 : 0,
    });
  }

  return {
    direction,
    total_signals: signals.length,
    avg_signal_size: signals.length > 0 ? totalDelta / signals.length : 0,
    stats_by_second: statsArray,
  };
}

function formatResults(rawStats: any[]) {
  // Transform raw SQL results to structured format
  return { raw: rawStats };
}
