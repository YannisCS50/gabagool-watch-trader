import { useState, useEffect } from 'react';
import { Settings2, Save, Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

interface V26Config {
  id: string;
  enabled: boolean;
  max_lead_time_sec: number;
  min_lead_time_sec: number;
  cancel_after_start_sec: number;
  config_version: number;
  updated_at: string;
}

interface AssetConfig {
  id: string;
  asset: string;
  enabled: boolean;
  shares: number;
  price: number;
  side: 'UP' | 'DOWN';
}

const AVAILABLE_ASSETS = ['BTC', 'ETH', 'SOL', 'XRP'] as const;

export function V26StrategyModal() {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [globalConfig, setGlobalConfig] = useState<V26Config | null>(null);
  const [assetConfigs, setAssetConfigs] = useState<AssetConfig[]>([]);

  // Global form state
  const [enabled, setEnabled] = useState(true);
  const [maxLeadTimeSec, setMaxLeadTimeSec] = useState(600);
  const [minLeadTimeSec, setMinLeadTimeSec] = useState(60);
  const [cancelAfterStartSec, setCancelAfterStartSec] = useState(30);

  // Per-asset form state
  const [assetSettings, setAssetSettings] = useState<Record<string, { enabled: boolean; shares: number; price: number; side: 'UP' | 'DOWN' }>>({
    BTC: { enabled: true, shares: 10, price: 0.48, side: 'DOWN' },
    ETH: { enabled: true, shares: 10, price: 0.48, side: 'DOWN' },
    SOL: { enabled: true, shares: 10, price: 0.48, side: 'DOWN' },
    XRP: { enabled: true, shares: 10, price: 0.48, side: 'DOWN' },
  });

  const fetchConfig = async () => {
    setLoading(true);
    
    // Fetch global config and per-asset config in parallel
    const [globalRes, assetRes] = await Promise.all([
      supabase.from('v26_config').select('*').limit(1).single(),
      supabase.from('v26_asset_config').select('*').order('asset'),
    ]);

    if (globalRes.error) {
      console.error('Failed to fetch global config:', globalRes.error);
    } else if (globalRes.data) {
      const cfg = globalRes.data as V26Config;
      setGlobalConfig(cfg);
      setEnabled(cfg.enabled);
      setMaxLeadTimeSec(cfg.max_lead_time_sec);
      setMinLeadTimeSec(cfg.min_lead_time_sec);
      setCancelAfterStartSec(cfg.cancel_after_start_sec);
    }

    if (assetRes.error) {
      console.error('Failed to fetch asset configs:', assetRes.error);
    } else if (assetRes.data) {
      const configs = assetRes.data as AssetConfig[];
      setAssetConfigs(configs);
      
      const newSettings: typeof assetSettings = {};
      for (const cfg of configs) {
        newSettings[cfg.asset] = {
          enabled: cfg.enabled,
          shares: cfg.shares,
          price: Number(cfg.price),
          side: cfg.side as 'UP' | 'DOWN',
        };
      }
      setAssetSettings(prev => ({ ...prev, ...newSettings }));
    }

    setLoading(false);
  };

  useEffect(() => {
    if (open) {
      fetchConfig();
    }
  }, [open]);

  const handleSave = async () => {
    if (!globalConfig) return;

    setSaving(true);
    
    // Increment config_version to trigger runner reload
    const newVersion = (globalConfig.config_version || 1) + 1;
    
    // Update global config
    const { error: globalError } = await supabase
      .from('v26_config')
      .update({
        enabled,
        max_lead_time_sec: maxLeadTimeSec,
        min_lead_time_sec: minLeadTimeSec,
        cancel_after_start_sec: cancelAfterStartSec,
        config_version: newVersion,
        // Update assets array based on which are enabled
        assets: AVAILABLE_ASSETS.filter(a => assetSettings[a]?.enabled),
      })
      .eq('id', globalConfig.id);

    if (globalError) {
      console.error('Failed to save global config:', globalError);
      toast.error('Opslaan mislukt');
      setSaving(false);
      return;
    }

    // Update per-asset configs
    const updatePromises = assetConfigs.map(cfg => {
      const settings = assetSettings[cfg.asset];
      if (!settings) return Promise.resolve();
      
      return supabase
        .from('v26_asset_config')
        .update({
          enabled: settings.enabled,
          shares: settings.shares,
          price: settings.price,
          side: settings.side,
        })
        .eq('id', cfg.id);
    });

    await Promise.all(updatePromises);

    toast.success('✅ Opgeslagen! Runner herlaadt config binnen 10 seconden.');
    setOpen(false);
    setSaving(false);
  };

  const updateAssetSetting = (asset: string, key: keyof typeof assetSettings.BTC, value: any) => {
    setAssetSettings(prev => ({
      ...prev,
      [asset]: { ...prev[asset], [key]: value },
    }));
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Settings2 className="h-4 w-4 mr-2" />
          Strategy
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Settings2 className="h-5 w-5" />
            V26 Strategy Instellingen
          </DialogTitle>
          <DialogDescription>
            Pas de trading parameters per asset aan.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-6 py-4">
            {/* Global Enabled Toggle */}
            <div className="flex items-center justify-between p-3 rounded-lg bg-muted/30">
              <div>
                <Label htmlFor="enabled" className="text-base font-medium">
                  Strategy Actief
                </Label>
                <p className="text-sm text-muted-foreground">
                  Master switch voor alle trading
                </p>
              </div>
              <Switch
                id="enabled"
                checked={enabled}
                onCheckedChange={setEnabled}
              />
            </div>

            {/* Per-Asset Configuration */}
            <div className="space-y-3">
              <Label className="text-base font-medium">Asset Configuratie</Label>
              
              {AVAILABLE_ASSETS.map((asset) => {
                const settings = assetSettings[asset];
                if (!settings) return null;
                
                return (
                  <div 
                    key={asset} 
                    className={`p-3 rounded-lg border ${settings.enabled ? 'border-border bg-card' : 'border-border/50 bg-muted/20 opacity-60'}`}
                  >
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-lg">{asset}</span>
                        <Switch
                          checked={settings.enabled}
                          onCheckedChange={(v) => updateAssetSetting(asset, 'enabled', v)}
                        />
                      </div>
                      <div className="flex gap-1">
                        <Button
                          type="button"
                          variant={settings.side === 'DOWN' ? 'default' : 'outline'}
                          size="sm"
                          onClick={() => updateAssetSetting(asset, 'side', 'DOWN')}
                          className={`h-7 px-2 ${settings.side === 'DOWN' ? 'bg-red-500 hover:bg-red-600' : ''}`}
                          disabled={!settings.enabled}
                        >
                          DOWN
                        </Button>
                        <Button
                          type="button"
                          variant={settings.side === 'UP' ? 'default' : 'outline'}
                          size="sm"
                          onClick={() => updateAssetSetting(asset, 'side', 'UP')}
                          className={`h-7 px-2 ${settings.side === 'UP' ? 'bg-green-500 hover:bg-green-600' : ''}`}
                          disabled={!settings.enabled}
                        >
                          UP
                        </Button>
                      </div>
                    </div>
                    
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <Label className="text-xs text-muted-foreground">Shares</Label>
                        <Input
                          type="number"
                          min={1}
                          max={100}
                          value={settings.shares}
                          onChange={(e) => updateAssetSetting(asset, 'shares', parseInt(e.target.value) || 1)}
                          disabled={!settings.enabled}
                          className="h-8"
                        />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs text-muted-foreground">Prijs ($)</Label>
                        <Input
                          type="number"
                          min={0.01}
                          max={0.99}
                          step={0.01}
                          value={settings.price}
                          onChange={(e) => updateAssetSetting(asset, 'price', parseFloat(e.target.value) || 0.48)}
                          disabled={!settings.enabled}
                          className="h-8"
                        />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Timing Settings */}
            <div className="space-y-4">
              <Label className="text-base font-medium">Timing (globaal)</Label>
              <div className="grid grid-cols-3 gap-3">
                <div className="space-y-1">
                  <Label htmlFor="maxLead" className="text-xs text-muted-foreground">Max lead (sec)</Label>
                  <Input
                    id="maxLead"
                    type="number"
                    min={60}
                    max={900}
                    value={maxLeadTimeSec}
                    onChange={(e) => setMaxLeadTimeSec(parseInt(e.target.value) || 600)}
                    className="h-8"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="minLead" className="text-xs text-muted-foreground">Min lead (sec)</Label>
                  <Input
                    id="minLead"
                    type="number"
                    min={10}
                    max={300}
                    value={minLeadTimeSec}
                    onChange={(e) => setMinLeadTimeSec(parseInt(e.target.value) || 60)}
                    className="h-8"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="cancelAfter" className="text-xs text-muted-foreground">Cancel na (sec)</Label>
                  <Input
                    id="cancelAfter"
                    type="number"
                    min={10}
                    max={120}
                    value={cancelAfterStartSec}
                    onChange={(e) => setCancelAfterStartSec(parseInt(e.target.value) || 30)}
                    className="h-8"
                  />
                </div>
              </div>
            </div>

            {/* Last Updated */}
            {globalConfig?.updated_at && (
              <p className="text-xs text-muted-foreground text-center">
                Laatst bijgewerkt: {new Date(globalConfig.updated_at).toLocaleString('nl-NL')}
              </p>
            )}

            {/* Save Button */}
            <Button
              onClick={handleSave}
              disabled={saving}
              className="w-full"
            >
              {saving ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Opslaan...
                </>
              ) : (
                <>
                  <Save className="h-4 w-4 mr-2" />
                  Opslaan
                </>
              )}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
