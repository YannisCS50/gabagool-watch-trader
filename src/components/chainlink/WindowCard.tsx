import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { format } from 'date-fns';
import { WindowSummary } from '@/hooks/useChainlinkWindows';
import { WindowPriceChart } from './WindowPriceChart';
import { TrendingUp, TrendingDown, Activity, Zap } from 'lucide-react';

interface WindowCardProps {
  window: WindowSummary;
  expanded?: boolean;
  onToggle?: () => void;
}

export function WindowCard({ window: w, expanded, onToggle }: WindowCardProps) {
  const isAboveStrike = w.close_price > w.strike_price;
  const isActive = Date.now() < w.window_end;

  return (
    <Card 
      className={`cursor-pointer hover:bg-muted/50 transition-colors ${isActive ? 'border-primary/50' : ''}`}
      onClick={onToggle}
    >
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="font-mono font-bold">
              {w.asset}
            </Badge>
            <span className="text-sm font-medium">
              {format(new Date(w.window_start), 'MMM d, HH:mm')} - {format(new Date(w.window_end), 'HH:mm')}
            </span>
            {isActive && (
              <Badge variant="default" className="animate-pulse">
                LIVE
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Badge variant={isAboveStrike ? 'default' : 'destructive'} className="flex items-center gap-1">
              {isAboveStrike ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
              {w.price_change >= 0 ? '+' : ''}{w.price_change.toFixed(2)} ({w.price_change_pct.toFixed(3)}%)
            </Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 md:grid-cols-6 gap-4 text-sm">
          <div>
            <div className="text-muted-foreground text-xs">Strike</div>
            <div className="font-mono font-medium">
              ${w.strike_price.toLocaleString()}
            </div>
          </div>
          <div>
            <div className="text-muted-foreground text-xs">Open</div>
            <div className="font-mono">
              ${w.open_price.toLocaleString()}
            </div>
          </div>
          <div>
            <div className="text-muted-foreground text-xs">Close</div>
            <div className={`font-mono ${isAboveStrike ? 'text-green-500' : 'text-red-500'}`}>
              ${w.close_price.toLocaleString()}
            </div>
          </div>
          <div>
            <div className="text-muted-foreground text-xs">Range</div>
            <div className="font-mono text-xs">
              ${w.low_price.toLocaleString()} - ${w.high_price.toLocaleString()}
            </div>
          </div>
          <div>
            <div className="text-muted-foreground text-xs flex items-center gap-1">
              <Activity className="h-3 w-3" /> Ticks
            </div>
            <div className="font-mono">{w.tick_count}</div>
          </div>
          <div>
            <div className="text-muted-foreground text-xs flex items-center gap-1">
              <Zap className="h-3 w-3" /> Signals
            </div>
            <div className="font-mono">
              <span className="text-green-500">{w.signals_up}↑</span>
              {' / '}
              <span className="text-red-500">{w.signals_down}↓</span>
            </div>
          </div>
        </div>

        {expanded && (
          <div className="mt-4 pt-4 border-t">
            <WindowPriceChart 
              marketSlug={w.market_slug}
              strikePrice={w.strike_price}
              windowStart={w.window_start}
              windowEnd={w.window_end}
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
