import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { format } from 'date-fns';
import { BetSummary } from '@/hooks/useBetsHistory';
import { BetPriceChart } from './BetPriceChart';

interface BetCardProps {
  bet: BetSummary;
  expanded?: boolean;
  onToggle?: () => void;
}

export function BetCard({ bet, expanded, onToggle }: BetCardProps) {
  const paired = Math.min(bet.up_shares, bet.down_shares);
  const unpaired = Math.abs(bet.up_shares - bet.down_shares);
  const pairedPct = bet.up_shares + bet.down_shares > 0 
    ? (paired * 2) / (bet.up_shares + bet.down_shares) * 100 
    : 0;

  return (
    <Card 
      className="cursor-pointer hover:bg-muted/50 transition-colors"
      onClick={onToggle}
    >
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="font-mono">
              {bet.asset}
            </Badge>
            <CardTitle className="text-sm font-medium">
              {format(new Date(bet.window_start), 'MMM d, HH:mm')} - {format(new Date(bet.window_end), 'HH:mm')}
            </CardTitle>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant={pairedPct >= 80 ? 'default' : pairedPct >= 50 ? 'secondary' : 'destructive'}>
              {pairedPct.toFixed(0)}% paired
            </Badge>
            {bet.result && (
              <Badge variant={bet.result === 'win' ? 'default' : 'destructive'}>
                {bet.result}
              </Badge>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
          <div>
            <div className="text-muted-foreground">Up Shares</div>
            <div className="font-mono text-green-500">
              {bet.up_shares.toFixed(2)}
              {bet.up_avg_price && (
                <span className="text-xs text-muted-foreground ml-1">
                  @{(bet.up_avg_price * 100).toFixed(1)}¢
                </span>
              )}
            </div>
          </div>
          <div>
            <div className="text-muted-foreground">Down Shares</div>
            <div className="font-mono text-red-500">
              {bet.down_shares.toFixed(2)}
              {bet.down_avg_price && (
                <span className="text-xs text-muted-foreground ml-1">
                  @{(bet.down_avg_price * 100).toFixed(1)}¢
                </span>
              )}
            </div>
          </div>
          <div>
            <div className="text-muted-foreground">Strike</div>
            <div className="font-mono">
              {bet.strike_price ? `$${bet.strike_price.toLocaleString()}` : '-'}
            </div>
          </div>
          <div>
            <div className="text-muted-foreground">Cost</div>
            <div className="font-mono">
              ${bet.total_cost.toFixed(2)}
            </div>
          </div>
        </div>

        {expanded && (
          <div className="mt-4 pt-4 border-t">
            <BetPriceChart 
              asset={bet.asset} 
              windowStart={bet.window_start} 
              windowEnd={bet.window_end}
              strikePrice={bet.strike_price}
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
