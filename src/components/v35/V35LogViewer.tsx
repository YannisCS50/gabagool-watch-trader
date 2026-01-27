import { useState, useEffect, useRef } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { supabase } from '@/integrations/supabase/client';
import { Pause, Play, Trash2, Terminal } from 'lucide-react';
import { format } from 'date-fns';

interface LogEntry {
  id: string;
  ts: number;
  created_at: string;
  event_type: string;
  asset: string;
  market_id: string | null;
  reason_code: string | null;
  data: Record<string, unknown> | null;
}

const EVENT_TYPES = ['ALL', 'fill', 'order', 'hedge', 'signal', 'error', 'settlement', 'rebalance'] as const;
const ASSETS = ['ALL', 'BTC', 'ETH', 'SOL', 'XRP'] as const;

const DEFAULT_LIMIT = 300;

function normalizeEvent(row: unknown): LogEntry {
  const r = row as Record<string, unknown>;
  return {
    id: r.id as string,
    ts: typeof r.ts === 'number' ? r.ts : Date.parse(r.created_at as string),
    created_at: r.created_at as string,
    event_type: r.event_type as string,
    asset: r.asset as string,
    market_id: r.market_id as string | null,
    reason_code: r.reason_code as string | null,
    data: r.data && typeof r.data === 'object' ? r.data as Record<string, unknown> : null,
  };
}

export function V35LogViewer() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [isPaused, setIsPaused] = useState(false);
  const [eventFilter, setEventFilter] = useState<string>('ALL');
  const [assetFilter, setAssetFilter] = useState<string>('ALL');
  const scrollRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);

  // Initial fetch from bot_events
  useEffect(() => {
    const fetchLogs = async () => {
      const { data, error } = await supabase
        .from('bot_events')
        .select('*')
        .order('ts', { ascending: false })
        .limit(DEFAULT_LIMIT);

      if (error) {
        console.error('[V35LogViewer] Failed to fetch logs:', error);
        return;
      }

      if (data) {
        setLogs(data.map(normalizeEvent));
      }
    };

    fetchLogs();
  }, []);

  // Realtime subscription
  useEffect(() => {
    if (isPaused) return;

    const channel = supabase
      .channel('v35-events-realtime')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'bot_events' },
        (payload) => {
          const newLog = normalizeEvent(payload.new);
          setLogs((prev) => [newLog, ...prev.slice(0, DEFAULT_LIMIT - 1)]);
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [isPaused]);

  // Auto-scroll to top
  useEffect(() => {
    if (autoScrollRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = 0;
    }
  }, [logs]);

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    autoScrollRef.current = el.scrollTop < 50;
  };

  const clearLogs = () => {
    setLogs([]);
  };

  const filteredLogs = logs.filter(log => {
    if (eventFilter !== 'ALL' && log.event_type !== eventFilter) return false;
    if (assetFilter !== 'ALL' && log.asset !== assetFilter) return false;
    return true;
  });

  const getEventColor = (eventType: string) => {
    switch (eventType) {
      case 'fill': return 'text-cyan-400 bg-cyan-500/20';
      case 'order': return 'text-blue-400 bg-blue-500/20';
      case 'hedge': return 'text-purple-400 bg-purple-500/20';
      case 'signal': return 'text-green-400 bg-green-500/20';
      case 'error': return 'text-red-400 bg-red-500/20';
      case 'settlement': return 'text-amber-400 bg-amber-500/20';
      case 'rebalance': return 'text-orange-400 bg-orange-500/20';
      default: return 'text-muted-foreground bg-muted/20';
    }
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-lg flex items-center gap-2">
            <Terminal className="h-5 w-5" />
            V35 Event Log
            {!isPaused && (
              <Badge variant="outline" className="bg-primary/20 text-primary border-primary/30 text-xs">
                LIVE
              </Badge>
            )}
          </CardTitle>
          
          <div className="flex items-center gap-2 flex-wrap">
            <Select value={eventFilter} onValueChange={setEventFilter}>
              <SelectTrigger className="w-28 h-7 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {EVENT_TYPES.map(t => (
                  <SelectItem key={t} value={t}>{t}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            
            <Select value={assetFilter} onValueChange={setAssetFilter}>
              <SelectTrigger className="w-20 h-7 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ASSETS.map(a => (
                  <SelectItem key={a} value={a}>{a}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => setIsPaused(!isPaused)}
            >
              {isPaused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
            </Button>
            
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={clearLogs}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </CardHeader>
      
      <CardContent className="p-0">
        <ScrollArea 
          className="h-[350px] font-mono text-xs"
          ref={scrollRef as React.RefObject<HTMLDivElement>}
          onScrollCapture={handleScroll}
        >
          <div className="p-2 space-y-0.5">
            {filteredLogs.length === 0 ? (
              <div className="text-center text-muted-foreground py-8">
                No events yet. Start the V35 runner to see activity.
              </div>
            ) : (
              filteredLogs.map((log) => (
                <div 
                  key={log.id} 
                  className="flex items-start gap-2 hover:bg-muted/30 py-0.5 px-1 rounded"
                >
                  <span className="text-muted-foreground shrink-0 w-20">
                    {format(new Date(log.ts), 'HH:mm:ss')}
                  </span>
                  <Badge className={`${getEventColor(log.event_type)} text-[10px] px-1 py-0 shrink-0`}>
                    {log.event_type.toUpperCase()}
                  </Badge>
                  <Badge variant="outline" className="text-[10px] px-1 py-0 shrink-0">
                    {log.asset}
                  </Badge>
                  {log.reason_code && (
                    <span className="text-amber-400 shrink-0">
                      [{log.reason_code}]
                    </span>
                  )}
                  {log.market_id && (
                    <span className="text-muted-foreground truncate max-w-[180px]">
                      {log.market_id.slice(-20)}
                    </span>
                  )}
                  {log.data && Object.keys(log.data).length > 0 && (
                    <span className="text-muted-foreground ml-1 truncate max-w-[250px]">
                      {JSON.stringify(log.data)}
                    </span>
                  )}
                </div>
              ))
            )}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
