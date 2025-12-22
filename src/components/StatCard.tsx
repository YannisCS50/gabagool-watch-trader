import { ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface StatCardProps {
  label: string;
  value: string | number;
  icon?: ReactNode;
  trend?: {
    value: number;
    isPositive: boolean;
  };
  className?: string;
}

export function StatCard({ label, value, icon, trend, className }: StatCardProps) {
  return (
    <div className={cn(
      "glass rounded-lg p-4 animate-fade-in",
      className
    )}>
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs uppercase tracking-wider text-muted-foreground font-medium">
            {label}
          </p>
          <p className="text-2xl font-mono font-semibold mt-1 text-foreground">
            {value}
          </p>
          {trend && (
            <p className={cn(
              "text-xs font-mono mt-1",
              trend.isPositive ? "text-success" : "text-destructive"
            )}>
              {trend.isPositive ? '↑' : '↓'} {Math.abs(trend.value)}%
            </p>
          )}
        </div>
        {icon && (
          <div className="text-muted-foreground">
            {icon}
          </div>
        )}
      </div>
    </div>
  );
}
