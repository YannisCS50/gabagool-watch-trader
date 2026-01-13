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
  // Tick-to-tick delta detection
  tick_delta_usd: number;
  // Delta threshold for direction logic (strike - actual)
  delta_threshold: number;
  // Share price range
  min_share_price: number;
  max_share_price: number;
  // Trade settings
  trade_size_usd: number;
  max_shares: number;
  price_buffer_cents: number;
  assets: string[];
  // Trailing stop with minimum profit
  min_profit_cents: number;
  trailing_trigger_cents: number;
  trailing_distance_cents: number;
  emergency_sl_cents: number;
  // Timeout
  timeout_ms: number;
  // Polling
  binance_poll_ms: number;
  orderbook_poll_ms: number;
  order_cooldown_ms: number;
  // Accumulation & Auto-Hedge
  accumulation_enabled: boolean;
  max_total_cost_usd: number;
  max_total_shares: number;
  auto_hedge_enabled: boolean;
  hedge_trigger_cents: number;
  hedge_min_profit_cents: number;
}

const DEFAULT_CONFIG: V29Config = {
  id: 'default',
  enabled: true,
  tick_delta_usd: 6,
  delta_threshold: 70,
  min_share_price: 0.30,
  max_share_price: 0.75,
  trade_size_usd: 5,
  max_shares: 10,
  price_buffer_cents: 1,
  assets: ['BTC', 'ETH', 'SOL', 'XRP'],
  min_profit_cents: 4,
  trailing_trigger_cents: 7,
  trailing_distance_cents: 3,
  emergency_sl_cents: 10,
  timeout_ms: 30000,
  binance_poll_ms: 100,
  orderbook_poll_ms: 2000,
  order_cooldown_ms: 3000,
  // Accumulation & Hedge
  accumulation_enabled: true,
  max_total_cost_usd: 75,
  max_total_shares: 300,
  auto_hedge_enabled: true,
  hedge_trigger_cents: 15,
  hedge_min_profit_cents: 10,
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
          tick_delta_usd: config.tick_delta_usd,
          delta_threshold: config.delta_threshold,
          min_share_price: config.min_share_price,
          max_share_price: config.max_share_price,
          trade_size_usd: config.trade_size_usd,
          max_shares: config.max_shares,
          price_buffer_cents: config.price_buffer_cents,
          assets: config.assets,
          min_profit_cents: config.min_profit_cents,
          trailing_trigger_cents: config.trailing_trigger_cents,
          trailing_distance_cents: config.trailing_distance_cents,
          emergency_sl_cents: config.emergency_sl_cents,
          timeout_ms: config.timeout_ms,
          binance_poll_ms: config.binance_poll_ms,
          orderbook_poll_ms: config.orderbook_poll_ms,
          order_cooldown_ms: config.order_cooldown_ms,
          // Accumulation & Hedge
          accumulation_enabled: config.accumulation_enabled,
          max_total_cost_usd: config.max_total_cost_usd,
          max_total_shares: config.max_total_shares,
          auto_hedge_enabled: config.auto_hedge_enabled,
          hedge_trigger_cents: config.hedge_trigger_cents,
          hedge_min_profit_cents: config.hedge_min_profit_cents,
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
          
          {/* Delta-based Direction Logic Explanation */}
          <div className="p-3 rounded-lg bg-blue-500/10 border border-blue-500/20 text-sm">
            <p className="font-medium text-blue-400 mb-2">Delta Richtingslogica:</p>
            <ul className="text-xs text-muted-foreground space-y-1">
              <li>• <strong>Delta = strike - binance prijs</strong></li>
              <li>• Delta tussen -{config.delta_threshold} en +{config.delta_threshold}: trade beide richtingen</li>
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
                Trigger trade bij ${config.tick_delta_usd} prijsverandering
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
                ±${config.delta_threshold} voor richtingslogica
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
                Minimaal {(config.min_share_price * 100).toFixed(0)}¢ per share
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

        {/* Trailing Stop Exit Settings */}
        <div className="space-y-4">
          <h4 className="font-medium text-sm text-muted-foreground flex items-center gap-2">
            <Shield className="h-4 w-4" />
            Exit Instellingen (Trailing Stop)
          </h4>
          
          {/* Explanation */}
          <div className="p-3 rounded-lg bg-green-500/10 border border-green-500/20 text-sm">
            <p className="font-medium text-green-400 mb-2">Trailing Stop Logica:</p>
            <ul className="text-xs text-muted-foreground space-y-1">
              <li>• <strong>Min Profit</strong>: Gegarandeerde minimum winst (altijd {config.min_profit_cents}¢)</li>
              <li>• Profit stijgt naar <strong>≥{config.trailing_trigger_cents}¢</strong> → trailing actief</li>
              <li>• Daalt <strong>{config.trailing_distance_cents}¢</strong> vanaf peak → verkoop</li>
              <li>• Noodstop bij <strong>-{config.emergency_sl_cents}¢</strong> verlies</li>
            </ul>
          </div>
          
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-3 p-3 rounded-lg bg-green-500/5 border border-green-500/20">
              <Label className="text-sm text-green-400">Min Profit (¢)</Label>
              <Input
                type="number"
                value={config.min_profit_cents}
                onChange={(e) => updateField('min_profit_cents', parseFloat(e.target.value) || 0)}
                className="h-9"
              />
              <p className="text-xs text-muted-foreground">
                Gegarandeerde minimale winst per share
              </p>
            </div>
            
            <div className="space-y-3 p-3 rounded-lg bg-blue-500/5 border border-blue-500/20">
              <Label className="text-sm text-blue-400">Trailing Trigger (¢)</Label>
              <Input
                type="number"
                value={config.trailing_trigger_cents}
                onChange={(e) => updateField('trailing_trigger_cents', parseFloat(e.target.value) || 0)}
                className="h-9"
              />
              <p className="text-xs text-muted-foreground">
                Start trailing stop bij ≥{config.trailing_trigger_cents}¢ winst
              </p>
            </div>
            
            <div className="space-y-3 p-3 rounded-lg bg-amber-500/5 border border-amber-500/20">
              <Label className="text-sm text-amber-400">Trailing Distance (¢)</Label>
              <Input
                type="number"
                value={config.trailing_distance_cents}
                onChange={(e) => updateField('trailing_distance_cents', parseFloat(e.target.value) || 0)}
                className="h-9"
              />
              <p className="text-xs text-muted-foreground">
                Verkoop als profit {config.trailing_distance_cents}¢ daalt van peak
              </p>
            </div>
            
            <div className="space-y-3 p-3 rounded-lg bg-red-500/5 border border-red-500/20">
              <Label className="text-sm text-red-400">Emergency Stop Loss (¢)</Label>
              <Input
                type="number"
                value={config.emergency_sl_cents}
                onChange={(e) => updateField('emergency_sl_cents', parseFloat(e.target.value) || 0)}
                className="h-9"
              />
              <p className="text-xs text-muted-foreground">
                Noodstop bij -{config.emergency_sl_cents}¢ (met verlies)
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
              Auto-close positie na {(config.timeout_ms / 1000).toFixed(0)}s (verkoopt op min_profit indien mogelijk)
            </p>
          </div>
        </div>

        <Separator />

        {/* Accumulation & Hedge Settings */}
        <div className="space-y-4">
          <h4 className="font-medium text-sm text-muted-foreground flex items-center gap-2">
            <Shield className="h-4 w-4" />
            Accumulatie & Auto-Hedge
          </h4>
          
          {/* Explanation */}
          <div className="p-3 rounded-lg bg-purple-500/10 border border-purple-500/20 text-sm">
            <p className="font-medium text-purple-400 mb-2">Accumulatie Strategie:</p>
            <ul className="text-xs text-muted-foreground space-y-1">
              <li>• <strong>Accumulatie</strong>: Bouw posities op over tijd (niet-agressief)</li>
              <li>• Max ${config.max_total_cost_usd} of {config.max_total_shares} shares per asset/side</li>
              <li>• <strong>Auto-Hedge</strong>: Koop tegenovergestelde shares als het goedkoop is</li>
              <li>• Hedge bij ask &lt; {config.hedge_trigger_cents}¢ EN unrealized profit ≥ {config.hedge_min_profit_cents}¢</li>
            </ul>
          </div>
          
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-3 p-3 rounded-lg bg-purple-500/5 border border-purple-500/20">
              <div className="flex items-center justify-between">
                <Label className="text-sm text-purple-400">Accumulatie Enabled</Label>
                <Switch
                  checked={config.accumulation_enabled}
                  onCheckedChange={(v) => updateField('accumulation_enabled', v)}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                Bouw posities op i.p.v. enkele trades
              </p>
            </div>
            
            <div className="space-y-3 p-3 rounded-lg bg-blue-500/5 border border-blue-500/20">
              <div className="flex items-center justify-between">
                <Label className="text-sm text-blue-400">Auto-Hedge Enabled</Label>
                <Switch
                  checked={config.auto_hedge_enabled}
                  onCheckedChange={(v) => updateField('auto_hedge_enabled', v)}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                Automatisch hedgen bij winst + goedkope tegenovergestelde
              </p>
            </div>
            
            <div className="space-y-2">
              <Label className="text-xs">Max Totale Kosten (USD)</Label>
              <Input
                type="number"
                value={config.max_total_cost_usd}
                onChange={(e) => updateField('max_total_cost_usd', parseFloat(e.target.value) || 0)}
                className="h-9"
              />
              <p className="text-xs text-muted-foreground">
                Stop accumulatie bij ${config.max_total_cost_usd} per side
              </p>
            </div>
            
            <div className="space-y-2">
              <Label className="text-xs">Max Totale Shares</Label>
              <Input
                type="number"
                value={config.max_total_shares}
                onChange={(e) => updateField('max_total_shares', parseInt(e.target.value) || 0)}
                className="h-9"
              />
              <p className="text-xs text-muted-foreground">
                Stop accumulatie bij {config.max_total_shares} shares per side
              </p>
            </div>
            
            <div className="space-y-2">
              <Label className="text-xs">Hedge Trigger (¢)</Label>
              <Input
                type="number"
                value={config.hedge_trigger_cents}
                onChange={(e) => updateField('hedge_trigger_cents', parseInt(e.target.value) || 0)}
                className="h-9"
              />
              <p className="text-xs text-muted-foreground">
                Hedge als tegenovergestelde ask &lt; {config.hedge_trigger_cents}¢
              </p>
            </div>
            
            <div className="space-y-2">
              <Label className="text-xs">Min Profit voor Hedge (¢)</Label>
              <Input
                type="number"
                value={config.hedge_min_profit_cents}
                onChange={(e) => updateField('hedge_min_profit_cents', parseInt(e.target.value) || 0)}
                className="h-9"
              />
              <p className="text-xs text-muted-foreground">
                Alleen hedgen bij ≥{config.hedge_min_profit_cents}¢ unrealized profit
              </p>
            </div>
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
