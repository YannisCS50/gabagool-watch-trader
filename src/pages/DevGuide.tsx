import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { ArrowLeft, BookOpen, Code, Database, Zap, Shield, TrendingUp, Bell, TestTube, Rocket } from "lucide-react";
import { Link } from "react-router-dom";

const CodeBlock = ({ children, language = "rust" }: { children: string; language?: string }) => (
  <pre className="bg-muted/50 border border-border rounded-lg p-4 overflow-x-auto text-sm font-mono">
    <code className={`language-${language}`}>{children}</code>
  </pre>
);

const DevGuide = () => {
  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <div className="border-b border-border bg-card/50 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-6 py-4">
          <div className="flex items-center gap-4">
            <Link to="/" className="text-muted-foreground hover:text-foreground transition-colors">
              <ArrowLeft className="h-5 w-5" />
            </Link>
            <div>
              <h1 className="text-2xl font-bold text-foreground">Gabagool22 Bot Strategie</h1>
              <p className="text-muted-foreground text-sm">Rust-based Polymarket Arbitrage Trading Bot</p>
            </div>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="max-w-5xl mx-auto px-6 py-8">
        {/* Quick Stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
          <Card className="bg-card/50">
            <CardContent className="p-4 text-center">
              <div className="text-2xl font-bold text-primary">$28M+</div>
              <div className="text-xs text-muted-foreground">Total Volume</div>
            </CardContent>
          </Card>
          <Card className="bg-card/50">
            <CardContent className="p-4 text-center">
              <div className="text-2xl font-bold text-chart-1">2.3%</div>
              <div className="text-xs text-muted-foreground">Gemiddelde Marge</div>
            </CardContent>
          </Card>
          <Card className="bg-card/50">
            <CardContent className="p-4 text-center">
              <div className="text-2xl font-bold text-chart-2">~1000</div>
              <div className="text-xs text-muted-foreground">Trades/Dag</div>
            </CardContent>
          </Card>
          <Card className="bg-card/50">
            <CardContent className="p-4 text-center">
              <div className="text-2xl font-bold text-chart-3">Rust</div>
              <div className="text-xs text-muted-foreground">Programmeertaal</div>
            </CardContent>
          </Card>
        </div>

        {/* Table of Contents */}
        <Card className="mb-8 bg-card/50">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <BookOpen className="h-5 w-5 text-primary" />
              Inhoudsopgave
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid md:grid-cols-2 gap-2 text-sm">
              <a href="#ch1" className="text-muted-foreground hover:text-primary transition-colors">1. Strategie Overzicht</a>
              <a href="#ch2" className="text-muted-foreground hover:text-primary transition-colors">2. Arbitrage Conditie</a>
              <a href="#ch3" className="text-muted-foreground hover:text-primary transition-colors">3. Polymarket CLOB API</a>
              <a href="#ch4" className="text-muted-foreground hover:text-primary transition-colors">4. Rust Implementatie</a>
              <a href="#ch5" className="text-muted-foreground hover:text-primary transition-colors">5. Order Management</a>
              <a href="#ch6" className="text-muted-foreground hover:text-primary transition-colors">6. Risk Management</a>
              <a href="#ch7" className="text-muted-foreground hover:text-primary transition-colors">7. Telegram Integratie</a>
              <a href="#ch8" className="text-muted-foreground hover:text-primary transition-colors">8. Testing & Deployment</a>
            </div>
          </CardContent>
        </Card>

        {/* Chapter 1: Strategy Overview */}
        <section id="ch1" className="mb-8">
          <div className="flex items-center gap-3 mb-4">
            <div className="h-10 w-10 rounded-lg bg-primary/20 flex items-center justify-center">
              <TrendingUp className="h-5 w-5 text-primary" />
            </div>
            <div>
              <h2 className="text-xl font-bold text-foreground">1. Strategie Overzicht</h2>
              <p className="text-sm text-muted-foreground">De kern van Gabagool22's trading bot</p>
            </div>
          </div>
          
          <Card className="bg-card/50">
            <CardContent className="p-6">
              <Accordion type="multiple" className="w-full">
                <AccordionItem value="wat-is-arbitrage">
                  <AccordionTrigger>Wat is Polymarket Arbitrage?</AccordionTrigger>
                  <AccordionContent className="space-y-4">
                    <p>
                      Polymarket biedt binaire markten aan waarbij je kunt wedden op "Ja" of "Nee" uitkomsten. 
                      In een efficiënte markt zou de som van de beste ask-prijzen voor beide uitkomsten precies 
                      $1.00 moeten zijn. Wanneer dit niet het geval is, ontstaat er een arbitrage-mogelijkheid.
                    </p>
                    
                    <div className="bg-muted/30 rounded-lg p-4">
                      <h4 className="font-semibold mb-2">Voorbeeld:</h4>
                      <ul className="space-y-1 text-sm">
                        <li>• Markt: "Wordt Bitcoin $100k in 2025?"</li>
                        <li>• Ask prijs "Yes": $0.48</li>
                        <li>• Ask prijs "No": $0.50</li>
                        <li>• <strong>Totaal: $0.98</strong> (minder dan $1.00!)</li>
                        <li>• <strong>Arbitrage winst: $0.02 per paar</strong> (2% rendement)</li>
                      </ul>
                    </div>

                    <p className="text-sm text-muted-foreground">
                      Door beide zijden tegelijk te kopen voor $0.98, ben je gegarandeerd van $1.00 
                      uitbetaling ongeacht de uitkomst - een risicoloze winst van $0.02.
                    </p>
                  </AccordionContent>
                </AccordionItem>

                <AccordionItem value="gabagool-approach">
                  <AccordionTrigger>Gabagool22's Aanpak</AccordionTrigger>
                  <AccordionContent className="space-y-4">
                    <div className="grid md:grid-cols-2 gap-4">
                      <div className="bg-chart-1/10 rounded-lg p-4 border border-chart-1/20">
                        <h4 className="font-semibold text-chart-1 mb-2">Snelheid</h4>
                        <p className="text-sm">
                          Geschreven in Rust voor maximale performance. WebSocket streams voor 
                          real-time orderbook updates met sub-milliseconde latency.
                        </p>
                      </div>
                      <div className="bg-chart-2/10 rounded-lg p-4 border border-chart-2/20">
                        <h4 className="font-semibold text-chart-2 mb-2">Volume</h4>
                        <p className="text-sm">
                          ~1000 trades per dag, $28M+ totaal volume. Kleine marges (1-3%) 
                          maar hoge frequentie zorgt voor consistente winst.
                        </p>
                      </div>
                      <div className="bg-chart-3/10 rounded-lg p-4 border border-chart-3/20">
                        <h4 className="font-semibold text-chart-3 mb-2">Risk Management</h4>
                        <p className="text-sm">
                          Altijd beide zijden kopen. Buffer margin voor slippage en fees. 
                          Partial fill handling voorkomt eenzijdige posities.
                        </p>
                      </div>
                      <div className="bg-chart-4/10 rounded-lg p-4 border border-chart-4/20">
                        <h4 className="font-semibold text-chart-4 mb-2">Monitoring</h4>
                        <p className="text-sm">
                          Telegram bot voor real-time alerts, pause/resume functionaliteit, 
                          en status monitoring van actieve posities.
                        </p>
                      </div>
                    </div>
                  </AccordionContent>
                </AccordionItem>

                <AccordionItem value="winst-analyse">
                  <AccordionTrigger>Winstgevendheid Analyse</AccordionTrigger>
                  <AccordionContent className="space-y-4">
                    <p>
                      Gebaseerd op Gabagool22's publieke trading data kunnen we de volgende metrics afleiden:
                    </p>
                    
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-border">
                            <th className="text-left py-2 text-muted-foreground">Metric</th>
                            <th className="text-right py-2 text-muted-foreground">Waarde</th>
                          </tr>
                        </thead>
                        <tbody>
                          <tr className="border-b border-border/50">
                            <td className="py-2">Totaal Volume</td>
                            <td className="text-right font-mono">$28,000,000+</td>
                          </tr>
                          <tr className="border-b border-border/50">
                            <td className="py-2">Gemiddelde Trade Size</td>
                            <td className="text-right font-mono">$500 - $2,000</td>
                          </tr>
                          <tr className="border-b border-border/50">
                            <td className="py-2">Gemiddelde Marge</td>
                            <td className="text-right font-mono">1.5% - 3%</td>
                          </tr>
                          <tr className="border-b border-border/50">
                            <td className="py-2">Trades per Dag</td>
                            <td className="text-right font-mono">~1,000</td>
                          </tr>
                          <tr>
                            <td className="py-2">Geschatte Dagelijkse Winst</td>
                            <td className="text-right font-mono text-chart-1">$5,000 - $15,000</td>
                          </tr>
                        </tbody>
                      </table>
                    </div>

                    <div className="bg-muted/30 rounded-lg p-4 text-sm">
                      <strong>Let op:</strong> Deze cijfers zijn schattingen gebaseerd op publieke data. 
                      Werkelijke resultaten variëren afhankelijk van marktcondities, competitie, en fees.
                    </div>
                  </AccordionContent>
                </AccordionItem>
              </Accordion>
            </CardContent>
          </Card>
        </section>

        {/* Chapter 2: Arbitrage Condition */}
        <section id="ch2" className="mb-8">
          <div className="flex items-center gap-3 mb-4">
            <div className="h-10 w-10 rounded-lg bg-chart-1/20 flex items-center justify-center">
              <Zap className="h-5 w-5 text-chart-1" />
            </div>
            <div>
              <h2 className="text-xl font-bold text-foreground">2. Arbitrage Conditie</h2>
              <p className="text-sm text-muted-foreground">De wiskundige formule achter de strategie</p>
            </div>
          </div>
          
          <Card className="bg-card/50">
            <CardContent className="p-6">
              <Accordion type="multiple" className="w-full">
                <AccordionItem value="formule">
                  <AccordionTrigger>De Kernformule</AccordionTrigger>
                  <AccordionContent className="space-y-4">
                    <div className="bg-primary/10 border border-primary/20 rounded-lg p-6 text-center">
                      <code className="text-lg font-mono font-bold text-primary">
                        ask(Yes) + ask(No) &lt; 1.00 - buffer
                      </code>
                    </div>
                    
                    <div className="space-y-3 mt-4">
                      <div className="flex items-start gap-3">
                        <Badge variant="outline" className="mt-0.5">ask(Yes)</Badge>
                        <p className="text-sm">Laagste verkoopprijs voor de "Yes" uitkomst in het orderbook</p>
                      </div>
                      <div className="flex items-start gap-3">
                        <Badge variant="outline" className="mt-0.5">ask(No)</Badge>
                        <p className="text-sm">Laagste verkoopprijs voor de "No" uitkomst in het orderbook</p>
                      </div>
                      <div className="flex items-start gap-3">
                        <Badge variant="outline" className="mt-0.5">buffer</Badge>
                        <p className="text-sm">Veiligheidsmarge voor fees, slippage, en partial fills (typisch 0.5% - 1%)</p>
                      </div>
                    </div>

                    <CodeBlock language="rust">{`// Arbitrage check implementatie
fn check_arbitrage(market: &Market, buffer: f64) -> Option<ArbitrageOpportunity> {
    let ask_yes = market.orderbook_yes.best_ask()?;
    let ask_no = market.orderbook_no.best_ask()?;
    
    let total_cost = ask_yes.price + ask_no.price;
    let threshold = 1.0 - buffer;
    
    if total_cost < threshold {
        let profit_margin = 1.0 - total_cost;
        let max_size = ask_yes.size.min(ask_no.size);
        
        Some(ArbitrageOpportunity {
            market_id: market.id.clone(),
            ask_yes: ask_yes.price,
            ask_no: ask_no.price,
            profit_margin,
            max_size,
            expected_profit: max_size * profit_margin,
        })
    } else {
        None
    }
}`}</CodeBlock>
                  </AccordionContent>
                </AccordionItem>

                <AccordionItem value="buffer-berekening">
                  <AccordionTrigger>Buffer Berekening</AccordionTrigger>
                  <AccordionContent className="space-y-4">
                    <p>
                      De buffer is cruciaal om winstgevend te blijven na aftrek van alle kosten:
                    </p>
                    
                    <div className="space-y-3">
                      <div className="bg-muted/30 rounded-lg p-4">
                        <h4 className="font-semibold mb-2">Kostencomponenten:</h4>
                        <ul className="space-y-2 text-sm">
                          <li className="flex justify-between">
                            <span>Polymarket Trading Fee (taker)</span>
                            <span className="font-mono">~0.1%</span>
                          </li>
                          <li className="flex justify-between">
                            <span>Slippage bij market orders</span>
                            <span className="font-mono">0.1% - 0.3%</span>
                          </li>
                          <li className="flex justify-between">
                            <span>Partial fill risk buffer</span>
                            <span className="font-mono">0.2% - 0.5%</span>
                          </li>
                          <li className="flex justify-between border-t border-border pt-2 font-semibold">
                            <span>Aanbevolen minimum buffer</span>
                            <span className="font-mono text-primary">0.5% - 1.0%</span>
                          </li>
                        </ul>
                      </div>
                    </div>

                    <CodeBlock language="rust">{`// Buffer configuratie
#[derive(Clone)]
pub struct ArbitrageConfig {
    /// Minimum profit margin na fees (bijv. 0.005 = 0.5%)
    pub min_buffer: f64,
    
    /// Maximum position size per trade in USD
    pub max_position_size: f64,
    
    /// Minimum liquiditeit vereist aan beide kanten
    pub min_liquidity: f64,
    
    /// Tijd in ms om beide orders te plaatsen
    pub execution_timeout_ms: u64,
}

impl Default for ArbitrageConfig {
    fn default() -> Self {
        Self {
            min_buffer: 0.008,  // 0.8% buffer
            max_position_size: 2000.0,
            min_liquidity: 500.0,
            execution_timeout_ms: 1000,
        }
    }
}`}</CodeBlock>
                  </AccordionContent>
                </AccordionItem>

                <AccordionItem value="opportunity-ranking">
                  <AccordionTrigger>Opportunity Ranking</AccordionTrigger>
                  <AccordionContent className="space-y-4">
                    <p>
                      Wanneer meerdere arbitrage-mogelijkheden tegelijk bestaan, moet de bot 
                      prioriteren op basis van verwachte winst:
                    </p>

                    <CodeBlock language="rust">{`#[derive(Clone, PartialEq)]
pub struct ArbitrageOpportunity {
    pub market_id: String,
    pub ask_yes: f64,
    pub ask_no: f64,
    pub profit_margin: f64,
    pub max_size: f64,
    pub expected_profit: f64,
    pub liquidity_score: f64,
}

impl ArbitrageOpportunity {
    /// Bereken een score voor prioritering
    pub fn priority_score(&self) -> f64 {
        // Weeg expected profit zwaarder dan margin alleen
        let profit_weight = self.expected_profit * 2.0;
        
        // Bonus voor hogere liquiditeit (minder slippage risico)
        let liquidity_bonus = (self.liquidity_score / 1000.0).min(1.0);
        
        // Penalty voor zeer kleine of zeer grote margins (outliers)
        let margin_penalty = if self.profit_margin > 0.05 {
            0.5  // Te mooi om waar te zijn, mogelijk stale data
        } else {
            1.0
        };
        
        profit_weight * liquidity_bonus * margin_penalty
    }
}

// Sorteer opportunities op priority score
fn rank_opportunities(mut opps: Vec<ArbitrageOpportunity>) -> Vec<ArbitrageOpportunity> {
    opps.sort_by(|a, b| {
        b.priority_score()
            .partial_cmp(&a.priority_score())
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    opps
}`}</CodeBlock>
                  </AccordionContent>
                </AccordionItem>
              </Accordion>
            </CardContent>
          </Card>
        </section>

        {/* Chapter 3: Polymarket CLOB API */}
        <section id="ch3" className="mb-8">
          <div className="flex items-center gap-3 mb-4">
            <div className="h-10 w-10 rounded-lg bg-chart-2/20 flex items-center justify-center">
              <Database className="h-5 w-5 text-chart-2" />
            </div>
            <div>
              <h2 className="text-xl font-bold text-foreground">3. Polymarket CLOB API</h2>
              <p className="text-sm text-muted-foreground">Real-time data streaming en order execution</p>
            </div>
          </div>
          
          <Card className="bg-card/50">
            <CardContent className="p-6">
              <Accordion type="multiple" className="w-full">
                <AccordionItem value="api-overview">
                  <AccordionTrigger>API Overzicht</AccordionTrigger>
                  <AccordionContent className="space-y-4">
                    <p>
                      Polymarket gebruikt een Central Limit Order Book (CLOB) systeem via hun 
                      eigen API. De bot heeft twee hoofdinterfaces nodig:
                    </p>
                    
                    <div className="grid md:grid-cols-2 gap-4">
                      <div className="bg-muted/30 rounded-lg p-4">
                        <h4 className="font-semibold mb-2 flex items-center gap-2">
                          <Badge variant="secondary">REST</Badge>
                          Order Placement
                        </h4>
                        <ul className="text-sm space-y-1">
                          <li>• POST /order - Plaats nieuwe orders</li>
                          <li>• DELETE /order - Cancel orders</li>
                          <li>• GET /orders - Actieve orders</li>
                          <li>• GET /trades - Trade history</li>
                        </ul>
                      </div>
                      <div className="bg-muted/30 rounded-lg p-4">
                        <h4 className="font-semibold mb-2 flex items-center gap-2">
                          <Badge variant="secondary">WebSocket</Badge>
                          Real-time Data
                        </h4>
                        <ul className="text-sm space-y-1">
                          <li>• book - Orderbook updates</li>
                          <li>• price - Prijswijzigingen</li>
                          <li>• user - Order/fill updates</li>
                          <li>• market - Market metadata</li>
                        </ul>
                      </div>
                    </div>

                    <div className="bg-muted/30 rounded-lg p-4 text-sm">
                      <strong>Base URLs:</strong>
                      <ul className="mt-2 font-mono text-xs">
                        <li>REST: https://clob.polymarket.com</li>
                        <li>WebSocket: wss://ws-subscriptions-clob.polymarket.com/ws</li>
                      </ul>
                    </div>
                  </AccordionContent>
                </AccordionItem>

                <AccordionItem value="websocket-streams">
                  <AccordionTrigger>WebSocket Streaming</AccordionTrigger>
                  <AccordionContent className="space-y-4">
                    <p>
                      Real-time orderbook updates zijn essentieel voor snelle arbitrage detectie:
                    </p>

                    <CodeBlock language="rust">{`use tokio_tungstenite::{connect_async, tungstenite::Message};
use futures_util::{StreamExt, SinkExt};
use serde::{Deserialize, Serialize};

const WS_URL: &str = "wss://ws-subscriptions-clob.polymarket.com/ws";

#[derive(Serialize)]
struct SubscribeMessage {
    auth: Option<AuthPayload>,
    markets: Vec<String>,
    assets_ids: Vec<String>,
    #[serde(rename = "type")]
    msg_type: String,
}

#[derive(Deserialize, Debug)]
struct BookUpdate {
    market: String,
    asset_id: String,
    bids: Vec<PriceLevel>,
    asks: Vec<PriceLevel>,
    timestamp: u64,
}

#[derive(Deserialize, Debug, Clone)]
struct PriceLevel {
    price: String,
    size: String,
}

pub async fn connect_orderbook_stream(
    market_ids: Vec<String>,
    tx: tokio::sync::mpsc::Sender<BookUpdate>,
) -> Result<(), Box<dyn std::error::Error>> {
    let (ws_stream, _) = connect_async(WS_URL).await?;
    let (mut write, mut read) = ws_stream.split();

    // Subscribe to orderbook updates
    let subscribe_msg = SubscribeMessage {
        auth: None,
        markets: market_ids.clone(),
        assets_ids: vec![],
        msg_type: "subscribe".to_string(),
    };
    
    write.send(Message::Text(
        serde_json::to_string(&subscribe_msg)?
    )).await?;

    // Process incoming messages
    while let Some(msg) = read.next().await {
        match msg? {
            Message::Text(text) => {
                if let Ok(update) = serde_json::from_str::<BookUpdate>(&text) {
                    tx.send(update).await?;
                }
            }
            Message::Ping(data) => {
                write.send(Message::Pong(data)).await?;
            }
            _ => {}
        }
    }
    
    Ok(())
}`}</CodeBlock>
                  </AccordionContent>
                </AccordionItem>

                <AccordionItem value="orderbook-management">
                  <AccordionTrigger>Orderbook Management</AccordionTrigger>
                  <AccordionContent className="space-y-4">
                    <p>
                      Maintain een lokale kopie van het orderbook voor snelle arbitrage checks:
                    </p>

                    <CodeBlock language="rust">{`use std::collections::BTreeMap;
use parking_lot::RwLock;
use std::sync::Arc;

#[derive(Clone)]
pub struct OrderBook {
    /// Bids: prijs -> size (hoogste prijs eerst)
    pub bids: BTreeMap<OrderedFloat<f64>, f64>,
    /// Asks: prijs -> size (laagste prijs eerst)  
    pub asks: BTreeMap<OrderedFloat<f64>, f64>,
    pub last_update: u64,
}

impl OrderBook {
    pub fn new() -> Self {
        Self {
            bids: BTreeMap::new(),
            asks: BTreeMap::new(),
            last_update: 0,
        }
    }

    pub fn best_bid(&self) -> Option<(f64, f64)> {
        self.bids.iter().next_back().map(|(p, s)| (p.0, *s))
    }

    pub fn best_ask(&self) -> Option<(f64, f64)> {
        self.asks.iter().next().map(|(p, s)| (p.0, *s))
    }

    pub fn apply_update(&mut self, update: &BookUpdate) {
        // Clear and rebuild - Polymarket sends full snapshots
        self.bids.clear();
        self.asks.clear();

        for level in &update.bids {
            let price: f64 = level.price.parse().unwrap_or(0.0);
            let size: f64 = level.size.parse().unwrap_or(0.0);
            if size > 0.0 {
                self.bids.insert(OrderedFloat(price), size);
            }
        }

        for level in &update.asks {
            let price: f64 = level.price.parse().unwrap_or(0.0);
            let size: f64 = level.size.parse().unwrap_or(0.0);
            if size > 0.0 {
                self.asks.insert(OrderedFloat(price), size);
            }
        }

        self.last_update = update.timestamp;
    }
}

// Thread-safe market state
pub struct MarketState {
    pub yes_book: Arc<RwLock<OrderBook>>,
    pub no_book: Arc<RwLock<OrderBook>>,
    pub market_id: String,
}`}</CodeBlock>
                  </AccordionContent>
                </AccordionItem>

                <AccordionItem value="authentication">
                  <AccordionTrigger>API Authenticatie (EIP-712)</AccordionTrigger>
                  <AccordionContent className="space-y-4">
                    <p>
                      Polymarket gebruikt Ethereum-style signing voor order authenticatie. 
                      Orders worden gesigned met EIP-712 typed data:
                    </p>

                    <CodeBlock language="rust">{`use ethers::signers::{LocalWallet, Signer};
use ethers::types::{H256, Signature};
use sha3::{Digest, Keccak256};

#[derive(Clone)]
pub struct PolymarketAuth {
    wallet: LocalWallet,
    api_key: String,
    api_secret: String,
}

impl PolymarketAuth {
    pub fn new(private_key: &str, api_key: String, api_secret: String) -> Result<Self, Box<dyn std::error::Error>> {
        let wallet: LocalWallet = private_key.parse()?;
        Ok(Self { wallet, api_key, api_secret })
    }

    /// Genereer L1 authenticatie headers voor REST API
    pub async fn generate_auth_headers(&self, method: &str, path: &str, body: &str) -> Vec<(String, String)> {
        let timestamp = chrono::Utc::now().timestamp_millis().to_string();
        
        // Create signature payload
        let message = format!("{}{}{}{}", timestamp, method, path, body);
        let signature = self.sign_message(&message).await;
        
        vec![
            ("POLY_ADDRESS".to_string(), format!("{:?}", self.wallet.address())),
            ("POLY_SIGNATURE".to_string(), signature),
            ("POLY_TIMESTAMP".to_string(), timestamp),
            ("POLY_API_KEY".to_string(), self.api_key.clone()),
        ]
    }

    /// Sign een bericht met de wallet
    async fn sign_message(&self, message: &str) -> String {
        let hash = Keccak256::digest(message.as_bytes());
        let signature = self.wallet
            .sign_message(H256::from_slice(&hash))
            .await
            .expect("Failed to sign message");
        format!("0x{}", hex::encode(signature.to_vec()))
    }

    /// Sign een order voor de CLOB
    pub async fn sign_order(&self, order: &Order) -> String {
        // EIP-712 typed data signing
        let domain_separator = self.compute_domain_separator();
        let order_hash = order.compute_hash();
        
        let digest = Keccak256::digest(
            &[&[0x19, 0x01], domain_separator.as_bytes(), order_hash.as_bytes()].concat()
        );
        
        let signature = self.wallet
            .sign_message(H256::from_slice(&digest))
            .await
            .expect("Failed to sign order");
            
        format!("0x{}", hex::encode(signature.to_vec()))
    }

    fn compute_domain_separator(&self) -> H256 {
        // Polymarket CLOB domain separator
        // Chain ID: 137 (Polygon)
        let type_hash = Keccak256::digest(
            b"EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
        );
        // ... implementation details
        H256::zero() // Placeholder
    }
}`}</CodeBlock>
                  </AccordionContent>
                </AccordionItem>
              </Accordion>
            </CardContent>
          </Card>
        </section>

        {/* Chapter 4: Rust Implementation */}
        <section id="ch4" className="mb-8">
          <div className="flex items-center gap-3 mb-4">
            <div className="h-10 w-10 rounded-lg bg-chart-3/20 flex items-center justify-center">
              <Code className="h-5 w-5 text-chart-3" />
            </div>
            <div>
              <h2 className="text-xl font-bold text-foreground">4. Rust Implementatie</h2>
              <p className="text-sm text-muted-foreground">Core bot architectuur en modules</p>
            </div>
          </div>
          
          <Card className="bg-card/50">
            <CardContent className="p-6">
              <Accordion type="multiple" className="w-full">
                <AccordionItem value="project-structure">
                  <AccordionTrigger>Project Structuur</AccordionTrigger>
                  <AccordionContent className="space-y-4">
                    <CodeBlock language="bash">{`polymarket-arb-bot/
├── Cargo.toml
├── src/
│   ├── main.rs           # Entry point, async runtime setup
│   ├── lib.rs            # Library exports
│   ├── config.rs         # Configuration management
│   ├── api/
│   │   ├── mod.rs
│   │   ├── rest.rs       # REST API client
│   │   ├── websocket.rs  # WebSocket streaming
│   │   └── auth.rs       # EIP-712 signing
│   ├── orderbook/
│   │   ├── mod.rs
│   │   ├── book.rs       # Orderbook data structure
│   │   └── manager.rs    # Multi-market orderbook state
│   ├── strategy/
│   │   ├── mod.rs
│   │   ├── arbitrage.rs  # Arbitrage detection logic
│   │   └── executor.rs   # Trade execution
│   ├── risk/
│   │   ├── mod.rs
│   │   ├── position.rs   # Position tracking
│   │   └── limits.rs     # Risk limits
│   ├── telegram/
│   │   ├── mod.rs
│   │   └── bot.rs        # Telegram commands
│   └── utils/
│       ├── mod.rs
│       └── logging.rs    # Structured logging
├── config/
│   └── default.toml      # Default configuration
└── tests/
    └── integration/      # Integration tests`}</CodeBlock>
                  </AccordionContent>
                </AccordionItem>

                <AccordionItem value="cargo-toml">
                  <AccordionTrigger>Cargo.toml Dependencies</AccordionTrigger>
                  <AccordionContent className="space-y-4">
                    <CodeBlock language="toml">{`[package]
name = "polymarket-arb-bot"
version = "0.1.0"
edition = "2021"

[dependencies]
# Async runtime
tokio = { version = "1.35", features = ["full"] }
futures-util = "0.3"

# HTTP & WebSocket
reqwest = { version = "0.11", features = ["json"] }
tokio-tungstenite = { version = "0.21", features = ["native-tls"] }

# Serialization
serde = { version = "1.0", features = ["derive"] }
serde_json = "1.0"

# Ethereum signing
ethers = { version = "2.0", features = ["legacy"] }
sha3 = "0.10"
hex = "0.4"

# Utilities
ordered-float = "4.2"
parking_lot = "0.12"
chrono = "0.4"
thiserror = "1.0"
anyhow = "1.0"

# Configuration
config = "0.14"
dotenv = "0.15"

# Logging
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter"] }

# Telegram
teloxide = { version = "0.12", features = ["macros"] }

# Testing
tokio-test = "0.4"

[dev-dependencies]
mockall = "0.12"
wiremock = "0.5"`}</CodeBlock>
                  </AccordionContent>
                </AccordionItem>

                <AccordionItem value="main-loop">
                  <AccordionTrigger>Main Event Loop</AccordionTrigger>
                  <AccordionContent className="space-y-4">
                    <CodeBlock language="rust">{`use tokio::sync::mpsc;
use std::sync::Arc;
use parking_lot::RwLock;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Initialize logging
    tracing_subscriber::fmt()
        .with_env_filter("polymarket_arb_bot=debug,info")
        .init();

    // Load configuration
    let config = Config::load()?;
    
    // Initialize authentication
    let auth = PolymarketAuth::new(
        &config.private_key,
        config.api_key.clone(),
        config.api_secret.clone(),
    )?;

    // Create shared state
    let state = Arc::new(BotState::new(config.clone()));
    
    // Create channels for communication
    let (orderbook_tx, orderbook_rx) = mpsc::channel::<BookUpdate>(1000);
    let (trade_tx, trade_rx) = mpsc::channel::<TradeSignal>(100);
    let (telegram_tx, telegram_rx) = mpsc::channel::<TelegramCommand>(50);

    // Spawn WebSocket stream handler
    let ws_state = state.clone();
    let ws_handle = tokio::spawn(async move {
        loop {
            if let Err(e) = run_websocket_stream(
                ws_state.clone(),
                orderbook_tx.clone(),
            ).await {
                tracing::error!("WebSocket error: {}, reconnecting...", e);
                tokio::time::sleep(Duration::from_secs(5)).await;
            }
        }
    });

    // Spawn arbitrage detector
    let arb_state = state.clone();
    let arb_handle = tokio::spawn(async move {
        run_arbitrage_detector(arb_state, orderbook_rx, trade_tx).await
    });

    // Spawn trade executor
    let exec_state = state.clone();
    let exec_auth = auth.clone();
    let exec_handle = tokio::spawn(async move {
        run_trade_executor(exec_state, exec_auth, trade_rx).await
    });

    // Spawn Telegram bot
    let tg_state = state.clone();
    let tg_handle = tokio::spawn(async move {
        run_telegram_bot(tg_state, telegram_rx).await
    });

    // Wait for all tasks
    tokio::select! {
        _ = ws_handle => tracing::error!("WebSocket handler exited"),
        _ = arb_handle => tracing::error!("Arbitrage detector exited"),
        _ = exec_handle => tracing::error!("Trade executor exited"),
        _ = tg_handle => tracing::error!("Telegram bot exited"),
        _ = tokio::signal::ctrl_c() => {
            tracing::info!("Shutdown signal received");
        }
    }

    Ok(())
}`}</CodeBlock>
                  </AccordionContent>
                </AccordionItem>

                <AccordionItem value="arbitrage-detector">
                  <AccordionTrigger>Arbitrage Detector</AccordionTrigger>
                  <AccordionContent className="space-y-4">
                    <CodeBlock language="rust">{`pub async fn run_arbitrage_detector(
    state: Arc<BotState>,
    mut orderbook_rx: mpsc::Receiver<BookUpdate>,
    trade_tx: mpsc::Sender<TradeSignal>,
) {
    tracing::info!("Arbitrage detector started");

    while let Some(update) = orderbook_rx.recv().await {
        // Skip if bot is paused
        if state.is_paused() {
            continue;
        }

        // Update local orderbook
        state.update_orderbook(&update);

        // Check for arbitrage opportunity
        if let Some(opportunity) = check_arbitrage_opportunity(&state, &update.market) {
            tracing::info!(
                market = %opportunity.market_id,
                margin = %opportunity.profit_margin,
                size = %opportunity.max_size,
                "Arbitrage opportunity detected"
            );

            // Validate opportunity
            if validate_opportunity(&state, &opportunity) {
                // Send trade signal
                if let Err(e) = trade_tx.send(TradeSignal::Execute(opportunity)).await {
                    tracing::error!("Failed to send trade signal: {}", e);
                }
            }
        }
    }
}

fn check_arbitrage_opportunity(
    state: &BotState,
    market_id: &str,
) -> Option<ArbitrageOpportunity> {
    let market = state.get_market(market_id)?;
    let config = state.config();

    let yes_book = market.yes_book.read();
    let no_book = market.no_book.read();

    let (ask_yes_price, ask_yes_size) = yes_book.best_ask()?;
    let (ask_no_price, ask_no_size) = no_book.best_ask()?;

    let total_cost = ask_yes_price + ask_no_price;
    let threshold = 1.0 - config.min_buffer;

    if total_cost < threshold {
        let profit_margin = 1.0 - total_cost;
        let max_size = ask_yes_size
            .min(ask_no_size)
            .min(config.max_position_size / total_cost);

        Some(ArbitrageOpportunity {
            market_id: market_id.to_string(),
            yes_asset_id: market.yes_asset_id.clone(),
            no_asset_id: market.no_asset_id.clone(),
            ask_yes: ask_yes_price,
            ask_no: ask_no_price,
            profit_margin,
            max_size,
            expected_profit: max_size * profit_margin,
            liquidity_score: ask_yes_size + ask_no_size,
            detected_at: chrono::Utc::now(),
        })
    } else {
        None
    }
}

fn validate_opportunity(state: &BotState, opp: &ArbitrageOpportunity) -> bool {
    let config = state.config();

    // Check minimum profit threshold
    if opp.expected_profit < config.min_profit_threshold {
        return false;
    }

    // Check if we already have position in this market
    if state.has_pending_orders(&opp.market_id) {
        return false;
    }

    // Check daily trade limits
    if state.daily_trade_count() >= config.max_daily_trades {
        return false;
    }

    // Check maximum exposure
    let current_exposure = state.total_exposure();
    let new_exposure = opp.max_size * (opp.ask_yes + opp.ask_no);
    if current_exposure + new_exposure > config.max_total_exposure {
        return false;
    }

    true
}`}</CodeBlock>
                  </AccordionContent>
                </AccordionItem>
              </Accordion>
            </CardContent>
          </Card>
        </section>

        {/* Chapter 5: Order Management */}
        <section id="ch5" className="mb-8">
          <div className="flex items-center gap-3 mb-4">
            <div className="h-10 w-10 rounded-lg bg-chart-4/20 flex items-center justify-center">
              <Zap className="h-5 w-5 text-chart-4" />
            </div>
            <div>
              <h2 className="text-xl font-bold text-foreground">5. Order Management</h2>
              <p className="text-sm text-muted-foreground">Atomic execution en partial fill handling</p>
            </div>
          </div>
          
          <Card className="bg-card/50">
            <CardContent className="p-6">
              <Accordion type="multiple" className="w-full">
                <AccordionItem value="order-structure">
                  <AccordionTrigger>Order Structuur</AccordionTrigger>
                  <AccordionContent className="space-y-4">
                    <CodeBlock language="rust">{`#[derive(Clone, Serialize, Deserialize)]
pub struct Order {
    /// Asset ID (Yes of No token)
    pub asset_id: String,
    
    /// BUY of SELL
    pub side: OrderSide,
    
    /// Prijs per share (0.01 - 0.99)
    pub price: f64,
    
    /// Aantal shares
    pub size: f64,
    
    /// Order type: GTC, FOK, IOC
    pub order_type: OrderType,
    
    /// Expiration timestamp (unix ms)
    pub expiration: u64,
    
    /// Nonce voor deduplicatie
    pub nonce: u64,
    
    /// EIP-712 signature
    pub signature: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum OrderSide {
    Buy,
    Sell,
}

#[derive(Clone, Serialize, Deserialize)]
pub enum OrderType {
    #[serde(rename = "GTC")]
    GoodTillCancel,
    #[serde(rename = "FOK")]
    FillOrKill,
    #[serde(rename = "IOC")]
    ImmediateOrCancel,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct OrderResponse {
    pub order_id: String,
    pub status: OrderStatus,
    pub filled_size: f64,
    pub remaining_size: f64,
    pub avg_fill_price: Option<f64>,
}

#[derive(Clone, Serialize, Deserialize, PartialEq)]
pub enum OrderStatus {
    Pending,
    Open,
    Filled,
    PartiallyFilled,
    Cancelled,
    Expired,
    Failed,
}`}</CodeBlock>
                  </AccordionContent>
                </AccordionItem>

                <AccordionItem value="atomic-execution">
                  <AccordionTrigger>Atomic Execution Strategy</AccordionTrigger>
                  <AccordionContent className="space-y-4">
                    <p>
                      Voor arbitrage is het cruciaal dat beide zijden tegelijk worden uitgevoerd. 
                      We gebruiken IOC (Immediate or Cancel) orders om partial fills te minimaliseren:
                    </p>

                    <CodeBlock language="rust">{`pub async fn execute_arbitrage(
    state: Arc<BotState>,
    auth: &PolymarketAuth,
    opp: ArbitrageOpportunity,
) -> Result<ArbitrageResult, ExecutionError> {
    let client = state.api_client();
    
    // Bereid beide orders voor
    let yes_order = Order {
        asset_id: opp.yes_asset_id.clone(),
        side: OrderSide::Buy,
        price: opp.ask_yes,
        size: opp.max_size,
        order_type: OrderType::ImmediateOrCancel,
        expiration: chrono::Utc::now().timestamp_millis() as u64 + 60_000,
        nonce: generate_nonce(),
        signature: String::new(),
    };

    let no_order = Order {
        asset_id: opp.no_asset_id.clone(),
        side: OrderSide::Buy,
        price: opp.ask_no,
        size: opp.max_size,
        order_type: OrderType::ImmediateOrCancel,
        expiration: chrono::Utc::now().timestamp_millis() as u64 + 60_000,
        nonce: generate_nonce(),
        signature: String::new(),
    };

    // Sign beide orders
    let signed_yes = sign_order(auth, yes_order).await?;
    let signed_no = sign_order(auth, no_order).await?;

    // Plaats beide orders tegelijk
    let (yes_result, no_result) = tokio::join!(
        client.place_order(&signed_yes),
        client.place_order(&signed_no),
    );

    // Analyseer resultaten
    let yes_response = yes_result?;
    let no_response = no_result?;

    // Handle partial fills
    handle_partial_fills(
        state.clone(),
        auth,
        &opp,
        &yes_response,
        &no_response,
    ).await
}

async fn handle_partial_fills(
    state: Arc<BotState>,
    auth: &PolymarketAuth,
    opp: &ArbitrageOpportunity,
    yes_resp: &OrderResponse,
    no_resp: &OrderResponse,
) -> Result<ArbitrageResult, ExecutionError> {
    let yes_filled = yes_resp.filled_size;
    let no_filled = no_resp.filled_size;

    // Perfect fill - beide orders volledig gevuld
    if yes_filled == opp.max_size && no_filled == opp.max_size {
        return Ok(ArbitrageResult::Success {
            yes_filled,
            no_filled,
            profit: opp.expected_profit,
        });
    }

    // Partial fill - probeer te balanceren
    let min_filled = yes_filled.min(no_filled);
    
    if min_filled > 0.0 {
        let balanced_profit = min_filled * opp.profit_margin;
        
        // Verkoop de overschot
        let excess_yes = yes_filled - min_filled;
        let excess_no = no_filled - min_filled;
        
        if excess_yes > 0.0 {
            let sell_order = create_sell_order(
                &opp.yes_asset_id,
                excess_yes,
                opp.ask_yes * 0.99,
            );
            let signed = sign_order(auth, sell_order).await?;
            state.api_client().place_order(&signed).await?;
        }
        
        if excess_no > 0.0 {
            let sell_order = create_sell_order(
                &opp.no_asset_id,
                excess_no,
                opp.ask_no * 0.99,
            );
            let signed = sign_order(auth, sell_order).await?;
            state.api_client().place_order(&signed).await?;
        }

        return Ok(ArbitrageResult::PartialSuccess {
            balanced_size: min_filled,
            profit: balanced_profit,
            unwind_pending: excess_yes + excess_no,
        });
    }

    Ok(ArbitrageResult::NoFill)
}`}</CodeBlock>
                  </AccordionContent>
                </AccordionItem>
              </Accordion>
            </CardContent>
          </Card>
        </section>

        {/* Chapter 6: Risk Management */}
        <section id="ch6" className="mb-8">
          <div className="flex items-center gap-3 mb-4">
            <div className="h-10 w-10 rounded-lg bg-destructive/20 flex items-center justify-center">
              <Shield className="h-5 w-5 text-destructive" />
            </div>
            <div>
              <h2 className="text-xl font-bold text-foreground">6. Risk Management</h2>
              <p className="text-sm text-muted-foreground">Limieten, monitoring en fail-safes</p>
            </div>
          </div>
          
          <Card className="bg-card/50">
            <CardContent className="p-6">
              <Accordion type="multiple" className="w-full">
                <AccordionItem value="risk-limits">
                  <AccordionTrigger>Risk Limieten</AccordionTrigger>
                  <AccordionContent className="space-y-4">
                    <CodeBlock language="rust">{`#[derive(Clone)]
pub struct RiskLimits {
    /// Maximum positie grootte per trade (USD)
    pub max_position_size: f64,
    
    /// Maximum totale exposure (USD)
    pub max_total_exposure: f64,
    
    /// Maximum aantal trades per dag
    pub max_daily_trades: u32,
    
    /// Maximum verlies per dag (USD)
    pub max_daily_loss: f64,
    
    /// Maximum exposure per markt (USD)
    pub max_market_exposure: f64,
    
    /// Minimum liquiditeit vereist
    pub min_liquidity: f64,
    
    /// Maximum unbalanced position time (sec)
    pub max_unbalance_duration: u64,
    
    /// Cooldown na failed trade (sec)
    pub trade_cooldown: u64,
}

impl Default for RiskLimits {
    fn default() -> Self {
        Self {
            max_position_size: 2000.0,
            max_total_exposure: 50000.0,
            max_daily_trades: 1000,
            max_daily_loss: 500.0,
            max_market_exposure: 10000.0,
            min_liquidity: 500.0,
            max_unbalance_duration: 300,
            trade_cooldown: 5,
        }
    }
}

pub struct RiskManager {
    limits: RiskLimits,
    daily_pnl: f64,
    daily_trade_count: u32,
    market_exposures: HashMap<String, f64>,
    is_halted: bool,
}

impl RiskManager {
    pub fn can_trade(&self, opp: &ArbitrageOpportunity) -> Result<(), RiskCheckError> {
        if self.is_halted {
            return Err(RiskCheckError::BotHalted);
        }

        if self.daily_pnl < -self.limits.max_daily_loss {
            return Err(RiskCheckError::DailyLossExceeded);
        }

        if self.daily_trade_count >= self.limits.max_daily_trades {
            return Err(RiskCheckError::DailyTradeLimit);
        }

        let trade_size = opp.max_size * (opp.ask_yes + opp.ask_no);
        if trade_size > self.limits.max_position_size {
            return Err(RiskCheckError::PositionTooLarge);
        }

        let total_exposure: f64 = self.market_exposures.values().sum();
        if total_exposure + trade_size > self.limits.max_total_exposure {
            return Err(RiskCheckError::TotalExposureExceeded);
        }

        if opp.liquidity_score < self.limits.min_liquidity {
            return Err(RiskCheckError::InsufficientLiquidity);
        }

        Ok(())
    }
}`}</CodeBlock>
                  </AccordionContent>
                </AccordionItem>

                <AccordionItem value="circuit-breakers">
                  <AccordionTrigger>Circuit Breakers</AccordionTrigger>
                  <AccordionContent className="space-y-4">
                    <CodeBlock language="rust">{`pub struct CircuitBreaker {
    consecutive_failures: u32,
    last_failure_time: Option<chrono::DateTime<chrono::Utc>>,
    max_failures: u32,
    cooldown_duration: Duration,
    state: CircuitState,
}

#[derive(Clone, PartialEq)]
pub enum CircuitState {
    Closed,     // Normal operation
    Open,       // Tripped - no trades
    HalfOpen,   // Testing recovery
}

impl CircuitBreaker {
    pub fn record_success(&mut self) {
        self.consecutive_failures = 0;
        if self.state == CircuitState::HalfOpen {
            self.state = CircuitState::Closed;
            tracing::info!("Circuit breaker closed");
        }
    }

    pub fn record_failure(&mut self) -> CircuitState {
        self.consecutive_failures += 1;
        self.last_failure_time = Some(chrono::Utc::now());

        if self.consecutive_failures >= self.max_failures {
            self.state = CircuitState::Open;
            tracing::error!(
                failures = self.consecutive_failures,
                "Circuit breaker OPEN"
            );
        }

        self.state.clone()
    }

    pub fn can_proceed(&mut self) -> bool {
        match self.state {
            CircuitState::Closed => true,
            CircuitState::Open => {
                if let Some(last) = self.last_failure_time {
                    if chrono::Utc::now() - last > self.cooldown_duration {
                        self.state = CircuitState::HalfOpen;
                        return true;
                    }
                }
                false
            }
            CircuitState::HalfOpen => true,
        }
    }
}`}</CodeBlock>
                  </AccordionContent>
                </AccordionItem>
              </Accordion>
            </CardContent>
          </Card>
        </section>

        {/* Chapter 7: Telegram Integration */}
        <section id="ch7" className="mb-8">
          <div className="flex items-center gap-3 mb-4">
            <div className="h-10 w-10 rounded-lg bg-blue-500/20 flex items-center justify-center">
              <Bell className="h-5 w-5 text-blue-500" />
            </div>
            <div>
              <h2 className="text-xl font-bold text-foreground">7. Telegram Integratie</h2>
              <p className="text-sm text-muted-foreground">Real-time alerts en bot control</p>
            </div>
          </div>
          
          <Card className="bg-card/50">
            <CardContent className="p-6">
              <Accordion type="multiple" className="w-full">
                <AccordionItem value="telegram-commands">
                  <AccordionTrigger>Beschikbare Commands</AccordionTrigger>
                  <AccordionContent className="space-y-4">
                    <div className="grid gap-3">
                      <div className="bg-muted/30 rounded-lg p-3 flex items-center gap-3">
                        <Badge variant="outline" className="font-mono">/status</Badge>
                        <span className="text-sm">Bekijk huidige bot status, PnL, en actieve posities</span>
                      </div>
                      <div className="bg-muted/30 rounded-lg p-3 flex items-center gap-3">
                        <Badge variant="outline" className="font-mono">/pause</Badge>
                        <span className="text-sm">Pauzeer alle trading activiteit</span>
                      </div>
                      <div className="bg-muted/30 rounded-lg p-3 flex items-center gap-3">
                        <Badge variant="outline" className="font-mono">/resume</Badge>
                        <span className="text-sm">Hervat trading activiteit</span>
                      </div>
                      <div className="bg-muted/30 rounded-lg p-3 flex items-center gap-3">
                        <Badge variant="outline" className="font-mono">/positions</Badge>
                        <span className="text-sm">Lijst alle open posities</span>
                      </div>
                      <div className="bg-muted/30 rounded-lg p-3 flex items-center gap-3">
                        <Badge variant="outline" className="font-mono">/pnl</Badge>
                        <span className="text-sm">Bekijk dagelijkse en totale PnL</span>
                      </div>
                      <div className="bg-muted/30 rounded-lg p-3 flex items-center gap-3">
                        <Badge variant="outline" className="font-mono">/set buffer 0.01</Badge>
                        <span className="text-sm">Pas configuratie aan runtime aan</span>
                      </div>
                    </div>
                  </AccordionContent>
                </AccordionItem>

                <AccordionItem value="telegram-implementation">
                  <AccordionTrigger>Implementatie</AccordionTrigger>
                  <AccordionContent className="space-y-4">
                    <CodeBlock language="rust">{`use teloxide::prelude::*;
use teloxide::utils::command::BotCommands;

#[derive(BotCommands, Clone)]
#[command(rename_rule = "lowercase")]
enum Command {
    #[command(description = "Bekijk bot status")]
    Status,
    #[command(description = "Pauzeer trading")]
    Pause,
    #[command(description = "Hervat trading")]
    Resume,
    #[command(description = "Bekijk open posities")]
    Positions,
    #[command(description = "Bekijk PnL")]
    Pnl,
    #[command(description = "Pas setting aan")]
    Set { key: String, value: String },
}

pub async fn run_telegram_bot(
    state: Arc<BotState>,
    bot_token: String,
    allowed_chat_id: i64,
) {
    let bot = Bot::new(bot_token);

    let handler = Update::filter_message()
        .filter_command::<Command>()
        .endpoint(move |bot: Bot, msg: Message, cmd: Command| {
            let state = state.clone();
            async move {
                if msg.chat.id.0 != allowed_chat_id {
                    return Ok(());
                }

                let response = match cmd {
                    Command::Status => handle_status(&state).await,
                    Command::Pause => handle_pause(&state).await,
                    Command::Resume => handle_resume(&state).await,
                    Command::Positions => handle_positions(&state).await,
                    Command::Pnl => handle_pnl(&state).await,
                    Command::Set { key, value } => handle_set(&state, &key, &value).await,
                };

                bot.send_message(msg.chat.id, response).await?;
                Ok(())
            }
        });

    Dispatcher::builder(bot, handler)
        .enable_ctrlc_handler()
        .build()
        .dispatch()
        .await;
}

async fn handle_status(state: &BotState) -> String {
    let is_paused = state.is_paused();
    let daily_pnl = state.daily_pnl();
    let trade_count = state.daily_trade_count();

    format!(
        "🤖 *Bot Status*\\n\\n\
         Status: {}\\n\
         Daily PnL: $\{:.2}\\n\
         Trades Today: {}",
        if is_paused { "⏸️ Paused" } else { "▶️ Running" },
        daily_pnl,
        trade_count
    )
}

async fn handle_pause(state: &BotState) -> String {
    state.set_paused(true);
    "⏸️ Bot paused.".to_string()
}

async fn handle_resume(state: &BotState) -> String {
    state.set_paused(false);
    "▶️ Bot resumed.".to_string()
}`}</CodeBlock>
                  </AccordionContent>
                </AccordionItem>
              </Accordion>
            </CardContent>
          </Card>
        </section>

        {/* Chapter 8: Testing & Deployment */}
        <section id="ch8" className="mb-8">
          <div className="flex items-center gap-3 mb-4">
            <div className="h-10 w-10 rounded-lg bg-chart-5/20 flex items-center justify-center">
              <TestTube className="h-5 w-5 text-chart-5" />
            </div>
            <div>
              <h2 className="text-xl font-bold text-foreground">8. Testing & Deployment</h2>
              <p className="text-sm text-muted-foreground">Teststrategieën en productie deployment</p>
            </div>
          </div>
          
          <Card className="bg-card/50">
            <CardContent className="p-6">
              <Accordion type="multiple" className="w-full">
                <AccordionItem value="testing-strategy">
                  <AccordionTrigger>Testing Strategie</AccordionTrigger>
                  <AccordionContent className="space-y-4">
                    <div className="grid md:grid-cols-3 gap-4 mb-4">
                      <div className="bg-muted/30 rounded-lg p-4">
                        <h4 className="font-semibold mb-2">Unit Tests</h4>
                        <p className="text-sm text-muted-foreground">
                          Test individuele componenten: orderbook logic, arbitrage detection.
                        </p>
                      </div>
                      <div className="bg-muted/30 rounded-lg p-4">
                        <h4 className="font-semibold mb-2">Integration Tests</h4>
                        <p className="text-sm text-muted-foreground">
                          Test API integratie met mock servers, WebSocket handling.
                        </p>
                      </div>
                      <div className="bg-muted/30 rounded-lg p-4">
                        <h4 className="font-semibold mb-2">Paper Trading</h4>
                        <p className="text-sm text-muted-foreground">
                          Simuleer trades met real market data zonder echte orders.
                        </p>
                      </div>
                    </div>

                    <CodeBlock language="rust">{`#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_arbitrage_detection() {
        let mut yes_book = OrderBook::new();
        let mut no_book = OrderBook::new();
        
        // Setup with arbitrage opportunity
        yes_book.asks.insert(OrderedFloat(0.48), 1000.0);
        no_book.asks.insert(OrderedFloat(0.50), 1000.0);
        // Total: 0.98, profit: 2%

        let config = ArbitrageConfig {
            min_buffer: 0.01,
            ..Default::default()
        };

        let opportunity = check_arbitrage(&market, &config);
        
        assert!(opportunity.is_some());
        let opp = opportunity.unwrap();
        assert!((opp.profit_margin - 0.02).abs() < 0.001);
    }

    #[test]
    fn test_no_arbitrage_when_prices_equal() {
        let mut yes_book = OrderBook::new();
        let mut no_book = OrderBook::new();
        
        // No arbitrage: total = 1.00
        yes_book.asks.insert(OrderedFloat(0.50), 1000.0);
        no_book.asks.insert(OrderedFloat(0.50), 1000.0);

        let config = ArbitrageConfig::default();
        let opportunity = check_arbitrage(&market, &config);
        
        assert!(opportunity.is_none());
    }
}`}</CodeBlock>
                  </AccordionContent>
                </AccordionItem>

                <AccordionItem value="deployment">
                  <AccordionTrigger>Production Deployment</AccordionTrigger>
                  <AccordionContent className="space-y-4">
                    <div className="bg-muted/30 rounded-lg p-4 mb-4">
                      <h4 className="font-semibold mb-2">Deployment Checklist</h4>
                      <ul className="space-y-2 text-sm">
                        <li className="flex items-center gap-2">
                          <span className="text-chart-1">✓</span>
                          <span>All unit tests passing</span>
                        </li>
                        <li className="flex items-center gap-2">
                          <span className="text-chart-1">✓</span>
                          <span>Paper trading validated (1+ week)</span>
                        </li>
                        <li className="flex items-center gap-2">
                          <span className="text-chart-1">✓</span>
                          <span>Risk limits configured conservatively</span>
                        </li>
                        <li className="flex items-center gap-2">
                          <span className="text-chart-1">✓</span>
                          <span>Telegram alerts working</span>
                        </li>
                        <li className="flex items-center gap-2">
                          <span className="text-chart-1">✓</span>
                          <span>Secrets securely stored</span>
                        </li>
                      </ul>
                    </div>

                    <CodeBlock language="dockerfile">{`# Dockerfile
FROM rust:1.75-slim as builder
WORKDIR /app
COPY . .
RUN cargo build --release

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y \\
    ca-certificates libssl3 \\
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/target/release/polymarket-arb-bot /usr/local/bin/

RUN useradd -r -s /bin/false botuser
USER botuser

ENTRYPOINT ["polymarket-arb-bot"]`}</CodeBlock>

                    <CodeBlock language="yaml">{`# docker-compose.yml
version: '3.8'
services:
  bot:
    build: .
    restart: unless-stopped
    environment:
      - RUST_LOG=info
      - PRIVATE_KEY=\${PRIVATE_KEY}
      - POLYMARKET_API_KEY=\${POLYMARKET_API_KEY}
      - TELEGRAM_BOT_TOKEN=\${TELEGRAM_BOT_TOKEN}
    deploy:
      resources:
        limits:
          cpus: '2'
          memory: 512M`}</CodeBlock>
                  </AccordionContent>
                </AccordionItem>
              </Accordion>
            </CardContent>
          </Card>
        </section>

        {/* Final Notes */}
        <Card className="bg-primary/5 border-primary/20">
          <CardContent className="p-6">
            <div className="flex items-start gap-4">
              <div className="h-10 w-10 rounded-lg bg-primary/20 flex items-center justify-center shrink-0">
                <Rocket className="h-5 w-5 text-primary" />
              </div>
              <div>
                <h3 className="font-bold text-lg mb-2">Belangrijke Opmerkingen</h3>
                <ul className="space-y-2 text-sm text-muted-foreground">
                  <li>• <strong>Start klein:</strong> Begin met lage limieten en verhoog geleidelijk.</li>
                  <li>• <strong>Monitor continu:</strong> Arbitrage-condities veranderen snel door competitie.</li>
                  <li>• <strong>Fees:</strong> Houd rekening met Polymarket fees (~0.1%) en gas costs.</li>
                  <li>• <strong>Latency:</strong> Overweeg VPS dicht bij Polymarket servers.</li>
                  <li>• <strong>Disclaimer:</strong> Dit is geen financieel advies. Trading brengt risico's.</li>
                </ul>
              </div>
            </div>
          </CardContent>
        </Card>

        <Separator className="my-8" />
        
        <div className="text-center text-muted-foreground text-sm">
          <p>Gebaseerd op analyse van Gabagool22's trading strategie</p>
          <p>Laatste update: December 2024</p>
        </div>
      </div>
    </div>
  );
};

export default DevGuide;
