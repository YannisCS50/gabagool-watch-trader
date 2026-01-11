import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Settings, Save, RotateCcw, AlertTriangle } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

interface AssetThreshold {
  min: number;
  max: number;
  current: number;
}

interface V27Config {
  enabled: boolean;
  shadow_mode: boolean;
  assets: string[];
  asset_thresholds: Record<string, AssetThreshold>;
  causality_min_ms: number;
  causality_max_ms: number;
  correction_threshold_pct: number;
}

interface V27ConfigEditorProps {
  config: V27Config | null;
  onConfigUpdated: () => void;
}

const ASSET_DISPLAY: Record<string, { label: string; unit: string; decimals: number }> = {
  BTC: { label: 'Bitcoin', unit: '$', decimals: 0 },
  ETH: { label: 'Ethereum', unit: '$', decimals: 2 },
  SOL: { label: 'Solana', unit: '$', decimals: 2 },
  XRP: { label: 'XRP', unit: '$', decimals: 4 },
};

export function V27ConfigEditor({ config, onConfigUpdated }: V27ConfigEditorProps) {
  const [localConfig, setLocalConfig] = useState<V27Config | null>(config);
  const [saving, setSaving] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);

  if (!localConfig) {
    return (
      <Card>
        <CardContent className="pt-6">
          <p className="text-muted-foreground text-center">Geen config geladen</p>
        </CardContent>
      </Card>
    );
  }

  const updateThreshold = (asset: string, value: number) => {
    const thresholds = { ...localConfig.asset_thresholds };
    const assetConfig = thresholds[asset];
    
    // Clamp to min/max
    const clamped = Math.max(assetConfig.min, Math.min(assetConfig.max, value));
    
    thresholds[asset] = { ...assetConfig, current: clamped };
    setLocalConfig({ ...localConfig, asset_thresholds: thresholds });
    setHasChanges(true);
  };

  const saveConfig = async () => {
    setSaving(true);
    try {
      const updatePayload = {
        enabled: localConfig.enabled,
        shadow_mode: localConfig.shadow_mode,
        asset_thresholds: JSON.parse(JSON.stringify(localConfig.asset_thresholds)),
        causality_min_ms: localConfig.causality_min_ms,
        causality_max_ms: localConfig.causality_max_ms,
        correction_threshold_pct: localConfig.correction_threshold_pct,
      };
      
      const { error } = await supabase
        .from('v27_config')
        .update(updatePayload)
        .eq('id', 'default');

      if (error) throw error;
      
      toast.success('V27 config opgeslagen');
      setHasChanges(false);
      onConfigUpdated();
    } catch (err) {
      console.error('Failed to save config:', err);
      toast.error('Kon config niet opslaan');
    } finally {
      setSaving(false);
    }
  };

  const resetToDefaults = () => {
    setLocalConfig({
      ...localConfig,
      asset_thresholds: {
        BTC: { min: 45, max: 70, current: 55 },
        ETH: { min: 0.18, max: 0.30, current: 0.22 },
        SOL: { min: 0.08, max: 0.15, current: 0.10 },
        XRP: { min: 0.003, max: 0.008, current: 0.005 },
      },
    });
    setHasChanges(true);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg flex items-center gap-2">
          <Settings className="h-5 w-5" />
          Threshold Configuratie
          {hasChanges && (
            <Badge variant="outline" className="text-amber-500 border-amber-500">
              Unsaved
            </Badge>
          )}
        </CardTitle>
        <CardDescription>
          Pas delta thresholds aan om meer/minder opportunities te krijgen
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Global Settings */}
        <div className="flex items-center justify-between p-3 rounded-lg bg-muted/30">
          <div className="flex items-center gap-3">
            <Switch
              checked={localConfig.shadow_mode}
              onCheckedChange={(v) => {
                setLocalConfig({ ...localConfig, shadow_mode: v });
                setHasChanges(true);
              }}
            />
            <div>
              <Label>Shadow Mode</Label>
              <p className="text-xs text-muted-foreground">
                {localConfig.shadow_mode ? 'Alleen loggen, geen echte trades' : 'LIVE TRADING'}
              </p>
            </div>
          </div>
          {!localConfig.shadow_mode && (
            <Badge variant="destructive" className="animate-pulse">
              <AlertTriangle className="h-3 w-3 mr-1" />
              LIVE
            </Badge>
          )}
        </div>

        {/* Asset Thresholds */}
        <div className="space-y-4">
          <h4 className="font-medium text-sm text-muted-foreground">Delta Thresholds per Asset</h4>
          
          {Object.entries(localConfig.asset_thresholds).map(([asset, threshold]) => {
            const display = ASSET_DISPLAY[asset] || { label: asset, unit: '$', decimals: 2 };
            const range = threshold.max - threshold.min;
            const sliderValue = ((threshold.current - threshold.min) / range) * 100;
            
            return (
              <div key={asset} className="space-y-2 p-3 rounded-lg bg-muted/20">
                <div className="flex items-center justify-between">
                  <div>
                    <span className="font-medium">{display.label}</span>
                    <Badge variant="outline" className="ml-2 text-xs">{asset}</Badge>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-muted-foreground">
                      {display.unit}{threshold.current.toFixed(display.decimals)}
                    </span>
                    <Input
                      type="number"
                      step={display.decimals === 0 ? 1 : Math.pow(10, -display.decimals)}
                      min={threshold.min}
                      max={threshold.max}
                      value={threshold.current}
                      onChange={(e) => updateThreshold(asset, parseFloat(e.target.value) || 0)}
                      className="w-24 h-8 text-right"
                    />
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-xs text-muted-foreground w-16">
                    {display.unit}{threshold.min.toFixed(display.decimals)}
                  </span>
                  <Slider
                    value={[sliderValue]}
                    max={100}
                    step={1}
                    onValueChange={([v]) => {
                      const newValue = threshold.min + (v / 100) * range;
                      updateThreshold(asset, newValue);
                    }}
                    className="flex-1"
                  />
                  <span className="text-xs text-muted-foreground w-16 text-right">
                    {display.unit}{threshold.max.toFixed(display.decimals)}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">
                  Spot moet &gt;{display.unit}{threshold.current.toFixed(display.decimals)} van strike afwijken
                </p>
              </div>
            );
          })}
        </div>

        {/* Causality Settings */}
        <div className="space-y-3 p-3 rounded-lg bg-muted/20">
          <h4 className="font-medium text-sm text-muted-foreground">Causality Window</h4>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label className="text-xs">Min Lead (ms)</Label>
              <Input
                type="number"
                value={localConfig.causality_min_ms}
                onChange={(e) => {
                  setLocalConfig({ ...localConfig, causality_min_ms: parseInt(e.target.value) || 200 });
                  setHasChanges(true);
                }}
                className="h-8"
              />
            </div>
            <div>
              <Label className="text-xs">Max Lead (ms)</Label>
              <Input
                type="number"
                value={localConfig.causality_max_ms}
                onChange={(e) => {
                  setLocalConfig({ ...localConfig, causality_max_ms: parseInt(e.target.value) || 3000 });
                  setHasChanges(true);
                }}
                className="h-8"
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Spot moet {localConfig.causality_min_ms}-{localConfig.causality_max_ms}ms vóór Polymarket bewegen
          </p>
        </div>

        {/* Actions */}
        <div className="flex gap-2">
          <Button onClick={saveConfig} disabled={saving || !hasChanges} className="flex-1">
            <Save className="h-4 w-4 mr-2" />
            {saving ? 'Opslaan...' : 'Opslaan'}
          </Button>
          <Button variant="outline" onClick={resetToDefaults}>
            <RotateCcw className="h-4 w-4 mr-2" />
            Reset
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
