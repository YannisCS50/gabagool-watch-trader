import { useRealtimePriceLogs } from '@/hooks/useRealtimePriceLogs';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Play, Square, RefreshCw, Database, Zap, Clock, TrendingUp } from 'lucide-react';
import { format } from 'date-fns';

export function RealtimePriceLogger() {
  const {
    logs,
    status,
    isLoading,
    isCollecting,
    error,
    lastCollect,
    isAutoCollecting,
    collectNow,
    startAutoCollect,
    stopAutoCollect,
    fetchRecentLogs,
  } = useRealtimePriceLogs();

  return (
    <div className="space-y-4">
      {/* Control Panel */}
      <Card className="bg-[#161B22] border-[#30363D]">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center justify-between text-[#E6EDF3]">
            <span className="flex items-center gap-2">
              <Database className="h-5 w-5" />
              Price Feed Database Logger
            </span>
            <div className="flex items-center gap-2">
              {isAutoCollecting ? (
                <Badge variant="default" className="bg-green-600">
                  <Zap className="h-3 w-3 mr-1" /> Auto-collecting
                </Badge>
              ) : (
                <Badge variant="secondary" className="bg-[#30363D]">
                  <Clock className="h-3 w-3 mr-1" /> Manual mode
                </Badge>
              )}
            </div>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-4 mb-4">
            <Button
              onClick={() => startAutoCollect(10)}
              disabled={isAutoCollecting}
              variant="default"
              className="bg-green-600 hover:bg-green-700"
            >
              <Play className="h-4 w-4 mr-2" />
              Start Auto-Collect (10s)
            </Button>
            <Button
              onClick={stopAutoCollect}
              disabled={!isAutoCollecting}
              variant="destructive"
            >
              <Square className="h-4 w-4 mr-2" />
              Stop Auto-Collect
            </Button>
            <Button
              onClick={collectNow}
              disabled={isCollecting}
              variant="outline"
              className="border-[#30363D] text-[#E6EDF3] hover:bg-[#21262D]"
            >
              <TrendingUp className="h-4 w-4 mr-2" />
              {isCollecting ? 'Collecting...' : 'Collect Now'}
            </Button>
            <Button
              onClick={() => fetchRecentLogs(100)}
              variant="outline"
              disabled={isLoading}
              className="border-[#30363D] text-[#E6EDF3] hover:bg-[#21262D]"
            >
              <RefreshCw className="h-4 w-4 mr-2" />
              Refresh Logs
            </Button>
          </div>

          {error && (
            <div className="text-red-400 text-sm mb-4 p-2 bg-red-900/20 rounded">{error}</div>
          )}

          {/* Last Collect Result */}
          {lastCollect && (
            <div className="bg-[#21262D] rounded-lg p-3 mb-4">
              <div className="text-xs text-muted-foreground mb-1">Last Collection</div>
              <div className="flex gap-4 text-sm">
                <span className="text-[#E6EDF3]">
                  <strong>{lastCollect.collected}</strong> prices collected
                </span>
                <span className="text-orange-400">
                  Polymarket: {lastCollect.polymarket}
                </span>
                <span className="text-blue-400">
                  Chainlink: {lastCollect.chainlink}
                </span>
              </div>
              {lastCollect.logs.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {lastCollect.logs.map((log, i) => (
                    <Badge 
                      key={i} 
                      variant="outline"
                      className={`text-xs ${log.source.includes('chainlink') ? 'border-blue-500 text-blue-400' : 'border-orange-500 text-orange-400'}`}
                    >
                      {log.asset}: ${log.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </Badge>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Status Grid */}
          {status && (
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mb-4">
              <div className="bg-[#21262D] rounded-lg p-3">
                <div className="text-xs text-muted-foreground">Total Logs</div>
                <div className="text-2xl font-bold text-[#E6EDF3]">{status.totalLogs.toLocaleString()}</div>
              </div>
              
              <div className="bg-[#21262D] rounded-lg p-3">
                <div className="text-xs text-muted-foreground">Last Hour</div>
                <div className="text-2xl font-bold text-[#E6EDF3]">{status.lastHourLogs.toLocaleString()}</div>
              </div>
              
              <div className="bg-[#21262D] rounded-lg p-3">
                <div className="text-xs text-muted-foreground">In View</div>
                <div className="text-2xl font-bold text-[#E6EDF3]">{logs.length}</div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Recent Logs */}
      <Card className="bg-[#161B22] border-[#30363D]">
        <CardHeader className="pb-3">
          <CardTitle className="text-base text-[#E6EDF3]">Recent Logs ({logs.length})</CardTitle>
        </CardHeader>
        <CardContent>
          <ScrollArea className="h-[400px]">
            <div className="space-y-1">
              {logs.length === 0 ? (
                <div className="text-center text-muted-foreground py-8">
                  No logs yet. Click "Collect Now" or start auto-collect to begin.
                </div>
              ) : (
                logs.map((log) => (
                  <div
                    key={log.id}
                    className="flex items-center justify-between py-2 px-3 bg-[#21262D] rounded text-sm font-mono"
                  >
                    <div className="flex items-center gap-3">
                      <Badge
                        variant="outline"
                        className={log.source.includes('chainlink') ? 'border-blue-500 text-blue-400' : 'border-orange-500 text-orange-400'}
                      >
                        {log.source.includes('chainlink') ? 'CL' : 'PM'}
                      </Badge>
                      <span className="font-semibold w-12 text-[#E6EDF3]">{log.asset}</span>
                      <span className="text-[#E6EDF3]">
                        ${log.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </span>
                    </div>
                    <span className="text-muted-foreground text-xs">
                      {format(new Date(log.created_at), 'HH:mm:ss.SSS')}
                    </span>
                  </div>
                ))
              )}
            </div>
          </ScrollArea>
        </CardContent>
      </Card>
    </div>
  );
}
