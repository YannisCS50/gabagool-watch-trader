import { useState } from 'react';
import { useChainlinkWindows } from '@/hooks/useChainlinkWindows';
import { WindowCard } from './WindowCard';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { TrendingUp, TrendingDown, Activity, Clock } from 'lucide-react';

export function WindowsList() {
  const [assetFilter, setAssetFilter] = useState<string>('all');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  
  const { data: windows, isLoading, error } = useChainlinkWindows(assetFilter);

  const assets = windows ? [...new Set(windows.map(w => w.asset))] : [];

  // Stats
  const totalTicks = windows?.reduce((sum, w) => sum + w.tick_count, 0) || 0;
  const totalWindows = windows?.length || 0;
  const upWins = windows?.filter(w => w.close_price > w.strike_price).length || 0;
  const downWins = totalWindows - upWins;
  const activeWindows = windows?.filter(w => Date.now() < w.window_end).length || 0;

  if (isLoading) {
    return (
      <div className="space-y-4">
        {[1, 2, 3].map(i => (
          <Skeleton key={i} className="h-32 w-full" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 bg-destructive/20 text-destructive rounded-lg">
        Error loading windows: {(error as Error).message}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Filter */}
      <div className="flex gap-4">
        <Select value={assetFilter} onValueChange={setAssetFilter}>
          <SelectTrigger className="w-32">
            <SelectValue placeholder="Asset" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Assets</SelectItem>
            {assets.map(asset => (
              <SelectItem key={asset} value={asset}>{asset}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <div className="bg-card p-4 rounded-lg border">
          <div className="text-sm text-muted-foreground flex items-center gap-1">
            <Clock className="h-4 w-4" /> Windows
          </div>
          <div className="text-2xl font-bold">{totalWindows}</div>
          {activeWindows > 0 && (
            <div className="text-xs text-primary">{activeWindows} live</div>
          )}
        </div>
        <div className="bg-card p-4 rounded-lg border">
          <div className="text-sm text-muted-foreground flex items-center gap-1">
            <Activity className="h-4 w-4" /> Total Ticks
          </div>
          <div className="text-2xl font-bold">{totalTicks.toLocaleString()}</div>
        </div>
        <div className="bg-card p-4 rounded-lg border">
          <div className="text-sm text-muted-foreground flex items-center gap-1">
            <TrendingUp className="h-4 w-4" /> Up Outcomes
          </div>
          <div className="text-2xl font-bold text-green-500">{upWins}</div>
          <div className="text-xs text-muted-foreground">
            {totalWindows > 0 ? ((upWins / totalWindows) * 100).toFixed(0) : 0}%
          </div>
        </div>
        <div className="bg-card p-4 rounded-lg border">
          <div className="text-sm text-muted-foreground flex items-center gap-1">
            <TrendingDown className="h-4 w-4" /> Down Outcomes
          </div>
          <div className="text-2xl font-bold text-red-500">{downWins}</div>
          <div className="text-xs text-muted-foreground">
            {totalWindows > 0 ? ((downWins / totalWindows) * 100).toFixed(0) : 0}%
          </div>
        </div>
        <div className="bg-card p-4 rounded-lg border">
          <div className="text-sm text-muted-foreground">Avg Ticks/Window</div>
          <div className="text-2xl font-bold">
            {totalWindows > 0 ? Math.round(totalTicks / totalWindows) : 0}
          </div>
        </div>
      </div>

      {/* Windows list */}
      {!windows || windows.length === 0 ? (
        <div className="text-center py-8 text-muted-foreground">
          No windows found
        </div>
      ) : (
        <div className="space-y-3">
          {windows.map(w => (
            <WindowCard 
              key={w.market_slug}
              window={w}
              expanded={expandedId === w.market_slug}
              onToggle={() => setExpandedId(
                expandedId === w.market_slug ? null : w.market_slug
              )}
            />
          ))}
        </div>
      )}
    </div>
  );
}
