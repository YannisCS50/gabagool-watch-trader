import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { V29RSignal } from '@/hooks/useV29ResponseData';

interface Props {
  signals: V29RSignal[];
}

export function V29RRepricingChart({ signals }: Props) {
  const filledSignals = signals
    .filter(s => s.status === 'filled' || s.status === 'closed')
    .filter(s => s.price_at_1s != null);

  const upSignals = filledSignals.filter(s => s.direction === 'UP');
  const downSignals = filledSignals.filter(s => s.direction === 'DOWN');

  const calcAvg = (arr: V29RSignal[], field: 'price_at_1s' | 'price_at_2s' | 'price_at_3s' | 'price_at_5s' | 'share_price_t0') => {
    const vals = arr.map(s => s[field] as number).filter(v => v != null);
    return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  };

  const data = [
    { time: '0s', upMove: 0, downMove: 0 },
    { 
      time: '1s', 
      upMove: calcAvg(upSignals, 'price_at_1s') && calcAvg(upSignals, 'share_price_t0') ? 
        ((calcAvg(upSignals, 'price_at_1s') || 0) - (calcAvg(upSignals, 'share_price_t0') || 0)) * 100 : null,
      downMove: calcAvg(downSignals, 'price_at_1s') && calcAvg(downSignals, 'share_price_t0') ? 
        ((calcAvg(downSignals, 'price_at_1s') || 0) - (calcAvg(downSignals, 'share_price_t0') || 0)) * 100 : null,
    },
    { 
      time: '2s', 
      upMove: calcAvg(upSignals, 'price_at_2s') && calcAvg(upSignals, 'share_price_t0') ? 
        ((calcAvg(upSignals, 'price_at_2s') || 0) - (calcAvg(upSignals, 'share_price_t0') || 0)) * 100 : null,
      downMove: calcAvg(downSignals, 'price_at_2s') && calcAvg(downSignals, 'share_price_t0') ? 
        ((calcAvg(downSignals, 'price_at_2s') || 0) - (calcAvg(downSignals, 'share_price_t0') || 0)) * 100 : null,
    },
    { 
      time: '3s', 
      upMove: calcAvg(upSignals, 'price_at_3s') && calcAvg(upSignals, 'share_price_t0') ? 
        ((calcAvg(upSignals, 'price_at_3s') || 0) - (calcAvg(upSignals, 'share_price_t0') || 0)) * 100 : null,
      downMove: calcAvg(downSignals, 'price_at_3s') && calcAvg(downSignals, 'share_price_t0') ? 
        ((calcAvg(downSignals, 'price_at_3s') || 0) - (calcAvg(downSignals, 'share_price_t0') || 0)) * 100 : null,
    },
    { 
      time: '5s', 
      upMove: calcAvg(upSignals, 'price_at_5s') && calcAvg(upSignals, 'share_price_t0') ? 
        ((calcAvg(upSignals, 'price_at_5s') || 0) - (calcAvg(upSignals, 'share_price_t0') || 0)) * 100 : null,
      downMove: calcAvg(downSignals, 'price_at_5s') && calcAvg(downSignals, 'share_price_t0') ? 
        ((calcAvg(downSignals, 'price_at_5s') || 0) - (calcAvg(downSignals, 'share_price_t0') || 0)) * 100 : null,
    },
  ];

  if (filledSignals.length === 0) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Avg Repricing Curve</CardTitle>
        </CardHeader>
        <CardContent className="flex items-center justify-center h-[200px]">
          <p className="text-muted-foreground">No repricing data yet</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">
          Avg Repricing (UP: {upSignals.length} / DOWN: {downSignals.length})
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={250}>
          <LineChart data={data}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
            <XAxis dataKey="time" stroke="hsl(var(--muted-foreground))" fontSize={12} />
            <YAxis stroke="hsl(var(--muted-foreground))" fontSize={12} tickFormatter={(v) => `${v.toFixed(1)}¢`} />
            <Tooltip formatter={(value: number) => [`${value?.toFixed(2) || '-'}¢`, '']} />
            <Legend />
            <Line type="monotone" dataKey="upMove" name="UP" stroke="#22c55e" strokeWidth={2} connectNulls />
            <Line type="monotone" dataKey="downMove" name="DOWN" stroke="#ef4444" strokeWidth={2} connectNulls />
          </LineChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}
