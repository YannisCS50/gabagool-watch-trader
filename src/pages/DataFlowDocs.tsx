import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { NavLink } from "@/components/NavLink";
import { ArrowLeft, ArrowRight, Radio, Database, Wifi, RefreshCw, Eye, Clock, CheckCircle } from "lucide-react";

const DataFlowDocs = () => {
  return (
    <div className="min-h-screen bg-background p-4 md:p-8">
      <div className="max-w-6xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center gap-4 mb-6">
          <NavLink to="/live-trading" className="text-muted-foreground hover:text-foreground">
            <ArrowLeft className="w-5 h-5" />
          </NavLink>
          <div>
            <h1 className="text-3xl font-bold">Data Flow Architecture</h1>
            <p className="text-muted-foreground">Hoe data realtime wordt gelezen en gesynchroniseerd</p>
          </div>
        </div>

        {/* Overview */}
        <Card className="border-primary/20">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Radio className="w-5 h-5 text-green-500" />
              Realtime Data Sources
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="bg-muted/30 p-4 rounded-lg font-mono text-xs overflow-x-auto">
              <pre>{`┌─────────────────────────────────────────────────────────────────────────────┐
│                           DATA SOURCES                                       │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐                  │
│  │  Polymarket  │    │  Polymarket  │    │   Chainlink  │                  │
│  │ CLOB WebSocket│    │  Data API    │    │     RPC      │                  │
│  │  (prices)    │    │ (positions)  │    │   (oracle)   │                  │
│  └──────┬───────┘    └──────┬───────┘    └──────┬───────┘                  │
│         │                   │                   │                           │
│         ▼                   ▼                   ▼                           │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │                      SUPABASE EDGE FUNCTIONS                          │  │
│  │  • live-trade-realtime (WebSocket consumer)                          │  │
│  │  • runner-proxy (position sync)                                      │  │
│  │  • chainlink-price-collector (oracle prices)                         │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│         │                   │                   │                           │
│         ▼                   ▼                   ▼                           │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │                         SUPABASE TABLES                              │  │
│  │  • live_trades          • bot_positions      • strike_prices         │  │
│  │  • order_queue          • runner_heartbeats  • market_history        │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│         │                                                                   │
│         ▼                                                                   │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │                      SUPABASE REALTIME                               │  │
│  │  • postgres_changes subscriptions                                    │  │
│  │  • Broadcast naar alle connected clients                             │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│         │                                                                   │
│         ▼                                                                   │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │                         REACT UI                                     │  │
│  │  • useBotPositions hook                                              │  │
│  │  • useLiveTrades hook                                                │  │
│  │  • useRealtimeLiveBot hook                                           │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘`}</pre>
            </div>
          </CardContent>
        </Card>

        {/* Polymarket CLOB WebSocket */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Wifi className="w-5 h-5 text-blue-500" />
              Polymarket CLOB WebSocket
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-muted-foreground">
              Real-time orderbook en prijsdata via WebSocket verbinding naar <code>wss://ws-subscriptions-clob.polymarket.com/ws/market</code>
            </p>
            
            <div className="grid md:grid-cols-2 gap-4">
              <div className="bg-muted/30 p-4 rounded-lg">
                <h4 className="font-semibold mb-2">Subscription Events</h4>
                <div className="font-mono text-xs space-y-2">
                  <pre className="bg-muted/50 p-2 rounded">{`// Subscribe to market
{
  "type": "Market",
  "assets_ids": [
    "token_id_up",
    "token_id_down"
  ]
}`}</pre>
                </div>
              </div>
              
              <div className="bg-muted/30 p-4 rounded-lg">
                <h4 className="font-semibold mb-2">Inkomende Data</h4>
                <div className="font-mono text-xs space-y-2">
                  <pre className="bg-muted/50 p-2 rounded">{`// Book update event
{
  "event_type": "book",
  "asset_id": "token_id",
  "market": "condition_id",
  "bids": [
    { "price": "0.45", "size": "100" }
  ],
  "asks": [
    { "price": "0.47", "size": "150" }
  ]
}`}</pre>
                </div>
              </div>
            </div>

            <div className="bg-blue-500/10 border border-blue-500/30 p-4 rounded-lg">
              <h4 className="font-semibold text-blue-600 mb-2 flex items-center gap-2">
                <Clock className="w-4 h-4" /> Update Frequentie
              </h4>
              <ul className="text-sm text-muted-foreground space-y-1">
                <li>• Orderbook updates: <strong>10-50ms</strong> bij actieve markt</li>
                <li>• Price changes: <strong>100-500ms</strong> gemiddeld</li>
                <li>• Reconnect bij disconnect: <strong>automatisch na 5s</strong></li>
              </ul>
            </div>
          </CardContent>
        </Card>

        {/* Position Sync */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <RefreshCw className="w-5 h-5 text-orange-500" />
              Position Synchronisatie
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-muted-foreground">
              Posities worden periodiek gesynchroniseerd van Polymarket Data API naar de <code>bot_positions</code> tabel.
            </p>
            
            <div className="bg-muted/30 p-4 rounded-lg font-mono text-xs overflow-x-auto">
              <pre>{`// local-runner/src/positions-sync.ts
const POSITION_SYNC_INTERVAL = 60_000; // 60 seconden

async function syncPositions() {
  // 1. Fetch positions from Polymarket Data API
  const response = await fetch(
    \`https://data-api.polymarket.com/positions?user=\${walletAddress}\`
  );
  const positions = await response.json();
  
  // 2. Transform en upsert naar bot_positions
  for (const pos of positions) {
    await supabase.from('bot_positions').upsert({
      wallet_address: walletAddress,
      market_slug: extractMarketSlug(pos),
      outcome: pos.outcome,
      shares: pos.size,
      avg_price: pos.avgPrice,
      current_price: pos.curPrice,
      value: pos.currentValue,
      cost: pos.initialValue,
      pnl: pos.currentValue - pos.initialValue,
      synced_at: new Date().toISOString(),
    }, {
      onConflict: 'wallet_address,market_slug,outcome'
    });
  }
  
  // 3. Delete stale positions (niet meer in API response)
  await supabase.from('bot_positions')
    .delete()
    .eq('wallet_address', walletAddress)
    .lt('synced_at', oneMinuteAgo);
}`}</pre>
            </div>

            <div className="grid md:grid-cols-3 gap-4">
              <div className="text-center p-4 bg-muted/30 rounded-lg">
                <div className="text-2xl font-bold text-orange-500">60s</div>
                <p className="text-sm text-muted-foreground">Sync interval</p>
              </div>
              <div className="text-center p-4 bg-muted/30 rounded-lg">
                <div className="text-2xl font-bold text-blue-500">~200ms</div>
                <p className="text-sm text-muted-foreground">API latency</p>
              </div>
              <div className="text-center p-4 bg-muted/30 rounded-lg">
                <div className="text-2xl font-bold text-green-500">~30ms</div>
                <p className="text-sm text-muted-foreground">DB write</p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Supabase Realtime */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Database className="w-5 h-5 text-green-500" />
              Supabase Realtime Subscriptions
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-muted-foreground">
              De React UI subscribet op database changes via Supabase Realtime. 
              Dit zorgt voor instant updates zonder polling.
            </p>
            
            <div className="bg-muted/30 p-4 rounded-lg font-mono text-xs overflow-x-auto">
              <pre>{`// useBotPositions.ts - Realtime subscription
useEffect(() => {
  fetchPositions(); // Initial fetch
  
  const channel = supabase
    .channel('bot_positions_changes')
    .on(
      'postgres_changes',
      { 
        event: '*',  // INSERT, UPDATE, DELETE
        schema: 'public', 
        table: 'bot_positions' 
      },
      (payload) => {
        console.log('Position changed:', payload);
        fetchPositions(); // Refetch on any change
      }
    )
    .subscribe();

  return () => {
    supabase.removeChannel(channel);
  };
}, []);`}</pre>
            </div>

            <div className="grid md:grid-cols-2 gap-4">
              <div className="bg-green-500/10 border border-green-500/30 p-4 rounded-lg">
                <h4 className="font-semibold text-green-600 mb-2">Subscribed Tables</h4>
                <ul className="text-sm text-muted-foreground space-y-1">
                  <li>✓ <code>bot_positions</code> - Live posities</li>
                  <li>✓ <code>live_trades</code> - Trade history</li>
                  <li>✓ <code>order_queue</code> - Pending orders</li>
                  <li>✓ <code>runner_heartbeats</code> - Runner status</li>
                </ul>
              </div>
              
              <div className="bg-muted/30 p-4 rounded-lg">
                <h4 className="font-semibold mb-2">Latency Breakdown</h4>
                <ul className="text-sm text-muted-foreground space-y-1">
                  <li>• DB write → Realtime: <strong>~50ms</strong></li>
                  <li>• Realtime → React: <strong>~100ms</strong></li>
                  <li>• React re-render: <strong>~20ms</strong></li>
                  <li>• <strong>Totaal: ~170ms</strong></li>
                </ul>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Runner Heartbeat */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Eye className="w-5 h-5 text-purple-500" />
              Runner Health Monitoring
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-muted-foreground">
              De local runner stuurt elke 30 seconden een heartbeat om de status te rapporteren.
            </p>
            
            <div className="bg-muted/30 p-4 rounded-lg font-mono text-xs overflow-x-auto">
              <pre>{`// Heartbeat payload
{
  runner_id: "local-runner-v1",
  runner_type: "local",
  status: "active",
  last_heartbeat: "2024-12-30T10:15:30.000Z",
  balance: 1234.56,          // USDC balance
  markets_count: 4,          // Active markets
  positions_count: 8,        // Open positions
  trades_count: 156,         // 24h trades
  version: "3.2.1",          // Strategy version
  ip_address: "vpn-xxx"      // Masked IP
}`}</pre>
            </div>

            <div className="grid md:grid-cols-2 gap-4">
              <div className="bg-muted/30 p-4 rounded-lg">
                <h4 className="font-semibold mb-2">Online Detection</h4>
                <ul className="text-sm text-muted-foreground space-y-1">
                  <li>• Heartbeat interval: <strong>30s</strong></li>
                  <li>• Offline threshold: <strong>60s</strong> zonder heartbeat</li>
                  <li>• UI check: <code>last_heartbeat &gt; now - 60s</code></li>
                </ul>
              </div>
              
              <div className="bg-muted/30 p-4 rounded-lg">
                <h4 className="font-semibold mb-2">Gerapporteerde Metrics</h4>
                <ul className="text-sm text-muted-foreground space-y-1">
                  <li>• USDC balance (via CLOB API)</li>
                  <li>• Aantal actieve markets</li>
                  <li>• Aantal open posities</li>
                  <li>• Trades in laatste 24u</li>
                </ul>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Data Freshness Summary */}
        <Card className="border-green-500/30">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CheckCircle className="w-5 h-5 text-green-500" />
              Data Freshness Overzicht
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b">
                    <th className="text-left py-2">Data Type</th>
                    <th className="text-left py-2">Source</th>
                    <th className="text-right py-2">Update Freq</th>
                    <th className="text-right py-2">UI Latency</th>
                  </tr>
                </thead>
                <tbody className="font-mono">
                  <tr className="border-b border-muted">
                    <td className="py-2">Orderbook Prices</td>
                    <td>CLOB WebSocket</td>
                    <td className="text-right text-green-500">~100ms</td>
                    <td className="text-right text-green-500">~200ms</td>
                  </tr>
                  <tr className="border-b border-muted">
                    <td className="py-2">Trade Signals</td>
                    <td>live-trade-realtime</td>
                    <td className="text-right text-green-500">realtime</td>
                    <td className="text-right text-yellow-500">~2-4s</td>
                  </tr>
                  <tr className="border-b border-muted">
                    <td className="py-2">Order Status</td>
                    <td>order_queue + Realtime</td>
                    <td className="text-right text-green-500">on change</td>
                    <td className="text-right text-green-500">~200ms</td>
                  </tr>
                  <tr className="border-b border-muted">
                    <td className="py-2">Positions</td>
                    <td>Polymarket API</td>
                    <td className="text-right text-yellow-500">60s</td>
                    <td className="text-right text-yellow-500">~60s</td>
                  </tr>
                  <tr className="border-b border-muted">
                    <td className="py-2">Runner Status</td>
                    <td>Heartbeat</td>
                    <td className="text-right text-yellow-500">30s</td>
                    <td className="text-right text-yellow-500">~30s</td>
                  </tr>
                  <tr className="border-b border-muted">
                    <td className="py-2">Strike Prices</td>
                    <td>Chainlink RPC</td>
                    <td className="text-right text-yellow-500">on market start</td>
                    <td className="text-right text-green-500">~200ms</td>
                  </tr>
                </tbody>
              </table>
            </div>
            
            <div className="mt-4 grid md:grid-cols-2 gap-4">
              <div className="bg-green-500/10 border border-green-500/30 p-4 rounded-lg">
                <h4 className="font-semibold text-green-600 mb-2">✓ Werkt Realtime</h4>
                <ul className="text-sm text-muted-foreground">
                  <li>• Order status updates</li>
                  <li>• Trade confirmations</li>
                  <li>• Runner online/offline</li>
                </ul>
              </div>
              
              <div className="bg-yellow-500/10 border border-yellow-500/30 p-4 rounded-lg">
                <h4 className="font-semibold text-yellow-600 mb-2">⚠️ Periodieke Updates</h4>
                <ul className="text-sm text-muted-foreground">
                  <li>• Positions (60s vertraging)</li>
                  <li>• Balance (30s vertraging)</li>
                  <li>• P&L berekeningen</li>
                </ul>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Links */}
        <div className="flex gap-4 justify-center pt-4">
          <NavLink to="/order-flow-docs">
            <Badge variant="outline" className="cursor-pointer hover:bg-primary/10">
              ← Order Flow Docs
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

export default DataFlowDocs;
