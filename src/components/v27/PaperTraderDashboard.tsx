import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { 
  usePaperSignals, 
  usePaperTraderStats, 
  usePaperTradingConfig,
  updatePaperTradingConfig,
  type PaperSignal 
} from '@/hooks/usePaperTraderData';
import { RefreshCw, TrendingUp, TrendingDown, Target, XCircle, Clock } from 'lucide-react';
import { toast } from 'sonner';

function formatCents(value: number | null): string {
  if (value === null) return '-';
  return `${(value * 100).toFixed(1)}¢`;
}

function formatPnl(value: number | null): string {
  if (value === null) return '-';
  const prefix = value >= 0 ? '+' : '';
  return `${prefix}$${value.toFixed(2)}`;
}

function formatTime(ts: number | null): string {
  if (ts === null) return '-';
  return new Date(ts).toLocaleTimeString();
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    pending: 'bg-yellow-500/20 text-yellow-400',
    filled: 'bg-blue-500/20 text-blue-400',
    sold: 'bg-green-500/20 text-green-400',
    expired: 'bg-gray-500/20 text-gray-400',
    failed: 'bg-red-500/20 text-red-400',
  };
  
  return (
    <Badge className={colors[status] || 'bg-gray-500/20 text-gray-400'}>
      {status}
    </Badge>
  );
}

function ExitTypeBadge({ exitType }: { exitType: string | null }) {
  if (!exitType) return null;
  
  const config: Record<string, { icon: React.ReactNode; color: string; label: string }> = {
    tp: { icon: <Target className="h-3 w-3" />, color: 'bg-green-500/20 text-green-400', label: 'TP' },
    sl: { icon: <XCircle className="h-3 w-3" />, color: 'bg-red-500/20 text-red-400', label: 'SL' },
    timeout: { icon: <Clock className="h-3 w-3" />, color: 'bg-yellow-500/20 text-yellow-400', label: 'Timeout' },
  };
  
  const c = config[exitType];
  if (!c) return null;
  
  return (
    <Badge className={`${c.color} flex items-center gap-1`}>
      {c.icon}
      {c.label}
    </Badge>
  );
}

