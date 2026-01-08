import { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { supabase } from '@/integrations/supabase/client';
import { ChevronLeft, ChevronRight, ExternalLink, Loader2, CheckCircle2, XCircle, ArrowUp, ArrowDown } from 'lucide-react';
import { format } from 'date-fns';
import { toZonedTime } from 'date-fns-tz';

interface UnsettledTrade {
  id: string;
  asset: string;
  market_slug: string;
  side: string;
  filled_shares: number;
  avg_fill_price: number;
  event_start_time: string;
  event_end_time: string;
  created_at: string;
}

interface V26OracleSettleModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSettled?: () => void;
}

export function V26OracleSettleModal({ open, onOpenChange, onSettled }: V26OracleSettleModalProps) {
  const [trades, setTrades] = useState<UnsettledTrade[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [settling, setSettling] = useState(false);

  const fetchUnsettledTrades = async () => {
    setLoading(true);
    
    // Only show trades older than 45 minutes
    const cutoffTime = new Date(Date.now() - 45 * 60 * 1000).toISOString();
    
    const { data, error } = await supabase
      .from('v26_trades')
      .select('id, asset, market_slug, side, filled_shares, avg_fill_price, event_start_time, event_end_time, created_at')
      .eq('status', 'filled')
      .is('result', null)
      .lt('event_end_time', cutoffTime)
      .order('event_end_time', { ascending: true });

    if (!error && data) {
      setTrades(data);
      setCurrentIndex(0);
    }
    setLoading(false);
  };

  useEffect(() => {
    if (open) {
      fetchUnsettledTrades();
    }
  }, [open]);

  const currentTrade = trades[currentIndex];

  const settleTrade = async (winningOutcome: 'UP' | 'DOWN') => {
    if (!currentTrade) return;
    
    setSettling(true);
    
    const didWin = currentTrade.side === winningOutcome;
    const shares = currentTrade.filled_shares;
    const cost = shares * currentTrade.avg_fill_price;
    const payout = didWin ? shares : 0;
    const pnl = payout - cost;

    const { error } = await supabase
      .from('v26_trades')
      .update({
        result: winningOutcome,
        pnl: pnl,
        settled_at: new Date().toISOString(),
      })
      .eq('id', currentTrade.id);

    setSettling(false);

    if (!error) {
      // Remove from list and go to next
      const newTrades = trades.filter((_, i) => i !== currentIndex);
      setTrades(newTrades);
      
      // Adjust index if we're at the end
      if (currentIndex >= newTrades.length && newTrades.length > 0) {
        setCurrentIndex(newTrades.length - 1);
      }
      
      onSettled?.();
    }
  };

  const formatEventTime = (isoString: string) => {
    const date = toZonedTime(new Date(isoString), 'America/New_York');
    return format(date, 'MMM d, h:mm a') + ' ET';
  };

  const getPolymarketLink = (trade: UnsettledTrade) => {
    const timestamp = Math.floor(new Date(trade.event_start_time).getTime() / 1000);
    return `https://polymarket.com/event/${trade.asset.toLowerCase()}-updown-15m-${timestamp}`;
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            🎯 Oracle Settlement
            {trades.length > 0 && (
              <Badge variant="outline" className="ml-2">
                {trades.length} unsettled
              </Badge>
            )}
          </DialogTitle>
          <DialogDescription>
            Vul handmatig de uitkomst in voor trades die nog niet gesettled zijn.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : trades.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            <CheckCircle2 className="h-12 w-12 mx-auto mb-3 text-green-500 opacity-50" />
            <p>Alle trades zijn al gesettled! 🎉</p>
          </div>
        ) : currentTrade ? (
          <div className="space-y-4">
            {/* Navigation */}
            <div className="flex items-center justify-between">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setCurrentIndex(i => Math.max(0, i - 1))}
                disabled={currentIndex === 0 || settling}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <span className="text-sm text-muted-foreground">
                {currentIndex + 1} / {trades.length}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setCurrentIndex(i => Math.min(trades.length - 1, i + 1))}
                disabled={currentIndex === trades.length - 1 || settling}
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>

            {/* Trade Info Card */}
            <Card>
              <CardContent className="pt-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-lg">{currentTrade.asset}</span>
                    <Badge 
                      variant="outline" 
                      className={currentTrade.side === 'DOWN' ? 'text-red-500 border-red-500/30' : 'text-green-500 border-green-500/30'}
                    >
                      {currentTrade.side === 'DOWN' ? <ArrowDown className="h-3 w-3 mr-1" /> : <ArrowUp className="h-3 w-3 mr-1" />}
                      {currentTrade.side}
                    </Badge>
                  </div>
                  <a
                    href={getPolymarketLink(currentTrade)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <ExternalLink className="h-4 w-4" />
                  </a>
                </div>

                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div>
                    <span className="text-muted-foreground">Window</span>
                    <div className="font-mono">{formatEventTime(currentTrade.event_start_time)}</div>
                    <div className="font-mono text-xs text-muted-foreground">to {formatEventTime(currentTrade.event_end_time)}</div>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Position</span>
                    <div className="font-mono">{currentTrade.filled_shares} @ ${currentTrade.avg_fill_price.toFixed(2)}</div>
                    <div className="font-mono text-xs text-muted-foreground">
                      Cost: ${(currentTrade.filled_shares * currentTrade.avg_fill_price).toFixed(2)}
                    </div>
                  </div>
                </div>

                <div className="pt-2 border-t border-border/50">
                  <div className="text-sm text-muted-foreground mb-2">Welke kant won?</div>
                  <p className="text-xs text-muted-foreground mb-3">
                    Klik op de knop om aan te geven of de prijs hoger (UP) of lager (DOWN) sloot dan de strike.
                  </p>
                </div>
              </CardContent>
            </Card>

            {/* Settlement Buttons */}
            <div className="grid grid-cols-2 gap-3">
              <Button
                variant="outline"
                size="lg"
                className="h-16 border-green-500/30 hover:bg-green-500/10 hover:border-green-500/50"
                onClick={() => settleTrade('UP')}
                disabled={settling}
              >
                {settling ? (
                  <Loader2 className="h-5 w-5 animate-spin" />
                ) : (
                  <div className="flex flex-col items-center">
                    <ArrowUp className="h-5 w-5 text-green-500 mb-1" />
                    <span className="text-green-500 font-bold">UP won</span>
                    {currentTrade.side === 'UP' && (
                      <span className="text-xs text-green-500/70">+${(currentTrade.filled_shares * (1 - currentTrade.avg_fill_price)).toFixed(2)}</span>
                    )}
                    {currentTrade.side === 'DOWN' && (
                      <span className="text-xs text-red-500/70">-${(currentTrade.filled_shares * currentTrade.avg_fill_price).toFixed(2)}</span>
                    )}
                  </div>
                )}
              </Button>

              <Button
                variant="outline"
                size="lg"
                className="h-16 border-red-500/30 hover:bg-red-500/10 hover:border-red-500/50"
                onClick={() => settleTrade('DOWN')}
                disabled={settling}
              >
                {settling ? (
                  <Loader2 className="h-5 w-5 animate-spin" />
                ) : (
                  <div className="flex flex-col items-center">
                    <ArrowDown className="h-5 w-5 text-red-500 mb-1" />
                    <span className="text-red-500 font-bold">DOWN won</span>
                    {currentTrade.side === 'DOWN' && (
                      <span className="text-xs text-green-500/70">+${(currentTrade.filled_shares * (1 - currentTrade.avg_fill_price)).toFixed(2)}</span>
                    )}
                    {currentTrade.side === 'UP' && (
                      <span className="text-xs text-red-500/70">-${(currentTrade.filled_shares * currentTrade.avg_fill_price).toFixed(2)}</span>
                    )}
                  </div>
                )}
              </Button>
            </div>

            {/* Skip button */}
            <Button
              variant="ghost"
              size="sm"
              className="w-full text-muted-foreground"
              onClick={() => setCurrentIndex(i => (i + 1) % trades.length)}
              disabled={trades.length <= 1 || settling}
            >
              Skip naar volgende
            </Button>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
