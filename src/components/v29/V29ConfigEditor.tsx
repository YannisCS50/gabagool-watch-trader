import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';
import { Settings, Save, RotateCcw, Zap, DollarSign, Clock } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

interface V29Config {
  id: string;
  enabled: boolean;
  tick_delta_usd: number;
  delta_threshold: number;
  min_share_price: number;
  max_share_price: number;
  shares_per_trade: number;
  prevent_counter_scalping: boolean;
  take_profit_cents: number;
  timeout_seconds: number;
  max_sell_retries: number;
  price_buffer_cents: number;
  assets: string[];
  binance_poll_ms: number;
  orderbook_poll_ms: number;
  order_cooldown_ms: number;
}

const DEFAULT_CONFIG: V29Config = {
  id: 'default',
  enabled: true,
  tick_delta_usd: 6,
  delta_threshold: 75,
  min_share_price: 0.30,
  max_share_price: 0.75,
  shares_per_trade: 5,
  prevent_counter_scalping: false,
  take_profit_cents: 4,
  timeout_seconds: 10,
  max_sell_retries: 5,
  price_buffer_cents: 1,
  assets: ['BTC', 'ETH', 'SOL', 'XRP'],
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
          await createDefaultConfig();
        } else {
          throw error;
        }
      } else {
        // Map old fields to new fields if they exist
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const dbData = data as any;
        const mappedConfig: V29Config = {
          id: dbData.id,
          enabled: dbData.enabled ?? true,
          tick_delta_usd: dbData.tick_delta_usd ?? 6,
          delta_threshold: dbData.delta_threshold ?? 75,
          min_share_price: dbData.min_share_price ?? 0.30,
          max_share_price: dbData.max_share_price ?? 0.75,
          shares_per_trade: dbData.shares_per_trade ?? dbData.max_shares ?? 5,
          prevent_counter_scalping: dbData.prevent_counter_scalping ?? false,
          take_profit_cents: dbData.take_profit_cents ?? dbData.min_profit_cents ?? 4,
          timeout_seconds: dbData.timeout_seconds ?? (dbData.timeout_ms ? dbData.timeout_ms / 1000 : 10),
          max_sell_retries: dbData.max_sell_retries ?? 5,
          price_buffer_cents: dbData.price_buffer_cents ?? 1,
          assets: dbData.assets ?? ['BTC', 'ETH', 'SOL', 'XRP'],
          binance_poll_ms: dbData.binance_poll_ms ?? 100,
          orderbook_poll_ms: dbData.orderbook_poll_ms ?? 2000,
          order_cooldown_ms: dbData.order_cooldown_ms ?? 3000,
        };
        setConfig(mappedConfig);
      }
    } catch (err) {
      console.error('Failed to load V29 config:', err);
      toast.error('Kon V29 config niet laden');
    } finally {
      setLoading(false);
    }
  };

  const createDefaultConfig = async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await supabase
      .from('v29_config')
      .insert(DEFAULT_CONFIG as any)
      .select()
      .single();

    if (error) throw error;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setConfig(data as any as V29Config);
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await supabase
        .from('v29_config')
        .update({
          enabled: config.enabled,
          tick_delta_usd: config.tick_delta_usd,
          delta_threshold: config.delta_threshold,
          min_share_price: config.min_share_price,
          max_share_price: config.max_share_price,
          shares_per_trade: config.shares_per_trade,
          prevent_counter_scalping: config.prevent_counter_scalping,
          take_profit_cents: config.take_profit_cents,
          timeout_seconds: config.timeout_seconds,
          max_sell_retries: config.max_sell_retries,
          price_buffer_cents: config.price_buffer_cents,
          assets: config.assets,
          binance_poll_ms: config.binance_poll_ms,
          orderbook_poll_ms: config.orderbook_poll_ms,
          order_cooldown_ms: config.order_cooldown_ms,
        } as any)
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
          V29 Simple Strategy
          {hasChanges && (
            <Badge variant="outline" className="text-amber-500 border-amber-500">
              Unsaved
            </Badge>
          )}
        </CardTitle>
        <CardDescription>
          Buy {config.shares_per_trade} shares → TP {config.take_profit_cents}¢ → Timeout {config.timeout_seconds}s → 1 positie max
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

        {/* Strategy Summary */}
        <div className="p-4 rounded-lg bg-green-500/10 border border-green-500/20">
          <p className="font-medium text-green-400 mb-2">📋 Strategie:</p>
          <ul className="text-sm text-muted-foreground space-y-1">
            <li>1. Binance spike (${config.tick_delta_usd}) → Koop <strong>{config.shares_per_trade} shares</strong></li>
            <li>2. Bij <strong>+{config.take_profit_cents}¢</strong> winst → Verkoop</li>
            <li>3. Timeout: <strong>{config.timeout_seconds}s</strong> → Market sell</li>
            <li>4. Max sell retries: <strong>{config.max_sell_retries}x</strong>, daarna force sell</li>
            <li>5. <strong>Max 1 positie</strong> tegelijk (geen stacking!)</li>
            {config.prevent_counter_scalping && (
              <li className="text-amber-400">6. 🛡️ <strong>Counter-scalp blocker ACTIEF</strong> - geen opposite trades!</li>
            )}
          </ul>
        </div>

        {/* Counter-Scalping Toggle */}
        <div className="flex items-center justify-between p-3 rounded-lg bg-amber-500/10 border border-amber-500/20">
          <div className="flex items-center gap-3">
            <Switch
              checked={config.prevent_counter_scalping}
              onCheckedChange={(v) => updateField('prevent_counter_scalping', v)}
            />
            <div>
              <Label className="text-amber-400">Prevent Counter-Scalping</Label>
              <p className="text-xs text-muted-foreground">
                {config.prevent_counter_scalping 
                  ? '🛡️ Blokkeert kopen van tegenovergestelde richting als je al positie hebt' 
                  : '⚠️ Kan beide richtingen kopen in dezelfde markt'}
              </p>
            </div>
          </div>
          {config.prevent_counter_scalping && (
            <Badge variant="outline" className="text-amber-400 border-amber-400">
              BESCHERMD
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
          
          {/* Delta Direction Logic */}
          <div className="p-3 rounded-lg bg-blue-500/10 border border-blue-500/20 text-sm">
            <p className="font-medium text-blue-400 mb-2">Delta Richtingslogica:</p>
            <ul className="text-xs text-muted-foreground space-y-1">
              <li>• Delta tussen <strong>-{config.delta_threshold}</strong> en <strong>+{config.delta_threshold}</strong>: trade beide richtingen</li>
              <li>• Delta &lt; -{config.delta_threshold}: alleen DOWN trades</li>
              <li>• Delta &gt; +{config.delta_threshold}: alleen UP trades</li>
            </ul>
          </div>
          
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label className="text-xs">Tick Delta (USD)</Label>
              <Input
                type="number"
                value={config.tick_delta_usd}
                onChange={(e) => updateField('tick_delta_usd', parseFloat(e.target.value) || 0)}
                className="h-9"
              />
              <p className="text-xs text-muted-foreground">
                Trigger bij ${config.tick_delta_usd} prijsverandering
              </p>
            </div>
            
            <div className="space-y-2">
              <Label className="text-xs">Delta Threshold (USD)</Label>
              <Input
                type="number"
                value={config.delta_threshold}
                onChange={(e) => updateField('delta_threshold', parseFloat(e.target.value) || 0)}
                className="h-9"
              />
              <p className="text-xs text-muted-foreground">
                ±${config.delta_threshold} richtingslogica
              </p>
            </div>
            
            <div className="space-y-2">
              <Label className="text-xs">Min Share Price</Label>
              <Input
                type="number"
                step="0.01"
                value={config.min_share_price}
                onChange={(e) => updateField('min_share_price', parseFloat(e.target.value) || 0)}
                className="h-9"
              />
              <p className="text-xs text-muted-foreground">
                Minimaal {(config.min_share_price * 100).toFixed(0)}¢
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
                Maximaal {(config.max_share_price * 100).toFixed(0)}¢
              </p>
            </div>
            
            <div className="space-y-2">
              <Label className="text-xs">Shares per Trade</Label>
              <Input
                type="number"
                value={config.shares_per_trade}
                onChange={(e) => updateField('shares_per_trade', parseInt(e.target.value) || 5)}
                className="h-9"
              />
              <p className="text-xs text-muted-foreground">
                Vaste {config.shares_per_trade} shares per trade
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

        {/* Exit Settings */}
        <div className="space-y-4">
          <h4 className="font-medium text-sm text-muted-foreground flex items-center gap-2">
            <Clock className="h-4 w-4" />
            Exit Instellingen
          </h4>
          
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-3 p-3 rounded-lg bg-green-500/5 border border-green-500/20">
              <Label className="text-sm text-green-400">Take Profit (¢)</Label>
              <Input
                type="number"
                value={config.take_profit_cents}
                onChange={(e) => updateField('take_profit_cents', parseFloat(e.target.value) || 4)}
                className="h-9"
              />
              <p className="text-xs text-muted-foreground">
                Verkoop bij +{config.take_profit_cents}¢ winst
              </p>
            </div>
            
            <div className="space-y-3 p-3 rounded-lg bg-amber-500/5 border border-amber-500/20">
              <Label className="text-sm text-amber-400">Timeout (sec)</Label>
              <Input
                type="number"
                value={config.timeout_seconds}
                onChange={(e) => updateField('timeout_seconds', parseInt(e.target.value) || 10)}
                className="h-9"
              />
              <p className="text-xs text-muted-foreground">
                Na {config.timeout_seconds}s → market sell
              </p>
            </div>
            
            <div className="space-y-3 p-3 rounded-lg bg-red-500/5 border border-red-500/20">
              <Label className="text-sm text-red-400">Max Sell Retries</Label>
              <Input
                type="number"
                value={config.max_sell_retries}
                onChange={(e) => updateField('max_sell_retries', parseInt(e.target.value) || 5)}
                className="h-9"
              />
              <p className="text-xs text-muted-foreground">
                Na {config.max_sell_retries}x → force sell
              </p>
            </div>
            
            <div className="space-y-3 p-3 rounded-lg bg-muted/30">
              <Label className="text-sm">Order Cooldown (ms)</Label>
              <Input
                type="number"
                value={config.order_cooldown_ms}
                onChange={(e) => updateField('order_cooldown_ms', parseInt(e.target.value) || 3000)}
                className="h-9"
              />
              <p className="text-xs text-muted-foreground">
                {(config.order_cooldown_ms / 1000).toFixed(1)}s tussen orders
              </p>
            </div>
          </div>
        </div>

        <Separator />

        {/* Polling Settings (collapsed) */}
        <details className="space-y-4">
          <summary className="cursor-pointer text-sm text-muted-foreground">
            ⚙️ Geavanceerde Instellingen
          </summary>
          <div className="grid grid-cols-2 gap-4 mt-4">
            <div className="space-y-2">
              <Label className="text-xs">Binance Poll (ms)</Label>
              <Input
                type="number"
                value={config.binance_poll_ms}
                onChange={(e) => updateField('binance_poll_ms', parseInt(e.target.value) || 100)}
                className="h-9"
              />
            </div>
            
            <div className="space-y-2">
              <Label className="text-xs">Orderbook Poll (ms)</Label>
              <Input
                type="number"
                value={config.orderbook_poll_ms}
                onChange={(e) => updateField('orderbook_poll_ms', parseInt(e.target.value) || 2000)}
                className="h-9"
              />
            </div>
          </div>
        </details>

        <Separator />

        {/* Actions */}
        <div className="flex items-center gap-3">
          <Button
            onClick={saveConfig}
            disabled={saving || !hasChanges}
            className="flex-1"
          >
            {saving ? (
              <>Opslaan...</>
            ) : (
              <>
                <Save className="h-4 w-4 mr-2" />
                Opslaan
              </>
            )}
          </Button>
          
          <Button
            variant="outline"
            onClick={resetToDefaults}
          >
            <RotateCcw className="h-4 w-4 mr-2" />
            Reset
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
