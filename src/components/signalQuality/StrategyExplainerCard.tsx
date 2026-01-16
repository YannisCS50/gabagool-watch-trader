import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { 
  Lightbulb, 
  TrendingUp, 
  TrendingDown, 
  AlertTriangle, 
  CheckCircle,
  XCircle,
  ArrowRight,
  Target,
  Clock,
  DollarSign
} from 'lucide-react';
import { SignalQualityStats, BucketAggregation } from '@/types/signalQuality';

interface StrategyExplainerCardProps {
  stats: SignalQualityStats | null;
  aggregations: BucketAggregation[];
}

export function StrategyExplainerCard({ stats, aggregations }: StrategyExplainerCardProps) {
  if (!stats) return null;
  
  // Generate recommendations based on data
  const recommendations = generateRecommendations(stats, aggregations);
  const healthScore = calculateHealthScore(stats, aggregations);
  
  return (
    <div className="space-y-6">
      {/* Strategy Health Overview */}
      <Card className="border-2 border-primary/20">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-lg flex items-center gap-2">
              <Target className="h-5 w-5 text-primary" />
              Strategie Gezondheid
            </CardTitle>
            <Badge 
              variant={healthScore >= 70 ? 'default' : healthScore >= 40 ? 'secondary' : 'destructive'}
              className="text-lg px-3 py-1"
            >
              {healthScore}/100
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground mb-4">
            Deze score geeft aan hoe goed je trading strategie presteert op basis van historische signalen.
            Een score boven 70 is goed, onder 40 vraagt om aanpassingen.
          </p>
          
          {/* Health breakdown */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="p-3 rounded-lg bg-muted/50">
              <div className="text-sm text-muted-foreground">Edge Kwaliteit</div>
              <div className={`text-xl font-bold ${stats.avgEdgeAfterSpread > 0 ? 'text-green-500' : 'text-red-500'}`}>
                {stats.avgEdgeAfterSpread > 0.5 ? 'Goed' : stats.avgEdgeAfterSpread > 0 ? 'Matig' : 'Slecht'}
              </div>
            </div>
            <div className="p-3 rounded-lg bg-muted/50">
              <div className="text-sm text-muted-foreground">False Edge Risico</div>
              <div className={`text-xl font-bold ${stats.falseEdgePct < 20 ? 'text-green-500' : stats.falseEdgePct < 40 ? 'text-amber-500' : 'text-red-500'}`}>
                {stats.falseEdgePct < 20 ? 'Laag' : stats.falseEdgePct < 40 ? 'Matig' : 'Hoog'}
              </div>
            </div>
            <div className="p-3 rounded-lg bg-muted/50">
              <div className="text-sm text-muted-foreground">Signaal Filter</div>
              <div className={`text-xl font-bold ${stats.winRateWhenShouldTrade > 55 ? 'text-green-500' : stats.winRateWhenShouldTrade > 45 ? 'text-amber-500' : 'text-red-500'}`}>
                {stats.winRateWhenShouldTrade > 55 ? 'Effectief' : stats.winRateWhenShouldTrade > 45 ? 'Neutraal' : 'Ineffectief'}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Recommendations */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Lightbulb className="h-5 w-5 text-amber-500" />
            Aanbevelingen om je Strategie te Verbeteren
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {recommendations.length === 0 ? (
            <div className="flex items-center gap-3 p-4 rounded-lg bg-green-500/10 border border-green-500/30">
              <CheckCircle className="h-6 w-6 text-green-500 flex-shrink-0" />
              <div>
                <div className="font-medium text-green-500">Alles ziet er goed uit!</div>
                <div className="text-sm text-muted-foreground">
                  Je strategie presteert binnen verwachte parameters. Blijf monitoren voor veranderingen.
                </div>
              </div>
            </div>
          ) : (
            recommendations.map((rec, i) => (
              <div 
                key={i} 
                className={`p-4 rounded-lg border ${
                  rec.priority === 'high' 
                    ? 'bg-red-500/10 border-red-500/30' 
                    : rec.priority === 'medium'
                    ? 'bg-amber-500/10 border-amber-500/30'
                    : 'bg-blue-500/10 border-blue-500/30'
                }`}
              >
                <div className="flex items-start gap-3">
                  <div className={`mt-0.5 ${
                    rec.priority === 'high' 
                      ? 'text-red-500' 
                      : rec.priority === 'medium'
                      ? 'text-amber-500'
                      : 'text-blue-500'
                  }`}>
                    {rec.icon}
                  </div>
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-medium">{rec.title}</span>
                      <Badge variant={
                        rec.priority === 'high' ? 'destructive' : 
                        rec.priority === 'medium' ? 'secondary' : 'outline'
                      } className="text-xs">
                        {rec.priority === 'high' ? 'Urgent' : rec.priority === 'medium' ? 'Aanbevolen' : 'Optioneel'}
                      </Badge>
                    </div>
                    <p className="text-sm text-muted-foreground mb-2">{rec.description}</p>
                    <div className="flex items-center gap-2 text-sm">
                      <ArrowRight className="h-4 w-4" />
                      <span className="font-medium">{rec.action}</span>
                    </div>
                  </div>
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}

interface Recommendation {
  title: string;
  description: string;
  action: string;
  priority: 'high' | 'medium' | 'low';
  icon: React.ReactNode;
}

function generateRecommendations(stats: SignalQualityStats, aggregations: BucketAggregation[]): Recommendation[] {
  const recs: Recommendation[] = [];
  
  // Check false edge percentage
  if (stats.falseEdgePct > 40) {
    recs.push({
      title: 'Te veel False Edges',
      description: `${stats.falseEdgePct.toFixed(0)}% van de signalen lijkt winstgevend maar verliest geld. Dit betekent dat de spread kosten hoger zijn dan de verwachte winst.`,
      action: 'Verhoog de minimum delta drempel om alleen grotere prijsbewegingen te traden',
      priority: 'high',
      icon: <AlertTriangle className="h-5 w-5" />
    });
  } else if (stats.falseEdgePct > 20) {
    recs.push({
      title: 'False Edge Risico',
      description: `${stats.falseEdgePct.toFixed(0)}% van signalen zijn false edges. Dit is acceptabel maar kan verbeterd worden.`,
      action: 'Overweeg hogere delta drempels voor assets met hoge false edge rates',
      priority: 'medium',
      icon: <AlertTriangle className="h-5 w-5" />
    });
  }
  
  // Check win rate difference
  const winRateDiff = stats.winRateWhenShouldTrade - stats.winRateWhenShouldNotTrade;
  if (winRateDiff < 5) {
    recs.push({
      title: 'Signaal Filter is Niet Effectief',
      description: `Het verschil tussen "should trade" en "should not trade" win rates is slechts ${winRateDiff.toFixed(0)}%. De filter onderscheidt goede van slechte trades niet goed.`,
      action: 'Pas de should_trade logica aan: voeg meer filters toe zoals spot lead tijd of delta buckets',
      priority: 'high',
      icon: <XCircle className="h-5 w-5" />
    });
  } else if (winRateDiff > 20) {
    recs.push({
      title: 'Signaal Filter Werkt Goed',
      description: `Je "should trade" signalen winnen ${winRateDiff.toFixed(0)}% vaker dan genegeerde signalen. Dit is een effectieve filter.`,
      action: 'Overweeg om meer agressief te traden wanneer should_trade = true',
      priority: 'low',
      icon: <CheckCircle className="h-5 w-5" />
    });
  }
  
  // Check average edge
  if (stats.avgEdgeAfterSpread < 0) {
    recs.push({
      title: 'Negatieve Gemiddelde Edge',
      description: `De gemiddelde edge na spread kosten is ${stats.avgEdgeAfterSpread.toFixed(2)}¢ - je verliest gemiddeld geld per trade.`,
      action: 'Stop met traden totdat je hogere edge signalen vindt of lagere spread kosten kunt krijgen',
      priority: 'high',
      icon: <TrendingDown className="h-5 w-5" />
    });
  } else if (stats.avgEdgeAfterSpread < 0.5) {
    recs.push({
      title: 'Lage Gemiddelde Edge',
      description: `De gemiddelde edge is slechts ${stats.avgEdgeAfterSpread.toFixed(2)}¢ - dit laat weinig marge voor fouten.`,
      action: 'Focus op hogere delta buckets (d20-50, d50-100) die typisch meer edge hebben',
      priority: 'medium',
      icon: <TrendingUp className="h-5 w-5" />
    });
  }
  
  // Check low confidence signals
  if (stats.lowConfidencePct > 30) {
    recs.push({
      title: 'Veel Onbetrouwbare Data',
      description: `${stats.lowConfidencePct.toFixed(0)}% van de signalen komt uit buckets met weinig historische samples. Statistieken kunnen misleidend zijn.`,
      action: 'Verzamel meer data voordat je conclusies trekt, of focus op buckets met >30 samples',
      priority: 'medium',
      icon: <Clock className="h-5 w-5" />
    });
  }
  
  // Check bucket-specific issues
  const lowWinRateBuckets = aggregations.filter(b => !b.isLowSample && b.winRate < 45);
  if (lowWinRateBuckets.length > 0) {
    recs.push({
      title: 'Slechte Delta Buckets Gevonden',
      description: `Buckets ${lowWinRateBuckets.map(b => b.bucket).join(', ')} hebben win rates onder 45%. Dit zijn verliezende segmenten.`,
      action: 'Sluit deze buckets uit van trading of verhoog de minimum edge drempel voor deze ranges',
      priority: 'high',
      icon: <DollarSign className="h-5 w-5" />
    });
  }
  
  const highWinRateBuckets = aggregations.filter(b => !b.isLowSample && b.winRate > 60);
  if (highWinRateBuckets.length > 0) {
    recs.push({
      title: 'Winstgevende Buckets Gevonden',
      description: `Buckets ${highWinRateBuckets.map(b => b.bucket).join(', ')} hebben win rates boven 60%. Dit zijn je beste segmenten.`,
      action: 'Overweeg om meer kapitaal te alloceren naar trades in deze buckets',
      priority: 'low',
      icon: <TrendingUp className="h-5 w-5" />
    });
  }
  
  return recs.sort((a, b) => {
    const priorityOrder = { high: 0, medium: 1, low: 2 };
    return priorityOrder[a.priority] - priorityOrder[b.priority];
  });
}

function calculateHealthScore(stats: SignalQualityStats, aggregations: BucketAggregation[]): number {
  let score = 50; // Start at neutral
  
  // Edge quality (up to +/- 20 points)
  if (stats.avgEdgeAfterSpread > 1) score += 20;
  else if (stats.avgEdgeAfterSpread > 0.5) score += 10;
  else if (stats.avgEdgeAfterSpread > 0) score += 5;
  else if (stats.avgEdgeAfterSpread > -0.5) score -= 10;
  else score -= 20;
  
  // False edge rate (up to +/- 15 points)
  if (stats.falseEdgePct < 10) score += 15;
  else if (stats.falseEdgePct < 20) score += 10;
  else if (stats.falseEdgePct < 30) score += 0;
  else if (stats.falseEdgePct < 40) score -= 10;
  else score -= 15;
  
  // Win rate when should trade (up to +/- 15 points)
  if (stats.winRateWhenShouldTrade > 60) score += 15;
  else if (stats.winRateWhenShouldTrade > 55) score += 10;
  else if (stats.winRateWhenShouldTrade > 50) score += 5;
  else if (stats.winRateWhenShouldTrade > 45) score -= 5;
  else score -= 15;
  
  // Clamp to 0-100
  return Math.max(0, Math.min(100, score));
}
