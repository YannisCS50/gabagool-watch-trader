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
import { Badge } from '@/components/ui/badge';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

interface V26Config {
  id: string;
  shares: number;
  price: number;
  side: 'UP' | 'DOWN';
  assets: string[];
  enabled: boolean;
  max_lead_time_sec: number;
  min_lead_time_sec: number;
  cancel_after_start_sec: number;
  updated_at: string;
}

const AVAILABLE_ASSETS = ['BTC', 'ETH', 'SOL', 'XRP'] as const;

export function V26StrategyModal() {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [config, setConfig] = useState<V26Config | null>(null);

  // Form state
  const [shares, setShares] = useState(10);
  const [price, setPrice] = useState(0.48);
  const [side, setSide] = useState<'UP' | 'DOWN'>('DOWN');
  const [assets, setAssets] = useState<string[]>(['BTC', 'ETH', 'SOL', 'XRP']);
  const [enabled, setEnabled] = useState(true);
  const [maxLeadTimeSec, setMaxLeadTimeSec] = useState(600);
  const [minLeadTimeSec, setMinLeadTimeSec] = useState(60);
  const [cancelAfterStartSec, setCancelAfterStartSec] = useState(30);

  const fetchConfig = async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('v26_config')
      .select('*')
      .limit(1)
      .single();

    if (error) {
      console.error('Failed to fetch config:', error);
      toast.error('Kon config niet laden');
    } else if (data) {
      const cfg = data as V26Config;
      setConfig(cfg);
      setShares(cfg.shares);
      setPrice(Number(cfg.price));
      setSide(cfg.side as 'UP' | 'DOWN');
      setAssets(cfg.assets);
      setEnabled(cfg.enabled);
      setMaxLeadTimeSec(cfg.max_lead_time_sec);
      setMinLeadTimeSec(cfg.min_lead_time_sec);
      setCancelAfterStartSec(cfg.cancel_after_start_sec);
    }
    setLoading(false);
  };

  useEffect(() => {
    if (open) {
      fetchConfig();
    }
  }, [open]);

  const handleSave = async () => {
    if (!config) return;

    setSaving(true);
    
    // Increment config_version to trigger runner reload
    const newVersion = ((config as any).config_version || 1) + 1;
    
    const { error } = await supabase
      .from('v26_config')
      .update({
        shares,
        price,
        side,
        assets,
        enabled,
        max_lead_time_sec: maxLeadTimeSec,
        min_lead_time_sec: minLeadTimeSec,
        cancel_after_start_sec: cancelAfterStartSec,
        config_version: newVersion,
      })
      .eq('id', config.id);

    if (error) {
      console.error('Failed to save config:', error);
      toast.error('Opslaan mislukt');
    } else {
      toast.success('✅ Opgeslagen! Runner herlaadt config binnen 10 seconden.');
      setOpen(false);
    }
    setSaving(false);
  };

  const toggleAsset = (asset: string) => {
    if (assets.includes(asset)) {
      if (assets.length > 1) {
        setAssets(assets.filter((a) => a !== asset));
      }
    } else {
      setAssets([...assets, asset]);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Settings2 className="h-4 w-4 mr-2" />
          Strategy
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Settings2 className="h-5 w-5" />
            V26 Strategy Instellingen
          </DialogTitle>
          <DialogDescription>
            Pas de trading parameters aan. Wijzigingen worden opgepikt bij de volgende market poll.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-6 py-4">
            {/* Enabled Toggle */}
            <div className="flex items-center justify-between">
              <div>
                <Label htmlFor="enabled" className="text-base font-medium">
                  Strategy Actief
                </Label>
                <p className="text-sm text-muted-foreground">
                  Zet trading aan of uit
                </p>
              </div>
              <Switch
                id="enabled"
                checked={enabled}
                onCheckedChange={setEnabled}
              />
            </div>

            {/* Side Selection */}
            <div className="space-y-2">
              <Label className="text-base font-medium">Side</Label>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant={side === 'DOWN' ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setSide('DOWN')}
                  className={side === 'DOWN' ? 'bg-red-500 hover:bg-red-600' : ''}
                >
                  🐍 DOWN
                </Button>
                <Button
                  type="button"
                  variant={side === 'UP' ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setSide('UP')}
                  className={side === 'UP' ? 'bg-green-500 hover:bg-green-600' : ''}
                >
                  🚀 UP
                </Button>
              </div>
            </div>

            {/* Shares & Price */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="shares">Shares per trade</Label>
                <Input
                  id="shares"
                  type="number"
                  min={1}
                  max={100}
                  value={shares}
                  onChange={(e) => setShares(parseInt(e.target.value) || 1)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="price">Limit prijs ($)</Label>
                <Input
                  id="price"
                  type="number"
                  min={0.01}
                  max={0.99}
                  step={0.01}
                  value={price}
                  onChange={(e) => setPrice(parseFloat(e.target.value) || 0.48)}
                />
              </div>
            </div>

            {/* Assets */}
            <div className="space-y-2">
              <Label className="text-base font-medium">Assets</Label>
              <div className="flex flex-wrap gap-2">
                {AVAILABLE_ASSETS.map((asset) => (
                  <Badge
                    key={asset}
                    variant={assets.includes(asset) ? 'default' : 'outline'}
                    className="cursor-pointer select-none"
                    onClick={() => toggleAsset(asset)}
                  >
                    {asset}
                  </Badge>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                Klik om te (de)selecteren. Minimaal 1 asset vereist.
              </p>
            </div>

            {/* Timing Settings */}
            <div className="space-y-4">
              <Label className="text-base font-medium">Timing</Label>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="maxLead" className="text-sm">Max lead time (sec)</Label>
                  <Input
                    id="maxLead"
                    type="number"
                    min={60}
                    max={900}
                    value={maxLeadTimeSec}
                    onChange={(e) => setMaxLeadTimeSec(parseInt(e.target.value) || 600)}
                  />
                  <p className="text-xs text-muted-foreground">
                    Plaats order max dit vroeg
                  </p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="minLead" className="text-sm">Min lead time (sec)</Label>
                  <Input
                    id="minLead"
                    type="number"
                    min={10}
                    max={300}
                    value={minLeadTimeSec}
                    onChange={(e) => setMinLeadTimeSec(parseInt(e.target.value) || 60)}
                  />
                  <p className="text-xs text-muted-foreground">
                    Niet meer plaatsen als minder dan dit
                  </p>
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="cancelAfter" className="text-sm">Cancel na start (sec)</Label>
                <Input
                  id="cancelAfter"
                  type="number"
                  min={10}
                  max={120}
                  value={cancelAfterStartSec}
                  onChange={(e) => setCancelAfterStartSec(parseInt(e.target.value) || 30)}
                />
                <p className="text-xs text-muted-foreground">
                  Cancel unfilled order dit na market start
                </p>
              </div>
            </div>

            {/* Last Updated */}
            {config?.updated_at && (
              <p className="text-xs text-muted-foreground text-center">
                Laatst bijgewerkt: {new Date(config.updated_at).toLocaleString('nl-NL')}
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
