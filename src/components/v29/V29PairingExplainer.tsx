import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Info, TrendingUp, TrendingDown, ArrowRight, CheckCircle } from 'lucide-react';

export function V29PairingExplainer() {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Info className="h-4 w-4" />
          How V29 Pair-Instead-of-Sell Works
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Step by step */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div className="p-3 bg-blue-500/10 rounded-lg space-y-2">
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="text-xs">1</Badge>
              <span className="font-medium text-sm">Binance Tick</span>
            </div>
            <p className="text-xs text-muted-foreground">
              Binance price moves $6+ → Buy shares in direction of move
            </p>
            <div className="flex items-center gap-1 text-xs">
              <TrendingUp className="h-3 w-3 text-green-500" />
              <span>Price up → Buy UP</span>
            </div>
            <div className="flex items-center gap-1 text-xs">
              <TrendingDown className="h-3 w-3 text-red-500" />
              <span>Price down → Buy DOWN</span>
            </div>
          </div>

          <div className="p-3 bg-orange-500/10 rounded-lg space-y-2">
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="text-xs">2</Badge>
              <span className="font-medium text-sm">Wait for Pair</span>
            </div>
            <p className="text-xs text-muted-foreground">
              Position is "unpaired" - waiting for opposite side to become cheap
            </p>
            <div className="flex items-center gap-1 text-xs text-orange-500">
              <ArrowRight className="h-3 w-3" />
              <span>Monitoring orderbook...</span>
            </div>
          </div>

          <div className="p-3 bg-green-500/10 rounded-lg space-y-2">
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="text-xs">3</Badge>
              <span className="font-medium text-sm">Pair Up</span>
            </div>
            <p className="text-xs text-muted-foreground">
              When combined price {"<"} 98¢, buy opposite side to lock profit
            </p>
            <div className="flex items-center gap-1 text-xs">
              <span>UP@60¢ + DOWN@38¢ = 98¢</span>
            </div>
            <div className="flex items-center gap-1 text-xs text-green-500">
              <CheckCircle className="h-3 w-3" />
              <span>2¢ profit locked!</span>
            </div>
          </div>

          <div className="p-3 bg-purple-500/10 rounded-lg space-y-2">
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="text-xs">4</Badge>
              <span className="font-medium text-sm">Settlement</span>
            </div>
            <p className="text-xs text-muted-foreground">
              At market end, one side pays $1. We own both sides!
            </p>
            <div className="flex items-center gap-1 text-xs">
              <span>Invested: 98¢</span>
            </div>
            <div className="flex items-center gap-1 text-xs text-green-500">
              <span>Receive: $1.00</span>
            </div>
          </div>
        </div>

        {/* Advantages */}
        <div className="p-3 bg-muted/30 rounded-lg">
          <p className="text-sm font-medium mb-2">✨ Advantages over Selling</p>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
            <div className="flex items-center gap-1">
              <CheckCircle className="h-3 w-3 text-green-500" />
              <span>No sell slippage</span>
            </div>
            <div className="flex items-center gap-1">
              <CheckCircle className="h-3 w-3 text-green-500" />
              <span>Buying is easier</span>
            </div>
            <div className="flex items-center gap-1">
              <CheckCircle className="h-3 w-3 text-green-500" />
              <span>Profit guaranteed</span>
            </div>
            <div className="flex items-center gap-1">
              <CheckCircle className="h-3 w-3 text-green-500" />
              <span>No active exit</span>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
