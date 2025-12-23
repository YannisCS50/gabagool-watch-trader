import { useState, useEffect, useRef, memo } from 'react';
import { cn } from '@/lib/utils';

interface LivePriceProps {
  price: number;
  previousPrice?: number;
  format?: 'cents' | 'dollars';
  className?: string;
  showFlash?: boolean;
}

export const LivePrice = memo(({ 
  price, 
  previousPrice,
  format = 'cents',
  className,
  showFlash = true
}: LivePriceProps) => {
  const [flash, setFlash] = useState<'up' | 'down' | null>(null);
  const prevPriceRef = useRef(price);

  useEffect(() => {
    if (showFlash && prevPriceRef.current !== price) {
      const direction = price > prevPriceRef.current ? 'up' : 'down';
      setFlash(direction);
      
      const timeout = setTimeout(() => setFlash(null), 300);
      prevPriceRef.current = price;
      
      return () => clearTimeout(timeout);
    }
  }, [price, showFlash]);

  const formattedPrice = format === 'cents' 
    ? `${(price * 100).toFixed(1)}¢`
    : `$${price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  return (
    <span 
      className={cn(
        "font-mono tabular-nums transition-colors duration-150",
        flash === 'up' && "text-emerald-400 bg-emerald-500/20",
        flash === 'down' && "text-red-400 bg-red-500/20",
        className
      )}
    >
      {formattedPrice}
    </span>
  );
});

LivePrice.displayName = 'LivePrice';

interface LiveMarketPricesProps {
  upPrice: number;
  downPrice: number;
  className?: string;
}

export const LiveMarketPrices = memo(({ 
  upPrice, 
  downPrice,
  className 
}: LiveMarketPricesProps) => {
  const combinedPrice = upPrice + downPrice;
  const arbitrageEdge = (1 - combinedPrice) * 100;
  const hasArbitrage = arbitrageEdge > 0;

  return (
    <div className={cn("flex items-center gap-4 text-sm font-mono", className)}>
      <div className="flex items-center gap-1">
        <span className="text-muted-foreground text-xs">UP:</span>
        <LivePrice price={upPrice} className="text-emerald-400 font-medium" />
      </div>
      <div className="flex items-center gap-1">
        <span className="text-muted-foreground text-xs">DOWN:</span>
        <LivePrice price={downPrice} className="text-red-400 font-medium" />
      </div>
      <div className="flex items-center gap-1">
        <span className="text-muted-foreground text-xs">Σ:</span>
        <span className={cn(
          "font-medium",
          hasArbitrage ? "text-emerald-400" : "text-muted-foreground"
        )}>
          {(combinedPrice * 100).toFixed(1)}¢
        </span>
        {hasArbitrage && (
          <span className="text-emerald-400 text-xs">
            (+{arbitrageEdge.toFixed(1)}%)
          </span>
        )}
      </div>
    </div>
  );
});

LiveMarketPrices.displayName = 'LiveMarketPrices';