function StatsCards() {
  const { data: stats, isLoading } = usePaperTraderStats();
  
  if (isLoading || !stats) {
    return <div className="text-muted-foreground">Loading stats...</div>;
  }
  
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
      <Card>
        <CardContent className="pt-4">
          <div className="text-sm text-muted-foreground">Total Trades</div>
          <div className="text-2xl font-bold">{stats.totalTrades}</div>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="pt-4">
          <div className="text-sm text-muted-foreground">Total PnL</div>
          <div className={`text-2xl font-bold ${stats.totalPnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
            {formatPnl(stats.totalPnl)}
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="pt-4">
          <div className="text-sm text-muted-foreground">Win Rate</div>
          <div className="text-2xl font-bold">{stats.winRate.toFixed(1)}%</div>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="pt-4">
          <div className="text-sm text-muted-foreground">TP / SL / Timeout</div>
          <div className="text-lg font-bold">
            <span className="text-green-400">{stats.tpHits}</span>
            {' / '}
            <span className="text-red-400">{stats.slHits}</span>
            {' / '}
            <span className="text-yellow-400">{stats.timeouts}</span>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function SignalsTable() {
  const { data: signals, isLoading, refetch } = usePaperSignals(50);
  
  if (isLoading) {
    return <div className="text-muted-foreground">Loading signals...</div>;
  }
  
  return (
    <div className="space-y-2">
      <div className="flex justify-between items-center">
        <h3 className="font-semibold">Recent Signals</h3>
        <Button variant="ghost" size="sm" onClick={() => refetch()}>
          <RefreshCw className="h-4 w-4" />
        </Button>
      </div>
      
      <div className="rounded-md border max-h-[400px] overflow-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Time</TableHead>
              <TableHead>Asset</TableHead>
              <TableHead>Dir</TableHead>
              <TableHead>Entry</TableHead>
              <TableHead>Exit</TableHead>
              <TableHead>TP/SL</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Exit</TableHead>
              <TableHead className="text-right">PnL</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {signals?.map((signal) => (
              <TableRow key={signal.id}>
                <TableCell className="font-mono text-xs">
                  {formatTime(signal.signal_ts)}
                </TableCell>
                <TableCell className="font-bold">{signal.asset}</TableCell>
                <TableCell>
                  {signal.direction === 'UP' ? (
                    <TrendingUp className="h-4 w-4 text-green-400" />
                  ) : (
                    <TrendingDown className="h-4 w-4 text-red-400" />
                  )}
                </TableCell>
                <TableCell className="font-mono">{formatCents(signal.entry_price)}</TableCell>
                <TableCell className="font-mono">{formatCents(signal.exit_price)}</TableCell>
                <TableCell className="font-mono text-xs">
                  <span className="text-green-400">{formatCents(signal.tp_price)}</span>
                  {' / '}
                  <span className="text-red-400">{formatCents(signal.sl_price)}</span>
                </TableCell>
                <TableCell>
                  <StatusBadge status={signal.status} />
                </TableCell>
                <TableCell>
                  <ExitTypeBadge exitType={signal.exit_type} />
                </TableCell>
                <TableCell className={`text-right font-mono ${(signal.net_pnl ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                  {formatPnl(signal.net_pnl)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function ConfigEditor() {
  const { data: config, refetch } = usePaperTradingConfig();
  const [saving, setSaving] = useState(false);
  
  const handleUpdate = async (updates: Record<string, unknown>) => {
    setSaving(true);
    const success = await updatePaperTradingConfig(updates);
    setSaving(false);
    
    if (success) {
      toast.success('Config updated');
      refetch();
    } else {
      toast.error('Failed to update config');
    }
  };
  
  if (!config) {
    return <div className="text-muted-foreground">Loading config...</div>;
  }
  
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        <div className="flex items-center justify-between space-x-2">
          <Label>Enabled</Label>
          <Switch 
            checked={config.enabled} 
            onCheckedChange={(v) => handleUpdate({ enabled: v })}
          />
        </div>
        
        <div className="flex items-center justify-between space-x-2">
          <Label className="text-red-400">LIVE MODE</Label>
          <Switch 
            checked={config.is_live} 
            onCheckedChange={(v) => handleUpdate({ is_live: v })}
            className="data-[state=checked]:bg-red-500"
          />
        </div>
        
        <div>
          <Label>Trade Size ($)</Label>
          <Input 
            type="number" 
            value={config.trade_size_usd}
            onChange={(e) => handleUpdate({ trade_size_usd: parseFloat(e.target.value) || 5 })}
            className="h-8"
          />
        </div>
        
        <div>
          <Label>Min Delta ($)</Label>
          <Input 
            type="number" 
            value={config.min_delta_usd}
            onChange={(e) => handleUpdate({ min_delta_usd: parseFloat(e.target.value) || 10 })}
            className="h-8"
          />
        </div>
        
        <div>
          <Label>TP (¢)</Label>
          <div className="flex gap-1 items-center">
            <Input 
              type="number" 
              value={config.tp_cents}
              onChange={(e) => handleUpdate({ tp_cents: parseFloat(e.target.value) || 3 })}
              className="h-8"
              disabled={!config.tp_enabled}
            />
            <Switch 
              checked={config.tp_enabled} 
              onCheckedChange={(v) => handleUpdate({ tp_enabled: v })}
            />
          </div>
        </div>
        
        <div>
          <Label>SL (¢)</Label>
          <div className="flex gap-1 items-center">
            <Input 
              type="number" 
              value={config.sl_cents}
              onChange={(e) => handleUpdate({ sl_cents: parseFloat(e.target.value) || 3 })}
              className="h-8"
              disabled={!config.sl_enabled}
            />
            <Switch 
              checked={config.sl_enabled} 
              onCheckedChange={(v) => handleUpdate({ sl_enabled: v })}
            />
          </div>
        </div>
        
        <div>
          <Label>Timeout (s)</Label>
          <Input 
            type="number" 
            value={config.timeout_ms / 1000}
            onChange={(e) => handleUpdate({ timeout_ms: (parseFloat(e.target.value) || 15) * 1000 })}
            className="h-8"
          />
        </div>
        
        <div>
          <Label>Min Share (¢)</Label>
          <Input 
            type="number" 
            value={config.min_share_price * 100}
            onChange={(e) => handleUpdate({ min_share_price: (parseFloat(e.target.value) || 35) / 100 })}
            className="h-8"
          />
        </div>
        
        <div>
          <Label>Max Share (¢)</Label>
          <Input 
            type="number" 
            value={config.max_share_price * 100}
            onChange={(e) => handleUpdate({ max_share_price: (parseFloat(e.target.value) || 65) / 100 })}
            className="h-8"
          />
        </div>
      </div>
      
      {config.is_live && (
        <div className="p-4 bg-red-500/20 border border-red-500 rounded-md">
          <p className="text-red-400 font-bold">⚠️ LIVE MODE IS ENABLED</p>
          <p className="text-sm text-red-300">Real orders will be placed with ${config.trade_size_usd} per trade</p>
        </div>
      )}
    </div>
  );
}

export default function PaperTraderDashboard() {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold">Paper Trader</h2>
        <p className="text-muted-foreground">Monitor paper trading signals from the runner</p>
      </div>
      
      <StatsCards />
      
      <Tabs defaultValue="signals">
        <TabsList>
          <TabsTrigger value="signals">Signals</TabsTrigger>
          <TabsTrigger value="config">Config</TabsTrigger>
        </TabsList>
        
        <TabsContent value="signals" className="mt-4">
          <Card>
            <CardContent className="pt-4">
              <SignalsTable />
            </CardContent>
          </Card>
        </TabsContent>
        
        <TabsContent value="config" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle>Paper Trading Configuration</CardTitle>
            </CardHeader>
            <CardContent>
              <ConfigEditor />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
