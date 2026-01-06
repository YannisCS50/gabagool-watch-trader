import { Card, CardContent } from '@/components/ui/card';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { HelpCircle, TrendingUp, TrendingDown, Target, Percent, DollarSign, Activity, BarChart3, Trophy } from 'lucide-react';
import { HealthMetrics } from '@/lib/botHealthMetrics';

interface BotHealthKeyNumbersProps {
  metrics: HealthMetrics;
}

interface KeyNumber {
  label: string;
  value: string | number;
  tooltip: string;
  isWarning?: boolean;
  isDanger?: boolean;
  isPositive?: boolean;
  icon?: React.ReactNode;
}

export function BotHealthKeyNumbers({ metrics }: BotHealthKeyNumbersProps) {
  const formatPnL = (value: number) => {
    const sign = value >= 0 ? '+' : '';
    return `${sign}$${value.toFixed(2)}`;
  };

  const formatPercent = (value: number) => `${value.toFixed(1)}%`;
  
  const formatProfitFactor = (value: number) => {
    if (value === Infinity) return '∞';
    if (value === 0) return '0.00';
    return value.toFixed(2);
  };

  const keyNumbers: KeyNumber[] = [
    {
      label: 'Total PnL',
      value: formatPnL(metrics.totalPnL),
      tooltip: `Totale winst/verlies berekend uit ${metrics.totalTrades} afgeronde trades.`,
      isWarning: metrics.totalPnL < 0 && metrics.totalPnL >= -100,
      isDanger: metrics.totalPnL < -100,
      isPositive: metrics.totalPnL > 0,
      icon: metrics.totalPnL >= 0 ? <TrendingUp className="w-4 h-4" /> : <TrendingDown className="w-4 h-4" />,
    },
    {
      label: 'Win Rate',
      value: formatPercent(metrics.winRate),
      tooltip: `${metrics.winCount} wins / ${metrics.totalTrades} trades`,
      isWarning: metrics.winRate < 50 && metrics.winRate >= 40,
      isDanger: metrics.winRate < 40,
      isPositive: metrics.winRate >= 55,
      icon: <Trophy className="w-4 h-4" />,
    },
    {
      label: 'Profit Factor',
      value: formatProfitFactor(metrics.profitFactor),
      tooltip: `Winsten / Verliezen ratio. ${formatPnL(metrics.totalWins)} wins vs ${formatPnL(-metrics.totalLosses)} losses`,
      isWarning: metrics.profitFactor < 1.5 && metrics.profitFactor >= 1,
      isDanger: metrics.profitFactor < 1,
      isPositive: metrics.profitFactor >= 2,
      icon: <BarChart3 className="w-4 h-4" />,
    },
    {
      label: 'Avg Win',
      value: formatPnL(metrics.avgWin),
      tooltip: `Gemiddelde winst per winnende trade (${metrics.winCount} trades)`,
      isPositive: metrics.avgWin > 0,
      icon: <TrendingUp className="w-4 h-4" />,
    },
    {
      label: 'Avg Loss',
      value: formatPnL(-metrics.avgLoss),
      tooltip: `Gemiddeld verlies per verliezende trade (${metrics.lossCount} trades)`,
      isDanger: metrics.avgLoss > metrics.avgWin,
      icon: <TrendingDown className="w-4 h-4" />,
    },
    {
      label: 'Total Trades',
      value: metrics.totalTrades,
      tooltip: 'Totaal aantal afgeronde trades in de geselecteerde periode',
      icon: <Activity className="w-4 h-4" />,
    },
    {
      label: 'Max Shares/Side',
      value: metrics.maxSharesPerSide,
      tooltip: 'Maximale shares op één kant (UP of DOWN) binnen één markt. Limiet is 100.',
      isWarning: metrics.maxSharesPerSide > 70 && metrics.maxSharesPerSide <= 100,
      isDanger: metrics.maxSharesPerSide > 100,
      icon: <Target className="w-4 h-4" />,
    },
    {
      label: 'Order Failure %',
      value: formatPercent(metrics.orderFailureRate),
      tooltip: 'Percentage mislukte orders t.o.v. totaal aantal orders.',
      isWarning: metrics.orderFailureRate > 5 && metrics.orderFailureRate <= 15,
      isDanger: metrics.orderFailureRate > 15,
      isPositive: metrics.orderFailureRate < 2,
      icon: <Percent className="w-4 h-4" />,
    },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
      {keyNumbers.map((item, idx) => (
        <Card 
          key={idx} 
          className={`
            transition-all duration-200
            ${item.isDanger ? 'border-red-500/50 bg-red-500/10' : ''}
            ${item.isWarning && !item.isDanger ? 'border-yellow-500/50 bg-yellow-500/10' : ''}
            ${item.isPositive && !item.isWarning && !item.isDanger ? 'border-green-500/30 bg-green-500/5' : ''}
          `}
        >
          <CardContent className="pt-4 pb-4">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <span className={`
                  ${item.isDanger ? 'text-red-400' : ''}
                  ${item.isWarning && !item.isDanger ? 'text-yellow-400' : ''}
                  ${item.isPositive && !item.isWarning && !item.isDanger ? 'text-green-400' : ''}
                  ${!item.isDanger && !item.isWarning && !item.isPositive ? 'text-muted-foreground' : ''}
                `}>
                  {item.icon}
                </span>
                <span className="text-xs text-muted-foreground">{item.label}</span>
              </div>
              <Tooltip>
                <TooltipTrigger>
                  <HelpCircle className="w-3 h-3 text-muted-foreground" />
                </TooltipTrigger>
                <TooltipContent className="max-w-xs">
                  <p className="text-sm">{item.tooltip}</p>
                </TooltipContent>
              </Tooltip>
            </div>
            <p className={`text-2xl font-bold ${
              item.isDanger ? 'text-red-400' : 
              item.isWarning ? 'text-yellow-400' : 
              item.isPositive ? 'text-green-400' : ''
            }`}>
              {item.value}
            </p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
