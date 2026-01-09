import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useDailyPnl } from '@/hooks/useDailyPnl';
import { Loader2, TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { format, parseISO } from 'date-fns';
import { Badge } from '@/components/ui/badge';

interface DailyPnLTableProps {
  wallet: string;
  limit?: number;
}

export function DailyPnLTable({ wallet, limit = 30 }: DailyPnLTableProps) {
  const { data: dailyData, isLoading, error } = useDailyPnl(wallet, limit);

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">Daily PnL Breakdown</CardTitle>
        </CardHeader>
        <CardContent className="flex items-center justify-center h-[200px]">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  if (error || !dailyData?.length) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">Daily PnL Breakdown</CardTitle>
        </CardHeader>
        <CardContent className="text-center text-muted-foreground py-8">
          {error ? 'Error loading data' : 'No daily data available'}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">Daily PnL Breakdown (Last {limit} Days)</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="max-h-[400px] overflow-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead className="text-right">PnL</TableHead>
                <TableHead className="text-right">Volume</TableHead>
                <TableHead className="text-center">Activity</TableHead>
                <TableHead className="text-right">Markets</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {dailyData.map((day) => {
                const pnl = day.realized_pnl || 0;
                const isPositive = pnl > 0;
                const isNegative = pnl < 0;
                const isZero = pnl === 0;

                return (
                  <TableRow key={day.date}>
                    <TableCell className="font-medium">
                      {format(parseISO(day.date), 'MMM d, yyyy')}
                    </TableCell>
                    <TableCell className="text-right">
                      <span className={`flex items-center justify-end gap-1 font-semibold ${
                        isPositive ? 'text-green-500' : isNegative ? 'text-red-500' : 'text-muted-foreground'
                      }`}>
                        {isPositive && <TrendingUp className="h-3 w-3" />}
                        {isNegative && <TrendingDown className="h-3 w-3" />}
                        {isZero && <Minus className="h-3 w-3" />}
                        ${Math.abs(pnl).toFixed(2)}
                      </span>
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground">
                      ${day.volume_traded?.toFixed(2) || '0.00'}
                    </TableCell>
                    <TableCell className="text-center">
                      <div className="flex items-center justify-center gap-1">
                        {day.buy_count > 0 && (
                          <Badge variant="outline" className="text-xs bg-blue-500/10 text-blue-500 border-blue-500/20">
                            {day.buy_count} buy
                          </Badge>
                        )}
                        {day.sell_count > 0 && (
                          <Badge variant="outline" className="text-xs bg-orange-500/10 text-orange-500 border-orange-500/20">
                            {day.sell_count} sell
                          </Badge>
                        )}
                        {day.redeem_count > 0 && (
                          <Badge variant="outline" className="text-xs bg-green-500/10 text-green-500 border-green-500/20">
                            {day.redeem_count} redeem
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground">
                      {day.markets_active || 0}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}
