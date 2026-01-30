import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Info, TrendingUp, TrendingDown, Zap } from 'lucide-react';

export function DeltaExplainerCard() {
  return (
    <Card className="border-primary/30 bg-gradient-to-br from-primary/5 to-transparent">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Info className="h-5 w-5 text-primary" />
          Wat is Delta Direction?
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="text-sm text-muted-foreground">
          <strong className="text-foreground">Delta</strong> is het verschil tussen de huidige spot prijs 
          (van Binance of Chainlink) en de strike prijs van de Polymarket markt.
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="p-4 rounded-lg bg-green-500/10 border border-green-500/20">
            <div className="flex items-center gap-2 mb-2">
              <TrendingUp className="h-5 w-5 text-green-500" />
              <span className="font-semibold text-green-500">Positieve Delta</span>
            </div>
            <p className="text-sm text-muted-foreground">
              <strong>Spot &gt; Strike</strong> → Prijs is al BOVEN de strike prijs
            </p>
            <div className="mt-2 text-xs">
              <Badge variant="outline" className="bg-green-500/10 text-green-500 border-green-500/30">
                Direction: UP favoriet
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground mt-2">
              Voorbeeld: BTC spot = $105,000, Strike = $104,500<br/>
              Delta = +$500 → UP outcome is waarschijnlijk
            </p>
          </div>

          <div className="p-4 rounded-lg bg-red-500/10 border border-red-500/20">
            <div className="flex items-center gap-2 mb-2">
              <TrendingDown className="h-5 w-5 text-red-500" />
              <span className="font-semibold text-red-500">Negatieve Delta</span>
            </div>
            <p className="text-sm text-muted-foreground">
              <strong>Spot &lt; Strike</strong> → Prijs is ONDER de strike prijs
            </p>
            <div className="mt-2 text-xs">
              <Badge variant="outline" className="bg-red-500/10 text-red-500 border-red-500/30">
                Direction: DOWN favoriet
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground mt-2">
              Voorbeeld: ETH spot = $3,200, Strike = $3,250<br/>
              Delta = -$50 → DOWN outcome is waarschijnlijk
            </p>
          </div>
        </div>

        <div className="p-4 rounded-lg bg-muted/50 border">
          <div className="flex items-center gap-2 mb-2">
            <Zap className="h-5 w-5 text-yellow-500" />
            <span className="font-semibold">Gabagool's Strategie</span>
          </div>
          <ul className="text-sm space-y-2 text-muted-foreground">
            <li>
              <strong>1. Dual-side hedging:</strong> Hij koopt ALTIJD zowel UP als DOWN in elke markt
            </li>
            <li>
              <strong>2. Combined Entry:</strong> Als UP prijs + DOWN prijs &lt; $1, is er gegarandeerde winst
            </li>
            <li>
              <strong>3. Delta onafhankelijk:</strong> Hij negeert delta grotendeels - koopt beide kanten
            </li>
            <li>
              <strong>4. Volume arbitrage:</strong> Focus op grote volumes waar spreads gunstiger zijn
            </li>
          </ul>
        </div>

        <div className="text-xs text-muted-foreground border-t pt-4">
          <strong>Formule:</strong> Delta = Binance_Prijs - Strike_Prijs<br/>
          <strong>Win kans:</strong> Combined Entry = Gem. UP prijs + Gem. DOWN prijs<br/>
          Als Combined Entry &lt; 100¢ → Gegarandeerde winst = 100¢ - Combined Entry per share pair
        </div>
      </CardContent>
    </Card>
  );
}
