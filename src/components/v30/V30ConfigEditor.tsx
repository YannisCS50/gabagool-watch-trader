import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { toast } from 'sonner';
import type { V30Config } from '@/hooks/useV30Data';

interface Props {
  config: V30Config;
  onUpdate: (updates: Partial<V30Config>) => Promise<boolean>;
}

export function V30ConfigEditor({ config, onUpdate }: Props) {
  const [localConfig, setLocalConfig] = useState(config);
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    const success = await onUpdate(localConfig);
    setSaving(false);
    
    if (success) {
      toast.success('V30 config saved');
    } else {
      toast.error('Failed to save config');
    }
  };

  const handleToggle = async (enabled: boolean) => {
    setLocalConfig(prev => ({ ...prev, enabled }));
    const success = await onUpdate({ enabled });
    if (success) {
      toast.success(enabled ? 'V30 enabled' : 'V30 disabled');
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between">
          V30 Configuration
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
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {/* Base Theta */}
          <div className="space-y-1">
            <Label htmlFor="base_theta" className="text-xs">Base θ (%)</Label>
            <Input
              id="base_theta"
              type="number"
              step="0.5"
              value={(localConfig.base_theta * 100).toFixed(1)}
              onChange={(e) => setLocalConfig(prev => ({ 
                ...prev, 
                base_theta: Number(e.target.value) / 100 
              }))}
              className="h-8"
            />
          </div>

          {/* Time Decay Factor */}
          <div className="space-y-1">
            <Label htmlFor="time_decay" className="text-xs">Time Decay</Label>
            <Input
              id="time_decay"
              type="number"
              step="0.1"
              min="0"
              max="1"
              value={localConfig.theta_time_decay_factor}
              onChange={(e) => setLocalConfig(prev => ({ 
                ...prev, 
                theta_time_decay_factor: Number(e.target.value) 
              }))}
              className="h-8"
            />
          </div>

          {/* Inventory Factor */}
          <div className="space-y-1">
            <Label htmlFor="inv_factor" className="text-xs">Inventory Factor</Label>
            <Input
              id="inv_factor"
              type="number"
              step="0.1"
              min="0"
              max="1"
              value={localConfig.theta_inventory_factor}
              onChange={(e) => setLocalConfig(prev => ({ 
                ...prev, 
                theta_inventory_factor: Number(e.target.value) 
              }))}
              className="h-8"
            />
          </div>

          {/* Max Inventory */}
          <div className="space-y-1">
            <Label htmlFor="i_max" className="text-xs">Max Inventory</Label>
            <Input
              id="i_max"
              type="number"
              step="50"
              min="50"
              value={localConfig.i_max_base}
              onChange={(e) => setLocalConfig(prev => ({ 
                ...prev, 
                i_max_base: Number(e.target.value) 
              }))}
              className="h-8"
            />
          </div>

          {/* Bet Size */}
          <div className="space-y-1">
            <Label htmlFor="bet_size" className="text-xs">Bet Size</Label>
            <Input
              id="bet_size"
              type="number"
              step="10"
              min="5"
              value={localConfig.bet_size_base}
              onChange={(e) => setLocalConfig(prev => ({ 
                ...prev, 
                bet_size_base: Number(e.target.value) 
              }))}
              className="h-8"
            />
          </div>

          {/* Force Counter % */}
          <div className="space-y-1">
            <Label htmlFor="force_pct" className="text-xs">Force Counter %</Label>
            <Input
              id="force_pct"
              type="number"
              step="5"
              min="50"
              max="100"
              value={(localConfig.force_counter_at_pct * 100).toFixed(0)}
              onChange={(e) => setLocalConfig(prev => ({ 
                ...prev, 
                force_counter_at_pct: Number(e.target.value) / 100 
              }))}
              className="h-8"
            />
          </div>

          {/* Aggressive Exit Sec */}
          <div className="space-y-1">
            <Label htmlFor="exit_sec" className="text-xs">Exit Sec</Label>
            <Input
              id="exit_sec"
              type="number"
              step="10"
              min="10"
              value={localConfig.aggressive_exit_sec}
              onChange={(e) => setLocalConfig(prev => ({ 
                ...prev, 
                aggressive_exit_sec: Number(e.target.value) 
              }))}
              className="h-8"
            />
          </div>

          {/* Model */}
          <div className="space-y-1">
            <Label className="text-xs">Model</Label>
            <div className="h-8 flex items-center text-sm text-muted-foreground">
              {localConfig.fair_value_model}
            </div>
          </div>
        </div>

        <div className="flex justify-end">
          <Button onClick={handleSave} disabled={saving} size="sm">
            {saving ? 'Saving...' : 'Save Config'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
