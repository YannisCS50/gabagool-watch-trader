import { Badge } from '@/components/ui/badge';
import { ShoppingCart, TrendingUp, CheckCircle2, XCircle } from 'lucide-react';

interface MarketLifecycleBadgeProps {
  lifecycleState?: string | null;
  lifecycleBought?: boolean;
  lifecycleSold?: boolean;
  lifecycleClaimed?: boolean;
  lifecycleLost?: boolean;
  size?: 'sm' | 'default';
}

const stateConfig = {
  BOUGHT: {
    label: 'Bought',
    icon: ShoppingCart,
    className: 'bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-900/30 dark:text-blue-400 dark:border-blue-800',
  },
  SOLD: {
    label: 'Sold',
    icon: TrendingUp,
    className: 'bg-purple-100 text-purple-800 border-purple-200 dark:bg-purple-900/30 dark:text-purple-400 dark:border-purple-800',
  },
  CLAIMED: {
    label: 'Claimed',
    icon: CheckCircle2,
    className: 'bg-green-100 text-green-800 border-green-200 dark:bg-green-900/30 dark:text-green-400 dark:border-green-800',
  },
  LOST: {
    label: 'Lost',
    icon: XCircle,
    className: 'bg-red-100 text-red-800 border-red-200 dark:bg-red-900/30 dark:text-red-400 dark:border-red-800',
  },
  UNKNOWN: {
    label: 'Unknown',
    icon: null,
    className: 'bg-muted text-muted-foreground',
  },
};

export function MarketLifecycleBadge({
  lifecycleState,
  lifecycleBought,
  lifecycleSold,
  lifecycleClaimed,
  lifecycleLost,
  size = 'default',
}: MarketLifecycleBadgeProps) {
  // If no explicit state, derive from flags
  let state = lifecycleState?.toUpperCase() || 'UNKNOWN';
  
  if (!lifecycleState) {
    if (lifecycleLost) state = 'LOST';
    else if (lifecycleClaimed) state = 'CLAIMED';
    else if (lifecycleSold) state = 'SOLD';
    else if (lifecycleBought) state = 'BOUGHT';
  }

  const config = stateConfig[state as keyof typeof stateConfig] || stateConfig.UNKNOWN;
  const Icon = config.icon;

  return (
    <Badge 
      variant="outline" 
      className={`${config.className} ${size === 'sm' ? 'text-[10px] px-1.5 py-0' : 'text-xs'}`}
    >
      {Icon && <Icon className={`${size === 'sm' ? 'h-2.5 w-2.5' : 'h-3 w-3'} mr-1`} />}
      {config.label}
    </Badge>
  );
}

/**
 * Show all lifecycle badges as chips (for detailed views)
 */
export function MarketLifecycleChips({
  lifecycleBought,
  lifecycleSold,
  lifecycleClaimed,
  lifecycleLost,
}: Omit<MarketLifecycleBadgeProps, 'lifecycleState' | 'size'>) {
  const badges = [];
  
  if (lifecycleBought) {
    badges.push(
      <Badge key="bought" variant="outline" className="text-[10px] px-1.5 py-0 bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-900/20 dark:text-blue-400 dark:border-blue-800">
        <ShoppingCart className="h-2.5 w-2.5 mr-0.5" />
        B
      </Badge>
    );
  }
  if (lifecycleSold) {
    badges.push(
      <Badge key="sold" variant="outline" className="text-[10px] px-1.5 py-0 bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-900/20 dark:text-purple-400 dark:border-purple-800">
        <TrendingUp className="h-2.5 w-2.5 mr-0.5" />
        S
      </Badge>
    );
  }
  if (lifecycleClaimed) {
    badges.push(
      <Badge key="claimed" variant="outline" className="text-[10px] px-1.5 py-0 bg-green-50 text-green-700 border-green-200 dark:bg-green-900/20 dark:text-green-400 dark:border-green-800">
        <CheckCircle2 className="h-2.5 w-2.5 mr-0.5" />
        C
      </Badge>
    );
  }
  if (lifecycleLost) {
    badges.push(
      <Badge key="lost" variant="outline" className="text-[10px] px-1.5 py-0 bg-red-50 text-red-700 border-red-200 dark:bg-red-900/20 dark:text-red-400 dark:border-red-800">
        <XCircle className="h-2.5 w-2.5 mr-0.5" />
        L
      </Badge>
    );
  }

  return <div className="flex gap-0.5">{badges}</div>;
}
