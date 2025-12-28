import { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';
import { useToast } from '@/hooks/use-toast';
import { supabase } from '@/integrations/supabase/client';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, Save, Shield, Zap, Settings2, TrendingUp, LogOut, AlertTriangle } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';

interface BotConfig {
  id: string;
  polymarket_address: string | null;
  backend_url: string | null;
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
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [config, setConfig] = useState<BotConfig | null>(null);
  const [user, setUser] = useState<any>(null);

  useEffect(() => {
    // Check authentication
    const checkAuth = async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        navigate('/auth');
        return;
      }
      setUser(session.user);
      fetchConfig();
    };
    
    checkAuth();

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (!session) {
        navigate('/auth');
      } else {
        setUser(session.user);
      }
    });

    return () => subscription.unsubscribe();
  }, [navigate]);

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
          polymarket_address: config.polymarket_address,
          backend_url: config.backend_url,
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

  const handleLogout = async () => {
    await supabase.auth.signOut();
    navigate('/auth');
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
          <div className="flex items-center gap-2">
            <Button onClick={saveConfig} disabled={saving}>
              <Save className="h-4 w-4 mr-2" />
              {saving ? 'Saving...' : 'Save Changes'}
            </Button>
            <Button variant="outline" onClick={handleLogout}>
              <LogOut className="h-4 w-4 mr-2" />
              Logout
            </Button>
          </div>
        </div>

        <div className="space-y-6">
          {/* Security Notice */}
          <Alert>
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>API Credentials Secured</AlertTitle>
            <AlertDescription>
              Private keys and API secrets are stored as encrypted environment variables only.
              Configure them in your local-runner's <code className="bg-muted px-1 rounded">.env</code> file.
            </AlertDescription>
          </Alert>

          {/* Polymarket Settings */}
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <Shield className="h-5 w-5 text-primary" />
                <CardTitle>Polymarket Settings</CardTitle>
              </div>
              <CardDescription>
                Public wallet address and connection settings
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="address">Wallet Address (Public)</Label>
                <Input
                  id="address"
                  type="text"
                  placeholder="0x..."
                  value={config?.polymarket_address || ''}
                  onChange={(e) => updateConfig('polymarket_address', e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Your Polymarket profile/proxy address (this is public info)
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

          {/* User Info */}
          {user && (
            <Card>
              <CardContent className="pt-6">
                <p className="text-sm text-muted-foreground">
                  Logged in as: <span className="font-medium text-foreground">{user.email}</span>
                </p>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
