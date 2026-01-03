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
      // Fetch all log tables in parallel
      const [fillsRes, settlementsRes, snapshotsRes, failuresRes, pricesRes] = await Promise.all([
        supabase.from('fill_logs').select('*').order('ts', { ascending: false }).limit(5000),
        supabase.from('settlement_logs').select('*').order('ts', { ascending: false }).limit(1000),
        supabase.from('snapshot_logs').select('*').order('ts', { ascending: false }).limit(10000),
        supabase.from('settlement_failures').select('*').order('created_at', { ascending: false }).limit(500),
        supabase.from('price_ticks').select('*').order('created_at', { ascending: false }).limit(5000),
      ]);

      // Combine all data into one array with type labels
      const allRows: string[] = [];
      
      // CSV Header
      allRows.push('type,timestamp,market_id,asset,side,outcome,shares,price,intent,pair_cost,delta,spot_price,strike_price,bot_state,winning_side,pnl,lost_side,lost_cost,reason');

      // Fill logs
      (fillsRes.data || []).forEach((row) => {
        allRows.push([
          'FILL',
          row.iso || new Date(row.ts).toISOString(),
          row.market_id || '',
          row.asset || '',
          row.side || '',
          row.side || '',
          row.fill_qty || '',
          row.fill_price || '',
          row.intent || '',
          '', // pair_cost
          row.delta || '',
          row.spot_price || '',
          row.strike_price || '',
          '', // bot_state
          '', // winning_side
          '', // pnl
          '', // lost_side
          '', // lost_cost
          '', // reason
        ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(','));
      });

      // Settlement logs
      (settlementsRes.data || []).forEach((row) => {
        allRows.push([
          'SETTLEMENT',
          row.iso || new Date(row.ts).toISOString(),
          row.market_id || '',
          row.asset || '',
          '', // side
          '', // outcome
          `${row.final_up_shares || 0}/${row.final_down_shares || 0}`,
          '', // price
          '', // intent
          row.pair_cost || '',
          '', // delta
          '', // spot_price
          '', // strike_price
          '', // bot_state
          row.winning_side || '',
          row.realized_pnl || '',
          '', // lost_side
          '', // lost_cost
          '', // reason
        ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(','));
      });

      // Snapshot logs (sample every 10th for size)
      (snapshotsRes.data || []).filter((_, i) => i % 10 === 0).forEach((row) => {
        allRows.push([
          'SNAPSHOT',
          row.iso || new Date(row.ts).toISOString(),
          row.market_id || '',
          row.asset || '',
          '', // side
          '', // outcome
          `${row.up_shares || 0}/${row.down_shares || 0}`,
          row.combined_ask || '',
          '', // intent
          row.pair_cost || '',
          row.delta || '',
          row.spot_price || '',
          row.strike_price || '',
          row.bot_state || '',
          '', // winning_side
          '', // pnl
          '', // lost_side
          '', // lost_cost
          '', // reason
        ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(','));
      });

      // Settlement failures
      (failuresRes.data || []).forEach((row) => {
        allRows.push([
          'FAILURE',
          row.created_at || '',
          row.market_slug || '',
          row.asset || '',
          '', // side
          '', // outcome
          `${row.up_shares || 0}/${row.down_shares || 0}`,
          '', // price
          '', // intent
          '', // pair_cost
          '', // delta
          '', // spot_price
          '', // strike_price
          '', // bot_state
          '', // winning_side
          '', // pnl
          row.lost_side || '',
          row.lost_cost || '',
          row.reason || '',
        ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(','));
      });

      // Price ticks (sample every 60th = ~1 per minute)
      (pricesRes.data || []).filter((_, i) => i % 60 === 0).forEach((row) => {
        allRows.push([
          'PRICE',
          row.created_at || '',
          '', // market_id
          row.asset || '',
          '', // side
          '', // outcome
          '', // shares
          row.price || '',
          '', // intent
          '', // pair_cost
          row.delta_percent || '',
          '', // spot_price
          '', // strike_price
          '', // bot_state
          '', // winning_side
          '', // pnl
          '', // lost_side
          '', // lost_cost
          '', // reason
        ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(','));
      });

      // Create and download CSV
      const csvContent = allRows.join('\n');
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `bot_logs_${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);

      const counts = {
        fills: fillsRes.data?.length || 0,
        settlements: settlementsRes.data?.length || 0,
        snapshots: Math.floor((snapshotsRes.data?.length || 0) / 10),
        failures: failuresRes.data?.length || 0,
        prices: Math.floor((pricesRes.data?.length || 0) / 60),
      };

      toast.success(`Downloaded ${allRows.length - 1} rows`, {
        description: `Fills: ${counts.fills}, Settlements: ${counts.settlements}, Snapshots: ${counts.snapshots}, Failures: ${counts.failures}`,
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
      {isDownloading ? 'Downloading...' : 'Download Logs CSV'}
    </Button>
  );
}
