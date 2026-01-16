import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Badge } from '@/components/ui/badge';
import { MomentumConfidence } from '@/hooks/useMomentumAnalysis';
import { Gauge, TrendingUp, AlertTriangle, XCircle, Zap } from 'lucide-react';

interface MomentumConfidenceCardProps {
  confidence: MomentumConfidence;
  isLoading?: boolean;
}

export function MomentumConfidenceCard({ confidence, isLoading }: MomentumConfidenceCardProps) {
  if (isLoading) {
    return (
      <Card>
        <CardContent className="py-8">
          <div className="animate-pulse space-y-4">
            <div className="h-8 bg-muted rounded w-1/3" />
            <div className="h-4 bg-muted rounded w-2/3" />
          </div>
        </CardContent>
      </Card>
    );
  }

  const getColorClass = () => {
    switch (confidence.label) {
      case 'AGRESSIEF': return 'text-green-500';
      case 'NORMAAL': return 'text-blue-500';
      case 'VOORZICHTIG': return 'text-yellow-500';
      case 'VERMIJDEN': return 'text-red-500';
    }
  };

  const getIcon = () => {
    switch (confidence.label) {
      case 'AGRESSIEF': return <Zap className="h-6 w-6" />;
      case 'NORMAAL': return <TrendingUp className="h-6 w-6" />;
      case 'VOORZICHTIG': return <AlertTriangle className="h-6 w-6" />;
      case 'VERMIJDEN': return <XCircle className="h-6 w-6" />;
    }
  };

  const getBgClass = () => {
    switch (confidence.label) {
      case 'AGRESSIEF': return 'bg-green-500/10 border-green-500/30';
      case 'NORMAAL': return 'bg-blue-500/10 border-blue-500/30';
      case 'VOORZICHTIG': return 'bg-yellow-500/10 border-yellow-500/30';
      case 'VERMIJDEN': return 'bg-red-500/10 border-red-500/30';
    }
  };

  const getProgressColor = () => {
    if (confidence.score >= 75) return 'bg-green-500';
    if (confidence.score >= 55) return 'bg-blue-500';
    if (confidence.score >= 35) return 'bg-yellow-500';
    return 'bg-red-500';
  };

  return (
    <Card className={`border-2 ${getBgClass()}`}>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Gauge className="h-5 w-5 text-muted-foreground" />
            <CardTitle>Momentum Confidence Score</CardTitle>
          </div>
          <Badge 
            variant="outline" 
            className={`text-lg px-4 py-1 ${getColorClass()} border-current`}
          >
            <span className="mr-2">{getIcon()}</span>
            {confidence.label}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Score gauge */}
        <div className="space-y-2">
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Vertrouwensscore</span>
            <span className={`font-bold text-lg ${getColorClass()}`}>{confidence.score}/100</span>
          </div>
          <div className="h-4 bg-muted rounded-full overflow-hidden">
            <div 
              className={`h-full transition-all duration-500 ${getProgressColor()}`}
              style={{ width: `${confidence.score}%` }}
            />
          </div>
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>Vermijden</span>
            <span>Voorzichtig</span>
            <span>Normaal</span>
            <span>Agressief</span>
          </div>
        </div>

        {/* Reasons */}
        <div className="space-y-2">
          <h4 className="text-sm font-medium">Waarom deze score?</h4>
          <ul className="space-y-1">
            {confidence.reasons.map((reason, i) => (
              <li key={i} className="text-sm text-muted-foreground flex items-start gap-2">
                <span className="text-primary mt-1">•</span>
                {reason}
              </li>
            ))}
          </ul>
        </div>

        {/* Interpretation */}
        <div className="p-3 rounded-lg bg-background/50 border">
          <h4 className="text-sm font-medium mb-1">Wat betekent dit?</h4>
          <p className="text-sm text-muted-foreground">
            {confidence.label === 'AGRESSIEF' && 
              'De signalen zijn betrouwbaar. Je kunt agressiever kopen en counter-ticks negeren bij grote delta.'}
            {confidence.label === 'NORMAAL' && 
              'De signalen werken, maar wees selectief. Focus op de beste delta buckets.'}
            {confidence.label === 'VOORZICHTIG' && 
              'De signalen zijn fragiel. Wacht op bevestiging en vermijd kleine deltas.'}
            {confidence.label === 'VERMIJDEN' && 
              'De huidige signalen zijn niet betrouwbaar. Analyseer wat er fout gaat.'}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
