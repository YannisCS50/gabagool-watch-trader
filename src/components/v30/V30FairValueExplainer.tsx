import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Slider } from '@/components/ui/slider';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { supabase } from '@/integrations/supabase/client';
import { TrendingUp, TrendingDown, Database, Calculator, Clock, DollarSign } from 'lucide-react';

interface CalibrationData {
  asset: string;
  total_markets: number;
  up_wins: number;
  down_wins: number;
  avg_delta: number;
  first_market: string;
  last_market: string;
}

// Asset volatility (same as in fair-value.ts)
const ASSET_VOLATILITY: Record<string, number> = {
  BTC: 150,
  ETH: 15,
  SOL: 1.5,
  XRP: 0.02,
};

const DELTA_BUCKET_SIZE: Record<string, number> = {
  BTC: 25,
  ETH: 3,
  SOL: 0.25,
  XRP: 0.005,
};

export function V30FairValueExplainer() {
  const [asset, setAsset] = useState<string>('BTC');
  const [delta, setDelta] = useState<number>(0);
  const [timeRemaining, setTimeRemaining] = useState<number>(300);
  const [calibrationData, setCalibrationData] = useState<CalibrationData[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchCalibrationData() {
      const { data, error } = await supabase
        .from('market_history')
        .select('asset, result, strike_price, close_price, event_end_time')
        .in('result', ['UP', 'DOWN'])
        .not('strike_price', 'is', null);

      if (error || !data) {
        setLoading(false);
        return;
      }

      // Aggregate by asset
      const byAsset: Record<string, CalibrationData> = {};
      data.forEach((row: any) => {
        if (!byAsset[row.asset]) {
          byAsset[row.asset] = {
            asset: row.asset,
            total_markets: 0,
            up_wins: 0,
            down_wins: 0,
            avg_delta: 0,
            first_market: row.event_end_time,
            last_market: row.event_end_time,
          };
        }
        const agg = byAsset[row.asset];
        agg.total_markets++;
        if (row.result === 'UP') agg.up_wins++;
        if (row.result === 'DOWN') agg.down_wins++;
        if (row.event_end_time < agg.first_market) agg.first_market = row.event_end_time;
        if (row.event_end_time > agg.last_market) agg.last_market = row.event_end_time;
      });

      setCalibrationData(Object.values(byAsset).sort((a, b) => b.total_markets - a.total_markets));
      setLoading(false);
    }
    fetchCalibrationData();
  }, []);

  // Calculate fair value using heuristic
  const sigma = ASSET_VOLATILITY[asset] || 100;
  const timeScale = Math.sqrt(Math.max(1, timeRemaining) / 900);
  const expectedMove = sigma * timeScale;
  const normalizedDelta = delta / expectedMove;
  const steepness = 2.0;
  const z = normalizedDelta * steepness;
  let pUp = 1 / (1 + Math.exp(-z));

  // Certainty boost near expiry
  if (timeRemaining < 60) {
    const certaintyBoost = (60 - timeRemaining) / 60;
    if (pUp > 0.5) {
      pUp = pUp + (1 - pUp) * certaintyBoost * 0.3;
    } else {
      pUp = pUp - pUp * certaintyBoost * 0.3;
    }
  }

  // Clamp
  const minP = timeRemaining > 30 ? 0.05 : 0.02;
  const maxP = timeRemaining > 30 ? 0.95 : 0.98;
  pUp = Math.max(minP, Math.min(maxP, pUp));
  const pDown = 1 - pUp;

  const currentAssetData = calibrationData.find(d => d.asset === asset);
  const deltaBucketSize = DELTA_BUCKET_SIZE[asset] || 10;
  const currentDeltaBucket = Math.round(delta / deltaBucketSize) * deltaBucketSize;

  // Estimate bucket coverage
  const timeBuckets = 16; // From config
  const deltaRange = sigma * 5; // Typical range
  const estimatedDeltaBuckets = Math.ceil((deltaRange * 2) / deltaBucketSize);
  const totalBuckets = timeBuckets * estimatedDeltaBuckets;
  const samplesPerBucket = currentAssetData ? currentAssetData.total_markets / totalBuckets : 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Calculator className="h-5 w-5" />
          Fair Value Calculator
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Calibration Data Summary */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {calibrationData.map((d) => (
            <div 
              key={d.asset} 
              className={`p-3 rounded-lg border ${d.asset === asset ? 'border-primary bg-primary/5' : 'border-border'}`}
              onClick={() => setAsset(d.asset)}
              role="button"
            >
              <div className="flex items-center justify-between mb-1">
                <span className="font-bold">{d.asset}</span>
                <Badge variant={d.total_markets > 100 ? 'default' : 'secondary'} className="text-xs">
                  {d.total_markets} samples
                </Badge>
              </div>
              <div className="text-xs text-muted-foreground flex gap-2">
                <span className="text-green-500">↑{d.up_wins}</span>
                <span className="text-red-500">↓{d.down_wins}</span>
              </div>
              <div className="text-xs text-muted-foreground mt-1">
                σ = ${ASSET_VOLATILITY[d.asset]}
              </div>
            </div>
          ))}
        </div>

        {/* Interactive Calculator */}
        <div className="space-y-4 p-4 bg-muted/30 rounded-lg">
          <div className="flex items-center gap-4">
            <Select value={asset} onValueChange={setAsset}>
              <SelectTrigger className="w-24">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="BTC">BTC</SelectItem>
                <SelectItem value="ETH">ETH</SelectItem>
                <SelectItem value="SOL">SOL</SelectItem>
                <SelectItem value="XRP">XRP</SelectItem>
              </SelectContent>
            </Select>
            <div className="flex-1">
              <div className="flex justify-between text-sm mb-1">
                <span className="flex items-center gap-1">
                  <DollarSign className="h-3 w-3" />
                  Delta: <span className={delta >= 0 ? 'text-green-500' : 'text-red-500'}>${delta.toFixed(2)}</span>
                </span>
                <span className="text-muted-foreground">
                  Bucket: ${currentDeltaBucket}
                </span>
              </div>
              <Slider
                value={[delta]}
                onValueChange={([v]) => setDelta(v)}
                min={-sigma * 3}
                max={sigma * 3}
                step={deltaBucketSize / 2}
              />
            </div>
          </div>

          <div>
            <div className="flex justify-between text-sm mb-1">
              <span className="flex items-center gap-1">
                <Clock className="h-3 w-3" />
                Time remaining: {timeRemaining}s
              </span>
              <span className="text-muted-foreground">
                {Math.floor(timeRemaining / 60)}m {timeRemaining % 60}s
              </span>
            </div>
            <Slider
              value={[timeRemaining]}
              onValueChange={([v]) => setTimeRemaining(v)}
              min={0}
              max={900}
              step={15}
            />
          </div>
        </div>

        {/* Calculation Steps */}
        <div className="space-y-2 font-mono text-sm bg-card p-4 rounded-lg border">
          <div className="text-muted-foreground">// Stap 1: Volatility & Time Scale</div>
          <div>σ = ${sigma} <span className="text-muted-foreground">(15-min volatility)</span></div>
          <div>timeScale = √({timeRemaining}/900) = {timeScale.toFixed(3)}</div>
          <div>expectedMove = {sigma} × {timeScale.toFixed(3)} = ${expectedMove.toFixed(2)}</div>
          
          <div className="text-muted-foreground mt-3">// Stap 2: Normalize delta</div>
          <div>normalizedDelta = {delta.toFixed(2)} / {expectedMove.toFixed(2)} = {normalizedDelta.toFixed(3)}</div>
          
          <div className="text-muted-foreground mt-3">// Stap 3: Logistic function</div>
          <div>z = {normalizedDelta.toFixed(3)} × 2.0 = {z.toFixed(3)}</div>
          <div>P(UP) = 1 / (1 + e^{(-z).toFixed(3)}) = {(1 / (1 + Math.exp(-z)) * 100).toFixed(1)}%</div>
          
          {timeRemaining < 60 && (
            <>
              <div className="text-muted-foreground mt-3">// Stap 4: Certainty boost (τ &lt; 60s)</div>
              <div>boost = {((60 - timeRemaining) / 60 * 0.3 * 100).toFixed(1)}%</div>
            </>
          )}
        </div>

        {/* Result */}
        <div className="grid grid-cols-2 gap-4">
          <div className={`p-4 rounded-lg border-2 ${pUp > 0.5 ? 'border-green-500 bg-green-500/10' : 'border-border'}`}>
            <div className="flex items-center gap-2 mb-2">
              <TrendingUp className="h-5 w-5 text-green-500" />
              <span className="font-semibold">P(UP)</span>
            </div>
            <div className="text-3xl font-bold text-green-500">
              {(pUp * 100).toFixed(1)}%
            </div>
          </div>
          <div className={`p-4 rounded-lg border-2 ${pDown > 0.5 ? 'border-red-500 bg-red-500/10' : 'border-border'}`}>
            <div className="flex items-center gap-2 mb-2">
              <TrendingDown className="h-5 w-5 text-red-500" />
              <span className="font-semibold">P(DOWN)</span>
            </div>
            <div className="text-3xl font-bold text-red-500">
              {(pDown * 100).toFixed(1)}%
            </div>
          </div>
        </div>

        {/* Bucket Stats */}
        <div className="p-4 bg-muted/30 rounded-lg">
          <div className="flex items-center gap-2 mb-3">
            <Database className="h-4 w-4" />
            <span className="font-semibold">Bucket Statistics ({asset})</span>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
            <div>
              <div className="text-muted-foreground">Time buckets</div>
              <div className="font-bold">16</div>
            </div>
            <div>
              <div className="text-muted-foreground">Delta bucket size</div>
              <div className="font-bold">${deltaBucketSize}</div>
            </div>
            <div>
              <div className="text-muted-foreground">Est. delta buckets</div>
              <div className="font-bold">~{estimatedDeltaBuckets}</div>
            </div>
            <div>
              <div className="text-muted-foreground">Total buckets</div>
              <div className="font-bold">~{totalBuckets}</div>
            </div>
          </div>
          <div className="mt-3 pt-3 border-t">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Samples per bucket (avg)</span>
              <Badge variant={samplesPerBucket >= 5 ? 'default' : 'secondary'}>
                {samplesPerBucket.toFixed(1)} {samplesPerBucket >= 5 ? '✓ trusted' : '→ heuristic'}
              </Badge>
            </div>
            <div className="flex justify-between mt-1">
              <span className="text-muted-foreground">Min samples for trust</span>
              <span className="font-mono">5</span>
            </div>
            <div className="flex justify-between mt-1">
              <span className="text-muted-foreground">EWMA alpha</span>
              <span className="font-mono">0.15</span>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}