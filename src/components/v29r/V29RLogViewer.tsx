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
  created_at: string;
  run_id: string | null;
  level: string;
  category: string;
  asset: string | null;
  message: string;
  data: Record<string, unknown> | null;
}

const CATEGORIES = ['ALL', 'system', 'BTC', 'ETH', 'SOL', 'XRP'] as const;
const LEVELS = ['ALL', 'debug', 'info', 'warn', 'error'] as const;
const DEFAULT_LIMIT = 500;

export function V29RLogViewer() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [isPaused, setIsPaused] = useState(false);
  const [categoryFilter, setCategoryFilter] = useState<string>('ALL');
  const [levelFilter, setLevelFilter] = useState<string>('ALL');
  const scrollRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);

  // Initial fetch
  useEffect(() => {
    const fetchLogs = async () => {
      const { data, error } = await supabase
        .from('v29_logs_response')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(DEFAULT_LIMIT);

      if (error) {
        console.error('[V29RLogViewer] Failed to fetch logs:', error);
        return;
      }

      if (data) {
        setLogs(data as LogEntry[]);
      }
    };

    fetchLogs();
  }, []);

  // Realtime subscription
  useEffect(() => {
    if (isPaused) return;

    const channel = supabase
      .channel('v29r-logs-realtime')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'v29_logs_response' },
        (payload) => {
          const newLog = payload.new as LogEntry;
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

  const clearLogs = () => setLogs([]);

  const filteredLogs = logs.filter(log => {
    if (categoryFilter !== 'ALL' && log.category !== categoryFilter) return false;
    if (levelFilter !== 'ALL' && log.level !== levelFilter) return false;
    return true;
  });

  const getLevelColor = (level: string) => {
    switch (level) {
      case 'error': return 'text-red-400 bg-red-500/20';
      case 'warn': return 'text-yellow-400 bg-yellow-500/20';
      case 'info': return 'text-blue-400 bg-blue-500/20';
      case 'debug': return 'text-gray-400 bg-gray-500/20';
      default: return 'text-gray-400';
    }
  };

  const getCategoryColor = (category: string) => {
    switch (category) {
      case 'BTC': return 'text-orange-400';
      case 'ETH': return 'text-purple-400';
      case 'SOL': return 'text-green-400';
      case 'XRP': return 'text-blue-400';
      case 'system': return 'text-gray-400';
      default: return 'text-muted-foreground';
    }
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-lg flex items-center gap-2">
            <Terminal className="h-5 w-5" />
            Runner Logs
            {!isPaused && (
              <Badge variant="outline" className="bg-green-500/20 text-green-400 border-green-500/30 text-xs">
                LIVE
              </Badge>
            )}
            <span className="text-xs text-muted-foreground font-normal">({filteredLogs.length})</span>
          </CardTitle>
          
          <div className="flex items-center gap-2 flex-wrap">
            <Select value={categoryFilter} onValueChange={setCategoryFilter}>
              <SelectTrigger className="w-24 h-7 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CATEGORIES.map(cat => (
                  <SelectItem key={cat} value={cat}>{cat}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            
            <Select value={levelFilter} onValueChange={setLevelFilter}>
              <SelectTrigger className="w-20 h-7 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LEVELS.map(lvl => (
                  <SelectItem key={lvl} value={lvl}>{lvl}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => setIsPaused(!isPaused)}
              title={isPaused ? 'Resume' : 'Pause'}
            >
              {isPaused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
            </Button>
            
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={clearLogs}
              title="Clear logs"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </CardHeader>
      
      <CardContent className="p-0">
        <ScrollArea 
          className="h-[350px] font-mono text-xs"
          ref={scrollRef as any}
          onScrollCapture={handleScroll}
        >
          <div className="p-2 space-y-0.5">
            {filteredLogs.length === 0 ? (
              <div className="text-center text-muted-foreground py-8">
                No logs yet. Start the V29R runner to see logs.
              </div>
            ) : (
              filteredLogs.map((log) => (
                <div 
                  key={log.id} 
                  className="flex items-start gap-2 hover:bg-muted/30 py-0.5 px-1 rounded"
                >
                  <span className="text-muted-foreground shrink-0 w-20">
                    {format(new Date(log.created_at), 'HH:mm:ss')}
                  </span>
                  <Badge className={`${getLevelColor(log.level)} text-[10px] px-1 py-0 shrink-0`}>
                    {log.level?.toUpperCase() || 'INFO'}
                  </Badge>
                  <span className={`${getCategoryColor(log.category)} shrink-0 w-14`}>
                    [{log.category || 'sys'}]
                  </span>
                  <span className="text-foreground break-all flex-1">
                    {log.message}
                  </span>
                  {log.data && Object.keys(log.data).length > 0 && (
                    <span className="text-muted-foreground text-[10px] ml-1 max-w-[200px] truncate" title={JSON.stringify(log.data)}>
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
