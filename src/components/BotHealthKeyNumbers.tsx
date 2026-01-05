import { Card, CardContent } from '@/components/ui/card';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { HelpCircle } from 'lucide-react';
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
}

export function BotHealthKeyNumbers({ metrics }: BotHealthKeyNumbersProps) {
  const keyNumbers: KeyNumber[] = [
    {
      label: 'Total PnL',
      value: `$${metrics.totalPnL.toFixed(2)}`,
      tooltip: 'Totale winst/verlies (realized + unrealized). PnL kan licht afwijken van Polymarket UI.',
      isWarning: metrics.totalPnL < 0 && metrics.totalPnL >= -50,
      isDanger: metrics.totalPnL < -50,
    },
    {
      label: 'Max Shares/Side',
      value: metrics.maxSharesPerSide,
      tooltip: 'Maximale shares op één kant (UP of DOWN) binnen één markt. Limiet is 100.',
      isWarning: metrics.maxSharesPerSide > 70 && metrics.maxSharesPerSide <= 100,
      isDanger: metrics.maxSharesPerSide > 100,
    },
    {
      label: 'Max Total Shares',
      value: metrics.maxTotalSharesPerMarket,
      tooltip: 'Maximale totale shares (UP + DOWN) binnen één markt. Limiet is 200.',
      isWarning: metrics.maxTotalSharesPerMarket > 150 && metrics.maxTotalSharesPerMarket <= 200,
      isDanger: metrics.maxTotalSharesPerMarket > 200,
    },
    {
      label: 'Emergency/uur',
      value: metrics.emergencyEventsPerHour.toFixed(1),
      tooltip: 'Aantal emergency events per uur. Normaal: ≤2/uur.',
      isWarning: metrics.emergencyEventsPerHour > 2 && metrics.emergencyEventsPerHour <= 6,
      isDanger: metrics.emergencyEventsPerHour > 6,
    },
    {
      label: 'Order Failure %',
      value: `${metrics.orderFailureRate.toFixed(1)}%`,
      tooltip: 'Percentage mislukte orders t.o.v. totaal aantal orders.',
      isWarning: metrics.orderFailureRate > 5 && metrics.orderFailureRate <= 15,
      isDanger: metrics.orderFailureRate > 15,
    },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
      {keyNumbers.map((item, idx) => (
        <Card 
          key={idx} 
          className={`
            ${item.isDanger ? 'border-red-500/50 bg-red-500/10' : ''}
            ${item.isWarning && !item.isDanger ? 'border-yellow-500/50 bg-yellow-500/10' : ''}
          `}
        >
          <CardContent className="pt-4 pb-4">
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs text-muted-foreground">{item.label}</span>
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
              item.isWarning ? 'text-yellow-400' : ''
            }`}>
              {item.value}
            </p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
