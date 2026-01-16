import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { V29RConfig } from '@/hooks/useV29ResponseData';
import { Save } from 'lucide-react';
import { toast } from 'sonner';

interface Props {
  config: V29RConfig;
  onUpdate: (updates: Partial<V29RConfig>) => Promise<boolean>;
}

export function V29RConfigPanel({ config, onUpdate }: Props) {
  const [localConfig, setLocalConfig] = useState(config);
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    const success = await onUpdate(localConfig);
    setSaving(false);
    if (success) {
      toast.success('Config saved');
    } else {
      toast.error('Failed to save config');
    }
  };

  const handleToggle = async (enabled: boolean) => {
    setLocalConfig(prev => ({ ...prev, enabled }));
    await onUpdate({ enabled });
    toast.success(enabled ? 'Strategy enabled' : 'Strategy disabled');
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center justify-between">
          <span>V29-Response Config</span>
          <div className="flex items-center gap-2">
            <Label htmlFor="enabled" className="text-xs">Enabled</Label>
            <Switch 
              id="enabled"
              checked={localConfig.enabled} 
              onCheckedChange={handleToggle}
            />
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Signal Detection */}
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">Signal Detection</p>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div>
              <Label className="text-xs">Binance Min Move ($)</Label>
              <Input 
                type="number" 
                step="0.5"
                value={localConfig.binance_min_move_usd}
                onChange={(e) => setLocalConfig(prev => ({ ...prev, binance_min_move_usd: parseFloat(e.target.value) || 6 }))}
              />
            </div>
            <div>
              <Label className="text-xs">Window (ms)</Label>
              <Input 
                type="number" 
                value={localConfig.binance_window_ms}
                onChange={(e) => setLocalConfig(prev => ({ ...prev, binance_window_ms: parseInt(e.target.value) || 300 }))}
              />
            </div>
            <div>
              <Label className="text-xs">Max Spread (¢)</Label>
              <Input 
                type="number" 
                step="0.1"
                value={localConfig.max_spread_cents}
                onChange={(e) => setLocalConfig(prev => ({ ...prev, max_spread_cents: parseFloat(e.target.value) || 1.0 }))}
              />
            </div>
            <div>
              <Label className="text-xs">Max Poly Move (¢)</Label>
              <Input 
                type="number" 
                step="0.1"
                value={localConfig.max_poly_move_cents}
                onChange={(e) => setLocalConfig(prev => ({ ...prev, max_poly_move_cents: parseFloat(e.target.value) || 0.5 }))}
              />
            </div>
          </div>
        </div>

        {/* UP Asymmetry */}
        <div className="space-y-2">
          <p className="text-xs font-medium text-green-500">UP Trades (Faster)</p>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <Label className="text-xs">Target Min (¢)</Label>
              <Input 
                type="number" 
                step="0.1"
                value={localConfig.up_target_cents_min}
                onChange={(e) => setLocalConfig(prev => ({ ...prev, up_target_cents_min: parseFloat(e.target.value) || 1.8 }))}
              />
            </div>
            <div>
              <Label className="text-xs">Target Max (¢)</Label>
              <Input 
                type="number" 
                step="0.1"
                value={localConfig.up_target_cents_max}
                onChange={(e) => setLocalConfig(prev => ({ ...prev, up_target_cents_max: parseFloat(e.target.value) || 2.0 }))}
              />
            </div>
            <div>
              <Label className="text-xs">Max Hold (ms)</Label>
              <Input 
                type="number" 
                step="100"
                value={localConfig.up_max_hold_ms}
                onChange={(e) => setLocalConfig(prev => ({ ...prev, up_max_hold_ms: parseInt(e.target.value) || 6000 }))}
              />
            </div>
          </div>
        </div>

        {/* DOWN Asymmetry */}
        <div className="space-y-2">
          <p className="text-xs font-medium text-red-500">DOWN Trades (Slower)</p>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <Label className="text-xs">Target Min (¢)</Label>
              <Input 
                type="number" 
                step="0.1"
                value={localConfig.down_target_cents_min}
                onChange={(e) => setLocalConfig(prev => ({ ...prev, down_target_cents_min: parseFloat(e.target.value) || 2.0 }))}
              />
            </div>
            <div>
              <Label className="text-xs">Target Max (¢)</Label>
              <Input 
                type="number" 
                step="0.1"
                value={localConfig.down_target_cents_max}
                onChange={(e) => setLocalConfig(prev => ({ ...prev, down_target_cents_max: parseFloat(e.target.value) || 2.4 }))}
              />
            </div>
            <div>
              <Label className="text-xs">Max Hold (ms)</Label>
              <Input 
                type="number" 
                step="100"
                value={localConfig.down_max_hold_ms}
                onChange={(e) => setLocalConfig(prev => ({ ...prev, down_max_hold_ms: parseInt(e.target.value) || 7000 }))}
              />
            </div>
          </div>
        </div>

        {/* Exit Logic */}
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">Exit Logic</p>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div>
              <Label className="text-xs">Exhaustion %</Label>
              <Input 
                type="number" 
                step="0.05"
                value={localConfig.repricing_exhaustion_pct}
                onChange={(e) => setLocalConfig(prev => ({ ...prev, repricing_exhaustion_pct: parseFloat(e.target.value) || 0.65 }))}
              />
            </div>
            <div>
              <Label className="text-xs">Stall (¢)</Label>
              <Input 
                type="number" 
                step="0.05"
                value={localConfig.stall_threshold_cents}
                onChange={(e) => setLocalConfig(prev => ({ ...prev, stall_threshold_cents: parseFloat(e.target.value) || 0.1 }))}
              />
            </div>
            <div>
              <Label className="text-xs">Adverse Spread (¢)</Label>
              <Input 
                type="number" 
                step="0.1"
                value={localConfig.adverse_spread_cents}
                onChange={(e) => setLocalConfig(prev => ({ ...prev, adverse_spread_cents: parseFloat(e.target.value) || 1.5 }))}
              />
            </div>
            <div>
              <Label className="text-xs">Cooldown (ms)</Label>
              <Input 
                type="number" 
                step="100"
                value={localConfig.cooldown_ms}
                onChange={(e) => setLocalConfig(prev => ({ ...prev, cooldown_ms: parseInt(e.target.value) || 2500 }))}
              />
            </div>
          </div>
        </div>

        <Button onClick={handleSave} disabled={saving} className="w-full">
          <Save className="h-4 w-4 mr-2" />
          {saving ? 'Saving...' : 'Save Config'}
        </Button>
      </CardContent>
    </Card>
  );
}
