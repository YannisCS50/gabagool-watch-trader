import { ArrowLeft, Code2, Copy, Check, Terminal, Cpu } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { useState } from 'react';

const RustStrategy = () => {
  const [copiedSection, setCopiedSection] = useState<string | null>(null);

  const copyToClipboard = (code: string, section: string) => {
    navigator.clipboard.writeText(code);
    setCopiedSection(section);
    setTimeout(() => setCopiedSection(null), 2000);
  };

  const dataStructures = `use serde::{Deserialize, Serialize};
use chrono::{DateTime, Utc};
use rust_decimal::Decimal;

/// Represents a single trade on Polymarket
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Trade {
    pub id: String,
    pub market: String,
    pub market_slug: Option<String>,
    pub outcome: Outcome,
    pub side: Side,
    pub price: Decimal,
    pub shares: Decimal,
    pub total: Decimal,
    pub timestamp: DateTime<Utc>,
    pub status: TradeStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Outcome {
    Yes,
    No,
    Up,
    Down,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Side {
    Buy,
    Sell,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TradeStatus {
    Filled,
    Pending,
    Cancelled,
}

/// Open position in a market
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Position {
    pub market: String,
    pub market_slug: Option<String>,
    pub outcome: Outcome,
    pub shares: Decimal,
    pub avg_price: Decimal,
    pub current_price: Decimal,
    pub pnl: Decimal,
    pub pnl_percent: Decimal,
}`;

  const arbitrageDetection = `use rust_decimal::Decimal;
use rust_decimal_macros::dec;
use std::collections::HashMap;

/// Result of arbitrage analysis for a market
#[derive(Debug, Clone)]
pub struct ArbitrageOpportunity {
    pub market: String,
    pub yes_price: Decimal,
    pub no_price: Decimal,
    pub price_sum: Decimal,
    pub edge: Decimal,           // 1.0 - sum (positive = profit)
    pub min_shares: Decimal,     // Matched shares for guaranteed profit
    pub guaranteed_profit: Decimal,
    pub is_profitable: bool,
}

/// Analyzes trades to find arbitrage opportunities
pub fn find_arbitrage_opportunities(trades: &[Trade]) -> Vec<ArbitrageOpportunity> {
    // Group BUY trades by market
    let mut market_buys: HashMap<String, HashMap<Outcome, Vec<&Trade>>> = HashMap::new();
    
    for trade in trades.iter().filter(|t| t.side == Side::Buy) {
        market_buys
            .entry(trade.market.clone())
            .or_default()
            .entry(trade.outcome)
            .or_default()
            .push(trade);
    }
    
    let mut opportunities = Vec::new();
    
    for (market, outcome_trades) in market_buys {
        // Check for both YES and NO (or UP and DOWN)
        let yes_trades = outcome_trades.get(&Outcome::Yes)
            .or_else(|| outcome_trades.get(&Outcome::Up));
        let no_trades = outcome_trades.get(&Outcome::No)
            .or_else(|| outcome_trades.get(&Outcome::Down));
        
        if let (Some(yes), Some(no)) = (yes_trades, no_trades) {
            let opp = calculate_arbitrage(&market, yes, no);
            opportunities.push(opp);
        }
    }
    
    // Sort by profitability
    opportunities.sort_by(|a, b| b.edge.cmp(&a.edge));
    opportunities
}

fn calculate_arbitrage(
    market: &str,
    yes_trades: &[&Trade],
    no_trades: &[&Trade],
) -> ArbitrageOpportunity {
    // Calculate volume-weighted average prices
    let yes_price = weighted_avg_price(yes_trades);
    let no_price = weighted_avg_price(no_trades);
    
    let yes_shares: Decimal = yes_trades.iter().map(|t| t.shares).sum();
    let no_shares: Decimal = no_trades.iter().map(|t| t.shares).sum();
    
    let price_sum = yes_price + no_price;
    let edge = dec!(1.0) - price_sum;
    let min_shares = yes_shares.min(no_shares);
    let guaranteed_profit = min_shares * edge;
    
    ArbitrageOpportunity {
        market: market.to_string(),
        yes_price,
        no_price,
        price_sum,
        edge,
        min_shares,
        guaranteed_profit,
        is_profitable: price_sum < dec!(1.0),
    }
}

fn weighted_avg_price(trades: &[&Trade]) -> Decimal {
    let total_cost: Decimal = trades.iter().map(|t| t.price * t.shares).sum();
    let total_shares: Decimal = trades.iter().map(|t| t.shares).sum();
    
    if total_shares.is_zero() {
        Decimal::ZERO
    } else {
        total_cost / total_shares
    }
}`;

  const positionGrouping = `use std::collections::HashMap;

/// Grouped positions for a single market
#[derive(Debug, Clone)]
pub struct MarketPositionGroup {
    pub market: String,
    pub yes_position: Option<Position>,
    pub no_position: Option<Position>,
    pub is_pair: bool,
    pub pair_shares: Decimal,
    pub price_sum: Decimal,
    pub edge: Decimal,
    pub guaranteed_profit: Decimal,
    pub total_value: Decimal,
}

/// Groups positions by market and calculates arbitrage metrics
pub fn group_positions(positions: &[Position]) -> Vec<MarketPositionGroup> {
    let mut market_map: HashMap<String, MarketPositionGroup> = HashMap::new();
    
    for pos in positions {
        let entry = market_map.entry(pos.market.clone()).or_insert_with(|| {
            MarketPositionGroup {
                market: pos.market.clone(),
                yes_position: None,
                no_position: None,
                is_pair: false,
                pair_shares: Decimal::ZERO,
                price_sum: Decimal::ZERO,
                edge: Decimal::ZERO,
                guaranteed_profit: Decimal::ZERO,
                total_value: Decimal::ZERO,
            }
        });
        
        match pos.outcome {
            Outcome::Yes | Outcome::Up => entry.yes_position = Some(pos.clone()),
            Outcome::No | Outcome::Down => entry.no_position = Some(pos.clone()),
        }
    }
    
    // Calculate metrics for each group
    market_map.values_mut().for_each(|group| {
        if let (Some(yes), Some(no)) = (&group.yes_position, &group.no_position) {
            group.is_pair = true;
            group.pair_shares = yes.shares.min(no.shares);
            group.price_sum = yes.avg_price + no.avg_price;
            group.edge = dec!(1.0) - group.price_sum;
            group.guaranteed_profit = group.pair_shares * group.edge;
        }
        
        let yes_value = group.yes_position.as_ref()
            .map(|p| p.shares * p.current_price)
            .unwrap_or_default();
        let no_value = group.no_position.as_ref()
            .map(|p| p.shares * p.current_price)
            .unwrap_or_default();
        
        group.total_value = yes_value + no_value;
    });
    
    let mut groups: Vec<_> = market_map.into_values().collect();
    
    // Sort: pairs first, then by value
    groups.sort_by(|a, b| {
        match (a.is_pair, b.is_pair) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => b.total_value.cmp(&a.total_value),
        }
    });
    
    groups
}`;

  const liveScanner = `use tokio::time::{interval, Duration};
use reqwest::Client;

/// Configuration for the arbitrage scanner
pub struct ScannerConfig {
    pub api_url: String,
    pub trader_username: String,
    pub scan_interval: Duration,
    pub min_edge_threshold: Decimal, // e.g., 0.01 for 1% edge
}

/// Live arbitrage scanner
pub struct ArbitrageScanner {
    config: ScannerConfig,
    client: Client,
}

impl ArbitrageScanner {
    pub fn new(config: ScannerConfig) -> Self {
        Self {
            config,
            client: Client::new(),
        }
    }
    
    /// Start continuous scanning for arbitrage opportunities
    pub async fn run(&self) -> Result<(), Box<dyn std::error::Error>> {
        let mut interval = interval(self.config.scan_interval);
        
        loop {
            interval.tick().await;
            
            match self.scan_once().await {
                Ok(opportunities) => {
                    self.process_opportunities(&opportunities).await;
                }
                Err(e) => {
                    eprintln!("Scan error: {}", e);
                }
            }
        }
    }
    
    /// Perform a single scan
    async fn scan_once(&self) -> Result<Vec<ArbitrageOpportunity>, reqwest::Error> {
        // Fetch current positions
        let positions: Vec<Position> = self.client
            .get(&format!("{}/positions/{}", self.config.api_url, self.config.trader_username))
            .send()
            .await?
            .json()
            .await?;
        
        // Fetch recent trades
        let trades: Vec<Trade> = self.client
            .get(&format!("{}/trades/{}", self.config.api_url, self.config.trader_username))
            .send()
            .await?
            .json()
            .await?;
        
        // Analyze for arbitrage
        let opportunities = find_arbitrage_opportunities(&trades);
        
        Ok(opportunities)
    }
    
    /// Process found opportunities
    async fn process_opportunities(&self, opportunities: &[ArbitrageOpportunity]) {
        let profitable: Vec<_> = opportunities
            .iter()
            .filter(|o| o.is_profitable && o.edge >= self.config.min_edge_threshold)
            .collect();
        
        if !profitable.is_empty() {
            println!("Found {} profitable arbitrage opportunities:", profitable.len());
            
            for opp in profitable {
                println!(
                    "  {} | YES: {:.2} + NO: {:.2} = {:.2} | Edge: {:.2}% | Profit: {}",
                    truncate(&opp.market, 30),
                    opp.yes_price * dec!(100),
                    opp.no_price * dec!(100),
                    opp.price_sum * dec!(100),
                    opp.edge * dec!(100),
                    opp.guaranteed_profit,
                );
            }
        }
    }
}

fn truncate(s: &str, max_len: usize) -> String {
    if s.len() <= max_len {
        s.to_string()
    } else {
        format!("{}...", &s[..max_len-3])
    }
}`;

  const mainExample = `use rust_decimal_macros::dec;
use tokio::time::Duration;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("Polymarket Arbitrage Scanner starting...");
    
    let config = ScannerConfig {
        api_url: "https://your-api.com".to_string(),
        trader_username: "gabagool22".to_string(),
        scan_interval: Duration::from_secs(30),
        min_edge_threshold: dec!(0.01), // 1% minimum edge
    };
    
    let scanner = ArbitrageScanner::new(config);
    
    // Run continuous scanning
    scanner.run().await?;
    
    Ok(())
}

// Example output:
// Polymarket Arbitrage Scanner starting...
// Found 3 profitable arbitrage opportunities:
//   Will BTC hit 100k by EOY? | YES: 45 + NO: 50 = 95 | Edge: 5.00% | Profit: 125.00
//   ETH above 4000 Dec 31? | YES: 38 + NO: 58 = 96 | Edge: 4.00% | Profit: 80.00
//   Fed rate cut January? | YES: 22 + NO: 75 = 97 | Edge: 3.00% | Profit: 45.00`;

  const cargoToml = `[package]
name = "polymarket-arbitrage"
version = "0.1.0"
edition = "2021"

[dependencies]
tokio = { version = "1", features = ["full"] }
reqwest = { version = "0.11", features = ["json"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
rust_decimal = { version = "1", features = ["serde"] }
rust_decimal_macros = "1"
chrono = { version = "0.4", features = ["serde"] }
thiserror = "1"`;

  const CodeBlock = ({ title, code, section }: { title: string; code: string; section: string }) => (
    <div className="mb-6">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
          <Code2 className="w-4 h-4 text-primary" />
          {title}
        </h3>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => copyToClipboard(code, section)}
          className="text-xs"
        >
          {copiedSection === section ? (
            <Check className="w-3 h-3 mr-1 text-success" />
          ) : (
            <Copy className="w-3 h-3 mr-1" />
          )}
          {copiedSection === section ? 'Copied!' : 'Copy'}
        </Button>
      </div>
      <pre className="bg-muted/50 rounded-lg p-4 overflow-x-auto text-xs font-mono text-foreground/90 border border-border/50">
        <code>{code}</code>
      </pre>
    </div>
  );

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border/50 bg-card/50 backdrop-blur-xl sticky top-0 z-50">
        <div className="container mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Link to="/dev-guide" className="flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors">
                <ArrowLeft className="w-4 h-4" />
              </Link>
              <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-orange-500 to-red-500 flex items-center justify-center">
                <Cpu className="w-4 h-4 text-primary-foreground" />
              </div>
              <span className="font-semibold text-lg">Rust Implementation</span>
              <span className="text-xs px-2 py-0.5 rounded-full bg-orange-500/20 text-orange-400 font-mono">
                RUST
              </span>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="container mx-auto px-4 py-6 space-y-6 max-w-4xl">
        {/* Intro */}
        <div className="glass rounded-lg p-6 border-l-4 border-orange-500">
          <h1 className="text-2xl font-bold mb-3 text-gradient">Arbitrage Strategy in Rust</h1>
          <p className="text-muted-foreground mb-4">
            Deze pagina toont hoe de Polymarket arbitrage strategie geïmplementeerd kan worden in Rust. 
            Rust biedt memory safety, zero-cost abstractions en excellent performance voor trading systemen.
          </p>
          <div className="grid grid-cols-3 gap-4 text-center">
            <div className="bg-orange-500/10 rounded-lg p-3">
              <Terminal className="w-5 h-5 mx-auto mb-1 text-orange-400" />
              <p className="text-xs text-muted-foreground">Type Safe</p>
              <p className="text-sm font-semibold">Compile-time garanties</p>
            </div>
            <div className="bg-orange-500/10 rounded-lg p-3">
              <Cpu className="w-5 h-5 mx-auto mb-1 text-orange-400" />
              <p className="text-xs text-muted-foreground">Performance</p>
              <p className="text-sm font-semibold">Zero-cost abstractions</p>
            </div>
            <div className="bg-orange-500/10 rounded-lg p-3">
              <Code2 className="w-5 h-5 mx-auto mb-1 text-orange-400" />
              <p className="text-xs text-muted-foreground">Async/Await</p>
              <p className="text-sm font-semibold">Tokio runtime</p>
            </div>
          </div>
        </div>

        {/* Cargo.toml */}
        <div className="glass rounded-lg p-6">
          <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
            📦 Dependencies (Cargo.toml)
          </h2>
          <CodeBlock title="Cargo.toml" code={cargoToml} section="cargo" />
        </div>

        {/* Data Structures */}
        <div className="glass rounded-lg p-6">
          <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
            🏗️ Data Structures
          </h2>
          <p className="text-sm text-muted-foreground mb-4">
            Basis types voor trades, posities en outcomes. Gebruikt rust_decimal voor 
            precise financiële berekeningen.
          </p>
          <CodeBlock title="types.rs" code={dataStructures} section="types" />
        </div>

        {/* Arbitrage Detection */}
        <div className="glass rounded-lg p-6">
          <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
            🎯 Arbitrage Detection
          </h2>
          <p className="text-sm text-muted-foreground mb-4">
            Kernlogica voor het detecteren van arbitrage kansen. Groepeert trades per markt en berekent 
            of YES + NO &lt; 1.00 (winstgevend).
          </p>
          <CodeBlock title="arbitrage.rs" code={arbitrageDetection} section="arbitrage" />
        </div>

        {/* Position Grouping */}
        <div className="glass rounded-lg p-6">
          <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
            📊 Position Grouping
          </h2>
          <p className="text-sm text-muted-foreground mb-4">
            Groepeert open posities per markt en berekent gegarandeerde winst voor complete pairs.
          </p>
          <CodeBlock title="positions.rs" code={positionGrouping} section="positions" />
        </div>

        {/* Live Scanner */}
        <div className="glass rounded-lg p-6">
          <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
            🔄 Live Scanner
          </h2>
          <p className="text-sm text-muted-foreground mb-4">
            Async scanner die continu monitort voor nieuwe arbitrage kansen met configureerbare intervallen.
          </p>
          <CodeBlock title="scanner.rs" code={liveScanner} section="scanner" />
        </div>

        {/* Main Example */}
        <div className="glass rounded-lg p-6">
          <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
            🚀 Main Entry Point
          </h2>
          <p className="text-sm text-muted-foreground mb-4">
            Voorbeeld van hoe alles samenkomt in de main functie.
          </p>
          <CodeBlock title="main.rs" code={mainExample} section="main" />
        </div>

        {/* Footer */}
        <div className="text-center py-8">
          <p className="text-xs text-muted-foreground">
            Deze Rust implementatie is een conceptuele vertaling van de TypeScript/React strategie.
          </p>
          <Link 
            to="/dev-guide" 
            className="inline-flex items-center gap-2 mt-4 text-sm text-primary hover:underline"
          >
            ← Terug naar Developer Guide
          </Link>
        </div>
      </main>
    </div>
  );
};

export default RustStrategy;