import { forwardRef, useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import type { V30Tick } from '@/hooks/useV30Data';
import { formatDistanceToNow } from 'date-fns';

interface Props {
  ticks: V30Tick[];
}

export const V30TradeLog = forwardRef<HTMLDivElement, Props>(({ ticks }, ref) => {
  // Force re-render every 10s for "time ago" updates
  const [, setNow] = useState(Date.now());
  
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 10000);
    return () => clearInterval(interval);
  }, []);

  // Filter to only ticks with actions
  const trades = ticks.filter(t => t.action_taken && t.action_taken !== 'none');

  return (
    <Card ref={ref}>
      <CardHeader>
        <CardTitle className="flex items-center justify-between">
          Trade Log
          <div className="flex items-center gap-2">
            {trades.length > 0 && (
              <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
            )}
            <Badge variant="outline">{trades.length} trades</Badge>
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ScrollArea className="h-64">
          {trades.length === 0 ? (
            <div className="text-center text-muted-foreground py-8">
              No trades yet
            </div>
          ) : (
            <div className="space-y-2">
              {trades.map((trade) => {
                const action = trade.action_taken ?? '';
                const isBuyUp = action.includes('buy_up');
                const isBuyDown = action.includes('buy_down');
                const isForce = action.includes('force');
                const isExit = action.includes('exit');

                return (
                  <div
                    key={trade.id}
                    className="flex items-center justify-between p-2 rounded bg-muted/50"
                  >
                    <div className="flex items-center gap-2">
                      <Badge
                        variant={
                          isExit ? 'secondary' :
                          isForce ? 'outline' :
                          isBuyUp ? 'default' : 'destructive'
                        }
                        className="w-24 justify-center"
                      >
                        {action.replace(/_/g, ' ').toUpperCase()}
                      </Badge>
                      <span className="font-medium">{trade.asset}</span>
                    </div>

                    <div className="flex items-center gap-4 text-sm">
                      {/* Edge info */}
                      <div className="text-muted-foreground">
                        {isBuyUp && trade.edge_up !== null && (
                          <span>Edge: {(trade.edge_up * 100).toFixed(1)}%</span>
                        )}
                        {isBuyDown && trade.edge_down !== null && (
                          <span>Edge: {(trade.edge_down * 100).toFixed(1)}%</span>
                        )}
                      </div>

                      {/* Price info */}
                      <div className="font-mono">
                        {isBuyUp && trade.up_best_ask !== null && (
                          <span>{(trade.up_best_ask * 100).toFixed(1)}¢</span>
                        )}
                        {isBuyDown && trade.down_best_ask !== null && (
                          <span>{(trade.down_best_ask * 100).toFixed(1)}¢</span>
                        )}
                      </div>

                      {/* Time */}
                      <div className="text-xs text-muted-foreground w-20 text-right">
                        {formatDistanceToNow(new Date(trade.ts), { addSuffix: true })}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </ScrollArea>
      </CardContent>
    </Card>
  );
});

V30TradeLog.displayName = 'V30TradeLog';
