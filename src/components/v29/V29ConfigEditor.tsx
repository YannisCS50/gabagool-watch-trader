import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';
import { Settings, Save, RotateCcw, AlertTriangle, Zap, Shield, Clock, DollarSign } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

interface V29Config {
  id: string;
  enabled: boolean;
  min_delta_usd: number;
  max_share_price: number;
  trade_size_usd: number;
  max_shares: number;
  price_buffer_cents: number;
  assets: string[];
  tp_enabled: boolean;
  tp_cents: number;
  sl_enabled: boolean;
  sl_cents: number;
  timeout_ms: number;
  binance_poll_ms: number;
  orderbook_poll_ms: number;
  order_cooldown_ms: number;
}

const DEFAULT_CONFIG: V29Config = {
  id: 'default',
  enabled: true,
  min_delta_usd: 150,
  max_share_price: 0.65,
  trade_size_usd: 5,
  max_shares: 10,
  price_buffer_cents: 1,
  assets: ['BTC', 'ETH', 'SOL', 'XRP'],
  tp_enabled: true,
  tp_cents: 2,
  sl_enabled: true,
  sl_cents: 3,
  timeout_ms: 30000,
  binance_poll_ms: 100,
  orderbook_poll_ms: 2000,
  order_cooldown_ms: 3000,
};

const AVAILABLE_ASSETS = ['BTC', 'ETH', 'SOL', 'XRP'];

