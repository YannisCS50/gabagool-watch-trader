import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PieChart, Pie, Cell, ResponsiveContainer, Legend, Tooltip } from 'recharts';
import { V29RStats } from '@/hooks/useV29ResponseData';

interface Props {
  stats: V29RStats;
}

const COLORS = {
  'TARGET_REACHED': '#22c55e',
  'REPRICING_EXHAUSTION': '#3b82f6',
  'ADVERSE_SELECTION': '#ef4444',
  'HARD_TIME_STOP': '#f97316',
};

export function V29RExitDistribution({ stats }: Props) {
  const data = Object.entries(stats.exitReasonDistribution).map(([name, value]) => ({
    name: name.replace(/_/g, ' '),
    value,
    color: COLORS[name as keyof typeof COLORS] || '#6b7280',
  }));

  if (data.length === 0) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Exit Reason Distribution</CardTitle>
        </CardHeader>
        <CardContent className="flex items-center justify-center h-[200px]">
          <p className="text-muted-foreground">No exits yet</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Exit Reason Distribution</CardTitle>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={250}>
          <PieChart>
            <Pie
              data={data}
              cx="50%"
              cy="50%"
              innerRadius={50}
              outerRadius={80}
              paddingAngle={2}
              dataKey="value"
              label={({ name, percent }) => `${(percent * 100).toFixed(0)}%`}
            >
              {data.map((entry, index) => (
                <Cell key={`cell-${index}`} fill={entry.color} />
              ))}
            </Pie>
            <Tooltip 
              formatter={(value: number) => [value, 'Count']}
              contentStyle={{ 
                backgroundColor: 'hsl(var(--card))',
                border: '1px solid hsl(var(--border))',
                borderRadius: '8px',
              }}
            />
            <Legend />
          </PieChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}
