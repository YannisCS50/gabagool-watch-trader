import { useRealtimePriceLogs } from '@/hooks/useRealtimePriceLogs';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { RefreshCw, Database, Zap, Server, TrendingUp } from 'lucide-react';
import { format } from 'date-fns';

export function RealtimePriceLogger() {
  const {
    logs,
    status,
    isLoading,
    error,
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
              WebSocket Price Logger
            </span>
            <Badge variant="default" className="bg-blue-600">
              <Server className="h-3 w-3 mr-1" /> Runner-based
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="bg-[#21262D] rounded-lg p-4 mb-4">
            <div className="flex items-start gap-3">
              <Zap className="h-5 w-5 text-yellow-400 mt-0.5" />
              <div>
                <p className="text-sm text-[#E6EDF3] font-medium">Millisecond-Precision Logging</p>
                <p className="text-xs text-muted-foreground mt-1">
                  WebSocket data wordt gelogd door de runner met <code className="bg-[#161B22] px-1 rounded">FEATURE_PRICE_LOGGER=true</code>
                </p>
                <p className="text-xs text-muted-foreground mt-2">
                  <strong>Sources:</strong> Binance WS (trade stream) + Polymarket RTDS (crypto_prices + chainlink)
                </p>
                <p className="text-xs text-muted-foreground">
                  <strong>Start runner:</strong> <code className="bg-[#161B22] px-1 rounded">FEATURE_PRICE_LOGGER=true npm start</code>
                </p>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap gap-4 mb-4">
            <Button
              onClick={() => fetchRecentLogs(500)}
              variant="outline"
              disabled={isLoading}
              className="border-[#30363D] text-[#E6EDF3] hover:bg-[#21262D]"
            >
              <RefreshCw className={`h-4 w-4 mr-2 ${isLoading ? 'animate-spin' : ''}`} />
              Refresh Logs (500)
            </Button>
          </div>

          {error && (
            <div className="text-red-400 text-sm mb-4 p-2 bg-red-900/20 rounded">{error}</div>
          )}

          {/* Status Grid */}
          {status && (
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mb-4">
              <div className="bg-[#21262D] rounded-lg p-3">
                <div className="text-xs text-muted-foreground">Total Logs (DB)</div>
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
