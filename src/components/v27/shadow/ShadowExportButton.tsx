import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Download, Loader2, ChevronDown, Clock, Calendar } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import type { ShadowPosition, ShadowExecution, ShadowDailyPnL, ShadowAccounting, ShadowHedgeAttempt } from '@/hooks/useShadowPositions';

interface ShadowExportButtonProps {
  positions: ShadowPosition[];
  executions: ShadowExecution[];
  dailyPnl: ShadowDailyPnL[];
  accounting: ShadowAccounting[];
  hedgeAttempts: ShadowHedgeAttempt[];
  evaluations: any[];
  stats: any;
}

type TimeFilter = 
  | { type: 'cycles'; cycles: number }
  | { type: 'hours'; hours: number }
  | { type: 'datetime'; from: string; to: string }
  | { type: 'all' };

const MARKET_CYCLE_MINUTES = 15;

export function ShadowExportButton({
  positions,
  executions,
  dailyPnl,
  accounting,
  hedgeAttempts,
  evaluations,
  stats,
}: ShadowExportButtonProps) {
  const [exporting, setExporting] = useState(false);
  const [dateTimeDialogOpen, setDateTimeDialogOpen] = useState(false);
  
  // DateTime range state - default to today
  const now = new Date();
  const today = now.toLocaleDateString('en-CA'); // YYYY-MM-DD
  const currentTime = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  
  const [fromDate, setFromDate] = useState(today);
  const [fromTime, setFromTime] = useState('00:00');
  const [toDate, setToDate] = useState(today);
  const [toTime, setToTime] = useState(currentTime);

  const filterByTime = <T extends { timestamp?: number; ts?: number; entry_timestamp?: number; date?: string }>(
    data: T[],
    filter: TimeFilter
  ): T[] => {
    if (filter.type === 'all') return data;

    const now = Date.now();
    let cutoffMs: number;

    if (filter.type === 'cycles') {
      // Each cycle is 15 minutes
      cutoffMs = now - filter.cycles * MARKET_CYCLE_MINUTES * 60 * 1000;
    } else if (filter.type === 'hours') {
      cutoffMs = now - filter.hours * 60 * 60 * 1000;
    } else if (filter.type === 'datetime') {
      const fromMs = new Date(filter.from).getTime();
      const toMs = new Date(filter.to).getTime();
      return data.filter((item) => {
        const itemTs = item.timestamp || item.ts || item.entry_timestamp || (item.date ? new Date(item.date).getTime() : 0);
        return itemTs >= fromMs && itemTs <= toMs;
      });
    } else {
      return data;
    }

    return data.filter((item) => {
      const itemTs = item.timestamp || item.ts || item.entry_timestamp || (item.date ? new Date(item.date).getTime() : 0);
      return itemTs >= cutoffMs;
    });
  };

  const getFilterLabel = (filter: TimeFilter): string => {
    if (filter.type === 'cycles') {
      return `${filter.cycles}_cycles_${filter.cycles * 15}min`;
    } else if (filter.type === 'hours') {
      return `${filter.hours}h`;
    } else if (filter.type === 'datetime') {
      const fromPart = filter.from.replace(/[T:]/g, '-').slice(0, 16);
      const toPart = filter.to.replace(/[T:]/g, '-').slice(11, 16);
      return `${fromPart}_to_${toPart}`;
    }
    return 'all';
  };

  const handleExport = async (filter: TimeFilter) => {
    setExporting(true);
    try {
      const filteredPositions = filterByTime(positions, filter);
      const filteredExecutions = filterByTime(executions, filter);
      const filteredDailyPnl = filterByTime(dailyPnl, filter);
      const filteredAccounting = filterByTime(accounting, filter);
      const filteredHedgeAttempts = filterByTime(hedgeAttempts, filter);
      const filteredEvaluations = filterByTime(evaluations, filter);

      const filterLabel = getFilterLabel(filter);

      // Calculate cycles info for metadata
      const cyclesInfo = filter.type === 'cycles' ? {
        cycles: filter.cycles,
        minutes: filter.cycles * MARKET_CYCLE_MINUTES,
        cycleLength: `${MARKET_CYCLE_MINUTES} min`,
      } : null;

      const exportData = {
        metadata: {
          exportedAt: new Date().toISOString(),
          version: 'v27-shadow-lifecycle-1.0',
          description: 'Complete shadow position lifecycle export for backtest replay',
          filter: filter,
          filterLabel,
          cyclesInfo,
          marketCycleDuration: `${MARKET_CYCLE_MINUTES} minutes`,
        },
        config_snapshot: {
          starting_equity: stats.startingEquity,
          default_size_usd: 50,
          maker_fee_rate: 0,
          taker_fee_rate: 0.0015,
          emergency_hedge_threshold_seconds: 30,
          min_spread_for_maker: 0.02,
        },
        summary: {
          ...stats,
          totalPositions: filteredPositions.length,
          totalExecutions: filteredExecutions.length,
          totalDays: filteredDailyPnl.length,
          totalSignals: filteredEvaluations.length,
          dateRange: {
            start: filteredDailyPnl.length > 0 ? filteredDailyPnl[filteredDailyPnl.length - 1].date : null,
            end: filteredDailyPnl.length > 0 ? filteredDailyPnl[0].date : null,
          },
        },
        positions: filteredPositions.map((p) => ({
          id: p.id,
          market_id: p.market_id,
          asset: p.asset,
          side: p.side,
          entry: {
            timestamp: p.entry_timestamp,
            iso: p.entry_iso,
            price: p.entry_price,
            fill_type: p.entry_fill_type,
            spread: p.spread_at_entry,
            best_bid: p.best_bid_at_signal,
            best_ask: p.best_ask_at_signal,
          },
          size: {
            usd: p.size_usd,
            shares: p.size_shares,
          },
          context: {
            signal_id: p.signal_id,
            time_to_expiry: p.time_to_expiry_at_entry,
            spot_price: p.spot_price_at_entry,
            theoretical_price: p.theoretical_price_at_entry,
            delta: p.delta_at_entry,
            mispricing: p.mispricing_at_entry,
          },
          hedge: p.hedge_timestamp ? {
            timestamp: p.hedge_timestamp,
            iso: p.hedge_iso,
            price: p.hedge_price,
            fill_type: p.hedge_fill_type,
            latency_ms: p.hedge_latency_ms,
            spread: p.hedge_spread,
          } : null,
          resolution: {
            type: p.resolution,
            timestamp: p.resolution_timestamp,
            reason: p.resolution_reason,
          },
          pnl: {
            gross: p.gross_pnl,
            fees: p.fees,
            net: p.net_pnl,
            roi_pct: p.roi_pct,
            combined_price_paid: p.combined_price_paid,
          },
        })),
        executions: filteredExecutions.map((e) => ({
          id: e.id,
          position_id: e.position_id,
          type: e.execution_type,
          timestamp: e.timestamp,
          iso: e.iso,
          side: e.side,
          price: e.price,
          shares: e.shares,
          cost_usd: e.cost_usd,
          fill: {
            type: e.fill_type,
            latency_ms: e.fill_latency_assumed_ms,
            confidence: e.fill_confidence,
          },
          orderbook: {
            best_bid: e.best_bid,
            best_ask: e.best_ask,
            spread: e.spread,
          },
          slippage_cents: e.slippage_cents,
          fee_usd: e.fee_usd,
        })),
        hedge_attempts: filteredHedgeAttempts.map((h) => ({
          id: h.id,
          position_id: h.position_id,
          attempt_number: h.attempt_number,
          timestamp: h.timestamp,
          seconds_since_entry: h.seconds_since_entry,
          hedge_side: h.hedge_side,
          target_price: h.target_price,
          actual_price: h.actual_price,
          spread: h.spread_at_attempt,
          success: h.success,
          failure_reason: h.failure_reason,
          is_emergency: h.is_emergency,
          projected_cpp: h.hedge_cpp,
          projected_pnl: h.projected_pnl,
        })),
        daily_pnl: filteredDailyPnl.map((d) => ({
          date: d.date,
          realized_pnl: d.realized_pnl,
          unrealized_pnl: d.unrealized_pnl,
          total_pnl: d.total_pnl,
          cumulative_pnl: d.cumulative_pnl,
          trades: d.trades,
          wins: d.wins,
          losses: d.losses,
          outcomes: {
            paired_hedged: d.paired_hedged,
            expired_one_sided: d.expired_one_sided,
            emergency_exited: d.emergency_exited,
            no_fill: d.no_fill,
          },
          metrics: {
            win_rate: d.win_rate,
            avg_win: d.avg_win,
            avg_loss: d.avg_loss,
            profit_factor: d.profit_factor,
          },
          equity: {
            starting: d.starting_equity,
            ending: d.ending_equity,
            max_drawdown: d.max_drawdown,
          },
          fees: d.total_fees,
        })),
        equity_curve: filteredAccounting.map((a) => ({
          timestamp: a.timestamp,
          iso: a.iso,
          equity: a.equity,
          realized_pnl: a.realized_pnl,
          unrealized_pnl: a.unrealized_pnl,
          fees: a.total_fees,
          open_positions: a.open_positions,
          total_trades: a.total_trades,
          drawdown: {
            usd: a.drawdown_usd,
            pct: a.drawdown_pct,
            max_pct: a.max_drawdown_pct,
          },
          peak_equity: a.peak_equity,
        })),
        signals: filteredEvaluations.slice(0, 2000).map((e) => ({
          id: e.id,
          ts: e.ts,
          market_id: e.market_id,
          asset: e.asset,
          action: e.action,
          signal_valid: e.signal_valid,
          mispricing: {
            magnitude: e.mispricing_magnitude,
            side: e.mispricing_side,
            threshold: e.dynamic_threshold,
          },
          spot_price: e.spot_price,
          adverse: {
            blocked: e.adverse_blocked,
            reason: e.adverse_reason,
          },
          skip_reason: e.skip_reason,
        })),
      };

      const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `shadow-export-${filterLabel}-${new Date().toISOString().split('T')[0]}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Export failed:', err);
    } finally {
      setExporting(false);
      setDateTimeDialogOpen(false);
    }
  };

  const handleDateTimeExport = () => {
    if (fromDate && fromTime && toDate && toTime) {
      handleExport({ 
        type: 'datetime', 
        from: `${fromDate}T${fromTime}:00`, 
        to: `${toDate}T${toTime}:00` 
      });
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" disabled={exporting} className="h-8 gap-1">
          {exporting ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Download className="h-4 w-4" />
          )}
          <span className="hidden sm:inline">Export</span>
          <ChevronDown className="h-3 w-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {/* Market Cycles - 15 min each */}
        <DropdownMenuLabel className="text-xs text-muted-foreground flex items-center gap-1">
          <Clock className="h-3 w-3" />
          Per market cycle (15 min)
        </DropdownMenuLabel>
        <DropdownMenuItem onClick={() => handleExport({ type: 'cycles', cycles: 1 })}>
          1 cycle (15 min)
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => handleExport({ type: 'cycles', cycles: 2 })}>
          2 cycles (30 min)
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => handleExport({ type: 'cycles', cycles: 4 })}>
          4 cycles (1 uur)
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => handleExport({ type: 'cycles', cycles: 8 })}>
          8 cycles (2 uur)
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => handleExport({ type: 'cycles', cycles: 16 })}>
          16 cycles (4 uur)
        </DropdownMenuItem>

        <DropdownMenuSeparator />
        
        {/* Hours */}
        <DropdownMenuLabel className="text-xs text-muted-foreground flex items-center gap-1">
          <Clock className="h-3 w-3" />
          Per uur
        </DropdownMenuLabel>
        <DropdownMenuItem onClick={() => handleExport({ type: 'hours', hours: 1 })}>
          Laatste 1 uur
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => handleExport({ type: 'hours', hours: 3 })}>
          Laatste 3 uur
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => handleExport({ type: 'hours', hours: 6 })}>
          Laatste 6 uur
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => handleExport({ type: 'hours', hours: 12 })}>
          Laatste 12 uur
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => handleExport({ type: 'hours', hours: 24 })}>
          Laatste 24 uur
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        {/* Custom DateTime Range */}
        <Dialog open={dateTimeDialogOpen} onOpenChange={setDateTimeDialogOpen}>
          <DialogTrigger asChild>
            <DropdownMenuItem onSelect={(e) => e.preventDefault()}>
              <Calendar className="h-4 w-4 mr-2" />
              Datum + tijd bereik...
            </DropdownMenuItem>
          </DialogTrigger>
          <DialogContent className="sm:max-w-[400px]">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Calendar className="h-5 w-5" />
                Export datum/tijd bereik
              </DialogTitle>
            </DialogHeader>
            <div className="space-y-4 py-4">
              {/* From */}
              <div className="space-y-2">
                <Label className="text-sm font-medium">Van</Label>
                <div className="grid grid-cols-2 gap-2">
                  <Input
                    type="date"
                    value={fromDate}
                    onChange={(e) => setFromDate(e.target.value)}
                  />
                  <Input
                    type="time"
                    value={fromTime}
                    onChange={(e) => setFromTime(e.target.value)}
                  />
                </div>
              </div>
              
              {/* To */}
              <div className="space-y-2">
                <Label className="text-sm font-medium">Tot</Label>
                <div className="grid grid-cols-2 gap-2">
                  <Input
                    type="date"
                    value={toDate}
                    onChange={(e) => setToDate(e.target.value)}
                  />
                  <Input
                    type="time"
                    value={toTime}
                    onChange={(e) => setToTime(e.target.value)}
                  />
                </div>
              </div>

              {/* Quick presets */}
              <div className="space-y-2">
                <Label className="text-xs text-muted-foreground">Snelle selectie</Label>
                <div className="flex flex-wrap gap-2">
                  <Button 
                    variant="outline" 
                    size="sm"
                    onClick={() => {
                      const now = new Date();
                      setFromDate(now.toLocaleDateString('en-CA'));
                      setFromTime('00:00');
                      setToDate(now.toLocaleDateString('en-CA'));
                      setToTime(now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }));
                    }}
                  >
                    Vandaag
                  </Button>
                  <Button 
                    variant="outline" 
                    size="sm"
                    onClick={() => {
                      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
                      setFromDate(yesterday.toLocaleDateString('en-CA'));
                      setFromTime('00:00');
                      setToDate(yesterday.toLocaleDateString('en-CA'));
                      setToTime('23:59');
                    }}
                  >
                    Gisteren
                  </Button>
                  <Button 
                    variant="outline" 
                    size="sm"
                    onClick={() => {
                      const now = new Date();
                      const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
                      setFromDate(weekAgo.toLocaleDateString('en-CA'));
                      setFromTime('00:00');
                      setToDate(now.toLocaleDateString('en-CA'));
                      setToTime(now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }));
                    }}
                  >
                    Laatste 7 dagen
                  </Button>
                </div>
              </div>

              <Button 
                className="w-full" 
                onClick={handleDateTimeExport}
                disabled={!fromDate || !fromTime || !toDate || !toTime || exporting}
              >
                {exporting ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Exporteren...
                  </>
                ) : (
                  <>
                    <Download className="h-4 w-4 mr-2" />
                    Exporteer bereik
                  </>
                )}
              </Button>
            </div>
          </DialogContent>
        </Dialog>

        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => handleExport({ type: 'all' })}>
          <Download className="h-4 w-4 mr-2" />
          Alles exporteren
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
