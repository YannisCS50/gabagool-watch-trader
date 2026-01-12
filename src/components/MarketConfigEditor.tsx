import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Slider } from '@/components/ui/slider';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { 
  Settings2, 
  Save, 
  RefreshCw, 
  TrendingUp, 
  TrendingDown,
  DollarSign,
  Percent,
  Clock,
  Shield,
  Zap
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useMarketConfig, type MarketConfig } from '@/hooks/useMarketConfig';

interface MarketConfigEditorProps {
  className?: string;
}

function AssetConfigPanel({ 
  config, 
  onUpdate, 
  saving 
}: { 
  config: MarketConfig; 
  onUpdate: (updates: Partial<MarketConfig>) => void;
  saving: boolean;
}) {
  const [localConfig, setLocalConfig] = useState(config);
  const [hasChanges, setHasChanges] = useState(false);

  const updateLocal = (updates: Partial<MarketConfig>) => {
    setLocalConfig(prev => ({ ...prev, ...updates }));
    setHasChanges(true);
  };

  const handleSave = () => {
    onUpdate(localConfig);
    setHasChanges(false);
  };

  const handleReset = () => {
    setLocalConfig(config);
    setHasChanges(false);
  };

  return (
    <div className="space-y-6">
      {/* Header with Enable Toggle */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-2xl font-bold">{config.asset}</span>
          <Badge 
            variant={localConfig.enabled ? "default" : "secondary"}
            className={cn(
              localConfig.enabled 
                ? 'bg-green-500/20 text-green-400' 
                : 'bg-muted text-muted-foreground'
            )}
          >
            {localConfig.enabled ? 'Active' : 'Disabled'}
          </Badge>
          {localConfig.shadow_only && (
            <Badge variant="outline" className="text-amber-400 border-amber-400/50">
              Shadow Only
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          {hasChanges && (
            <>
              <Button variant="outline" size="sm" onClick={handleReset}>
                Reset
              </Button>
              <Button size="sm" onClick={handleSave} disabled={saving}>
                <Save className="h-4 w-4 mr-1" />
                Save
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Main Toggles */}
      <div className="grid grid-cols-2 gap-4">
        <div className="flex items-center justify-between p-3 bg-muted/30 rounded-lg">
          <div className="flex items-center gap-2">
            <Zap className="h-4 w-4 text-green-400" />
            <Label>Trading Enabled</Label>
          </div>
          <Switch 
            checked={localConfig.enabled} 
            onCheckedChange={(enabled) => updateLocal({ enabled })}
          />
        </div>
        <div className="flex items-center justify-between p-3 bg-muted/30 rounded-lg">
          <div className="flex items-center gap-2">
            <Shield className="h-4 w-4 text-amber-400" />
            <Label>Shadow Only</Label>
          </div>
          <Switch 
            checked={localConfig.shadow_only} 
            onCheckedChange={(shadow_only) => updateLocal({ shadow_only })}
          />
        </div>
      </div>

      {/* Position Limits */}
      <Card className="glass">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <DollarSign className="h-4 w-4" />
            Position Limits
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label className="text-xs">Max Shares</Label>
              <Input
                type="number"
                value={localConfig.max_shares}
                onChange={(e) => updateLocal({ max_shares: parseFloat(e.target.value) || 0 })}
                className="h-8"
              />
            </div>
            <div className="space-y-2">
              <Label className="text-xs">Max Notional ($)</Label>
              <Input
                type="number"
                value={localConfig.max_notional_usd}
                onChange={(e) => updateLocal({ max_notional_usd: parseFloat(e.target.value) || 0 })}
                className="h-8"
              />
            </div>
            <div className="space-y-2">
              <Label className="text-xs">Max Exposure ($)</Label>
              <Input
                type="number"
                value={localConfig.max_exposure_usd}
                onChange={(e) => updateLocal({ max_exposure_usd: parseFloat(e.target.value) || 0 })}
                className="h-8"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Entry Thresholds */}
      <Card className="glass">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <TrendingUp className="h-4 w-4" />
            Entry Thresholds
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label className="text-xs">Min Edge (%)</Label>
              <div className="flex items-center gap-2">
                <Slider
                  value={[localConfig.min_edge_pct]}
                  onValueChange={([v]) => updateLocal({ min_edge_pct: v })}
                  min={0}
                  max={10}
                  step={0.5}
                  className="flex-1"
                />
                <span className="font-mono text-sm w-12">{localConfig.min_edge_pct}%</span>
              </div>
            </div>
            <div className="space-y-2">
              <Label className="text-xs">Min Delta ($)</Label>
              <Input
                type="number"
                value={localConfig.min_delta_usd}
                onChange={(e) => updateLocal({ min_delta_usd: parseFloat(e.target.value) || 0 })}
                className="h-8"
              />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label className="text-xs">Max Combined</Label>
              <Input
                type="number"
                step="0.01"
                value={localConfig.max_combined_price}
                onChange={(e) => updateLocal({ max_combined_price: parseFloat(e.target.value) || 0 })}
                className="h-8"
              />
            </div>
            <div className="space-y-2">
              <Label className="text-xs">Min Ask</Label>
              <Input
                type="number"
                step="0.01"
                value={localConfig.min_ask_price}
                onChange={(e) => updateLocal({ min_ask_price: parseFloat(e.target.value) || 0 })}
                className="h-8"
              />
            </div>
            <div className="space-y-2">
              <Label className="text-xs">Max Ask</Label>
              <Input
                type="number"
                step="0.01"
                value={localConfig.max_ask_price}
                onChange={(e) => updateLocal({ max_ask_price: parseFloat(e.target.value) || 0 })}
                className="h-8"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* TP/SL Settings */}
      <Card className="glass">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Percent className="h-4 w-4" />
            Take Profit / Stop Loss
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label className="text-xs text-green-400">Take Profit (%)</Label>
              <div className="flex items-center gap-2">
                <Slider
                  value={[localConfig.take_profit_pct]}
                  onValueChange={([v]) => updateLocal({ take_profit_pct: v })}
                  min={1}
                  max={20}
                  step={0.5}
                  className="flex-1"
                />
                <span className="font-mono text-sm text-green-400 w-12">+{localConfig.take_profit_pct}%</span>
              </div>
            </div>
            <div className="space-y-2">
              <Label className="text-xs text-red-400">Stop Loss (%)</Label>
              <div className="flex items-center gap-2">
                <Slider
                  value={[localConfig.stop_loss_pct]}
                  onValueChange={([v]) => updateLocal({ stop_loss_pct: v })}
                  min={1}
                  max={30}
                  step={0.5}
                  className="flex-1"
                />
                <span className="font-mono text-sm text-red-400 w-12">-{localConfig.stop_loss_pct}%</span>
              </div>
            </div>
          </div>
          <div className="flex items-center justify-between p-3 bg-muted/30 rounded-lg">
            <div className="flex items-center gap-2">
              <TrendingDown className="h-4 w-4" />
              <Label>Trailing Stop</Label>
            </div>
            <div className="flex items-center gap-2">
              {localConfig.trailing_stop_enabled && (
                <Input
                  type="number"
                  step="0.5"
                  value={localConfig.trailing_stop_pct ?? 3}
                  onChange={(e) => updateLocal({ trailing_stop_pct: parseFloat(e.target.value) || 3 })}
                  className="h-8 w-16"
                />
              )}
              <Switch 
                checked={localConfig.trailing_stop_enabled} 
                onCheckedChange={(trailing_stop_enabled) => updateLocal({ trailing_stop_enabled })}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Timing */}
      <Card className="glass">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Clock className="h-4 w-4" />
            Timing Windows
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label className="text-xs">Min Seconds Remaining</Label>
              <Input
                type="number"
                value={localConfig.min_seconds_remaining}
                onChange={(e) => updateLocal({ min_seconds_remaining: parseInt(e.target.value) || 0 })}
                className="h-8"
              />
            </div>
            <div className="space-y-2">
              <Label className="text-xs">Max Seconds Remaining</Label>
              <Input
                type="number"
                value={localConfig.max_seconds_remaining}
                onChange={(e) => updateLocal({ max_seconds_remaining: parseInt(e.target.value) || 0 })}
                className="h-8"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Last Updated */}
      <div className="text-xs text-muted-foreground text-right">
        Last updated: {new Date(config.updated_at).toLocaleString()}
      </div>
    </div>
  );
}

