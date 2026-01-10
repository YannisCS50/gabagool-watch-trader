import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Download, Loader2 } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

interface SnapshotRow {
  created_at: string;
  asset: string;
  market_id: string;
  strike_price: number | null;
  spot_price: number | null;
  up_ask: number | null;
  up_bid: number | null;
  down_ask: number | null;
  down_bid: number | null;
  combined_ask: number | null;
  combined_mid: number | null;
  bot_state: string | null;
}

interface PriceTickRow {
  created_at: string;
  asset: string;
  price: number;
}

export function DownloadTodayTicksButton() {
  const [isDownloading, setIsDownloading] = useState(false);

  const fetchAllSnapshots = async (fromDate: string): Promise<SnapshotRow[]> => {
    const pageSize = 1000;
    let allData: SnapshotRow[] = [];
    let offset = 0;
    let hasMore = true;

    while (hasMore) {
      const { data, error } = await supabase
        .from('snapshot_logs')
        .select('created_at,asset,market_id,strike_price,spot_price,up_ask,up_bid,down_ask,down_bid,combined_ask,combined_mid,bot_state')
        .gte('created_at', fromDate)
        .order('created_at', { ascending: true })
        .range(offset, offset + pageSize - 1);

      if (error) throw error;
      
      if (data && data.length > 0) {
        allData = [...allData, ...data];
        offset += pageSize;
        hasMore = data.length === pageSize;
      } else {
        hasMore = false;
      }
    }

    return allData;
  };

  const fetchAllPriceTicks = async (fromDate: string): Promise<PriceTickRow[]> => {
    const pageSize = 1000;
    let allData: PriceTickRow[] = [];
    let offset = 0;
    let hasMore = true;

    while (hasMore) {
      const { data, error } = await supabase
        .from('price_ticks')
        .select('created_at,asset,price')
        .gte('created_at', fromDate)
        .order('created_at', { ascending: true })
        .range(offset, offset + pageSize - 1);

      if (error) throw error;
      
      if (data && data.length > 0) {
        allData = [...allData, ...data];
        offset += pageSize;
        hasMore = data.length === pageSize;
      } else {
        hasMore = false;
      }
    }

    return allData;
  };

  const downloadCsv = async () => {
    setIsDownloading(true);
    try {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const fromDate = today.toISOString();

      toast.info('Fetching snapshots...');
      
      // Fetch snapshots
      const snapshots = await fetchAllSnapshots(fromDate);

      toast.info(`Got ${snapshots.length} snapshots, fetching price ticks...`);

      // Fetch price ticks
      const priceTicks = await fetchAllPriceTicks(fromDate);

      toast.info(`Got ${priceTicks.length} price ticks, generating CSV...`);

      // Create a map of price ticks by timestamp (rounded to second) and asset
      const priceMap = new Map<string, { btc: number | null; eth: number | null }>();
      for (const tick of priceTicks) {
        const ts = tick.created_at.substring(0, 19); // Round to second
        if (!priceMap.has(ts)) {
          priceMap.set(ts, { btc: null, eth: null });
        }
        const entry = priceMap.get(ts)!;
        if (tick.asset === 'BTC') entry.btc = tick.price;
        if (tick.asset === 'ETH') entry.eth = tick.price;
      }

      // Build CSV
      const headers = [
        'timestamp',
        'asset',
        'market_id',
        'bot_state',
        'strike_price',
        'spot_price',
        'up_bid',
        'up_ask',
        'down_bid',
        'down_ask',
        'combined_ask',
        'combined_mid',
        'arb_edge',
        'btc_tick',
        'eth_tick'
      ];

      const rows = snapshots.map((s) => {
        const ts = s.created_at.substring(0, 19);
        const prices = priceMap.get(ts) || { btc: null, eth: null };
        const arbEdge = s.combined_ask !== null && s.combined_ask < 1 
          ? (1 - s.combined_ask).toFixed(4) 
          : '';

        return [
          s.created_at,
          s.asset,
          s.market_id,
          s.bot_state || '',
          s.strike_price?.toFixed(2) || '',
          s.spot_price?.toFixed(2) || '',
          s.up_bid?.toFixed(4) || '',
          s.up_ask?.toFixed(4) || '',
          s.down_bid?.toFixed(4) || '',
          s.down_ask?.toFixed(4) || '',
          s.combined_ask?.toFixed(4) || '',
          s.combined_mid?.toFixed(4) || '',
          arbEdge,
          prices.btc?.toFixed(2) || '',
          prices.eth?.toFixed(2) || ''
        ].join(',');
      });

      const csv = [headers.join(','), ...rows].join('\n');

      // Download
      const blob = new Blob([csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `v26-ticks-${today.toISOString().split('T')[0]}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      toast.success(`Downloaded ${snapshots.length} snapshots + ${priceTicks.length} price ticks`);
    } catch (error) {
      console.error('Download failed:', error);
      toast.error('Download failed');
    } finally {
      setIsDownloading(false);
    }
  };

  return (
    <Button 
      onClick={downloadCsv} 
      disabled={isDownloading}
      variant="outline"
      size="sm"
    >
      {isDownloading ? (
        <Loader2 className="h-4 w-4 animate-spin mr-2" />
      ) : (
        <Download className="h-4 w-4 mr-2" />
      )}
      Today's Ticks
    </Button>
  );
}
