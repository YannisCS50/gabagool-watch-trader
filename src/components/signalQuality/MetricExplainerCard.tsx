import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { SignalQualityStats } from '@/types/signalQuality';
import { 
  HelpCircle, 
  TrendingUp, 
  TrendingDown, 
  AlertTriangle, 
  CheckCircle,
  XCircle,
  Target,
  Zap,
  Clock
} from 'lucide-react';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface MetricExplainerCardProps {
  stats: SignalQualityStats | null;
  isLoading?: boolean;
}

export function MetricExplainerCard({ stats, isLoading }: MetricExplainerCardProps) {
  if (isLoading) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {[1, 2, 3, 4].map(i => (
          <Card key={i} className="animate-pulse">
            <CardContent className="py-6">
              <div className="h-20 bg-muted rounded" />
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }
  
  if (!stats) {
    return (
      <Card className="border-dashed">
        <CardContent className="py-8 text-center text-muted-foreground">
          Geen data beschikbaar. Klik op "Populate" om signalen te analyseren.
        </CardContent>
      </Card>
    );
  }
  
  return (
    <TooltipProvider>
      <div className="space-y-6">
        {/* Total Signals - the foundation */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <Target className="h-5 w-5 text-primary" />
              <CardTitle className="text-lg">Totaal Signalen Geanalyseerd</CardTitle>
              <MetricHelp 
                title="Wat zijn signalen?"
                content="Een signaal is een moment waarop de bot een potentiële trading kans detecteerde. Dit gebeurt wanneer de prijs op Polymarket afwijkt van de 'eerlijke' prijs berekend uit Binance data."
              />
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-4xl font-bold mb-2">{stats.totalSignals.toLocaleString()}</div>
            <p className="text-muted-foreground">
              Dit zijn alle momenten waarop de bot een kans zag om te traden. 
              Hoe meer signalen, hoe betrouwbaarder de statistieken.
              <span className="text-primary font-medium"> Minimaal 1000 signalen wordt aanbevolen</span> voor betrouwbare conclusies.
            </p>
            <div className="mt-3">
              <Progress value={Math.min(100, (stats.totalSignals / 1000) * 100)} className="h-2" />
              <div className="text-xs text-muted-foreground mt-1">
                {stats.totalSignals >= 1000 ? '✓ Voldoende data voor analyse' : `${1000 - stats.totalSignals} signalen nodig voor betrouwbare analyse`}
              </div>
            </div>
          </CardContent>
        </Card>
        
        {/* Edge metrics */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Card className={stats.avgEdgeAfterSpread > 0 ? 'border-green-500/30' : 'border-red-500/30'}>
            <CardHeader className="pb-3">
              <div className="flex items-center gap-2">
                {stats.avgEdgeAfterSpread > 0 ? (
                  <TrendingUp className="h-5 w-5 text-green-500" />
                ) : (
                  <TrendingDown className="h-5 w-5 text-red-500" />
                )}
                <CardTitle className="text-lg">Gemiddelde Edge</CardTitle>
                <MetricHelp 
                  title="Wat is Edge?"
                  content="Edge is hoeveel cent je gemiddeld wint per share, NA aftrek van spread kosten. Spread is het verschil tussen koop- en verkoopprijs. Een positieve edge betekent dat je strategie winstgevend is."
                />
              </div>
            </CardHeader>
            <CardContent>
              <div className={`text-4xl font-bold mb-2 ${stats.avgEdgeAfterSpread > 0 ? 'text-green-500' : 'text-red-500'}`}>
                {stats.avgEdgeAfterSpread.toFixed(2)}¢
              </div>
              <p className="text-muted-foreground text-sm">
                {stats.avgEdgeAfterSpread > 0 ? (
                  <>
                    <span className="text-green-500 font-medium">Goed!</span> Je verdient gemiddeld {stats.avgEdgeAfterSpread.toFixed(2)} cent per share na kosten. 
                    Bij 1000 shares is dat ${(stats.avgEdgeAfterSpread * 10).toFixed(2)}.
                  </>
                ) : (
                  <>
                    <span className="text-red-500 font-medium">Probleem!</span> Je verliest gemiddeld {Math.abs(stats.avgEdgeAfterSpread).toFixed(2)} cent per share. 
                    De spread kosten zijn hoger dan je winst.
                  </>
                )}
              </p>
              
              {/* Visual explanation */}
              <div className="mt-4 p-3 rounded-lg bg-muted/50 text-sm">
                <div className="font-medium mb-2">Hoe wordt edge berekend?</div>
                <div className="space-y-1 text-muted-foreground">
                  <div>📈 Prijsbeweging na 7 seconden</div>
                  <div>➖ Minus: spread kosten (koop-verkoop verschil)</div>
                  <div>=  <span className="font-medium text-foreground">Netto edge</span></div>
                </div>
              </div>
            </CardContent>
          </Card>
          
          <Card className={stats.falseEdgePct < 30 ? 'border-green-500/30' : 'border-amber-500/30'}>
            <CardHeader className="pb-3">
              <div className="flex items-center gap-2">
                <AlertTriangle className={`h-5 w-5 ${stats.falseEdgePct < 30 ? 'text-green-500' : 'text-amber-500'}`} />
                <CardTitle className="text-lg">False Edges</CardTitle>
                <MetricHelp 
                  title="Wat is een False Edge?"
                  content="Een false edge is een signaal dat er winstgevend uitziet (de prijs beweegt de goede kant op), maar toch geld verliest door spread kosten. Dit is een van de grootste valkuilen in trading."
                />
              </div>
            </CardHeader>
            <CardContent>
              <div className={`text-4xl font-bold mb-2 ${stats.falseEdgePct < 30 ? 'text-green-500' : 'text-amber-500'}`}>
                {stats.falseEdgePct.toFixed(1)}%
              </div>
              <p className="text-muted-foreground text-sm">
                {stats.falseEdgeCount.toLocaleString()} van {stats.totalSignals.toLocaleString()} signalen 
                zagen er winstgevend uit maar waren het niet.
              </p>
              
              {/* Risk indicator */}
              <div className="mt-4">
                <div className="flex justify-between text-xs mb-1">
                  <span>Laag risico</span>
                  <span>Hoog risico</span>
                </div>
                <div className="h-3 rounded-full bg-gradient-to-r from-green-500 via-amber-500 to-red-500 relative">
                  <div 
                    className="absolute top-1/2 -translate-y-1/2 w-3 h-3 bg-white border-2 border-foreground rounded-full"
                    style={{ left: `${Math.min(95, stats.falseEdgePct)}%` }}
                  />
                </div>
                <div className="text-xs text-muted-foreground mt-2">
                  {stats.falseEdgePct < 20 && '✓ Uitstekend - weinig false positives'}
                  {stats.falseEdgePct >= 20 && stats.falseEdgePct < 40 && '⚠ Acceptabel maar let op spread kosten'}
                  {stats.falseEdgePct >= 40 && '⛔ Te hoog - verhoog minimum delta drempel'}
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
        
        {/* Should Trade Analysis */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <Zap className="h-5 w-5 text-primary" />
              <CardTitle className="text-lg">Signaal Filter Effectiviteit</CardTitle>
              <MetricHelp 
                title="Wat is de Signaal Filter?"
                content="De bot filtert signalen op basis van regels (delta grootte, timing, etc). 'Should Trade = True' betekent dat de bot denkt dat dit een goede trade is. Deze analyse toont of de filter daadwerkelijk helpt."
              />
            </div>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground mb-4">
              Vergelijking van win rates: trades die de filter doorliet vs. trades die gefilterd werden.
              Een effectieve filter heeft een <span className="font-medium text-foreground">hoger win rate voor "Should Trade"</span>.
            </p>
            
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="p-4 rounded-lg bg-green-500/10 border border-green-500/30">
                <div className="flex items-center gap-2 mb-2">
                  <CheckCircle className="h-5 w-5 text-green-500" />
                  <span className="font-medium">Should Trade = True</span>
                </div>
                <div className="text-3xl font-bold text-green-500 mb-1">
                  {stats.winRateWhenShouldTrade.toFixed(1)}% win rate
                </div>
                <div className="text-sm text-muted-foreground">
                  {stats.shouldTradeCount.toLocaleString()} signalen doorgelaten
                </div>
                <div className="text-xs text-muted-foreground mt-2">
                  Dit zijn trades die de bot zou uitvoeren
                </div>
              </div>
              
              <div className="p-4 rounded-lg bg-red-500/10 border border-red-500/30">
                <div className="flex items-center gap-2 mb-2">
                  <XCircle className="h-5 w-5 text-red-500" />
                  <span className="font-medium">Should Trade = False</span>
                </div>
                <div className="text-3xl font-bold text-red-500 mb-1">
                  {stats.winRateWhenShouldNotTrade.toFixed(1)}% win rate
                </div>
                <div className="text-sm text-muted-foreground">
                  {stats.shouldNotTradeCount.toLocaleString()} signalen geblokkeerd
                </div>
                <div className="text-xs text-muted-foreground mt-2">
                  Dit zijn trades die de bot zou skippen
                </div>
              </div>
            </div>
            
            {/* Filter effectiveness summary */}
            <div className="mt-4 p-3 rounded-lg bg-muted/50">
              <div className="flex items-center gap-2">
                {stats.winRateWhenShouldTrade > stats.winRateWhenShouldNotTrade + 10 ? (
                  <>
                    <CheckCircle className="h-5 w-5 text-green-500" />
                    <span className="text-green-500 font-medium">Filter werkt goed!</span>
                  </>
                ) : stats.winRateWhenShouldTrade > stats.winRateWhenShouldNotTrade ? (
                  <>
                    <Clock className="h-5 w-5 text-amber-500" />
                    <span className="text-amber-500 font-medium">Filter helpt een beetje</span>
                  </>
                ) : (
                  <>
                    <XCircle className="h-5 w-5 text-red-500" />
                    <span className="text-red-500 font-medium">Filter werkt niet!</span>
                  </>
                )}
              </div>
              <p className="text-sm text-muted-foreground mt-1">
                Verschil: {(stats.winRateWhenShouldTrade - stats.winRateWhenShouldNotTrade).toFixed(1)} procentpunt.
                {stats.winRateWhenShouldTrade > stats.winRateWhenShouldNotTrade + 10 
                  ? ' De filter selecteert duidelijk betere trades.'
                  : stats.winRateWhenShouldTrade > stats.winRateWhenShouldNotTrade
                  ? ' Overweeg strengere filterregels.'
                  : ' De filter maakt het erger - herzie de logica!'}
              </p>
            </div>
          </CardContent>
        </Card>
        
        {/* Low confidence warning */}
        {stats.lowConfidencePct > 15 && (
          <Card className="border-amber-500/50 bg-amber-500/5">
            <CardContent className="py-4">
              <div className="flex items-start gap-3">
                <AlertTriangle className="h-6 w-6 text-amber-500 flex-shrink-0 mt-0.5" />
                <div>
                  <div className="font-medium text-amber-500 mb-1">⚠️ Waarschuwing: Onbetrouwbare Data</div>
                  <p className="text-sm text-muted-foreground">
                    <span className="font-medium">{stats.lowConfidencePct.toFixed(0)}%</span> van de signalen 
                    ({stats.lowConfidenceCount.toLocaleString()}) komt uit categorieën met weinig historische data (minder dan 30 samples).
                    Dit betekent dat de statistieken voor die signalen onbetrouwbaar kunnen zijn.
                  </p>
                  <p className="text-sm text-muted-foreground mt-2">
                    <span className="font-medium">Wat te doen:</span> Wacht op meer data, of focus alleen op 
                    de delta buckets met voldoende samples (zie tabel hieronder).
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </TooltipProvider>
  );
}

function MetricHelp({ title, content }: { title: string; content: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <HelpCircle className="h-4 w-4 text-muted-foreground cursor-help" />
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">
        <div className="font-medium mb-1">{title}</div>
        <p className="text-xs">{content}</p>
      </TooltipContent>
    </Tooltip>
  );
}
