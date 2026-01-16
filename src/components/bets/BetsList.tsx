import { useState } from 'react';
import { useBetsHistory, BetSummary } from '@/hooks/useBetsHistory';
import { BetCard } from './BetCard';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';

export function BetsList() {
  const { bets, loading, error } = useBetsHistory();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [assetFilter, setAssetFilter] = useState<string>('all');
  const [search, setSearch] = useState('');

  const assets = [...new Set(bets.map(b => b.asset))];

  const filteredBets = bets.filter(bet => {
    if (assetFilter !== 'all' && bet.asset !== assetFilter) return false;
    if (search && !bet.market_id.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  if (loading) {
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
        Error loading bets: {error}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex gap-4">
        <Input 
          placeholder="Search market ID..." 
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-xs"
        />
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
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-card p-4 rounded-lg border">
          <div className="text-sm text-muted-foreground">Total Bets</div>
          <div className="text-2xl font-bold">{filteredBets.length}</div>
        </div>
        <div className="bg-card p-4 rounded-lg border">
          <div className="text-sm text-muted-foreground">Total Cost</div>
          <div className="text-2xl font-bold">
            ${filteredBets.reduce((sum, b) => sum + b.total_cost, 0).toFixed(2)}
          </div>
        </div>
        <div className="bg-card p-4 rounded-lg border">
          <div className="text-sm text-muted-foreground">Avg Pairing</div>
          <div className="text-2xl font-bold">
            {filteredBets.length > 0
              ? (filteredBets.reduce((sum, b) => {
                  const paired = Math.min(b.up_shares, b.down_shares);
                  const total = b.up_shares + b.down_shares;
                  return sum + (total > 0 ? (paired * 2) / total : 0);
                }, 0) / filteredBets.length * 100).toFixed(0)
              : 0}%
          </div>
        </div>
        <div className="bg-card p-4 rounded-lg border">
          <div className="text-sm text-muted-foreground">Total Fills</div>
          <div className="text-2xl font-bold">
            {filteredBets.reduce((sum, b) => sum + b.fill_count, 0)}
          </div>
        </div>
      </div>

      {/* Bets list */}
      {filteredBets.length === 0 ? (
        <div className="text-center py-8 text-muted-foreground">
          No bets found
        </div>
      ) : (
        <div className="space-y-3">
          {filteredBets.map(bet => (
            <BetCard 
              key={bet.market_id}
              bet={bet}
              expanded={expandedId === bet.market_id}
              onToggle={() => setExpandedId(
                expandedId === bet.market_id ? null : bet.market_id
              )}
            />
          ))}
        </div>
      )}
    </div>
  );
}