export function V29ConfigEditor() {
  const [config, setConfig] = useState<V29Config | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);

  useEffect(() => {
    fetchConfig();
  }, []);

  const fetchConfig = async () => {
    try {
      const { data, error } = await supabase
        .from('v29_config')
        .select('*')
        .eq('id', 'default')
        .single();

      if (error) {
        if (error.code === 'PGRST116') {
          // No config exists, create default
          await createDefaultConfig();
        } else {
          throw error;
        }
      } else {
        setConfig(data as V29Config);
      }
    } catch (err) {
      console.error('Failed to load V29 config:', err);
      toast.error('Kon V29 config niet laden');
    } finally {
      setLoading(false);
    }
  };

  const createDefaultConfig = async () => {
    const { data, error } = await supabase
      .from('v29_config')
      .insert(DEFAULT_CONFIG)
      .select()
      .single();

    if (error) throw error;
    setConfig(data as V29Config);
  };

  const updateField = <K extends keyof V29Config>(field: K, value: V29Config[K]) => {
    if (!config) return;
    setConfig({ ...config, [field]: value });
    setHasChanges(true);
  };

  const toggleAsset = (asset: string) => {
    if (!config) return;
    const newAssets = config.assets.includes(asset)
      ? config.assets.filter(a => a !== asset)
      : [...config.assets, asset];
    updateField('assets', newAssets);
  };

  const saveConfig = async () => {
    if (!config) return;
    setSaving(true);
    try {
      const { error } = await supabase
        .from('v29_config')
        .update({
          enabled: config.enabled,
          min_delta_usd: config.min_delta_usd,
          max_share_price: config.max_share_price,
          trade_size_usd: config.trade_size_usd,
          max_shares: config.max_shares,
          price_buffer_cents: config.price_buffer_cents,
          assets: config.assets,
          tp_enabled: config.tp_enabled,
          tp_cents: config.tp_cents,
          sl_enabled: config.sl_enabled,
          sl_cents: config.sl_cents,
          timeout_ms: config.timeout_ms,
          binance_poll_ms: config.binance_poll_ms,
          orderbook_poll_ms: config.orderbook_poll_ms,
          order_cooldown_ms: config.order_cooldown_ms,
        })
        .eq('id', 'default');

      if (error) throw error;

      toast.success('V29 config opgeslagen! Runner pikt dit automatisch op.');
      setHasChanges(false);
    } catch (err) {
      console.error('Failed to save config:', err);
      toast.error('Kon config niet opslaan');
    } finally {
      setSaving(false);
    }
  };

  const resetToDefaults = () => {
    setConfig(DEFAULT_CONFIG);
    setHasChanges(true);
  };

  if (loading) {
    return (
      <Card>
        <CardContent className="pt-6">
          <p className="text-muted-foreground text-center">Config laden...</p>
        </CardContent>
      </Card>
    );
  }

  if (!config) {
    return (
      <Card>
        <CardContent className="pt-6">
          <p className="text-muted-foreground text-center">Geen config gevonden</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg flex items-center gap-2">
          <Settings className="h-5 w-5" />
          V29 Runner Configuratie
          {hasChanges && (
            <Badge variant="outline" className="text-amber-500 border-amber-500">
              Unsaved
            </Badge>
          )}
        </CardTitle>
        <CardDescription>
          Tick-to-tick delta detectie • Realtime orderbook pricing
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Master Enable Toggle */}
        <div className="flex items-center justify-between p-3 rounded-lg bg-muted/30">
          <div className="flex items-center gap-3">
            <Switch
              checked={config.enabled}
              onCheckedChange={(v) => updateField('enabled', v)}
            />
            <div>
              <Label>Trading Enabled</Label>
              <p className="text-xs text-muted-foreground">
                {config.enabled ? 'LIVE TRADING ACTIEF' : 'Trading uitgeschakeld'}
              </p>
            </div>
          </div>
          {config.enabled && (
            <Badge variant="destructive" className="animate-pulse">
              <Zap className="h-3 w-3 mr-1" />
              LIVE
            </Badge>
          )}
        </div>

        {/* Assets Selection */}
        <div className="space-y-3">
          <h4 className="font-medium text-sm text-muted-foreground flex items-center gap-2">
            <DollarSign className="h-4 w-4" />
            Assets
          </h4>
          <div className="flex flex-wrap gap-2">
            {AVAILABLE_ASSETS.map(asset => (
              <Button
                key={asset}
                variant={config.assets.includes(asset) ? 'default' : 'outline'}
                size="sm"
                onClick={() => toggleAsset(asset)}
              >
                {asset}
              </Button>
            ))}
          </div>
        </div>

        <Separator />

        {/* Entry Settings */}
        <div className="space-y-4">
          <h4 className="font-medium text-sm text-muted-foreground flex items-center gap-2">
            <Zap className="h-4 w-4" />
            Entry Instellingen
          </h4>
          
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label className="text-xs">Min Delta (USD)</Label>
              <Input
                type="number"
                value={config.min_delta_usd}
                onChange={(e) => updateField('min_delta_usd', parseFloat(e.target.value) || 0)}
                className="h-9"
              />
              <p className="text-xs text-muted-foreground">
                Binance moet ${config.min_delta_usd} van strike afwijken
              </p>
            </div>
            
            <div className="space-y-2">
              <Label className="text-xs">Max Share Price</Label>
              <Input
                type="number"
                step="0.01"
                value={config.max_share_price}
                onChange={(e) => updateField('max_share_price', parseFloat(e.target.value) || 0)}
                className="h-9"
              />
              <p className="text-xs text-muted-foreground">
                Maximaal {(config.max_share_price * 100).toFixed(0)}¢ per share
              </p>
            </div>
            
            <div className="space-y-2">
              <Label className="text-xs">Trade Size (USD)</Label>
              <Input
                type="number"
                value={config.trade_size_usd}
                onChange={(e) => updateField('trade_size_usd', parseFloat(e.target.value) || 0)}
                className="h-9"
              />
              <p className="text-xs text-muted-foreground">
                ${config.trade_size_usd} per trade
              </p>
            </div>
            
            <div className="space-y-2">
              <Label className="text-xs">Max Shares</Label>
              <Input
                type="number"
                value={config.max_shares}
                onChange={(e) => updateField('max_shares', parseInt(e.target.value) || 0)}
                className="h-9"
              />
              <p className="text-xs text-muted-foreground">
                Maximum {config.max_shares} shares per order
              </p>
            </div>
            
            <div className="space-y-2">
              <Label className="text-xs">Price Buffer (cents)</Label>
              <Input
                type="number"
                value={config.price_buffer_cents}
                onChange={(e) => updateField('price_buffer_cents', parseFloat(e.target.value) || 0)}
                className="h-9"
              />
              <p className="text-xs text-muted-foreground">
                {config.price_buffer_cents}¢ boven best ask
              </p>
            </div>
          </div>
        </div>

        <Separator />

        {/* Take Profit & Stop Loss */}
        <div className="space-y-4">
          <h4 className="font-medium text-sm text-muted-foreground flex items-center gap-2">
            <Shield className="h-4 w-4" />
            Exit Instellingen
          </h4>
          
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-3 p-3 rounded-lg bg-green-500/5 border border-green-500/20">
              <div className="flex items-center justify-between">
                <Label className="text-sm text-green-400">Take Profit</Label>
                <Switch
                  checked={config.tp_enabled}
                  onCheckedChange={(v) => updateField('tp_enabled', v)}
                />
              </div>
              <Input
                type="number"
                value={config.tp_cents}
                onChange={(e) => updateField('tp_cents', parseFloat(e.target.value) || 0)}
                disabled={!config.tp_enabled}
                className="h-9"
              />
              <p className="text-xs text-muted-foreground">
                Verkoop als prijs +{config.tp_cents}¢ stijgt
              </p>
            </div>
            
            <div className="space-y-3 p-3 rounded-lg bg-red-500/5 border border-red-500/20">
              <div className="flex items-center justify-between">
                <Label className="text-sm text-red-400">Stop Loss</Label>
                <Switch
                  checked={config.sl_enabled}
                  onCheckedChange={(v) => updateField('sl_enabled', v)}
                />
              </div>
              <Input
                type="number"
                value={config.sl_cents}
                onChange={(e) => updateField('sl_cents', parseFloat(e.target.value) || 0)}
                disabled={!config.sl_enabled}
                className="h-9"
              />
              <p className="text-xs text-muted-foreground">
                Verkoop als prijs -{config.sl_cents}¢ daalt
              </p>
            </div>
          </div>
          
          <div className="space-y-2">
            <Label className="text-xs">Timeout (ms)</Label>
            <Input
              type="number"
              value={config.timeout_ms}
              onChange={(e) => updateField('timeout_ms', parseInt(e.target.value) || 0)}
              className="h-9"
            />
            <p className="text-xs text-muted-foreground">
              Auto-close positie na {(config.timeout_ms / 1000).toFixed(0)}s
            </p>
          </div>
        </div>

        <Separator />

        {/* Polling Settings */}
        <div className="space-y-4">
          <h4 className="font-medium text-sm text-muted-foreground flex items-center gap-2">
            <Clock className="h-4 w-4" />
            Polling Instellingen
          </h4>
          
          <div className="grid grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label className="text-xs">Binance Poll (ms)</Label>
              <Input
                type="number"
                value={config.binance_poll_ms}
                onChange={(e) => updateField('binance_poll_ms', parseInt(e.target.value) || 0)}
                className="h-9"
              />
            </div>
            
            <div className="space-y-2">
              <Label className="text-xs">Orderbook Poll (ms)</Label>
              <Input
                type="number"
                value={config.orderbook_poll_ms}
                onChange={(e) => updateField('orderbook_poll_ms', parseInt(e.target.value) || 0)}
                className="h-9"
              />
            </div>
            
            <div className="space-y-2">
              <Label className="text-xs">Order Cooldown (ms)</Label>
              <Input
                type="number"
                value={config.order_cooldown_ms}
                onChange={(e) => updateField('order_cooldown_ms', parseInt(e.target.value) || 0)}
                className="h-9"
              />
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="flex gap-2 pt-4">
          <Button onClick={saveConfig} disabled={saving || !hasChanges} className="flex-1">
            <Save className="h-4 w-4 mr-2" />
            {saving ? 'Opslaan...' : 'Opslaan'}
          </Button>
          <Button variant="outline" onClick={resetToDefaults}>
            <RotateCcw className="h-4 w-4 mr-2" />
            Reset
          </Button>
        </div>
        
        {hasChanges && (
          <p className="text-xs text-amber-500 flex items-center gap-1">
            <AlertTriangle className="h-3 w-3" />
            Wijzigingen niet opgeslagen. De runner laadt de nieuwe config automatisch na opslaan.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
