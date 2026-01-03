import { useState } from 'react';
import { Download, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

export function DownloadAllLogsButton() {
  const [isDownloading, setIsDownloading] = useState(false);

  const downloadAllLogs = async () => {
    setIsDownloading(true);
    
    try {
      // Calculate 30 days ago
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      const thirtyDaysAgoISO = thirtyDaysAgo.toISOString();

      toast.info('Fetching all data (this may take a moment)...');

      // Fetch ALL relevant tables - the ones that actually have data
      const [
        liveTradesRes, 
        orderQueueRes, 
        priceTicksRes,
        fillLogsRes,
        settlementLogsRes,
        settlementFailuresRes,
        strikePricesRes,
        snapshotLogsRes,
      ] = await Promise.all([
        // Live trades - THE main trading data
        supabase.from('live_trades')
          .select('*')
          .gte('created_at', thirtyDaysAgoISO)
          .order('created_at', { ascending: false }),
        
        // Order queue - all orders placed
        supabase.from('order_queue')
          .select('*')
          .gte('created_at', thirtyDaysAgoISO)
          .order('created_at', { ascending: false }),
        
        // Price ticks - raw chainlink prices (can be large!)
        supabase.from('price_ticks')
          .select('*')
          .gte('created_at', thirtyDaysAgoISO)
          .order('created_at', { ascending: false }),
        
        // Fill logs (if any)
        supabase.from('fill_logs')
          .select('*')
          .order('ts', { ascending: false }),
        
        // Settlement logs (if any)
        supabase.from('settlement_logs')
          .select('*')
          .order('ts', { ascending: false }),
        
        // Settlement failures (critical!)
        supabase.from('settlement_failures')
          .select('*')
          .order('created_at', { ascending: false }),
        
        // Strike prices
        supabase.from('strike_prices')
          .select('*')
          .gte('created_at', thirtyDaysAgoISO)
          .order('created_at', { ascending: false }),
        
        // Snapshot logs - market state snapshots with orderbook data
        supabase.from('snapshot_logs')
          .select('*')
          .gte('created_at', thirtyDaysAgoISO)
          .order('ts', { ascending: false }),
      ]);

      // Build CSV rows
      const allRows: string[] = [];
      
      // CSV Header - comprehensive
      allRows.push([
        'type',
        'timestamp',
        'market_slug',
        'asset',
        'outcome',
        'side',
        'shares',
        'price',
        'total',
        'status',
        'order_id',
        'intent',
        'reasoning',
        'event_start',
        'event_end',
        'strike_price',
        'open_price',
        'close_price',
        'delta',
        'pair_cost',
        'pnl',
        'error',
        // Snapshot-specific columns
        'seconds_remaining',
        'spot_price',
        'up_bid',
        'up_ask',
        'up_mid',
        'down_bid',
        'down_ask',
        'down_mid',
        'spread_up',
        'spread_down',
        'combined_ask',
        'combined_mid',
        'cheapest_ask_plus_other_mid',
        'skew',
        'adverse_streak',
        'no_liquidity_streak',
      ].join(','));

      // Live trades (5000+ records)
      (liveTradesRes.data || []).forEach((row) => {
        allRows.push([
          'TRADE',
          row.created_at || '',
          row.market_slug || '',
          row.asset || '',
          row.outcome || '',
          '', // side not in live_trades
          row.shares || '',
          row.price || '',
          row.total || '',
          row.status || '',
          row.order_id || '',
          '', // intent
          row.reasoning || '',
          row.event_start_time || '',
          row.event_end_time || '',
          '', // strike
          '', // open
          '', // close
          '', // delta
          '', // pair_cost
          '', // pnl
          '', // error
        ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(','));
      });

      // Order queue (22000+ records)
      (orderQueueRes.data || []).forEach((row) => {
        allRows.push([
          'ORDER',
          row.created_at || '',
          row.market_slug || '',
          row.asset || '',
          row.outcome || '',
          '', // side
          row.shares || '',
          row.price || '',
          '', // total
          row.status || '',
          row.order_id || '',
          '', // intent
          row.reasoning || '',
          row.event_start_time || '',
          row.event_end_time || '',
          '', // strike
          '', // open
          '', // close
          '', // delta
          '', // pair_cost
          '', // pnl
          row.error_message || '',
        ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(','));
      });

      // Price ticks (450k+ records - raw!)
      (priceTicksRes.data || []).forEach((row) => {
        allRows.push([
          'TICK',
          row.created_at || '',
          '', // market
          row.asset || '',
          '', // outcome
          '', // side
          '', // shares
          row.price || '',
          '', // total
          '', // status
          '', // order_id
          '', // intent
          '', // reasoning
          '', // event_start
          '', // event_end
          '', // strike
          '', // open
          '', // close
          row.delta_percent || '',
          '', // pair_cost
          '', // pnl
          '', // error
        ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(','));
      });

      // Fill logs
      (fillLogsRes.data || []).forEach((row) => {
        allRows.push([
          'FILL',
          row.iso || '',
          row.market_id || '',
          row.asset || '',
          '', // outcome
          row.side || '',
          row.fill_qty || '',
          row.fill_price || '',
          row.fill_notional || '',
          '', // status
          row.order_id || '',
          row.intent || '',
          '', // reasoning
          '', // event_start
          '', // event_end
          row.strike_price || '',
          '', // open
          '', // close
          row.delta || '',
          '', // pair_cost
          '', // pnl
          '', // error
        ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(','));
      });

      // Settlement logs
      (settlementLogsRes.data || []).forEach((row) => {
        allRows.push([
          'SETTLEMENT',
          row.iso || '',
          row.market_id || '',
          row.asset || '',
          row.winning_side || '',
          '', // side
          `${row.final_up_shares || 0}/${row.final_down_shares || 0}`,
          '', // price
          '', // total
          '', // status
          '', // order_id
          '', // intent
          '', // reasoning
          '', // event_start
          '', // event_end
          '', // strike
          '', // open
          '', // close
          '', // delta
          row.pair_cost || '',
          row.realized_pnl || '',
          '', // error
        ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(','));
      });

      // Settlement failures (CRITICAL)
      (settlementFailuresRes.data || []).forEach((row) => {
        allRows.push([
          'FAILURE',
          row.created_at || '',
          row.market_slug || '',
          row.asset || '',
          '', // outcome
          row.lost_side || '',
          `${row.up_shares || 0}/${row.down_shares || 0}`,
          '', // price
          row.lost_cost || '',
          '', // status
          '', // order_id
          '', // intent
          row.reason || '',
          '', // event_start
          '', // event_end
          '', // strike
          '', // open
          '', // close
          '', // delta
          '', // pair_cost
          '', // pnl
          '', // error
        ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(','));
      });

      // Strike prices
      (strikePricesRes.data || []).forEach((row) => {
        allRows.push([
          'STRIKE',
          row.created_at || '',
          row.market_slug || '',
          row.asset || '',
          '', // outcome
          '', // side
          '', // shares
          '', // price
          '', // total
          '', // status
          '', // order_id
          '', // intent
          '', // reasoning
          row.event_start_time || '',
          '', // event_end
          row.strike_price || '',
          row.open_price || '',
          row.close_price || '',
          '', // delta
          '', // pair_cost
          '', // pnl
          '', // error
        ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(','));
      });

      // Snapshot logs - market state with orderbook data
      (snapshotLogsRes.data || []).forEach((row) => {
        allRows.push([
          'SNAPSHOT',
          row.iso || '',
          row.market_id || '',
          row.asset || '',
          row.bot_state || '',
          '', // side
          `${row.up_shares || 0}/${row.down_shares || 0}`,
          '', // price
          '', // total
          '', // status
          '', // order_id
          '', // intent
          '', // reasoning
          '', // event_start
          '', // event_end
          row.strike_price || '',
          '', // open
          '', // close
          row.delta || '',
          row.pair_cost || '',
          '', // pnl
          '', // error
          // New fields - appended
          row.seconds_remaining || '',
          row.spot_price || '',
          row.up_bid || '',
          row.up_ask || '',
          row.up_mid || '',
          row.down_bid || '',
          row.down_ask || '',
          row.down_mid || '',
          row.spread_up || '',
          row.spread_down || '',
          row.combined_ask || '',
          row.combined_mid || '',
          row.cheapest_ask_plus_other_mid || '',
          row.skew || '',
          row.adverse_streak || '',
          row.no_liquidity_streak || '',
        ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(','));
      });

      // Create and download CSV
      const csvContent = allRows.join('\n');
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `bot_all_data_${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);

      const counts = {
        trades: liveTradesRes.data?.length || 0,
        orders: orderQueueRes.data?.length || 0,
        ticks: priceTicksRes.data?.length || 0,
        fills: fillLogsRes.data?.length || 0,
        settlements: settlementLogsRes.data?.length || 0,
        failures: settlementFailuresRes.data?.length || 0,
        strikes: strikePricesRes.data?.length || 0,
        snapshots: snapshotLogsRes.data?.length || 0,
      };

      const totalRows = allRows.length - 1;
      const sizeEstimate = (csvContent.length / 1024 / 1024).toFixed(1);

      toast.success(`Downloaded ${totalRows.toLocaleString()} rows (~${sizeEstimate}MB)`, {
        description: `Trades: ${counts.trades}, Snapshots: ${counts.snapshots.toLocaleString()}, Ticks: ${counts.ticks.toLocaleString()}`,
      });
    } catch (error) {
      console.error('Download error:', error);
      toast.error('Failed to download logs');
    } finally {
      setIsDownloading(false);
    }
  };

  return (
    <Button
      onClick={downloadAllLogs}
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
      {isDownloading ? 'Downloading...' : 'Download All CSV'}
    </Button>
  );
}
