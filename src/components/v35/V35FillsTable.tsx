import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ArrowDownRight, ArrowUpRight, Zap } from 'lucide-react';
import { format } from 'date-fns';

interface V35Fill {
  id: string;
  created_at: string;
  asset: string;
  market_slug: string;
  side: string;
  fill_type: string;
  price: number;
  size: number;
  order_id: string | null;
  fill_key?: string;
}

export function V35FillsTable() {
  const { data: fills } = useQuery({
    queryKey: ['v35-fills'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('v35_fills')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(100); // Fetch more, then dedup

      if (error) {
        console.error('[V35FillsTable] Error:', error);
        return [];
      }
      
      // Deduplicate by fill_key in UI (paranoid safety)
      const seen = new Set<string>();
      const deduped: V35Fill[] = [];
      for (const f of (data as V35Fill[])) {
        const key = f.fill_key || `${f.order_id}|${f.side}|${f.price}|${f.size}`;
        if (!seen.has(key)) {
          seen.add(key);
          deduped.push(f);
        }
      }
      return deduped.slice(0, 50); // Return first 50 unique
    },
    refetchInterval: 10000,
  });

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-lg flex items-center gap-2">
          <Zap className="h-5 w-5" />
          Recent Fills
        </CardTitle>
        <CardDescription>
          Latest 50 order executions
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        <ScrollArea className="h-[300px]">
          <div className="p-3 space-y-2">
            {!fills || fills.length === 0 ? (
              <div className="text-center text-muted-foreground py-8 text-sm">
                No fills recorded yet
              </div>
            ) : (
              fills.map((fill) => (
                <div
                  key={fill.id}
                  className="flex items-center justify-between py-2 px-2 border-b border-border/50 last:border-0 hover:bg-muted/30 rounded"
                >
                  <div className="flex items-center gap-3">
                    {fill.side === 'BUY' ? (
                      <ArrowDownRight className="h-4 w-4 text-primary" />
                    ) : (
                      <ArrowUpRight className="h-4 w-4 text-destructive" />
                    )}
                    <div>
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className="text-xs">{fill.asset}</Badge>
                        <Badge 
                          variant={fill.side === 'BUY' ? 'default' : 'secondary'}
                          className="text-xs"
                        >
                          {fill.side}
                        </Badge>
                        <Badge variant="outline" className="text-xs">
                          {fill.fill_type}
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {format(new Date(fill.created_at), 'HH:mm:ss')} • {fill.market_slug}
                      </p>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-medium">
                      {fill.size} @ ${fill.price.toFixed(2)}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      ${(fill.size * fill.price).toFixed(2)}
                    </p>
                  </div>
                </div>
              ))
            )}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
