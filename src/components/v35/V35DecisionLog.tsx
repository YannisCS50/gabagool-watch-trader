import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { 
  Brain, 
  ShieldAlert, 
  TrendingUp, 
  TrendingDown,
  Ban,
  Scale,
  Zap,
  RefreshCw,
  Clock
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { nl } from 'date-fns/locale';

interface DecisionEvent {
  id: string;
  event_type: string;
  asset: string;
  reason_code: string | null;
  data: {
    guardType?: string;
    blockedSide?: string;
    upQty?: number;
    downQty?: number;
    expensiveSide?: string;
    reason?: string;
    side?: string;
    price?: number;
    size?: number;
    imbalance?: number;
    budget?: number;
    existingOpen?: number;
    marketSlug?: string;
    [key: string]: unknown;
  } | null;
  ts: number;
  created_at: string;
  market_id: string | null;
}

const GUARD_ICONS: Record<string, React.ReactNode> = {
  'CHEAP_SIDE_SKIP': <Ban className="h-4 w-4 text-yellow-500" />,
  'BURST_CAP': <ShieldAlert className="h-4 w-4 text-orange-500" />,
  'EMERGENCY_STOP': <ShieldAlert className="h-4 w-4 text-destructive" />,
  'EXPENSIVE_BIAS': <Scale className="h-4 w-4 text-blue-500" />,
  'BALANCE_GUARD': <Scale className="h-4 w-4 text-purple-500" />,
  'GAP_GUARD': <ShieldAlert className="h-4 w-4 text-red-500" />,
};

const GUARD_COLORS: Record<string, string> = {
  'CHEAP_SIDE_SKIP': 'bg-yellow-500/10 text-yellow-600 border-yellow-500/30',
  'BURST_CAP': 'bg-orange-500/10 text-orange-600 border-orange-500/30',
  'EMERGENCY_STOP': 'bg-destructive/10 text-destructive border-destructive/30',
  'EXPENSIVE_BIAS': 'bg-blue-500/10 text-blue-600 border-blue-500/30',
  'BALANCE_GUARD': 'bg-purple-500/10 text-purple-600 border-purple-500/30',
  'GAP_GUARD': 'bg-red-500/10 text-red-600 border-red-500/30',
};

export function V35DecisionLog() {
  const queryClient = useQueryClient();
  const [isLive, setIsLive] = useState(true);

  // Fetch recent decision events
  const { data: events, isLoading } = useQuery({
    queryKey: ['v35-decision-events'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('bot_events')
        .select('*')
        .in('event_type', ['guard', 'quote', 'fill', 'hedge', 'decision', 'skip', 'rebalance'])
        .order('ts', { ascending: false })
        .limit(50);

      if (error) throw error;
      return (data || []) as DecisionEvent[];
    },
    refetchInterval: isLive ? 2000 : false,
  });

  // Subscribe to realtime updates
  useEffect(() => {
    if (!isLive) return;

    const channel = supabase
      .channel('v35-decisions-realtime')
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'bot_events',
        },
        () => {
          queryClient.invalidateQueries({ queryKey: ['v35-decision-events'] });
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [queryClient, isLive]);

  const getEventIcon = (event: DecisionEvent) => {
    const guardType = event.data?.guardType;
    if (guardType && GUARD_ICONS[guardType]) {
      return GUARD_ICONS[guardType];
    }

    switch (event.event_type) {
      case 'fill':
        return <Zap className="h-4 w-4 text-primary" />;
      case 'quote':
        return <TrendingUp className="h-4 w-4 text-muted-foreground" />;
      case 'hedge':
        return <Scale className="h-4 w-4 text-primary" />;
      case 'rebalance':
        return <RefreshCw className="h-4 w-4 text-blue-500" />;
      default:
        return <Brain className="h-4 w-4 text-muted-foreground" />;
    }
  };

  const getEventBadge = (event: DecisionEvent) => {
    const guardType = event.data?.guardType;
    if (guardType && GUARD_COLORS[guardType]) {
      return (
        <Badge variant="outline" className={GUARD_COLORS[guardType]}>
          {guardType}
        </Badge>
      );
    }

    return (
      <Badge variant="outline" className="text-muted-foreground">
        {event.event_type.toUpperCase()}
      </Badge>
    );
  };

  const formatEventMessage = (event: DecisionEvent): string => {
    const data = event.data || {};
    const guardType = data.guardType;

    // Guard events
    if (guardType === 'CHEAP_SIDE_SKIP') {
      return `${data.blockedSide} is cheap (${data.expensiveSide} is expensive). Skip om verlies te voorkomen.`;
    }
    if (guardType === 'BURST_CAP') {
      return `${data.blockedSide} budget op (${data.budget?.toFixed?.(0) || 0} < min). Wacht op fills.`;
    }
    if (guardType === 'EMERGENCY_STOP') {
      return `🚨 EMERGENCY: ${data.imbalance?.toFixed?.(0) || 0} shares imbalance. Alleen hedge toegestaan.`;
    }
    if (guardType === 'EXPENSIVE_BIAS') {
      return `${data.blockedSide} cheap-side limiet bereikt. Wacht tot expensive side groeit.`;
    }
    if (guardType === 'BALANCE_GUARD' || guardType === 'GAP_GUARD') {
      return data.reason || `Guard triggered: ${guardType}`;
    }

    // Other events
    if (event.event_type === 'fill') {
      const side = data.side || '?';
      const price = data.price?.toFixed?.(2) || '?';
      const size = data.size?.toFixed?.(0) || '?';
      return `${side} filled: ${size} @ $${price}`;
    }
    if (event.event_type === 'hedge') {
      return data.reason || 'Hedge attempt';
    }
    if (event.event_type === 'rebalance') {
      return data.reason || 'Rebalance triggered';
    }

    // Fallback
    return event.reason_code || data.reason || event.event_type;
  };

  const getPositionSummary = (event: DecisionEvent): string | null => {
    const data = event.data || {};
    if (data.upQty !== undefined && data.downQty !== undefined) {
      const upQty = Number(data.upQty) || 0;
      const downQty = Number(data.downQty) || 0;
      const diff = Math.abs(upQty - downQty);
      const leading = upQty > downQty ? 'UP' : 'DOWN';
      return `UP: ${upQty.toFixed(0)} | DOWN: ${downQty.toFixed(0)} (${leading} +${diff.toFixed(0)})`;
    }
    return null;
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Brain className="h-5 w-5 text-primary" />
              Realtime Decision Log
            </CardTitle>
            <CardDescription>
              Waarom koopt/skipt de bot shares
            </CardDescription>
          </div>
          <Badge
            variant={isLive ? "default" : "secondary"}
            className="cursor-pointer"
            onClick={() => setIsLive(!isLive)}
          >
            {isLive ? (
              <>
                <span className="w-2 h-2 bg-green-400 rounded-full mr-2 animate-pulse" />
                LIVE
              </>
            ) : (
              'PAUSED'
            )}
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        <ScrollArea className="h-[400px] pr-4">
          {isLoading ? (
            <div className="flex items-center justify-center h-32 text-muted-foreground">
              <RefreshCw className="h-5 w-5 animate-spin mr-2" />
              Laden...
            </div>
          ) : events && events.length > 0 ? (
            <div className="space-y-3">
              {events.map((event) => (
                <div
                  key={event.id}
                  className="flex items-start gap-3 p-3 rounded-lg border border-border/50 bg-muted/30 hover:bg-muted/50 transition-colors"
                >
                  <div className="mt-0.5">
                    {getEventIcon(event)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      {getEventBadge(event)}
                      <Badge variant="outline" className="text-xs">
                        {event.asset}
                      </Badge>
                      {event.data?.blockedSide && (
                        <Badge 
                          variant="outline" 
                          className={event.data.blockedSide === 'UP' 
                            ? 'bg-green-500/10 text-green-600 border-green-500/30' 
                            : 'bg-red-500/10 text-red-600 border-red-500/30'
                          }
                        >
                          {event.data.blockedSide === 'UP' ? (
                            <TrendingUp className="h-3 w-3 mr-1" />
                          ) : (
                            <TrendingDown className="h-3 w-3 mr-1" />
                          )}
                          {event.data.blockedSide}
                        </Badge>
                      )}
                    </div>
                    <p className="text-sm text-foreground">
                      {formatEventMessage(event)}
                    </p>
                    {getPositionSummary(event) && (
                      <p className="text-xs text-muted-foreground mt-1 font-mono">
                        📊 {getPositionSummary(event)}
                      </p>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground whitespace-nowrap flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    {formatDistanceToNow(new Date(event.created_at), { 
                      addSuffix: true,
                      locale: nl 
                    })}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center h-32 text-muted-foreground">
              <Brain className="h-8 w-8 mb-2 opacity-50" />
              <p>Geen recente beslissingen</p>
              <p className="text-xs">Events verschijnen hier als de bot actief is</p>
            </div>
          )}
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
