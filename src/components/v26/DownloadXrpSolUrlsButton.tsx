import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Download, Loader2 } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

export function DownloadXrpSolUrlsButton() {
  const [isDownloading, setIsDownloading] = useState(false);

  const downloadCsv = async () => {
    setIsDownloading(true);
    try {
      const { data, error } = await supabase
        .from('v26_trades')
        .select('asset, market_slug, side, filled_shares, avg_fill_price, event_start_time, event_end_time, result, pnl')
        .in('asset', ['XRP', 'SOL'])
        .gt('filled_shares', 0)
        .order('asset')
        .order('event_end_time');

      if (error) throw error;

      if (!data || data.length === 0) {
        toast.error('Geen XRP/SOL trades gevonden');
        return;
      }

      // Build CSV
      const headers = ['asset', 'market_slug', 'polymarket_url', 'side', 'filled_shares', 'avg_fill_price', 'event_start_time', 'event_end_time', 'result', 'pnl'];
      const rows = data.map(t => [
        t.asset,
        t.market_slug,
        `https://polymarket.com/event/${t.market_slug}`,
        t.side,
        t.filled_shares,
        t.avg_fill_price,
        t.event_start_time,
        t.event_end_time,
        t.result || '',
        t.pnl ?? ''
      ]);

      const csv = [
        headers.join(','),
        ...rows.map(row => row.map(v => `"${v}"`).join(','))
      ].join('\n');

      // Download
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `xrp-sol-trades-${new Date().toISOString().split('T')[0]}.csv`;
      link.click();
      URL.revokeObjectURL(url);

      toast.success(`${data.length} XRP/SOL trades gedownload`);
    } catch (err) {
      console.error('Download error:', err);
      toast.error('Download mislukt');
    } finally {
      setIsDownloading(false);
    }
  };

  return (
    <Button onClick={downloadCsv} disabled={isDownloading} variant="outline" size="sm">
      {isDownloading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Download className="h-4 w-4 mr-2" />}
      XRP/SOL URLs CSV
    </Button>
  );
}
