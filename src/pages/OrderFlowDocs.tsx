import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { NavLink } from "@/components/NavLink";
import { ArrowLeft, ArrowRight, CheckCircle, Clock, AlertTriangle, Zap, Database, Server, Globe } from "lucide-react";

const OrderFlowDocs = () => {
  return (
    <div className="min-h-screen bg-background p-4 md:p-8">
      <div className="max-w-6xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center gap-4 mb-6">
          <NavLink to="/live-trading" className="text-muted-foreground hover:text-foreground">
            <ArrowLeft className="w-5 h-5" />
          </NavLink>
          <div>
            <h1 className="text-3xl font-bold">Order Flow Architecture</h1>
            <p className="text-muted-foreground">Hoe orders worden verwerkt van UI → Database → Runner → Polymarket</p>
          </div>
        </div>

        {/* Flow Overview */}
        <Card className="border-primary/20">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Zap className="w-5 h-5 text-yellow-500" />
              Order Flow Pipeline
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap items-center gap-2 text-sm mb-6">
              <Badge variant="outline" className="bg-blue-500/10">1. Edge Function</Badge>
              <ArrowRight className="w-4 h-4 text-muted-foreground" />
              <Badge variant="outline" className="bg-purple-500/10">2. order_queue</Badge>
              <ArrowRight className="w-4 h-4 text-muted-foreground" />
              <Badge variant="outline" className="bg-orange-500/10">3. Local Runner</Badge>
              <ArrowRight className="w-4 h-4 text-muted-foreground" />
              <Badge variant="outline" className="bg-green-500/10">4. Polymarket CLOB</Badge>
              <ArrowRight className="w-4 h-4 text-muted-foreground" />
              <Badge variant="outline" className="bg-cyan-500/10">5. Confirmation</Badge>
            </div>
            
            <div className="bg-muted/30 p-4 rounded-lg font-mono text-xs overflow-x-auto">
              <pre>{`┌──────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│  live-trade-     │────▶│   order_queue    │────▶│   Local Runner   │
│  realtime (Edge) │     │   (Supabase)     │     │   (VPS/Docker)   │
└──────────────────┘     └──────────────────┘     └──────────────────┘
        │                        │                        │
        │ WebSocket              │ Realtime               │ HTTP/CLOB
        │ CLOB prices            │ subscription           │ API calls
        ▼                        ▼                        ▼
┌──────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│   Polymarket     │     │   runner-proxy   │     │   Polymarket     │
│   WebSocket      │     │   (Edge Func)    │◀────│   REST API       │
└──────────────────┘     └──────────────────┘     └──────────────────┘`}</pre>
            </div>
          </CardContent>
        </Card>

        {/* Step 1: Signal Detection */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Badge className="bg-blue-500">1</Badge>
              Signal Detection (live-trade-realtime)
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-muted-foreground">
              De <code className="text-primary">live-trade-realtime</code> edge function draait continu en luistert naar Polymarket CLOB WebSocket voor prijsupdates.
            </p>
            
            <div className="grid md:grid-cols-2 gap-4">
              <div className="bg-muted/30 p-4 rounded-lg">
                <h4 className="font-semibold mb-2 flex items-center gap-2">
                  <Globe className="w-4 h-4" /> Input: WebSocket Events
                </h4>
                <ul className="text-sm space-y-1 text-muted-foreground">
                  <li>• <code>book</code> - Orderbook updates (bids/asks)</li>
                  <li>• <code>price_change</code> - Mid-price changes</li>
                  <li>• Evaluatie elke prijsupdate (~100-500ms)</li>
                </ul>
              </div>
              
              <div className="bg-muted/30 p-4 rounded-lg">
                <h4 className="font-semibold mb-2 flex items-center gap-2">
                  <CheckCircle className="w-4 h-4 text-green-500" /> Output: Trade Signal
                </h4>
                <ul className="text-sm space-y-1 text-muted-foreground">
                  <li>• Check entry/hedge/accumulate condities</li>
                  <li>• Valideer positie limieten</li>
                  <li>• Queue order naar <code>order_queue</code></li>
                </ul>
              </div>
            </div>

            <div className="bg-yellow-500/10 border border-yellow-500/30 p-4 rounded-lg">
              <h4 className="font-semibold text-yellow-600 mb-2 flex items-center gap-2">
                <AlertTriangle className="w-4 h-4" /> Deduplicatie
              </h4>
              <p className="text-sm text-muted-foreground">
                Orders worden ge-dedupliceerd via een <code>decisionKey</code> (market + outcome + minute). 
                Dit voorkomt duplicate orders bij snelle prijsschommelingen.
              </p>
              <pre className="mt-2 text-xs bg-muted/50 p-2 rounded overflow-x-auto">{`const key = \`\${market_slug}-\${outcome}-\${Math.floor(Date.now() / 60000)}\`;
if (recentDecisions.has(key)) return; // Skip duplicate`}</pre>
            </div>
          </CardContent>
        </Card>

        {/* Step 2: Order Queue */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Badge className="bg-purple-500">2</Badge>
              Order Queue (Supabase Table)
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-muted-foreground">
              Orders worden opgeslagen in de <code className="text-primary">order_queue</code> tabel als centrale buffer tussen de edge function en de local runner.
            </p>
            
            <div className="bg-muted/30 p-4 rounded-lg font-mono text-xs overflow-x-auto">
              <pre>{`// order_queue schema
{
  id: uuid,
  status: 'pending' | 'processing' | 'filled' | 'failed' | 'cancelled',
  token_id: string,        // Polymarket token ID
  market_slug: string,     // e.g., "btc-updown-15m-1767094200"
  outcome: 'UP' | 'DOWN',
  shares: number,
  price: number,
  order_type: 'GTC',       // Good-Til-Cancelled
  created_at: timestamp,
  executed_at: timestamp | null,
  order_id: string | null, // Polymarket order ID na plaatsing
  avg_fill_price: number | null,
  error_message: string | null
}`}</pre>
            </div>

            <div className="grid md:grid-cols-3 gap-4">
              <div className="text-center p-4 bg-yellow-500/10 rounded-lg">
                <Clock className="w-8 h-8 mx-auto mb-2 text-yellow-500" />
                <div className="font-semibold">pending</div>
                <p className="text-xs text-muted-foreground">Wacht op runner pickup</p>
              </div>
              <div className="text-center p-4 bg-blue-500/10 rounded-lg">
                <Zap className="w-8 h-8 mx-auto mb-2 text-blue-500" />
                <div className="font-semibold">processing</div>
                <p className="text-xs text-muted-foreground">Runner bezig met executie</p>
              </div>
              <div className="text-center p-4 bg-green-500/10 rounded-lg">
                <CheckCircle className="w-8 h-8 mx-auto mb-2 text-green-500" />
                <div className="font-semibold">filled</div>
                <p className="text-xs text-muted-foreground">Order uitgevoerd</p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Step 3: Runner Polling */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Badge className="bg-orange-500">3</Badge>
              Local Runner Polling
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-muted-foreground">
              De local runner (op je VPS) pollt elke <strong>2 seconden</strong> voor nieuwe orders via de <code>runner-proxy</code> edge function.
            </p>
            
            <div className="bg-muted/30 p-4 rounded-lg font-mono text-xs overflow-x-auto">
              <pre>{`// local-runner/src/index.ts - Order polling
const ORDER_POLL_INTERVAL = 2000; // 2 seconden

setInterval(async () => {
  const response = await fetch(RUNNER_PROXY_URL, {
    method: 'POST',
    headers: { 'x-runner-secret': RUNNER_SECRET },
    body: JSON.stringify({ action: 'get-pending-orders' })
  });
  
  const { orders } = await response.json();
  
  for (const order of orders) {
    // Status wordt 'processing' gezet door runner-proxy
    const result = await placeOrder({
      tokenId: order.token_id,
      side: 'BUY',
      price: order.price,
      size: order.shares,
      orderType: 'GTC'
    });
    
    // Update order status in database
    await updateOrder(order.id, result);
  }
}, ORDER_POLL_INTERVAL);`}</pre>
            </div>

            <div className="bg-blue-500/10 border border-blue-500/30 p-4 rounded-lg">
              <h4 className="font-semibold text-blue-600 mb-2">Waarom Polling i.p.v. WebSocket?</h4>
              <ul className="text-sm text-muted-foreground space-y-1">
                <li>• Edge functions kunnen geen uitgaande WebSocket connecties onderhouden</li>
                <li>• Runner draait achter VPN → kan niet direct bereikt worden</li>
                <li>• 2s polling latency is acceptabel voor 15m markets</li>
                <li>• Eenvoudiger error recovery bij connection drops</li>
              </ul>
            </div>
          </CardContent>
        </Card>

        {/* Step 4: Polymarket Execution */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Badge className="bg-green-500">4</Badge>
              Polymarket CLOB Executie
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-muted-foreground">
              De runner plaatst orders via de Polymarket CLOB SDK met signature-based authentication.
            </p>
            
            <div className="grid md:grid-cols-2 gap-4">
              <div className="bg-muted/30 p-4 rounded-lg">
                <h4 className="font-semibold mb-2">Pre-Order Checks</h4>
                <ul className="text-sm space-y-1 text-muted-foreground">
                  <li>✓ Orderbook existence check</li>
                  <li>✓ Liquidity check (min 10 shares)</li>
                  <li>✓ Throttling (min 1.5s tussen orders)</li>
                  <li>✓ Cloudflare WAF backoff</li>
                </ul>
              </div>
              
              <div className="bg-muted/30 p-4 rounded-lg">
                <h4 className="font-semibold mb-2">Price Improvement</h4>
                <ul className="text-sm space-y-1 text-muted-foreground">
                  <li>• Prijs &lt; 50¢: +1¢ improvement</li>
                  <li>• Prijs &gt; 50¢: +2¢ improvement</li>
                  <li>• Max prijs: 99¢</li>
                  <li>• Order type: GTC (resting)</li>
                </ul>
              </div>
            </div>

            <div className="bg-muted/30 p-4 rounded-lg font-mono text-xs overflow-x-auto">
              <pre>{`// polymarket.ts - Order placement
const response = await client.createAndPostOrder(
  {
    tokenID: order.tokenId,
    price: adjustedPrice,  // Met price improvement
    size: order.size,
    side: Side.BUY,
  },
  {
    tickSize: '0.01',
    negRisk: false,
  },
  OrderType.GTC  // Good-Til-Cancelled
);

// Verify order placement
const orderDetails = await client.getOrder(orderId);
const fillStatus = sizeMatched >= originalSize ? 'filled' : 'open';`}</pre>
            </div>
          </CardContent>
        </Card>

        {/* Step 5: Confirmation */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Badge className="bg-cyan-500">5</Badge>
              Confirmation & Sync
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-muted-foreground">
              Na order placement wordt de status gesynchroniseerd en worden posities geverifieerd.
            </p>
            
            <div className="grid md:grid-cols-2 gap-4">
              <div className="bg-muted/30 p-4 rounded-lg">
                <h4 className="font-semibold mb-2 flex items-center gap-2">
                  <Database className="w-4 h-4" /> Order Update Flow
                </h4>
                <ol className="text-sm space-y-1 text-muted-foreground list-decimal list-inside">
                  <li>Runner ontvangt order response</li>
                  <li>Verifieer via <code>getOrder()</code></li>
                  <li>Update <code>order_queue</code> status</li>
                  <li>Insert in <code>live_trades</code></li>
                </ol>
              </div>
              
              <div className="bg-muted/30 p-4 rounded-lg">
                <h4 className="font-semibold mb-2 flex items-center gap-2">
                  <Server className="w-4 h-4" /> Position Sync
                </h4>
                <ol className="text-sm space-y-1 text-muted-foreground list-decimal list-inside">
                  <li>Elke 60s: fetch Polymarket positions</li>
                  <li>Vergelijk met <code>bot_positions</code></li>
                  <li>Upsert nieuwe/gewijzigde posities</li>
                  <li>Reconcile pending trades</li>
                </ol>
              </div>
            </div>

            <div className="bg-green-500/10 border border-green-500/30 p-4 rounded-lg">
              <h4 className="font-semibold text-green-600 mb-2">Realtime UI Updates</h4>
              <p className="text-sm text-muted-foreground">
                De UI subscribet op Supabase Realtime voor <code>order_queue</code> en <code>live_trades</code> tabellen.
                Status updates verschijnen binnen 1-2 seconden na database write.
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Timing Analysis */}
        <Card className="border-yellow-500/30">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Clock className="w-5 h-5 text-yellow-500" />
              Latency Analyse
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b">
                    <th className="text-left py-2">Stap</th>
                    <th className="text-right py-2">Typische Latency</th>
                    <th className="text-right py-2">Worst Case</th>
                  </tr>
                </thead>
                <tbody className="font-mono">
                  <tr className="border-b border-muted">
                    <td className="py-2">CLOB WebSocket → Edge Function</td>
                    <td className="text-right text-green-500">~50ms</td>
                    <td className="text-right text-yellow-500">200ms</td>
                  </tr>
                  <tr className="border-b border-muted">
                    <td className="py-2">Edge Function evaluatie</td>
                    <td className="text-right text-green-500">~20ms</td>
                    <td className="text-right text-yellow-500">100ms</td>
                  </tr>
                  <tr className="border-b border-muted">
                    <td className="py-2">Insert in order_queue</td>
                    <td className="text-right text-green-500">~30ms</td>
                    <td className="text-right text-yellow-500">100ms</td>
                  </tr>
                  <tr className="border-b border-muted">
                    <td className="py-2">Runner polling interval</td>
                    <td className="text-right text-yellow-500">0-2000ms</td>
                    <td className="text-right text-red-500">2000ms</td>
                  </tr>
                  <tr className="border-b border-muted">
                    <td className="py-2">Orderbook depth check</td>
                    <td className="text-right text-green-500">~100ms</td>
                    <td className="text-right text-yellow-500">500ms</td>
                  </tr>
                  <tr className="border-b border-muted">
                    <td className="py-2">Order placement + verify</td>
                    <td className="text-right text-green-500">~200ms</td>
                    <td className="text-right text-yellow-500">1000ms</td>
                  </tr>
                  <tr className="font-bold">
                    <td className="py-2">TOTAAL</td>
                    <td className="text-right text-green-500">~2.4s</td>
                    <td className="text-right text-red-500">~4s</td>
                  </tr>
                </tbody>
              </table>
            </div>
            
            <div className="mt-4 bg-muted/30 p-4 rounded-lg">
              <p className="text-sm text-muted-foreground">
                <strong>Conclusie:</strong> Typische order latency is 2-4 seconden van signaal tot fill. 
                Voor 15-minuut markets (900 seconden) is dit acceptabel (~0.3-0.4% van market duration).
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Links */}
        <div className="flex gap-4 justify-center pt-4">
          <NavLink to="/data-flow-docs">
            <Badge variant="outline" className="cursor-pointer hover:bg-primary/10">
              Data Flow Docs →
            </Badge>
          </NavLink>
          <NavLink to="/gpt-strategy">
            <Badge variant="outline" className="cursor-pointer hover:bg-primary/10">
              Strategy Docs →
            </Badge>
          </NavLink>
        </div>
      </div>
    </div>
  );
};

export default OrderFlowDocs;
