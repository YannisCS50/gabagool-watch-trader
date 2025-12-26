import { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';
import { useToast } from '@/hooks/use-toast';
import { supabase } from '@/integrations/supabase/client';
import { Link } from 'react-router-dom';
import { ArrowLeft, Save, Eye, EyeOff, Shield, Zap, Settings2, TrendingUp } from 'lucide-react';

interface BotConfig {
  id: string;
  polymarket_api_key: string | null;
  polymarket_api_secret: string | null;
  polymarket_passphrase: string | null;
  polymarket_private_key: string | null;
  polymarket_address: string | null;
  backend_url: string | null;
  runner_shared_secret: string | null;
  vpn_required: boolean | null;
  vpn_endpoint: string | null;
  trade_assets: string[] | null;
  max_notional_per_trade: number | null;
  opening_max_price: number | null;
  min_order_interval_ms: number | null;
  cloudflare_backoff_ms: number | null;
  strategy_enabled: boolean | null;
  min_edge_threshold: number | null;
  max_position_size: number | null;
}

export default function Settings() {
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showSecrets, setShowSecrets] = useState(false);
  const [config, setConfig] = useState<BotConfig | null>(null);

  useEffect(() => {
    fetchConfig();
  }, []);

  const fetchConfig = async () => {
    try {
      const { data, error } = await supabase
        .from('bot_config')
        .select('*')
        .eq('id', '00000000-0000-0000-0000-000000000001')
        .maybeSingle();

      if (error) throw error;
      setConfig(data);
    } catch (error) {
      console.error('Error fetching config:', error);
      toast({
        title: 'Error',
        description: 'Failed to load configuration',
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  };

  const saveConfig = async () => {
    if (!config) return;

    setSaving(true);
    try {
      const { error } = await supabase
        .from('bot_config')
        .update({
          polymarket_api_key: config.polymarket_api_key,
          polymarket_api_secret: config.polymarket_api_secret,
          polymarket_passphrase: config.polymarket_passphrase,
          polymarket_private_key: config.polymarket_private_key,
          polymarket_address: config.polymarket_address,
          backend_url: config.backend_url,
          runner_shared_secret: config.runner_shared_secret,
          vpn_required: config.vpn_required,
          vpn_endpoint: config.vpn_endpoint,
          trade_assets: config.trade_assets,
          max_notional_per_trade: config.max_notional_per_trade,
          opening_max_price: config.opening_max_price,
          min_order_interval_ms: config.min_order_interval_ms,
          cloudflare_backoff_ms: config.cloudflare_backoff_ms,
          strategy_enabled: config.strategy_enabled,
          min_edge_threshold: config.min_edge_threshold,
          max_position_size: config.max_position_size,
        })
        .eq('id', '00000000-0000-0000-0000-000000000001');

      if (error) throw error;

      toast({
        title: 'Saved',
        description: 'Configuration saved successfully',
      });
    } catch (error) {
      console.error('Error saving config:', error);
      toast({
        title: 'Error',
        description: 'Failed to save configuration',
        variant: 'destructive',
      });
    } finally {
      setSaving(false);
    }
  };

  const updateConfig = (field: keyof BotConfig, value: unknown) => {
    if (!config) return;
    setConfig({ ...config, [field]: value });
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="animate-pulse text-muted-foreground">Loading configuration...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="container max-w-4xl py-8">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-4">
            <Link to="/">
              <Button variant="ghost" size="icon">
                <ArrowLeft className="h-5 w-5" />
              </Button>
            </Link>
            <div>
              <h1 className="text-2xl font-bold">Bot Configuration</h1>
              <p className="text-muted-foreground">Manage your trading bot settings</p>
            </div>
          </div>
          <Button onClick={saveConfig} disabled={saving}>
            <Save className="h-4 w-4 mr-2" />
            {saving ? 'Saving...' : 'Save Changes'}
          </Button>
        </div>

        <div className="space-y-6">
          {/* Polymarket API Credentials */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Shield className="h-5 w-5 text-primary" />
                  <CardTitle>Polymarket API Credentials</CardTitle>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowSecrets(!showSecrets)}
                >
                  {showSecrets ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  {showSecrets ? 'Hide' : 'Show'}
                </Button>
              </div>
              <CardDescription>
                Your Polymarket CLOB API credentials for order placement
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="api_key">API Key</Label>
                  <Input
                    id="api_key"
                    type={showSecrets ? 'text' : 'password'}
                    placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                    value={config?.polymarket_api_key || ''}
                    onChange={(e) => updateConfig('polymarket_api_key', e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="api_secret">API Secret</Label>
                  <Input
                    id="api_secret"
                    type={showSecrets ? 'text' : 'password'}
                    placeholder="Your API secret"
                    value={config?.polymarket_api_secret || ''}
                    onChange={(e) => updateConfig('polymarket_api_secret', e.target.value)}
                  />
                </div>
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="passphrase">Passphrase</Label>
                  <Input
                    id="passphrase"
                    type={showSecrets ? 'text' : 'password'}
                    placeholder="Your passphrase"
                    value={config?.polymarket_passphrase || ''}
                    onChange={(e) => updateConfig('polymarket_passphrase', e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="address">Wallet Address</Label>
                  <Input
                    id="address"
                    type="text"
                    placeholder="0x..."
                    value={config?.polymarket_address || ''}
                    onChange={(e) => updateConfig('polymarket_address', e.target.value)}
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="private_key">Private Key (EOA Signer)</Label>
                <Input
                  id="private_key"
                  type={showSecrets ? 'text' : 'password'}
                  placeholder="0x..."
                  value={config?.polymarket_private_key || ''}
                  onChange={(e) => updateConfig('polymarket_private_key', e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  The private key of the EOA that controls your Polymarket Safe wallet
                </p>
              </div>
            </CardContent>
          </Card>

          {/* Backend Settings */}
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <Zap className="h-5 w-5 text-primary" />
                <CardTitle>Backend Settings</CardTitle>
              </div>
              <CardDescription>
                Connection settings for the local runner
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="backend_url">Backend URL</Label>
                  <Input
                    id="backend_url"
                    type="text"
                    placeholder="https://your-project.supabase.co"
                    value={config?.backend_url || ''}
                    onChange={(e) => updateConfig('backend_url', e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="runner_secret">Runner Shared Secret</Label>
                  <Input
                    id="runner_secret"
                    type={showSecrets ? 'text' : 'password'}
                    placeholder="Your shared secret"
                    value={config?.runner_shared_secret || ''}
                    onChange={(e) => updateConfig('runner_shared_secret', e.target.value)}
                  />
                </div>
              </div>
              <Separator />
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label>VPN Required</Label>
                  <p className="text-xs text-muted-foreground">
                    Require WireGuard VPN for order placement
                  </p>
                </div>
                <Switch
                  checked={config?.vpn_required ?? true}
                  onCheckedChange={(checked) => updateConfig('vpn_required', checked)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="vpn_endpoint">VPN Endpoint (optional)</Label>
                <Input
                  id="vpn_endpoint"
                  type="text"
                  placeholder="wg0"
                  value={config?.vpn_endpoint || ''}
                  onChange={(e) => updateConfig('vpn_endpoint', e.target.value)}
                />
              </div>
            </CardContent>
          </Card>

          {/* Trading Settings */}
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <Settings2 className="h-5 w-5 text-primary" />
                <CardTitle>Trading Settings</CardTitle>
              </div>
              <CardDescription>
                Order execution and risk management
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="trade_assets">Trade Assets (comma-separated)</Label>
                  <Input
                    id="trade_assets"
                    type="text"
                    placeholder="BTC, ETH"
                    value={config?.trade_assets?.join(', ') || ''}
                    onChange={(e) => updateConfig('trade_assets', e.target.value.split(',').map(s => s.trim()).filter(Boolean))}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="max_notional">Max Notional per Trade ($)</Label>
                  <Input
                    id="max_notional"
                    type="number"
                    step="0.1"
                    placeholder="5"
                    value={config?.max_notional_per_trade || ''}
                    onChange={(e) => updateConfig('max_notional_per_trade', parseFloat(e.target.value) || 0)}
                  />
                </div>
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="opening_max_price">Opening Max Price</Label>
                  <Input
                    id="opening_max_price"
                    type="number"
                    step="0.01"
                    placeholder="0.52"
                    value={config?.opening_max_price || ''}
                    onChange={(e) => updateConfig('opening_max_price', parseFloat(e.target.value) || 0)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="min_order_interval">Min Order Interval (ms)</Label>
                  <Input
                    id="min_order_interval"
                    type="number"
                    step="100"
                    placeholder="1500"
                    value={config?.min_order_interval_ms || ''}
                    onChange={(e) => updateConfig('min_order_interval_ms', parseInt(e.target.value) || 0)}
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="cloudflare_backoff">Cloudflare Backoff (ms)</Label>
                <Input
                  id="cloudflare_backoff"
                  type="number"
                  step="1000"
                  placeholder="60000"
                  value={config?.cloudflare_backoff_ms || ''}
                  onChange={(e) => updateConfig('cloudflare_backoff_ms', parseInt(e.target.value) || 0)}
                />
                <p className="text-xs text-muted-foreground">
                  Cooldown period after receiving a Cloudflare block
                </p>
              </div>
            </CardContent>
          </Card>

          {/* Strategy Parameters */}
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <TrendingUp className="h-5 w-5 text-primary" />
                <CardTitle>Strategy Parameters</CardTitle>
              </div>
              <CardDescription>
                Trading strategy configuration
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label>Strategy Enabled</Label>
                  <p className="text-xs text-muted-foreground">
                    Enable automated trading strategy
                  </p>
                </div>
                <Switch
                  checked={config?.strategy_enabled ?? true}
                  onCheckedChange={(checked) => updateConfig('strategy_enabled', checked)}
                />
              </div>
              <Separator />
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="min_edge">Min Edge Threshold</Label>
                  <Input
                    id="min_edge"
                    type="number"
                    step="0.001"
                    placeholder="0.02"
                    value={config?.min_edge_threshold || ''}
                    onChange={(e) => updateConfig('min_edge_threshold', parseFloat(e.target.value) || 0)}
                  />
                  <p className="text-xs text-muted-foreground">
                    Minimum arbitrage edge required to execute trade
                  </p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="max_position">Max Position Size ($)</Label>
                  <Input
                    id="max_position"
                    type="number"
                    step="1"
                    placeholder="100"
                    value={config?.max_position_size || ''}
                    onChange={(e) => updateConfig('max_position_size', parseFloat(e.target.value) || 0)}
                  />
                  <p className="text-xs text-muted-foreground">
                    Maximum total position value per market
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
