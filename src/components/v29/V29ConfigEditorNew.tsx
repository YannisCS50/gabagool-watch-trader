import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { toast } from 'sonner';
import { V29Config } from '@/hooks/useV29Data';
import { Settings, Zap, Target, Shield, Clock } from 'lucide-react';

interface Props {
  config: V29Config;
  onUpdate: (updates: Partial<V29Config>) => Promise<boolean>;
}

export function V29ConfigEditorNew({ config, onUpdate }: Props) {
  const [localConfig, setLocalConfig] = useState(config);
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    const success = await onUpdate(localConfig);
    setSaving(false);
    
    if (success) {
      toast.success('V29 config saved');
    } else {
      toast.error('Failed to save config');
    }
  };

  const handleToggle = async (enabled: boolean) => {
    setLocalConfig(prev => ({ ...prev, enabled }));
    const success = await onUpdate({ enabled });
    if (success) {
      toast.success(enabled ? 'V29 enabled' : 'V29 disabled');
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between">
          <span className="flex items-center gap-2">
            <Settings className="h-5 w-5" />
            V29 Configuration
          </span>
          <div className="flex items-center gap-2">
            <Label htmlFor="enabled" className="text-sm font-normal">
              {localConfig.enabled ? 'Trading Active' : 'Trading Disabled'}
            </Label>
            <Switch
              id="enabled"
              checked={localConfig.enabled}
              onCheckedChange={handleToggle}
            />
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        
        {/* Entry Settings */}
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <Zap className="h-4 w-4" />
            Entry Settings
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="space-y-1">
              <Label className="text-xs">Tick Delta ($)</Label>
              <Input
                type="number"
                step="1"
                value={localConfig.tick_delta_usd}
                onChange={(e) => setLocalConfig(prev => ({ 
                  ...prev, 
                  tick_delta_usd: Number(e.target.value) 
                }))}
                className="h-8"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Shares/Trade</Label>
              <Input
                type="number"
                step="1"
                min="5"
                value={localConfig.shares_per_trade}
                onChange={(e) => setLocalConfig(prev => ({ 
                  ...prev, 
                  shares_per_trade: Number(e.target.value) 
                }))}
                className="h-8"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Min Price (¢)</Label>
              <Input
                type="number"
                step="1"
                value={Math.round(localConfig.min_share_price * 100)}
                onChange={(e) => setLocalConfig(prev => ({ 
                  ...prev, 
                  min_share_price: Number(e.target.value) / 100 
                }))}
                className="h-8"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Max Price (¢)</Label>
              <Input
                type="number"
                step="1"
                value={Math.round(localConfig.max_share_price * 100)}
                onChange={(e) => setLocalConfig(prev => ({ 
                  ...prev, 
                  max_share_price: Number(e.target.value) / 100 
                }))}
                className="h-8"
              />
            </div>
          </div>
        </div>

        <Separator />

        {/* Direction Filter */}
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <Target className="h-4 w-4" />
            Direction Filter
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            <div className="space-y-1">
              <Label className="text-xs">Delta Threshold ($)</Label>
              <Input
                type="number"
                step="5"
                value={localConfig.delta_threshold}
                onChange={(e) => setLocalConfig(prev => ({ 
                  ...prev, 
                  delta_threshold: Number(e.target.value) 
                }))}
                className="h-8"
              />
              <p className="text-[10px] text-muted-foreground">{"<"}-X = DOWN only, {">"}+X = UP only</p>
            </div>
          </div>
        </div>

        <Separator />

        {/* Hedging/Pairing Config */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <Shield className="h-4 w-4" />
              Auto Hedge / Pairing
              <Badge variant={localConfig.auto_hedge_enabled ? 'default' : 'secondary'} className="text-xs">
                {localConfig.auto_hedge_enabled ? 'ON' : 'OFF'}
              </Badge>
            </div>
            <Switch
              checked={localConfig.auto_hedge_enabled}
              onCheckedChange={(v) => setLocalConfig(prev => ({ ...prev, auto_hedge_enabled: v }))}
            />
          </div>
          {localConfig.auto_hedge_enabled && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="space-y-1">
                <Label className="text-xs">Hedge Trigger (¢)</Label>
                <Input
                  type="number"
                  step="1"
                  value={localConfig.hedge_trigger_cents}
                  onChange={(e) => setLocalConfig(prev => ({ 
                    ...prev, 
                    hedge_trigger_cents: Number(e.target.value) 
                  }))}
                  className="h-8"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Min Profit (¢)</Label>
                <Input
                  type="number"
                  step="0.5"
                  value={localConfig.hedge_min_profit_cents}
                  onChange={(e) => setLocalConfig(prev => ({ 
                    ...prev, 
                    hedge_min_profit_cents: Number(e.target.value) 
                  }))}
                  className="h-8"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Force Close (sec)</Label>
                <Input
                  type="number"
                  step="10"
                  value={localConfig.force_close_after_sec}
                  onChange={(e) => setLocalConfig(prev => ({ 
                    ...prev, 
                    force_close_after_sec: Number(e.target.value) 
                  }))}
                  className="h-8"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Aggregate After (sec)</Label>
                <Input
                  type="number"
                  step="10"
                  value={localConfig.aggregate_after_sec}
                  onChange={(e) => setLocalConfig(prev => ({ 
                    ...prev, 
                    aggregate_after_sec: Number(e.target.value) 
                  }))}
                  className="h-8"
                />
              </div>
            </div>
          )}
        </div>

        <Separator />

        {/* Accumulation */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <Zap className="h-4 w-4" />
              Accumulation Mode
              <Badge variant={localConfig.accumulation_enabled ? 'default' : 'secondary'} className="text-xs">
                {localConfig.accumulation_enabled ? 'ON' : 'OFF'}
              </Badge>
            </div>
            <Switch
              checked={localConfig.accumulation_enabled}
              onCheckedChange={(v) => setLocalConfig(prev => ({ ...prev, accumulation_enabled: v }))}
            />
          </div>
          {localConfig.accumulation_enabled && (
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
              <div className="space-y-1">
                <Label className="text-xs">Max Total Cost ($)</Label>
                <Input
                  type="number"
                  step="10"
                  value={localConfig.max_total_cost_usd}
                  onChange={(e) => setLocalConfig(prev => ({ 
                    ...prev, 
                    max_total_cost_usd: Number(e.target.value) 
                  }))}
                  className="h-8"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Max Total Shares</Label>
                <Input
                  type="number"
                  step="10"
                  value={localConfig.max_total_shares}
                  onChange={(e) => setLocalConfig(prev => ({ 
                    ...prev, 
                    max_total_shares: Number(e.target.value) 
                  }))}
                  className="h-8"
                />
              </div>
            </div>
          )}
        </div>

        <Separator />

        {/* Exit Settings */}
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <Shield className="h-4 w-4" />
            Exit / Risk Settings
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="space-y-1">
              <Label className="text-xs">Take Profit (¢)</Label>
              <Input
                type="number"
                step="0.5"
                value={localConfig.take_profit_cents}
                onChange={(e) => setLocalConfig(prev => ({ 
                  ...prev, 
                  take_profit_cents: Number(e.target.value) 
                }))}
                className="h-8"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Stop Loss (¢)</Label>
              <Input
                type="number"
                step="0.5"
                value={localConfig.stop_loss_cents}
                onChange={(e) => setLocalConfig(prev => ({ 
                  ...prev, 
                  stop_loss_cents: Number(e.target.value) 
                }))}
                className="h-8"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Emergency SL (¢)</Label>
              <Input
                type="number"
                step="1"
                value={localConfig.emergency_sl_cents}
                onChange={(e) => setLocalConfig(prev => ({ 
                  ...prev, 
                  emergency_sl_cents: Number(e.target.value) 
                }))}
                className="h-8"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Price Buffer (¢)</Label>
              <Input
                type="number"
                step="1"
                value={localConfig.price_buffer_cents}
                onChange={(e) => setLocalConfig(prev => ({ 
                  ...prev, 
                  price_buffer_cents: Number(e.target.value) 
                }))}
                className="h-8"
              />
            </div>
          </div>
        </div>

        <Separator />

        {/* Trailing Stop */}
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <Target className="h-4 w-4" />
            Trailing Stop
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            <div className="space-y-1">
              <Label className="text-xs">Trigger (¢)</Label>
              <Input
                type="number"
                step="0.5"
                value={localConfig.trailing_trigger_cents}
                onChange={(e) => setLocalConfig(prev => ({ 
                  ...prev, 
                  trailing_trigger_cents: Number(e.target.value) 
                }))}
                className="h-8"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Distance (¢)</Label>
              <Input
                type="number"
                step="0.5"
                value={localConfig.trailing_distance_cents}
                onChange={(e) => setLocalConfig(prev => ({ 
                  ...prev, 
                  trailing_distance_cents: Number(e.target.value) 
                }))}
                className="h-8"
              />
            </div>
          </div>
        </div>

        <Separator />

        {/* Timing */}
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <Clock className="h-4 w-4" />
            Timing & Intervals
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="space-y-1">
              <Label className="text-xs">Binance Poll (ms)</Label>
              <Input
                type="number"
                step="50"
                value={localConfig.binance_poll_ms}
                onChange={(e) => setLocalConfig(prev => ({ 
                  ...prev, 
                  binance_poll_ms: Number(e.target.value) 
                }))}
                className="h-8"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Orderbook Poll (ms)</Label>
              <Input
                type="number"
                step="100"
                value={localConfig.orderbook_poll_ms}
                onChange={(e) => setLocalConfig(prev => ({ 
                  ...prev, 
                  orderbook_poll_ms: Number(e.target.value) 
                }))}
                className="h-8"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Order Cooldown (ms)</Label>
              <Input
                type="number"
                step="100"
                value={localConfig.order_cooldown_ms}
                onChange={(e) => setLocalConfig(prev => ({ 
                  ...prev, 
                  order_cooldown_ms: Number(e.target.value) 
                }))}
                className="h-8"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Timeout (sec)</Label>
              <Input
                type="number"
                step="10"
                value={localConfig.timeout_seconds}
                onChange={(e) => setLocalConfig(prev => ({ 
                  ...prev, 
                  timeout_seconds: Number(e.target.value) 
                }))}
                className="h-8"
              />
            </div>
          </div>
        </div>

        {/* Assets */}
        <div className="space-y-3">
          <Label className="text-xs text-muted-foreground">Active Assets</Label>
          <div className="flex gap-2">
            {['BTC', 'ETH', 'SOL', 'XRP'].map(asset => (
              <Badge 
                key={asset}
                variant={localConfig.assets.includes(asset) ? 'default' : 'outline'}
                className="cursor-pointer"
                onClick={() => {
                  setLocalConfig(prev => ({
                    ...prev,
                    assets: prev.assets.includes(asset)
                      ? prev.assets.filter(a => a !== asset)
                      : [...prev.assets, asset]
                  }));
                }}
              >
                {asset}
              </Badge>
            ))}
          </div>
        </div>

        {/* Other Toggles */}
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <Switch
              checked={localConfig.prevent_counter_scalping}
              onCheckedChange={(v) => setLocalConfig(prev => ({ ...prev, prevent_counter_scalping: v }))}
            />
            <Label className="text-xs">Prevent Counter Scalping</Label>
          </div>
        </div>

        {/* Save Button */}
        <div className="flex justify-end pt-4">
          <Button onClick={handleSave} disabled={saving}>
            {saving ? 'Saving...' : 'Save Config'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
