import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Download, Loader2, ChevronDown, Clock, Calendar } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
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
  | { type: 'hours'; hours: number }
  | { type: 'days'; days: number }
  | { type: 'date'; from: string; to: string }
  | { type: 'all' };

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
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [datePopoverOpen, setDatePopoverOpen] = useState(false);

  const filterByTime = <T extends { timestamp?: number; ts?: number; entry_timestamp?: number; date?: string }>(
    data: T[],
    filter: TimeFilter
  ): T[] => {
    if (filter.type === 'all') return data;

    const now = Date.now();
    let cutoffMs: number;

    if (filter.type === 'hours') {
      cutoffMs = now - filter.hours * 60 * 60 * 1000;
    } else if (filter.type === 'days') {
      cutoffMs = now - filter.days * 24 * 60 * 60 * 1000;
    } else if (filter.type === 'date') {
      const fromMs = new Date(filter.from + 'T00:00:00').getTime();
      const toMs = new Date(filter.to + 'T23:59:59').getTime();
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

  const handleExport = async (filter: TimeFilter) => {
    setExporting(true);
    try {
      const filteredPositions = filterByTime(positions, filter);
      const filteredExecutions = filterByTime(executions, filter);
      const filteredDailyPnl = filterByTime(dailyPnl, filter);
      const filteredAccounting = filterByTime(accounting, filter);
      const filteredHedgeAttempts = filterByTime(hedgeAttempts, filter);
      const filteredEvaluations = filterByTime(evaluations, filter);

      const filterLabel = 
        filter.type === 'hours' ? `last_${filter.hours}h` :
        filter.type === 'days' ? `last_${filter.days}d` :
        filter.type === 'date' ? `${filter.from}_to_${filter.to}` :
        'all';

      const exportData = {
        metadata: {
          exportedAt: new Date().toISOString(),
          version: 'v27-shadow-lifecycle-1.0',
          description: 'Complete shadow position lifecycle export for backtest replay',
          filter: filter,
          filterLabel,
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
        signals: filteredEvaluations.slice(0, 1000).map((e) => ({
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
    }
  };

  const handleDateRangeExport = () => {
    if (dateFrom && dateTo) {
      handleExport({ type: 'date', from: dateFrom, to: dateTo });
      setDatePopoverOpen(false);
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
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuLabel className="text-xs text-muted-foreground">Per uur</DropdownMenuLabel>
        <DropdownMenuItem onClick={() => handleExport({ type: 'hours', hours: 1 })}>
          <Clock className="h-4 w-4 mr-2" />
          Laatste 1 uur
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => handleExport({ type: 'hours', hours: 3 })}>
          <Clock className="h-4 w-4 mr-2" />
          Laatste 3 uur
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => handleExport({ type: 'hours', hours: 6 })}>
          <Clock className="h-4 w-4 mr-2" />
          Laatste 6 uur
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => handleExport({ type: 'hours', hours: 9 })}>
          <Clock className="h-4 w-4 mr-2" />
          Laatste 9 uur
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => handleExport({ type: 'hours', hours: 12 })}>
          <Clock className="h-4 w-4 mr-2" />
          Laatste 12 uur
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => handleExport({ type: 'hours', hours: 24 })}>
          <Clock className="h-4 w-4 mr-2" />
          Laatste 24 uur
        </DropdownMenuItem>

        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs text-muted-foreground">Per dag</DropdownMenuLabel>
        <DropdownMenuItem onClick={() => handleExport({ type: 'days', days: 1 })}>
          <Calendar className="h-4 w-4 mr-2" />
          Laatste dag
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => handleExport({ type: 'days', days: 3 })}>
          <Calendar className="h-4 w-4 mr-2" />
          Laatste 3 dagen
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => handleExport({ type: 'days', days: 7 })}>
          <Calendar className="h-4 w-4 mr-2" />
          Laatste 7 dagen
        </DropdownMenuItem>

        <DropdownMenuSeparator />
        <Popover open={datePopoverOpen} onOpenChange={setDatePopoverOpen}>
          <PopoverTrigger asChild>
            <DropdownMenuItem onSelect={(e) => e.preventDefault()}>
              <Calendar className="h-4 w-4 mr-2" />
              Datum bereik...
            </DropdownMenuItem>
          </PopoverTrigger>
          <PopoverContent className="w-64 p-3" align="end">
            <div className="space-y-3">
              <div className="space-y-1">
                <Label htmlFor="dateFrom" className="text-xs">Van</Label>
                <Input
                  id="dateFrom"
                  type="date"
                  value={dateFrom}
                  onChange={(e) => setDateFrom(e.target.value)}
                  className="h-8"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="dateTo" className="text-xs">Tot</Label>
                <Input
                  id="dateTo"
                  type="date"
                  value={dateTo}
                  onChange={(e) => setDateTo(e.target.value)}
                  className="h-8"
                />
              </div>
              <Button 
                size="sm" 
                className="w-full" 
                onClick={handleDateRangeExport}
                disabled={!dateFrom || !dateTo}
              >
                Exporteer bereik
              </Button>
            </div>
          </PopoverContent>
        </Popover>

        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => handleExport({ type: 'all' })}>
          <Download className="h-4 w-4 mr-2" />
          Alles exporteren
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
