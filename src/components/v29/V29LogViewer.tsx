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
  run_id: string | null;
  level: string;
  category: string;
  asset: string | null;
  message: string;
  data: Record<string, unknown> | null;
}

const CATEGORIES = ['ALL', 'price', 'signal', 'order', 'fill', 'market', 'system', 'error'] as const;
const LEVELS = ['ALL', 'debug', 'info', 'warn', 'error'] as const;

const DEFAULT_LIMIT = 2000;

function normalizeLog(row: any): LogEntry {
  return {
    ...row,
    ts: typeof row.ts === 'string' ? Number(row.ts) : row.ts,
    data: row?.data && typeof row.data === 'object' ? row.data : row?.data ?? null,
  } as LogEntry;
}

export function V29LogViewer() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [isPaused, setIsPaused] = useState(false);
  const [categoryFilter, setCategoryFilter] = useState<string>('ALL');
  const [levelFilter, setLevelFilter] = useState<string>('ALL');
  const [assetFilter, setAssetFilter] = useState<string>('ALL');
  const scrollRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);

  // Initial fetch
  useEffect(() => {
    const fetchLogs = async () => {
      const { data, error } = await supabase
        .from('v29_logs')
        .select('*')
        .order('ts', { ascending: false })
        .limit(DEFAULT_LIMIT);

      if (error) {
        console.error('[V29LogViewer] Failed to fetch logs:', error);
        return;
      }

      if (data) {
        // Keep descending order (newest first)
        setLogs((data as any[]).map(normalizeLog));
      }
    };

    fetchLogs();
  }, []);

  // Realtime subscription
  useEffect(() => {
    if (isPaused) return;

    const channel = supabase
      .channel('v29-logs-realtime')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'v29_logs' },
        (payload) => {
          const newLog = normalizeLog(payload.new);
          // Prepend new logs at the top (newest first)
          setLogs((prev) => [newLog, ...prev.slice(0, DEFAULT_LIMIT - 1)]);
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [isPaused]);

  // Auto-scroll to top (newest logs are at top now)
  useEffect(() => {
    if (autoScrollRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = 0;
    }
  }, [logs]);

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    // Check if at top (for newest-first layout)
    const isAtTop = el.scrollTop < 50;
    autoScrollRef.current = isAtTop;
  };

  const clearLogs = () => {
    setLogs([]);
  };

  const filteredLogs = logs.filter(log => {
    if (categoryFilter !== 'ALL' && log.category !== categoryFilter) return false;
    if (levelFilter !== 'ALL' && log.level !== levelFilter) return false;
    if (assetFilter !== 'ALL' && log.asset !== assetFilter) return false;
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
      case 'price': return 'text-green-400';
      case 'signal': return 'text-purple-400';
      case 'order': return 'text-blue-400';
      case 'fill': return 'text-cyan-400';
      case 'market': return 'text-orange-400';
      case 'system': return 'text-gray-400';
      case 'error': return 'text-red-400';
      default: return 'text-gray-400';
    }
  };

  return (
    <Card className="h-full">
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
            
            <Select value={assetFilter} onValueChange={setAssetFilter}>
              <SelectTrigger className="w-20 h-7 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">ALL</SelectItem>
                <SelectItem value="BTC">BTC</SelectItem>
                <SelectItem value="ETH">ETH</SelectItem>
                <SelectItem value="SOL">SOL</SelectItem>
                <SelectItem value="XRP">XRP</SelectItem>
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
          className="h-[400px] font-mono text-xs"
          ref={scrollRef as any}
          onScrollCapture={handleScroll}
        >
          <div className="p-2 space-y-0.5">
            {filteredLogs.length === 0 ? (
              <div className="text-center text-muted-foreground py-8">
                No logs yet. Start the V29 runner to see logs.
              </div>
            ) : (
              filteredLogs.map((log) => (
                <div 
                  key={log.id} 
                  className="flex items-start gap-2 hover:bg-muted/30 py-0.5 px-1 rounded"
                >
                  <span className="text-muted-foreground shrink-0 w-20">
                    {format(new Date(log.ts), 'HH:mm:ss.SSS')}
                  </span>
                  <Badge className={`${getLevelColor(log.level)} text-[10px] px-1 py-0 shrink-0`}>
                    {log.level.toUpperCase()}
                  </Badge>
                  <span className={`${getCategoryColor(log.category)} shrink-0 w-14`}>
                    [{log.category}]
                  </span>
                  {log.asset && (
                    <Badge variant="outline" className="text-[10px] px-1 py-0 shrink-0">
                      {log.asset}
                    </Badge>
                  )}
                  <span className="text-foreground break-all">
                    {log.message}
                  </span>
                  {log.data && Object.keys(log.data).length > 0 && (
                    <span className="text-muted-foreground ml-1">
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
