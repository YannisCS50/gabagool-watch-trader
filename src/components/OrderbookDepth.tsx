import { cn } from "@/lib/utils";

export type OrderbookLevel = {
  price: number;
  size: number;
};

interface OrderbookDepthProps {
  title: string;
  bids: OrderbookLevel[];
  asks: OrderbookLevel[];
  className?: string;
  maxRows?: number;
}

export function OrderbookDepth({
  title,
  bids,
  asks,
  className,
  maxRows = 12,
}: OrderbookDepthProps) {
  const rows = Math.max(Math.min(maxRows, 50), 1);

  const safeBids = (Array.isArray(bids) ? bids : []).slice(0, rows);
  const safeAsks = (Array.isArray(asks) ? asks : []).slice(0, rows);

  return (
    <section className={cn("rounded-lg border bg-card p-3", className)}>
      <header className="mb-2">
        <h3 className="text-sm font-medium text-foreground">{title}</h3>
        <p className="text-xs text-muted-foreground">Top {rows} levels</p>
      </header>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <div className="flex items-center justify-between text-xs text-muted-foreground mb-1">
            <span>Bid</span>
            <span>Size</span>
          </div>
          <div className="space-y-1">
            {safeBids.length === 0 ? (
              <div className="text-xs text-muted-foreground">No bids</div>
            ) : (
              safeBids.map((l, idx) => (
                <div
                  key={`bid-${idx}-${l.price}`}
                  className="flex items-center justify-between rounded-md bg-muted/40 px-2 py-1 font-mono text-xs"
                >
                  <span className="text-foreground">{(l.price * 100).toFixed(1)}¢</span>
                  <span className="text-muted-foreground">{l.size.toFixed(2)}</span>
                </div>
              ))
            )}
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between text-xs text-muted-foreground mb-1">
            <span>Ask</span>
            <span>Size</span>
          </div>
          <div className="space-y-1">
            {safeAsks.length === 0 ? (
              <div className="text-xs text-muted-foreground">No asks</div>
            ) : (
              safeAsks.map((l, idx) => (
                <div
                  key={`ask-${idx}-${l.price}`}
                  className="flex items-center justify-between rounded-md bg-muted/40 px-2 py-1 font-mono text-xs"
                >
                  <span className="text-foreground">{(l.price * 100).toFixed(1)}¢</span>
                  <span className="text-muted-foreground">{l.size.toFixed(2)}</span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
