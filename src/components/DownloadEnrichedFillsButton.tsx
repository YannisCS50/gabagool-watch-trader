import { useState } from 'react';
import { Download, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

interface FillRow {
  id: string;
  ts: number;
  iso: string;
  market_id: string;
  asset: string;
  side: string;
  fill_qty: number;
  fill_price: number;
  fill_notional: number;
  intent: string;
  seconds_remaining: number;
  spot_price: number | null;
  strike_price: number | null;
  delta: number | null;
  hedge_lag_ms: number | null;
  created_at: string;
}

interface SnapshotRow {
  ts: number;
  market_id: string;
  spot_price: number | null;
  strike_price: number | null;
  up_bid: number | null;
  up_ask: number | null;
  up_mid: number | null;
  down_bid: number | null;
  down_ask: number | null;
  down_mid: number | null;
  combined_ask: number | null;
  combined_mid: number | null;
  cheapest_ask_plus_other_mid: number | null;
  delta: number | null;
  seconds_remaining: number;
}

interface PriceTickRow {
  created_at: string;
  asset: string;
  price: number;
}

interface EnrichedFill {
  // Original fill data
  fill_ts: number;
  fill_iso: string;
  market_id: string;
  asset: string;
  side: string;
  fill_qty: number;
  fill_price: number;
  fill_notional: number;
  intent: string;
  seconds_remaining: number;

  // --- Convenience columns (what you want to see in the CSV) ---
  // "spot_price" = best available spot proxy for the row
  spot_price: number | null;
  // Explicit asset columns (helps when combining BTC+ETH in one file)
  btc_price: number | null;
  eth_price: number | null;
  // Common naming seen in trading exports
  index_price: number | null; // alias of spot_price
  mark_price: number | null;  // alias of mid_price

  // Orderbook / best price context (aliases)
  up_best_ask: number | null;
  down_best_ask: number | null;
  best_ask: number | null;
  ask_price: number | null;
  bid_price: number | null;
  mid_price: number | null;

  // From fill (may be null)
  fill_spot_price: number | null;
  fill_strike_price: number | null;
  fill_delta: number | null;
  hedge_lag_ms: number | null;

  // From nearest snapshot
  snap_ts: number | null;
  snap_lag_ms: number | null;
  snap_spot_price: number | null;
  snap_strike_price: number | null;
  snap_up_bid: number | null;
  snap_up_ask: number | null;
  snap_up_mid: number | null;
  snap_down_bid: number | null;
  snap_down_ask: number | null;
  snap_down_mid: number | null;
  snap_combined_ask: number | null;
  snap_combined_mid: number | null;
  snap_cheapest_ask_plus_other_mid: number | null;
  snap_delta: number | null;

  // From nearest price tick
  tick_price: number | null;
  tick_lag_ms: number | null;
}

export function DownloadEnrichedFillsButton() {
  const [isDownloading, setIsDownloading] = useState(false);

  const downloadEnrichedFills = async () => {
    setIsDownloading(true);

    try {
      toast.info('Fetching fills, snapshots, and price ticks...');

      // Fetch all data in parallel
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      const thirtyDaysAgoISO = thirtyDaysAgo.toISOString();

      const [fillsRes, snapshotsRes, ticksRes, tradesRes] = await Promise.all([
        supabase
          .from('fill_logs')
          .select('*')
          .order('ts', { ascending: false })
          .limit(5000),
        supabase
          .from('snapshot_logs')
          .select('ts, market_id, spot_price, strike_price, up_bid, up_ask, up_mid, down_bid, down_ask, down_mid, combined_ask, combined_mid, cheapest_ask_plus_other_mid, delta, seconds_remaining')
          .gte('created_at', thirtyDaysAgoISO)
          .order('ts', { ascending: false })
          .limit(50000),
        supabase
          .from('price_ticks')
          .select('created_at, asset, price')
          .gte('created_at', thirtyDaysAgoISO)
          .order('created_at', { ascending: false })
          .limit(50000),
        supabase
          .from('live_trades')
          .select('*')
          .gte('created_at', thirtyDaysAgoISO)
          .order('created_at', { ascending: false })
          .limit(10000),
      ]);

      const fills = (fillsRes.data || []) as FillRow[];
      const snapshots = (snapshotsRes.data || []) as SnapshotRow[];
      const ticks = (ticksRes.data || []) as PriceTickRow[];
      const trades = tradesRes.data || [];

      toast.info(`Processing ${fills.length} fills + ${trades.length} trades...`);

      // Index snapshots by market_id for faster lookup
      const snapshotsByMarket = new Map<string, SnapshotRow[]>();
      for (const snap of snapshots) {
        if (!snapshotsByMarket.has(snap.market_id)) {
          snapshotsByMarket.set(snap.market_id, []);
        }
        snapshotsByMarket.get(snap.market_id)!.push(snap);
      }

      // Index ticks by asset
      const ticksByAsset = new Map<string, { ts: number; price: number }[]>();
      for (const tick of ticks) {
        const ts = new Date(tick.created_at).getTime();
        if (!ticksByAsset.has(tick.asset)) {
          ticksByAsset.set(tick.asset, []);
        }
        ticksByAsset.get(tick.asset)!.push({ ts, price: tick.price });
      }

      // Sort ticks by ts descending for binary search
      for (const arr of ticksByAsset.values()) {
        arr.sort((a, b) => b.ts - a.ts);
      }

      // Find nearest snapshot (within 30s)
      function findNearestSnapshot(marketId: string, fillTs: number): SnapshotRow | null {
        const marketSnaps = snapshotsByMarket.get(marketId);
        if (!marketSnaps || marketSnaps.length === 0) return null;

        let best: SnapshotRow | null = null;
        let bestDiff = Infinity;

        for (const snap of marketSnaps) {
          const diff = Math.abs(snap.ts - fillTs);
          if (diff < bestDiff && diff <= 30000) {
            bestDiff = diff;
            best = snap;
          }
        }
        return best;
      }

      // Find nearest price tick (within 10s)
      function findNearestTick(asset: string, fillTs: number): { price: number; lagMs: number } | null {
        const assetTicks = ticksByAsset.get(asset);
        if (!assetTicks || assetTicks.length === 0) return null;

        let best: { price: number; lagMs: number } | null = null;
        let bestDiff = Infinity;

        for (const tick of assetTicks) {
          const diff = Math.abs(tick.ts - fillTs);
          if (diff < bestDiff && diff <= 10000) {
            bestDiff = diff;
            best = { price: tick.price, lagMs: tick.ts - fillTs };
          }
        }
        return best;
      }

      // Enrich fills
      const enrichedFills: EnrichedFill[] = [];

      for (const fill of fills) {
        const snap = findNearestSnapshot(fill.market_id, fill.ts);
        const tick = findNearestTick(fill.asset, fill.ts);

        const spotPrice = fill.spot_price ?? snap?.spot_price ?? tick?.price ?? null;
        const upBestAsk = snap?.up_ask ?? null;
        const downBestAsk = snap?.down_ask ?? null;
        const askPrice = fill.side === 'UP' ? upBestAsk : fill.side === 'DOWN' ? downBestAsk : null;
        const bidPrice =
          fill.side === 'UP' ? snap?.up_bid ?? null : fill.side === 'DOWN' ? snap?.down_bid ?? null : null;
        const midPrice =
          fill.side === 'UP' ? snap?.up_mid ?? null : fill.side === 'DOWN' ? snap?.down_mid ?? null : null;

        enrichedFills.push({
          fill_ts: fill.ts,
          fill_iso: fill.iso,
          market_id: fill.market_id,
          asset: fill.asset,
          side: fill.side,
          fill_qty: fill.fill_qty,
          fill_price: fill.fill_price,
          fill_notional: fill.fill_notional,
          intent: fill.intent,
          seconds_remaining: fill.seconds_remaining,

          spot_price: spotPrice,
          btc_price     : fill.asset === 'BTC' ? tick?.price ?? null : null,
          eth_price     : fill.asset === 'ETH' ? tick?.price ?? null : null,
          index_price   : spotPrice,
          mark_price    : midPrice,

          up_best_ask   : upBestAsk,
          down_best_ask : downBestAsk,
          best_ask      : askPrice,
          ask_price     : askPrice,
          bid_price     : bidPrice,
          mid_price     : midPrice,

          fill_spot_price: fill.spot_price,
          fill_strike_price: fill.strike_price,
          fill_delta: fill.delta,
          hedge_lag_ms: fill.hedge_lag_ms,
          snap_ts: snap?.ts ?? null,
          snap_lag_ms: snap ? fill.ts - snap.ts : null,
          snap_spot_price: snap?.spot_price ?? null,
          snap_strike_price: snap?.strike_price ?? null,
          snap_up_bid: snap?.up_bid ?? null,
          snap_up_ask: snap?.up_ask ?? null,
          snap_up_mid: snap?.up_mid ?? null,
          snap_down_bid: snap?.down_bid ?? null,
          snap_down_ask: snap?.down_ask ?? null,
          snap_down_mid: snap?.down_mid ?? null,
          snap_combined_ask: snap?.combined_ask ?? null,
          snap_combined_mid: snap?.combined_mid ?? null,
          snap_cheapest_ask_plus_other_mid: snap?.cheapest_ask_plus_other_mid ?? null,
          snap_delta: snap?.delta ?? null,
          tick_price: tick?.price ?? null,
          tick_lag_ms: tick?.lagMs ?? null,
        });
      }

      // Also enrich live_trades (they don't have fill_logs entry always)
      for (const trade of trades) {
        const tradeTs = new Date(trade.created_at).getTime();
        const marketId = trade.market_slug;
        const asset = trade.asset;

        const snap = findNearestSnapshot(marketId, tradeTs);
        const tick = findNearestTick(asset, tradeTs);

        const tradeSide = trade.outcome as string;
        const spotPrice = snap?.spot_price ?? tick?.price ?? null;
        const upBestAsk = snap?.up_ask ?? null;
        const downBestAsk = snap?.down_ask ?? null;
        const askPrice = tradeSide === 'UP' ? upBestAsk : tradeSide === 'DOWN' ? downBestAsk : null;
        const bidPrice =
          tradeSide === 'UP' ? snap?.up_bid ?? null : tradeSide === 'DOWN' ? snap?.down_bid ?? null : null;
        const midPrice =
          tradeSide === 'UP' ? snap?.up_mid ?? null : tradeSide === 'DOWN' ? snap?.down_mid ?? null : null;

        enrichedFills.push({
          fill_ts: tradeTs,
          fill_iso: trade.created_at,
          market_id: marketId,
          asset: asset,
          side: tradeSide,
          fill_qty: trade.shares,
          fill_price: trade.price,
          fill_notional: trade.total,
          intent: 'TRADE',
          seconds_remaining: 0,

          spot_price: spotPrice,
          btc_price     : asset === 'BTC' ? tick?.price ?? null : null,
          eth_price     : asset === 'ETH' ? tick?.price ?? null : null,
          index_price   : spotPrice,
          mark_price    : midPrice,

          up_best_ask   : upBestAsk,
          down_best_ask : downBestAsk,
          best_ask      : askPrice,
          ask_price     : askPrice,
          bid_price     : bidPrice,
          mid_price     : midPrice,

          fill_spot_price: null,
          fill_strike_price: null,
          fill_delta: null,
          hedge_lag_ms: null,
          snap_ts: snap?.ts ?? null,
          snap_lag_ms: snap ? tradeTs - snap.ts : null,
          snap_spot_price: snap?.spot_price ?? null,
          snap_strike_price: snap?.strike_price ?? null,
          snap_up_bid: snap?.up_bid ?? null,
          snap_up_ask: snap?.up_ask ?? null,
          snap_up_mid: snap?.up_mid ?? null,
          snap_down_bid: snap?.down_bid ?? null,
          snap_down_ask: snap?.down_ask ?? null,
          snap_down_mid: snap?.down_mid ?? null,
          snap_combined_ask: snap?.combined_ask ?? null,
          snap_combined_mid: snap?.combined_mid ?? null,
          snap_cheapest_ask_plus_other_mid: snap?.cheapest_ask_plus_other_mid ?? null,
          snap_delta: snap?.delta ?? null,
          tick_price: tick?.price ?? null,
          tick_lag_ms: tick?.lagMs ?? null,
        });
      }

      // Sort by timestamp descending
      enrichedFills.sort((a, b) => b.fill_ts - a.fill_ts);

      // Build CSV
      const headers = [
        'fill_iso',
        'market_id',
        'asset',
        'side',
        'intent',
        'fill_qty',
        'fill_price',
        'fill_notional',
        'seconds_remaining',

        // Requested / convenience columns
        'spot_price',
        'btc_price',
        'eth_price',
        'index_price',
        'mark_price',
        'up_best_ask',
        'down_best_ask',
        'best_ask',
        'ask_price',
        'bid_price',
        'mid_price',

        // Raw sources (still useful to debug)
        'fill_spot_price',
        'fill_strike_price',
        'fill_delta',
        'hedge_lag_ms',
        'snap_lag_ms',
        'snap_spot_price',
        'snap_strike_price',
        'snap_up_bid',
        'snap_up_ask',
        'snap_up_mid',
        'snap_down_bid',
        'snap_down_ask',
        'snap_down_mid',
        'snap_combined_ask',
        'snap_combined_mid',
        'snap_cheapest_ask_plus_other_mid',
        'snap_delta',
        'tick_price',
        'tick_lag_ms',
      ];

      const rows = enrichedFills.map((row) =>
        [
          row.fill_iso,
          row.market_id,
          row.asset,
          row.side,
          row.intent,
          row.fill_qty,
          row.fill_price,
          row.fill_notional,
          row.seconds_remaining,

          row.spot_price ?? '',
          row.btc_price ?? '',
          row.eth_price ?? '',
          row.index_price ?? '',
          row.mark_price ?? '',
          row.up_best_ask ?? '',
          row.down_best_ask ?? '',
          row.best_ask ?? '',
          row.ask_price ?? '',
          row.bid_price ?? '',
          row.mid_price ?? '',

          row.fill_spot_price ?? '',
          row.fill_strike_price ?? '',
          row.fill_delta ?? '',
          row.hedge_lag_ms ?? '',
          row.snap_lag_ms ?? '',
          row.snap_spot_price ?? '',
          row.snap_strike_price ?? '',
          row.snap_up_bid ?? '',
          row.snap_up_ask ?? '',
          row.snap_up_mid ?? '',
          row.snap_down_bid ?? '',
          row.snap_down_ask ?? '',
          row.snap_down_mid ?? '',
          row.snap_combined_ask ?? '',
          row.snap_combined_mid ?? '',
          row.snap_cheapest_ask_plus_other_mid ?? '',
          row.snap_delta ?? '',
          row.tick_price ?? '',
          row.tick_lag_ms ?? '',
        ]
          .map((v) => `"${String(v).replace(/"/g, '""')}"`)
          .join(',')
      );

      const csvContent = [headers.join(','), ...rows].join('\n');
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `fills_enriched_${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);

      // Stats
      const withSnap = enrichedFills.filter((r) => r.snap_ts !== null).length;
      const withTick = enrichedFills.filter((r) => r.tick_price !== null).length;

      toast.success(`Downloaded ${enrichedFills.length} enriched fills`, {
        description: `${withSnap} with snapshot context, ${withTick} with tick price`,
      });
    } catch (error) {
      console.error('Download error:', error);
      toast.error('Failed to download enriched fills');
    } finally {
      setIsDownloading(false);
    }
  };

  return (
    <Button
      onClick={downloadEnrichedFills}
      disabled={isDownloading}
      variant="outline"
      size="sm"
      className="font-mono text-xs"
    >
      {isDownloading ? (
        <Loader2 className="w-3 h-3 mr-2 animate-spin" />
      ) : (
        <Download className="w-3 h-3 mr-2" />
      )}
      {isDownloading ? 'Enriching...' : 'Fills + Context'}
    </Button>
  );
}
