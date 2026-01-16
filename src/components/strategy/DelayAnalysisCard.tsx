import { DelayStats } from '@/hooks/useStrategyDiscovery';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Clock, Zap } from 'lucide-react';

interface Props {
  stats: DelayStats[];
}

export function DelayAnalysisCard({ stats }: Props) {
  if (stats.length === 0) return null;
  
  const stat = stats[0];
  
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Clock className="h-5 w-5" />
          Polymarket Delay Analyse
        </CardTitle>
        <CardDescription>
          Hoe lang duurt het voordat Polymarket reageert op Binance prijsbewegingen?
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="bg-muted/50 rounded-lg p-4">
            <p className="text-sm text-muted-foreground">Asset</p>
            <p className="text-2xl font-bold">{stat.asset}</p>
          </div>
          
          <div className="bg-muted/50 rounded-lg p-4">
            <div className="flex items-center gap-2">
              <Zap className="h-4 w-4 text-yellow-500" />
              <p className="text-sm text-muted-foreground">Gem. Delay</p>
            </div>
            <p className="text-2xl font-bold">{stat.avgDelayMs.toFixed(0)}ms</p>
          </div>
          
          <div className="bg-muted/50 rounded-lg p-4">
            <p className="text-sm text-muted-foreground">Samples</p>
            <p className="text-2xl font-bold">{stat.sampleCount}</p>
          </div>
          
          <div className="bg-muted/50 rounded-lg p-4">
            <p className="text-sm text-muted-foreground">Reactie snelheid</p>
            <p className="text-2xl font-bold">
              {stat.avgDelayMs < 500 ? '⚡ Snel' : stat.avgDelayMs < 1500 ? '🐢 Medium' : '🦥 Traag'}
            </p>
          </div>
        </div>
        
        <div className="mt-4 p-4 bg-blue-500/10 rounded-lg">
          <h4 className="font-medium text-blue-700 dark:text-blue-400 mb-2">💡 Interpretatie</h4>
          <ul className="text-sm space-y-1 text-muted-foreground">
            <li>• <strong>Delay &lt; 500ms:</strong> Markt is efficiënt, moeilijker om arbitrage te vinden</li>
            <li>• <strong>Delay 500-1500ms:</strong> Gemiddelde reactietijd, kansen mogelijk bij grote moves</li>
            <li>• <strong>Delay &gt; 1500ms:</strong> Trage reactie, potentiële arbitrage mogelijkheden</li>
          </ul>
        </div>
      </CardContent>
    </Card>
  );
}