export function MarketConfigEditor({ className }: MarketConfigEditorProps) {
  const { configs, loading, saving, updateConfig, refetch } = useMarketConfig();
  const [selectedAsset, setSelectedAsset] = useState<string>('BTC');

  const selectedConfig = configs.find(c => c.asset === selectedAsset);

  if (loading) {
    return (
      <Card className={cn('glass', className)}>
        <CardContent className="flex items-center justify-center py-12">
          <RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className={cn('glass', className)}>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-lg flex items-center gap-2">
          <Settings2 className="h-5 w-5 text-primary" />
          Market Configuration
        </CardTitle>
        <Button variant="ghost" size="sm" onClick={refetch}>
          <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
        </Button>
      </CardHeader>
      <CardContent>
        <Tabs value={selectedAsset} onValueChange={setSelectedAsset}>
          <TabsList className="grid grid-cols-4 w-full mb-4">
            {configs.map(config => (
              <TabsTrigger 
                key={config.asset} 
                value={config.asset}
                className={cn(
                  'relative',
                  !config.enabled && 'opacity-50'
                )}
              >
                {config.asset}
                {config.enabled && (
                  <span className="absolute top-1 right-1 h-2 w-2 rounded-full bg-green-400" />
                )}
              </TabsTrigger>
            ))}
          </TabsList>

          {configs.map(config => (
            <TabsContent key={config.asset} value={config.asset}>
              <ScrollArea className="h-[600px] pr-4">
                <AssetConfigPanel
                  config={config}
                  onUpdate={(updates) => updateConfig(config.asset, updates)}
                  saving={saving}
                />
              </ScrollArea>
            </TabsContent>
          ))}
        </Tabs>
      </CardContent>
    </Card>
  );
}
