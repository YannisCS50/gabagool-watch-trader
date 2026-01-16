import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Lightbulb, CheckCircle, AlertTriangle, XCircle, ArrowRight } from 'lucide-react';

interface RecommendationsPanelProps {
  recommendations: string[];
  isLoading?: boolean;
}

export function RecommendationsPanel({ recommendations, isLoading }: RecommendationsPanelProps) {
  if (isLoading) {
    return (
      <Card>
        <CardContent className="py-8">
          <div className="animate-pulse space-y-3">
            {[1, 2, 3].map(i => (
              <div key={i} className="h-8 bg-muted rounded" />
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  const getIcon = (rec: string) => {
    if (rec.startsWith('✅')) return <CheckCircle className="h-5 w-5 text-green-500 flex-shrink-0" />;
    if (rec.startsWith('⚠️')) return <AlertTriangle className="h-5 w-5 text-yellow-500 flex-shrink-0" />;
    if (rec.startsWith('❌')) return <XCircle className="h-5 w-5 text-red-500 flex-shrink-0" />;
    if (rec.startsWith('📈') || rec.startsWith('🎯') || rec.startsWith('🚀')) {
      return <ArrowRight className="h-5 w-5 text-blue-500 flex-shrink-0" />;
    }
    if (rec.startsWith('⏸️')) return <AlertTriangle className="h-5 w-5 text-orange-500 flex-shrink-0" />;
    return <Lightbulb className="h-5 w-5 text-primary flex-shrink-0" />;
  };

  const cleanText = (rec: string) => {
    // Remove emoji prefix if present
    return rec.replace(/^[✅⚠️❌📈🎯🚀⏸️]\s*/, '');
  };

  const getCategory = (rec: string): 'action' | 'warning' | 'info' => {
    if (rec.startsWith('✅') || rec.startsWith('🚀') || rec.startsWith('🎯')) return 'action';
    if (rec.startsWith('⚠️') || rec.startsWith('⏸️')) return 'warning';
    return 'info';
  };

  // Group recommendations by category
  const actions = recommendations.filter(r => getCategory(r) === 'action');
  const warnings = recommendations.filter(r => getCategory(r) === 'warning');
  const info = recommendations.filter(r => getCategory(r) === 'info');

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Lightbulb className="h-5 w-5 text-yellow-500" />
          <CardTitle>Aanbevelingen</CardTitle>
        </div>
        <p className="text-sm text-muted-foreground">
          Concrete acties gebaseerd op de data-analyse
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Actions */}
        {actions.length > 0 && (
          <div className="space-y-2">
            <h4 className="text-sm font-medium text-green-500 flex items-center gap-1">
              <CheckCircle className="h-4 w-4" /> Doen
            </h4>
            <ul className="space-y-2">
              {actions.map((rec, i) => (
                <li key={i} className="flex items-start gap-3 p-3 rounded-lg bg-green-500/10 border border-green-500/20">
                  {getIcon(rec)}
                  <span className="text-sm">{cleanText(rec)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Warnings */}
        {warnings.length > 0 && (
          <div className="space-y-2">
            <h4 className="text-sm font-medium text-yellow-500 flex items-center gap-1">
              <AlertTriangle className="h-4 w-4" /> Let op
            </h4>
            <ul className="space-y-2">
              {warnings.map((rec, i) => (
                <li key={i} className="flex items-start gap-3 p-3 rounded-lg bg-yellow-500/10 border border-yellow-500/20">
                  {getIcon(rec)}
                  <span className="text-sm">{cleanText(rec)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Info */}
        {info.length > 0 && (
          <div className="space-y-2">
            <h4 className="text-sm font-medium text-blue-500 flex items-center gap-1">
              <Lightbulb className="h-4 w-4" /> Inzichten
            </h4>
            <ul className="space-y-2">
              {info.map((rec, i) => (
                <li key={i} className="flex items-start gap-3 p-3 rounded-lg bg-blue-500/10 border border-blue-500/20">
                  {getIcon(rec)}
                  <span className="text-sm">{cleanText(rec)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {recommendations.length === 0 && (
          <div className="text-center text-muted-foreground py-4">
            Geen aanbevelingen beschikbaar - meer data nodig
          </div>
        )}
      </CardContent>
    </Card>
  );
}
