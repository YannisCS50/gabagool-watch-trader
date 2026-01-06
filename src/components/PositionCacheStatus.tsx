import React, { useState, useEffect } from 'react';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Database, AlertTriangle, CheckCircle, XCircle, RefreshCw } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';

interface PositionCacheData {
  isHealthy: boolean;
  lastRefreshAtMs: number;
  lastRefreshDurationMs: number;
  refreshCount: number;
  errorCount: number;
  positionCount: number;
  marketCount: number;
  runnerVersion: string;
}

export function PositionCacheStatus() {
  const [cacheData, setCacheData] = useState<PositionCacheData | null>(null);
  const [ageMs, setAgeMs] = useState(0);

  // Fetch latest bot event with cache stats
  useEffect(() => {
    const fetchCacheStatus = async () => {
      // Get latest snapshot_log which contains the cache timing info
      const { data: snapshot } = await supabase
        .from('snapshot_logs')
        .select('ts, created_at, bot_state, run_id')
        .order('ts', { ascending: false })
        .limit(1)
        .single();

      // Get runner heartbeat for version info
      const { data: heartbeat } = await supabase
        .from('runner_heartbeats')
        .select('version, last_heartbeat, positions_count, markets_count, status')
        .eq('runner_type', 'local')
        .order('last_heartbeat', { ascending: false })
        .limit(1)
        .single();

      if (snapshot || heartbeat) {
        const lastRefreshAtMs = snapshot?.ts || Date.now();
        const isRecent = Date.now() - lastRefreshAtMs < 5000; // Within 5s
        
        setCacheData({
          isHealthy: isRecent && heartbeat?.status === 'online',
          lastRefreshAtMs,
          lastRefreshDurationMs: 0,
          refreshCount: 0,
          errorCount: 0,
          positionCount: heartbeat?.positions_count || 0,
          marketCount: heartbeat?.markets_count || 0,
          runnerVersion: heartbeat?.version || 'unknown',
        });
      }
    };

    fetchCacheStatus();
    const interval = setInterval(fetchCacheStatus, 2000);
    return () => clearInterval(interval);
  }, []);

  // Update age every 100ms for smooth display
  useEffect(() => {
    const updateAge = () => {
      if (cacheData?.lastRefreshAtMs) {
        setAgeMs(Date.now() - cacheData.lastRefreshAtMs);
      }
    };

    updateAge();
    const interval = setInterval(updateAge, 100);
    return () => clearInterval(interval);
  }, [cacheData?.lastRefreshAtMs]);

  if (!cacheData) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground text-xs">
        <RefreshCw className="w-3 h-3 animate-spin" />
        <span>Cache laden...</span>
      </div>
    );
  }

  const isStale = ageMs > 3000;
  const isWarning = ageMs > 2000 && ageMs <= 3000;
  const isHealthy = cacheData.isHealthy && !isStale;

  const getStatusColor = () => {
    if (!cacheData.isHealthy || isStale) return 'destructive';
    if (isWarning) return 'secondary';
    return 'default';
  };

  const getStatusIcon = () => {
    if (!cacheData.isHealthy || isStale) return <XCircle className="w-3 h-3" />;
    if (isWarning) return <AlertTriangle className="w-3 h-3" />;
    return <CheckCircle className="w-3 h-3" />;
  };

  const formatAge = (ms: number) => {
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  };

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex items-center gap-2">
            <Badge 
              variant={getStatusColor()} 
              className="flex items-center gap-1.5 cursor-help"
            >
              <Database className="w-3 h-3" />
              <span>Position Cache</span>
              {getStatusIcon()}
            </Badge>
            <span className={`text-xs font-mono ${isStale ? 'text-destructive' : isWarning ? 'text-yellow-500' : 'text-muted-foreground'}`}>
              {formatAge(ageMs)} ago
            </span>
          </div>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-sm">
          <div className="space-y-2 text-xs">
            <div className="font-semibold flex items-center gap-2">
              {isHealthy ? (
                <>
                  <CheckCircle className="w-4 h-4 text-green-500" />
                  Position Cache Healthy
                </>
              ) : (
                <>
                  <XCircle className="w-4 h-4 text-red-500" />
                  Position Cache Unhealthy
                </>
              )}
            </div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1">
              <span className="text-muted-foreground">Last sync:</span>
              <span className={isStale ? 'text-destructive font-bold' : ''}>{formatAge(ageMs)} ago</span>
              
              <span className="text-muted-foreground">Positions:</span>
              <span>{cacheData.positionCount}</span>
              
              <span className="text-muted-foreground">Markets:</span>
              <span>{cacheData.marketCount}</span>
              
              <span className="text-muted-foreground">Runner:</span>
              <span>v{cacheData.runnerVersion}</span>
            </div>
            {isStale && (
              <div className="text-destructive font-medium pt-1 border-t">
                ⚠️ Cache is stale! Bot decisions may be based on outdated data.
              </div>
            )}
            {!isStale && isHealthy && (
              <div className="text-green-500 pt-1 border-t">
                ✅ Polymarket positions worden elke seconde gesynchroniseerd
              </div>
            )}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
