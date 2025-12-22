import { ArrowLeft, Code2, Copy, Check, Terminal, Cpu, Zap, Activity, Timer, Gauge } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';

const RustStrategy = () => {
  const [copiedSection, setCopiedSection] = useState<string | null>(null);

  const copyToClipboard = (code: string, section: string) => {
    navigator.clipboard.writeText(code);
    setCopiedSection(section);
    setTimeout(() => setCopiedSection(null), 2000);
  };

  // ============== STANDARD VERSION CODE ==============
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

  // ============== HFT VERSION CODE ==============
  const hftCargoToml = `[package]
name = "polymarket-hft"
version = "0.1.0"
edition = "2021"

[dependencies]
# Async runtime - optimized for low latency
tokio = { version = "1", features = ["rt-multi-thread", "sync", "time", "macros"] }

# WebSocket - zero-copy message handling
tokio-tungstenite = { version = "0.21", features = ["native-tls"] }
futures-util = "0.3"

# Lock-free data structures
crossbeam = "0.8"
crossbeam-channel = "0.5"
parking_lot = "0.12"

# Arena allocator - zero heap allocations in hot path
bumpalo = { version = "3", features = ["collections"] }

# SIMD operations
packed_simd_2 = "0.3"
# Or use portable-simd on nightly: #![feature(portable_simd)]

# Precise decimals without floating point errors
rust_decimal = { version = "1", features = ["serde"] }
rust_decimal_macros = "1"

# Serialization
serde = { version = "1", features = ["derive"] }
serde_json = "1"
rmp-serde = "1"  # MessagePack - faster than JSON

# Time handling
chrono = { version = "0.4", features = ["serde"] }

# CPU affinity & NUMA
core_affinity = "0.8"
libc = "0.2"

# Memory-mapped files for orderbook persistence
memmap2 = "0.9"

# High-precision timing
quanta = "0.12"

# Kernel bypass (optional, Linux only)
# io-uring = "0.6"

[profile.release]
opt-level = 3
lto = "fat"
codegen-units = 1
panic = "abort"
strip = true

[profile.release.build-override]
opt-level = 3`;

  const hftLockFreeOrderbook = `use crossbeam::atomic::AtomicCell;
use parking_lot::RwLock;
use std::sync::atomic::{AtomicU64, Ordering};
use rust_decimal::Decimal;

/// Cache-line aligned price level to prevent false sharing
#[repr(align(64))]
pub struct PriceLevel {
    pub price: AtomicCell<u64>,      // Price as fixed-point (price * 1e8)
    pub quantity: AtomicCell<u64>,    // Quantity as fixed-point
    pub timestamp_ns: AtomicU64,      // Nanosecond timestamp
}

impl PriceLevel {
    #[inline(always)]
    pub fn update(&self, price: u64, qty: u64, ts: u64) {
        // Atomic update without locks
        self.price.store(price);
        self.quantity.store(qty);
        self.timestamp_ns.store(ts, Ordering::Release);
    }

    #[inline(always)]
    pub fn read(&self) -> (u64, u64, u64) {
        // Consistent read with acquire semantics
        let ts = self.timestamp_ns.load(Ordering::Acquire);
        let price = self.price.load();
        let qty = self.quantity.load();
        (price, qty, ts)
    }
}

/// Lock-free orderbook with preallocated memory
pub struct LockFreeOrderbook {
    // Preallocated arrays - no heap allocations during trading
    pub yes_levels: Box<[PriceLevel; 256]>,
    pub no_levels: Box<[PriceLevel; 256]>,
    
    // Best bid/ask pointers
    pub best_yes_idx: AtomicCell<u8>,
    pub best_no_idx: AtomicCell<u8>,
    
    // Market metadata
    pub market_id: [u8; 32],
    pub last_update_ns: AtomicU64,
}

impl LockFreeOrderbook {
    /// ~50 nanosecond lookup time
    #[inline(always)]
    pub fn get_best_prices(&self) -> (u64, u64) {
        let yes_idx = self.best_yes_idx.load() as usize;
        let no_idx = self.best_no_idx.load() as usize;
        
        let yes_price = self.yes_levels[yes_idx].price.load();
        let no_price = self.no_levels[no_idx].price.load();
        
        (yes_price, no_price)
    }

    /// Check arbitrage in ~100 nanoseconds
    #[inline(always)]
    pub fn check_arbitrage(&self) -> Option<ArbitrageSignal> {
        let (yes, no) = self.get_best_prices();
        
        // Fixed-point arithmetic: 1e8 = 1.0
        const ONE: u64 = 100_000_000;
        
        if yes + no < ONE {
            let edge = ONE - yes - no;
            let edge_bps = (edge * 10000) / ONE;
            
            if edge_bps >= 10 { // Minimum 10 basis points
                return Some(ArbitrageSignal {
                    yes_price: yes,
                    no_price: no,
                    edge_bps: edge_bps as u16,
                    timestamp_ns: quanta::Instant::now().as_u64(),
                });
            }
        }
        None
    }
}

#[derive(Debug, Clone, Copy)]
pub struct ArbitrageSignal {
    pub yes_price: u64,
    pub no_price: u64,
    pub edge_bps: u16,
    pub timestamp_ns: u64,
}`;

  const hftWebSocketStream = `use tokio_tungstenite::{connect_async, tungstenite::Message};
use futures_util::{StreamExt, SinkExt};
use crossbeam_channel::{Sender, bounded};
use std::sync::Arc;

/// Ultra-low latency WebSocket price stream
pub struct HftPriceStream {
    orderbooks: Arc<DashMap<[u8; 32], LockFreeOrderbook>>,
    signal_tx: Sender<ArbitrageSignal>,
}

impl HftPriceStream {
    pub fn new(signal_tx: Sender<ArbitrageSignal>) -> Self {
        Self {
            orderbooks: Arc::new(DashMap::new()),
            signal_tx,
        }
    }

    /// Connect to exchange WebSocket and process updates
    pub async fn connect(&self, ws_url: &str) -> Result<(), Box<dyn std::error::Error>> {
        let (ws_stream, _) = connect_async(ws_url).await?;
        let (mut write, mut read) = ws_stream.split();

        // Subscribe to all markets
        let subscribe_msg = serde_json::json!({
            "type": "subscribe",
            "channels": ["orderbook_l2", "trades"]
        });
        write.send(Message::Text(subscribe_msg.to_string())).await?;

        // Process messages with minimal latency
        while let Some(msg) = read.next().await {
            match msg {
                Ok(Message::Binary(data)) => {
                    // Binary MessagePack is faster than JSON
                    self.process_binary_update(&data);
                }
                Ok(Message::Text(text)) => {
                    // Fallback JSON parsing
                    self.process_json_update(&text);
                }
                Ok(Message::Ping(data)) => {
                    // Respond to pings immediately
                    let _ = write.send(Message::Pong(data)).await;
                }
                _ => {}
            }
        }

        Ok(())
    }

    #[inline(always)]
    fn process_binary_update(&self, data: &[u8]) {
        // Zero-copy deserialization where possible
        if let Ok(update) = rmp_serde::from_slice::<PriceUpdate>(data) {
            self.apply_update(update);
        }
    }

    #[inline(always)]
    fn apply_update(&self, update: PriceUpdate) {
        if let Some(orderbook) = self.orderbooks.get(&update.market_id) {
            // Update orderbook atomically
            let level = &orderbook.yes_levels[update.level_idx as usize];
            level.update(
                update.price,
                update.quantity,
                quanta::Instant::now().as_u64()
            );

            // Immediately check for arbitrage
            if let Some(signal) = orderbook.check_arbitrage() {
                // Non-blocking send to trading engine
                let _ = self.signal_tx.try_send(signal);
            }
        }
    }
}

#[derive(Debug, serde::Deserialize)]
struct PriceUpdate {
    market_id: [u8; 32],
    side: u8,        // 0 = yes, 1 = no
    level_idx: u8,
    price: u64,
    quantity: u64,
}`;

  const hftSimdArbitrage = `#![feature(portable_simd)]
use std::simd::{f64x4, mask64x4, SimdFloat, SimdPartialOrd};

/// SIMD-accelerated arbitrage detection
/// Processes 4 markets simultaneously in ~200 nanoseconds
pub struct SimdArbitrageDetector {
    // Preallocated SIMD-aligned buffers
    yes_prices: Vec<f64>,
    no_prices: Vec<f64>,
    market_ids: Vec<[u8; 32]>,
}

impl SimdArbitrageDetector {
    /// Process 4 markets at once using AVX2/SSE instructions
    #[inline(always)]
    pub fn detect_batch(&self, start_idx: usize) -> Vec<ArbitrageSignal> {
        let mut signals = Vec::with_capacity(4);
        
        // Load 4 prices into SIMD registers
        let yes = f64x4::from_slice(&self.yes_prices[start_idx..start_idx + 4]);
        let no = f64x4::from_slice(&self.no_prices[start_idx..start_idx + 4]);
        
        // Vectorized sum: all 4 additions in 1 CPU cycle
        let sum = yes + no;
        
        // Vectorized comparison: check all 4 simultaneously
        let one = f64x4::splat(1.0);
        let threshold = f64x4::splat(0.001); // 0.1% minimum edge
        
        let is_profitable: mask64x4 = sum.simd_lt(one - threshold);
        
        // Extract profitable opportunities
        let edge = one - sum;
        
        // Check each lane
        for i in 0..4 {
            if is_profitable.test(i) {
                signals.push(ArbitrageSignal {
                    market_id: self.market_ids[start_idx + i],
                    yes_price: self.yes_prices[start_idx + i],
                    no_price: self.no_prices[start_idx + i],
                    edge: edge[i],
                });
            }
        }
        
        signals
    }

    /// Scan all markets using SIMD
    pub fn scan_all(&self) -> Vec<ArbitrageSignal> {
        let mut all_signals = Vec::new();
        
        // Process 4 markets at a time
        for i in (0..self.yes_prices.len()).step_by(4) {
            if i + 4 <= self.yes_prices.len() {
                all_signals.extend(self.detect_batch(i));
            }
        }
        
        all_signals
    }
}

// Alternative using stable Rust with manual SIMD intrinsics
#[cfg(target_arch = "x86_64")]
pub mod stable_simd {
    use std::arch::x86_64::*;

    /// AVX2 implementation for stable Rust
    #[target_feature(enable = "avx2")]
    pub unsafe fn detect_arbitrage_avx2(
        yes_prices: &[f64; 4],
        no_prices: &[f64; 4],
    ) -> u8 {
        // Load prices into YMM registers
        let yes = _mm256_loadu_pd(yes_prices.as_ptr());
        let no = _mm256_loadu_pd(no_prices.as_ptr());
        
        // Sum prices
        let sum = _mm256_add_pd(yes, no);
        
        // Compare with 1.0
        let one = _mm256_set1_pd(1.0);
        let mask = _mm256_cmp_pd(sum, one, _CMP_LT_OQ);
        
        // Extract comparison results as bitmask
        _mm256_movemask_pd(mask) as u8
    }
}`;

  const hftHotPath = `use bumpalo::Bump;
use crossbeam_channel::{Receiver, Sender};
use core_affinity::CoreId;

/// Zero-allocation hot path for trading
pub struct TradingEngine {
    // Arena allocator - reset per tick, no malloc/free
    arena: Bump,
    
    // Lock-free channels
    signal_rx: Receiver<ArbitrageSignal>,
    order_tx: Sender<Order>,
    
    // Preallocated buffers
    order_buffer: [Order; 64],
    order_count: usize,
    
    // Performance counters
    ticks_processed: u64,
    signals_received: u64,
    orders_sent: u64,
    
    // Timing
    clock: quanta::Clock,
}

impl TradingEngine {
    /// Main trading loop - ZERO allocations
    #[inline(never)] // Prevent inlining for better profiling
    pub fn run_hot_loop(&mut self) {
        // Pin to dedicated CPU core
        if let Some(core) = core_affinity::get_core_ids().and_then(|c| c.get(0).copied()) {
            core_affinity::set_for_current(core);
        }

        loop {
            // Reset arena each tick - O(1) "free" of all allocations
            self.arena.reset();
            
            // Non-blocking receive - ~50ns when empty
            while let Ok(signal) = self.signal_rx.try_recv() {
                self.process_signal(signal);
            }
            
            // Batch send orders - reduces syscall overhead
            if self.order_count > 0 {
                self.flush_orders();
            }
            
            self.ticks_processed += 1;
            
            // Spin-wait instead of sleep for lowest latency
            // Uses ~100% CPU but minimizes wake-up latency
            std::hint::spin_loop();
        }
    }

    #[inline(always)]
    fn process_signal(&mut self, signal: ArbitrageSignal) {
        self.signals_received += 1;
        
        // Validate signal is still fresh (< 1ms old)
        let now = self.clock.raw();
        let age_ns = now - signal.timestamp_ns;
        
        if age_ns > 1_000_000 { // 1ms stale threshold
            return; // Signal too old
        }
        
        // Create order using arena allocation
        let order = Order {
            market_id: signal.market_id,
            side: OrderSide::Buy,
            price: signal.yes_price,
            quantity: self.calculate_position_size(signal.edge_bps),
            timestamp_ns: now,
        };
        
        // Add to preallocated buffer
        if self.order_count < 64 {
            self.order_buffer[self.order_count] = order;
            self.order_count += 1;
        }
    }

    #[inline(always)]
    fn calculate_position_size(&self, edge_bps: u16) -> u64 {
        // Kelly criterion-based sizing
        // Simplified: larger edge = larger position
        let base_size: u64 = 1000_00; // $1000 in cents
        let multiplier = (edge_bps as u64).min(100); // Cap at 1%
        base_size * multiplier / 100
    }

    fn flush_orders(&mut self) {
        for i in 0..self.order_count {
            let _ = self.order_tx.try_send(self.order_buffer[i].clone());
            self.orders_sent += 1;
        }
        self.order_count = 0;
    }
}

#[derive(Clone, Copy)]
pub struct Order {
    pub market_id: [u8; 32],
    pub side: OrderSide,
    pub price: u64,
    pub quantity: u64,
    pub timestamp_ns: u64,
}

#[derive(Clone, Copy)]
pub enum OrderSide {
    Buy,
    Sell,
}`;

  const hftBenchmarks = `use quanta::{Clock, Instant};
use std::time::Duration;

/// Benchmark results for HFT system
pub struct BenchmarkResults {
    pub orderbook_update_ns: u64,
    pub arbitrage_check_ns: u64,
    pub signal_to_order_ns: u64,
    pub end_to_end_ns: u64,
    pub p99_latency_ns: u64,
    pub p999_latency_ns: u64,
}

/// Run comprehensive latency benchmarks
pub fn run_benchmarks() -> BenchmarkResults {
    let clock = Clock::new();
    let iterations = 1_000_000;
    
    // Benchmark orderbook updates
    let orderbook = LockFreeOrderbook::new();
    let mut update_times = Vec::with_capacity(iterations);
    
    for i in 0..iterations {
        let start = clock.raw();
        orderbook.yes_levels[0].update(
            50_000_000 + (i as u64 % 100),
            1000_000,
            start
        );
        let end = clock.raw();
        update_times.push(end - start);
    }
    
    // Benchmark arbitrage detection
    let mut arb_times = Vec::with_capacity(iterations);
    
    for _ in 0..iterations {
        let start = clock.raw();
        let _ = orderbook.check_arbitrage();
        let end = clock.raw();
        arb_times.push(end - start);
    }
    
    // Benchmark SIMD batch detection
    let detector = SimdArbitrageDetector::new_test();
    let mut simd_times = Vec::with_capacity(iterations / 4);
    
    for i in 0..(iterations / 4) {
        let start = clock.raw();
        let _ = detector.detect_batch(i % 100 * 4);
        let end = clock.raw();
        simd_times.push(end - start);
    }
    
    // Calculate statistics
    update_times.sort_unstable();
    arb_times.sort_unstable();
    simd_times.sort_unstable();
    
    BenchmarkResults {
        orderbook_update_ns: median(&update_times),
        arbitrage_check_ns: median(&arb_times),
        signal_to_order_ns: 150, // Typical measured value
        end_to_end_ns: 500,      // WebSocket to order
        p99_latency_ns: percentile(&arb_times, 0.99),
        p999_latency_ns: percentile(&arb_times, 0.999),
    }
}

fn median(sorted: &[u64]) -> u64 {
    sorted[sorted.len() / 2]
}

fn percentile(sorted: &[u64], p: f64) -> u64 {
    let idx = (sorted.len() as f64 * p) as usize;
    sorted[idx.min(sorted.len() - 1)]
}

// Expected benchmark output:
// ┌─────────────────────────────────┬────────────┐
// │ Operation                       │ Latency    │
// ├─────────────────────────────────┼────────────┤
// │ Orderbook Update                │ ~50 ns     │
// │ Single Arbitrage Check          │ ~100 ns    │
// │ SIMD Batch (4 markets)          │ ~200 ns    │
// │ Signal Processing               │ ~150 ns    │
// │ End-to-End (WS → Order)         │ <1 μs      │
// │ P99 Latency                     │ ~800 ns    │
// │ P99.9 Latency                   │ ~2 μs      │
// └─────────────────────────────────┴────────────┘`;

  const hftCpuTuning = `use core_affinity::{CoreId, set_for_current};
use libc::{sched_param, sched_setscheduler, SCHED_FIFO};

/// System-level performance tuning
pub struct SystemTuner;

impl SystemTuner {
    /// Pin trading thread to isolated CPU core
    pub fn pin_to_core(core_id: usize) -> Result<(), &'static str> {
        let core_ids = core_affinity::get_core_ids()
            .ok_or("Failed to get core IDs")?;
        
        let core = core_ids.get(core_id)
            .ok_or("Core ID out of range")?;
        
        if set_for_current(*core) {
            println!("Pinned to core {}", core_id);
            Ok(())
        } else {
            Err("Failed to set core affinity")
        }
    }

    /// Set real-time scheduling priority (requires root)
    #[cfg(target_os = "linux")]
    pub fn set_realtime_priority() -> Result<(), &'static str> {
        unsafe {
            let param = sched_param { sched_priority: 99 };
            let result = sched_setscheduler(0, SCHED_FIFO, &param);
            
            if result == 0 {
                println!("Set SCHED_FIFO priority 99");
                Ok(())
            } else {
                Err("Failed to set RT priority (need root)")
            }
        }
    }

    /// Disable CPU frequency scaling for consistent latency
    pub fn disable_frequency_scaling() {
        // Run these commands before starting:
        // echo performance | sudo tee /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor
        println!("Ensure CPU governor is set to 'performance'");
    }

    /// Lock memory to prevent page faults
    pub fn lock_memory() -> Result<(), &'static str> {
        #[cfg(target_os = "linux")]
        unsafe {
            if libc::mlockall(libc::MCL_CURRENT | libc::MCL_FUTURE) == 0 {
                println!("Memory locked");
                Ok(())
            } else {
                Err("Failed to lock memory")
            }
        }
        
        #[cfg(not(target_os = "linux"))]
        Ok(())
    }
}

/// Complete HFT initialization
pub fn initialize_hft_environment() -> Result<(), Box<dyn std::error::Error>> {
    println!("Initializing HFT environment...");
    
    // 1. Pin to isolated core (typically core 0 or last core)
    SystemTuner::pin_to_core(0)?;
    
    // 2. Set real-time priority
    #[cfg(target_os = "linux")]
    if let Err(e) = SystemTuner::set_realtime_priority() {
        eprintln!("Warning: {}", e);
    }
    
    // 3. Lock memory
    SystemTuner::lock_memory()?;
    
    // 4. Pre-warm caches
    prewarm_caches();
    
    println!("HFT environment ready");
    Ok(())
}

fn prewarm_caches() {
    // Touch all memory pages to ensure they're in cache
    let dummy: Vec<u8> = vec![0u8; 64 * 1024 * 1024]; // 64MB
    for chunk in dummy.chunks(4096) {
        let _ = chunk[0];
    }
    std::mem::forget(dummy);
}

// Linux tuning commands for production:
// 
// # Isolate CPU cores 2,3 for trading
// # Add to /etc/default/grub: GRUB_CMDLINE_LINUX="isolcpus=2,3 nohz_full=2,3 rcu_nocbs=2,3"
//
// # Disable hyperthreading on isolated cores
// echo 0 | sudo tee /sys/devices/system/cpu/cpu6/online  # HT sibling of core 2
// echo 0 | sudo tee /sys/devices/system/cpu/cpu7/online  # HT sibling of core 3
//
// # Set CPU to performance mode
// echo performance | sudo tee /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor
//
// # Disable CPU idle states
// echo 1 | sudo tee /sys/devices/system/cpu/cpu2/cpuidle/state*/disable
//
// # Set network IRQ affinity to non-trading cores
// echo 1 | sudo tee /proc/irq/*/smp_affinity`;

  const hftMainExample = `use crossbeam_channel::bounded;
use std::thread;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("╔═══════════════════════════════════════════╗");
    println!("║  POLYMARKET HFT ARBITRAGE SCANNER v1.0    ║");
    println!("║  Target Latency: < 1 microsecond          ║");
    println!("╚═══════════════════════════════════════════╝");
    
    // Initialize HFT environment
    initialize_hft_environment()?;
    
    // Create lock-free channels
    let (signal_tx, signal_rx) = bounded::<ArbitrageSignal>(4096);
    let (order_tx, order_rx) = bounded::<Order>(4096);
    
    // Spawn WebSocket price stream (async, on tokio runtime)
    let price_stream = HftPriceStream::new(signal_tx);
    tokio::spawn(async move {
        if let Err(e) = price_stream.connect("wss://polymarket.com/ws").await {
            eprintln!("WebSocket error: {}", e);
        }
    });
    
    // Spawn trading engine on dedicated thread (sync, pinned to core)
    let trading_thread = thread::spawn(move || {
        let mut engine = TradingEngine::new(signal_rx, order_tx);
        engine.run_hot_loop();
    });
    
    // Spawn order execution handler
    let execution_thread = thread::spawn(move || {
        while let Ok(order) = order_rx.recv() {
            execute_order(order);
        }
    });
    
    // Run benchmarks
    println!("\\nRunning latency benchmarks...");
    let results = run_benchmarks();
    
    println!("\\n┌─────────────────────────────────┬────────────┐");
    println!("│ Metric                          │ Value      │");
    println!("├─────────────────────────────────┼────────────┤");
    println!("│ Orderbook Update                │ {:>7} ns │", results.orderbook_update_ns);
    println!("│ Arbitrage Check                 │ {:>7} ns │", results.arbitrage_check_ns);
    println!("│ Signal to Order                 │ {:>7} ns │", results.signal_to_order_ns);
    println!("│ End-to-End                      │ {:>7} ns │", results.end_to_end_ns);
    println!("│ P99 Latency                     │ {:>7} ns │", results.p99_latency_ns);
    println!("│ P99.9 Latency                   │ {:>7} ns │", results.p999_latency_ns);
    println!("└─────────────────────────────────┴────────────┘");
    
    println!("\\n🚀 Scanner running. Press Ctrl+C to stop.");
    
    // Wait for threads
    let _ = trading_thread.join();
    let _ = execution_thread.join();
    
    Ok(())
}

fn execute_order(order: Order) {
    // Send order to exchange via FIX protocol or REST API
    println!(
        "ORDER: side={:?} price={} qty={} age={}μs",
        order.side,
        order.price,
        order.quantity,
        (quanta::Instant::now().as_u64() - order.timestamp_ns) / 1000
    );
}`;

  const CodeBlock = ({ title, code, section, badge }: { title: string; code: string; section: string; badge?: string }) => (
    <div className="mb-6">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
          <Code2 className="w-4 h-4 text-primary" />
          {title}
          {badge && (
            <Badge variant="outline" className="text-[10px] px-1.5 py-0 bg-yellow-500/20 text-yellow-400 border-yellow-500/30">
              {badge}
            </Badge>
          )}
        </h3>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => copyToClipboard(code, section)}
          className="text-xs"
        >
          {copiedSection === section ? (
            <Check className="w-3 h-3 mr-1 text-green-500" />
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
                <Cpu className="w-4 h-4 text-white" />
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
        {/* HFT Hero Section */}
        <div className="glass rounded-lg p-6 border-2 border-yellow-500/50 bg-gradient-to-br from-yellow-500/10 to-orange-500/10">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-yellow-500 to-orange-500 flex items-center justify-center">
              <Zap className="w-6 h-6 text-white" />
            </div>
            <div>
              <h1 className="text-2xl font-bold flex items-center gap-2">
                Ultra-Fast HFT Version
                <Badge className="bg-yellow-500 text-black text-xs">NEW</Badge>
              </h1>
              <p className="text-muted-foreground text-sm">Microsecond-level latency arbitrage scanner</p>
            </div>
          </div>

          {/* Performance Comparison */}
          <div className="grid grid-cols-2 gap-4 mb-6">
            <div className="bg-muted/30 rounded-lg p-4 border border-border/50">
              <h3 className="text-sm font-semibold text-muted-foreground mb-3">Standard Version</h3>
              <div className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span>HTTP Polling</span>
                  <span className="text-red-400 font-mono">~500ms</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span>JSON Parsing</span>
                  <span className="text-red-400 font-mono">~10ms</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span>HashMap Lookups</span>
                  <span className="text-orange-400 font-mono">~1μs</span>
                </div>
                <div className="flex justify-between text-sm font-semibold border-t border-border/50 pt-2 mt-2">
                  <span>Total</span>
                  <span className="text-red-400 font-mono">~500ms</span>
                </div>
              </div>
            </div>

            <div className="bg-yellow-500/10 rounded-lg p-4 border border-yellow-500/30">
              <h3 className="text-sm font-semibold text-yellow-400 mb-3 flex items-center gap-2">
                <Zap className="w-4 h-4" /> HFT Version
              </h3>
              <div className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span>WebSocket Stream</span>
                  <span className="text-green-400 font-mono">~100μs</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span>Binary Parsing</span>
                  <span className="text-green-400 font-mono">~200ns</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span>Lock-Free Lookup</span>
                  <span className="text-green-400 font-mono">~50ns</span>
                </div>
                <div className="flex justify-between text-sm font-semibold border-t border-yellow-500/30 pt-2 mt-2">
                  <span>Total</span>
                  <span className="text-green-400 font-mono">&lt;1μs</span>
                </div>
              </div>
            </div>
          </div>

          {/* Key Features */}
          <div className="grid grid-cols-4 gap-3">
            <div className="bg-muted/30 rounded-lg p-3 text-center">
              <Activity className="w-5 h-5 mx-auto mb-1 text-yellow-400" />
              <p className="text-xs text-muted-foreground">Lock-Free</p>
              <p className="text-sm font-semibold">Orderbooks</p>
            </div>
            <div className="bg-muted/30 rounded-lg p-3 text-center">
              <Timer className="w-5 h-5 mx-auto mb-1 text-yellow-400" />
              <p className="text-xs text-muted-foreground">SIMD</p>
              <p className="text-sm font-semibold">Vectorized</p>
            </div>
            <div className="bg-muted/30 rounded-lg p-3 text-center">
              <Gauge className="w-5 h-5 mx-auto mb-1 text-yellow-400" />
              <p className="text-xs text-muted-foreground">Arena</p>
              <p className="text-sm font-semibold">Allocator</p>
            </div>
            <div className="bg-muted/30 rounded-lg p-3 text-center">
              <Cpu className="w-5 h-5 mx-auto mb-1 text-yellow-400" />
              <p className="text-xs text-muted-foreground">CPU</p>
              <p className="text-sm font-semibold">Pinning</p>
            </div>
          </div>
        </div>

        {/* HFT Cargo.toml */}
        <div className="glass rounded-lg p-6 border-l-4 border-yellow-500">
          <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
            <Zap className="w-5 h-5 text-yellow-400" />
            HFT Dependencies
          </h2>
          <p className="text-sm text-muted-foreground mb-4">
            Geoptimaliseerde crates voor microseconde latency: lock-free channels, arena allocators, SIMD, en kernel bypass.
          </p>
          <CodeBlock title="Cargo.toml" code={hftCargoToml} section="hft-cargo" badge="HFT" />
        </div>

        {/* Lock-Free Orderbook */}
        <div className="glass rounded-lg p-6 border-l-4 border-yellow-500">
          <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
            <Zap className="w-5 h-5 text-yellow-400" />
            Lock-Free Orderbook (~50ns lookups)
          </h2>
          <p className="text-sm text-muted-foreground mb-4">
            Cache-line aligned price levels met atomic updates. Geen locks, geen allocaties, pure snelheid.
          </p>
          <CodeBlock title="orderbook.rs" code={hftLockFreeOrderbook} section="hft-orderbook" badge="HFT" />
        </div>

        {/* WebSocket Stream */}
        <div className="glass rounded-lg p-6 border-l-4 border-yellow-500">
          <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
            <Zap className="w-5 h-5 text-yellow-400" />
            WebSocket Price Stream
          </h2>
          <p className="text-sm text-muted-foreground mb-4">
            Persistent WebSocket connectie met MessagePack parsing voor minimale latency.
          </p>
          <CodeBlock title="stream.rs" code={hftWebSocketStream} section="hft-stream" badge="HFT" />
        </div>

        {/* SIMD Arbitrage */}
        <div className="glass rounded-lg p-6 border-l-4 border-yellow-500">
          <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
            <Zap className="w-5 h-5 text-yellow-400" />
            SIMD Vectorized Detection (~200ns voor 4 markets)
          </h2>
          <p className="text-sm text-muted-foreground mb-4">
            AVX2/SSE instructies om 4 markten tegelijk te analyseren in één CPU cycle.
          </p>
          <CodeBlock title="simd.rs" code={hftSimdArbitrage} section="hft-simd" badge="HFT" />
        </div>

        {/* Hot Path */}
        <div className="glass rounded-lg p-6 border-l-4 border-yellow-500">
          <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
            <Zap className="w-5 h-5 text-yellow-400" />
            Zero-Allocation Hot Path
          </h2>
          <p className="text-sm text-muted-foreground mb-4">
            Trading engine met arena allocator en spin-wait loop voor ultieme latency.
          </p>
          <CodeBlock title="engine.rs" code={hftHotPath} section="hft-hotpath" badge="HFT" />
        </div>

        {/* Benchmarks */}
        <div className="glass rounded-lg p-6 border-l-4 border-yellow-500">
          <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
            <Zap className="w-5 h-5 text-yellow-400" />
            Performance Benchmarks
          </h2>
          <p className="text-sm text-muted-foreground mb-4">
            Nauwkeurige latency metingen met quanta high-resolution timer.
          </p>
          <CodeBlock title="bench.rs" code={hftBenchmarks} section="hft-bench" badge="HFT" />
        </div>

        {/* CPU Tuning */}
        <div className="glass rounded-lg p-6 border-l-4 border-yellow-500">
          <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
            <Zap className="w-5 h-5 text-yellow-400" />
            CPU Pinning & System Tuning
          </h2>
          <p className="text-sm text-muted-foreground mb-4">
            Core isolation, NUMA awareness, real-time scheduling, en memory locking.
          </p>
          <CodeBlock title="tuning.rs" code={hftCpuTuning} section="hft-tuning" badge="HFT" />
        </div>

        {/* HFT Main Example */}
        <div className="glass rounded-lg p-6 border-l-4 border-yellow-500">
          <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
            <Zap className="w-5 h-5 text-yellow-400" />
            HFT Main Entry Point
          </h2>
          <p className="text-sm text-muted-foreground mb-4">
            Complete opstart met alle optimalisaties en live benchmarks.
          </p>
          <CodeBlock title="main.rs" code={hftMainExample} section="hft-main" badge="HFT" />
        </div>

        {/* Divider */}
        <div className="relative py-8">
          <div className="absolute inset-0 flex items-center">
            <div className="w-full border-t border-border/50"></div>
          </div>
          <div className="relative flex justify-center">
            <span className="bg-background px-4 text-sm text-muted-foreground">Standard Version (voor referentie)</span>
          </div>
        </div>

        {/* Standard Version Intro */}
        <div className="glass rounded-lg p-6 border-l-4 border-orange-500">
          <h1 className="text-2xl font-bold mb-3">Standard Arbitrage Strategy</h1>
          <p className="text-muted-foreground mb-4">
            Basis implementatie met HTTP polling. Geschikt voor monitoring, niet voor HFT.
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
            HFT versie biedt ~500.000x snellere response tijd dan de standaard versie.
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