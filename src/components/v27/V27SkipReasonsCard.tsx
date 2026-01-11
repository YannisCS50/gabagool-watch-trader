import { useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Badge } from '@/components/ui/badge';
import { 
  XCircle, AlertTriangle, TrendingDown, Clock, 
  Shield, BookOpen, ArrowUpDown, Eye, Lock
} from 'lucide-react';

interface SkipReasonData {
  reason: string;
  count: number;
  percentage: number;
}

interface V27SkipReasonsCardProps {
  evaluations: Array<{
    decision: string;
    reason: string;
    mispricing_exists?: boolean;
    filter_pass?: boolean;
    failed_filter?: string;
  }>;
}

const REASON_LABELS: Record<string, { label: string; icon: React.ReactNode; color: string }> = {
  // Delta / Threshold reasons
  'Delta below threshold': { label: 'Delta te klein', icon: <TrendingDown className="h-4 w-4" />, color: 'text-muted-foreground' },
  'NO_MISPRICING': { label: 'Geen mispricing', icon: <TrendingDown className="h-4 w-4" />, color: 'text-muted-foreground' },
  
  // Causality reasons
  'Causality failed: Polymarket moved first': { label: 'Polymarket sneller', icon: <Clock className="h-4 w-4" />, color: 'text-orange-500' },
  'Causality failed: Spot lead too short': { label: 'Spot lead te kort', icon: <Clock className="h-4 w-4" />, color: 'text-orange-500' },
  'Causality failed: Spot lead too stale': { label: 'Spot lead te oud', icon: <Clock className="h-4 w-4" />, color: 'text-orange-500' },
  'Causality failed: No Polymarket data': { label: 'Geen Poly data', icon: <Clock className="h-4 w-4" />, color: 'text-orange-500' },
  
  // Filter reasons
  'AGGRESSIVE_FLOW': { label: 'Aggressive flow', icon: <Shield className="h-4 w-4" />, color: 'text-red-500' },
  'BOOK_SHAPE': { label: 'Book shape', icon: <BookOpen className="h-4 w-4" />, color: 'text-amber-500' },
  'SPREAD_EXPANSION': { label: 'Spread expansion', icon: <ArrowUpDown className="h-4 w-4" />, color: 'text-amber-500' },
  'FILTER_FAILED': { label: 'Filter gefaald', icon: <Shield className="h-4 w-4" />, color: 'text-red-500' },
  
  // Confidence
  'LOW_CONFIDENCE': { label: 'Lage confidence', icon: <AlertTriangle className="h-4 w-4" />, color: 'text-yellow-500' },
  
  // Position reasons
  'ALREADY_POSITIONED': { label: 'Al gepositioneerd', icon: <Lock className="h-4 w-4" />, color: 'text-blue-500' },
  'WOULD_CROSS_SPREAD': { label: 'Zou spread kruisen', icon: <XCircle className="h-4 w-4" />, color: 'text-red-500' },
  'EXCEEDS_MAX_NOTIONAL': { label: 'Max notional overschreden', icon: <AlertTriangle className="h-4 w-4" />, color: 'text-amber-500' },
  
  // Shadow mode
  'SHADOW_MODE': { label: 'Shadow mode', icon: <Eye className="h-4 w-4" />, color: 'text-purple-500' },
  
  // Polymarket already at expected
  'Polymarket already at expected price': { label: 'Poly al op expected', icon: <TrendingDown className="h-4 w-4" />, color: 'text-muted-foreground' },
  
  // Unknown asset
  'Unknown asset': { label: 'Onbekende asset', icon: <XCircle className="h-4 w-4" />, color: 'text-muted-foreground' },
};

function getReasonInfo(reason: string): { label: string; icon: React.ReactNode; color: string } {
  // Check for exact match
  if (REASON_LABELS[reason]) {
    return REASON_LABELS[reason];
  }
  
  // Check for partial matches (e.g., "Delta 0.0012 below threshold 55")
  if (reason.includes('below threshold')) {
    return REASON_LABELS['Delta below threshold'];
  }
  if (reason.includes('Causality failed')) {
    if (reason.includes('Polymarket moved first')) return REASON_LABELS['Causality failed: Polymarket moved first'];
    if (reason.includes('too short')) return REASON_LABELS['Causality failed: Spot lead too short'];
    if (reason.includes('too stale')) return REASON_LABELS['Causality failed: Spot lead too stale'];
    return { label: 'Causality check', icon: <Clock className="h-4 w-4" />, color: 'text-orange-500' };
  }
  
  // Default
  return { label: reason.slice(0, 25), icon: <XCircle className="h-4 w-4" />, color: 'text-muted-foreground' };
}

export function V27SkipReasonsCard({ evaluations }: V27SkipReasonsCardProps) {
  const skipData = useMemo(() => {
    const skipped = evaluations.filter(e => e.decision === 'SKIP');
    const total = skipped.length;
    
    if (total === 0) return [];
    
    // Count by normalized reason
    const counts: Record<string, number> = {};
    
    for (const eval_ of skipped) {
      let key = eval_.reason;
      
      // Normalize reasons
      if (key.includes('below threshold')) key = 'Delta below threshold';
      if (key.includes('Causality failed: Polymarket moved first')) key = 'Causality failed: Polymarket moved first';
      if (key.includes('Causality failed') && key.includes('too short')) key = 'Causality failed: Spot lead too short';
      if (key.includes('Causality failed') && key.includes('too stale')) key = 'Causality failed: Spot lead too stale';
      if (key.includes('Causality failed') && key.includes('No Polymarket')) key = 'Causality failed: No Polymarket data';
      if (key === 'Polymarket already at expected price') key = 'Polymarket already at expected price';
      
      // Use failed_filter if available
      if (eval_.failed_filter && eval_.failed_filter !== 'NO_MISPRICING') {
        key = eval_.failed_filter;
      }
      
      counts[key] = (counts[key] || 0) + 1;
    }
    
    // Convert to array and sort by count
    return Object.entries(counts)
      .map(([reason, count]) => ({
        reason,
        count,
        percentage: (count / total) * 100,
      }))
      .sort((a, b) => b.count - a.count);
  }, [evaluations]);

  const totalSkipped = evaluations.filter(e => e.decision === 'SKIP').length;
  const totalEntered = evaluations.filter(e => e.decision === 'ENTER').length;
  const entryRate = evaluations.length > 0 ? (totalEntered / evaluations.length) * 100 : 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg flex items-center gap-2">
          <XCircle className="h-5 w-5 text-muted-foreground" />
          Skip Redenen
        </CardTitle>
        <CardDescription>
          {totalSkipped} skips | {totalEntered} entries ({entryRate.toFixed(2)}% entry rate)
        </CardDescription>
      </CardHeader>
      <CardContent>
        {skipData.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-4">
            Nog geen evaluaties
          </p>
        ) : (
          <div className="space-y-4">
            {skipData.slice(0, 8).map((item) => {
              const info = getReasonInfo(item.reason);
              return (
                <div key={item.reason} className="space-y-1">
                  <div className="flex items-center justify-between text-sm">
                    <div className={`flex items-center gap-2 ${info.color}`}>
                      {info.icon}
                      <span>{info.label}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="text-xs">
                        {item.count}
                      </Badge>
                      <span className="text-muted-foreground w-12 text-right">
                        {item.percentage.toFixed(1)}%
                      </span>
                    </div>
                  </div>
                  <Progress value={item.percentage} className="h-2" />
                </div>
              );
            })}
            
            {skipData.length > 8 && (
              <p className="text-xs text-muted-foreground text-center pt-2">
                +{skipData.length - 8} andere redenen
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
