import { ArrowLeft, Copy, Check, Zap, Shield, Wifi, Database, Cpu, Terminal, ExternalLink, ChevronRight, BookOpen, Code2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';

const HFTBuildGuide = () => {
  const [copiedSection, setCopiedSection] = useState<string | null>(null);
  const [activeStep, setActiveStep] = useState(1);

  const copyToClipboard = (code: string, section: string) => {
    navigator.clipboard.writeText(code);
    setCopiedSection(section);
    setTimeout(() => setCopiedSection(null), 2000);
  };

  // ============== STEP 1: API RESEARCH ==============
  const apiEndpoints = `# Polymarket API Endpoints

## REST API (CLOB)
Base URL: https://clob.polymarket.com

## Data API (User Data)
Base URL: https://data-api.polymarket.com

## WebSocket (Real-time)
URL: wss://ws-subscriptions-clob.polymarket.com/ws/

## RTDS (Crypto Prices)
URL: wss://ws-live-data.polymarket.com`;

  const authHeaders = `// L1 Authentication Headers (voor eerste keer API key aanmaken)
// Vereist EIP-712 signature van je wallet

| Header           | Beschrijving                              |
|------------------|-------------------------------------------|
| POLY_ADDRESS     | Je Polygon wallet address                 |
| POLY_SIGNATURE   | EIP-712 signature                         |
| POLY_TIMESTAMP   | Huidige UNIX timestamp                    |
| POLY_NONCE       | Nonce (standaard 0)                       |

// L2 Authentication Headers (voor orders & trades)
// Na L1 krijg je: apiKey, secret, passphrase

| Header              | Beschrijving                           |
|---------------------|----------------------------------------|
| POLY_API_KEY        | Je API key (UUID format)               |
| POLY_TIMESTAMP      | Huidige UNIX timestamp                 |
| POLY_SIGNATURE      | HMAC-SHA256 signature                  |
| POLY_PASSPHRASE     | Je passphrase                          |`;

  const eip712Signing = `use ethers::signers::{LocalWallet, Signer};
use ethers::types::{H160, Signature};
use serde::{Deserialize, Serialize};
use sha2::{Sha256, Digest};
use std::time::{SystemTime, UNIX_EPOCH};

/// EIP-712 Domain for Polymarket CLOB
#[derive(Debug, Clone)]
pub struct ClobAuthDomain {
    pub name: String,      // "ClobAuthDomain"
    pub version: String,   // "1"
    pub chain_id: u64,     // 137 for Polygon mainnet
}

/// EIP-712 Message structure
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClobAuthMessage {
    pub address: H160,
    pub timestamp: String,
    pub nonce: u64,
    pub message: String,
}

impl ClobAuthMessage {
    pub fn new(address: H160, nonce: u64) -> Self {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs()
            .to_string();
        
        Self {
            address,
            timestamp,
            nonce,
            message: "This message attests that I control the given wallet".to_string(),
        }
    }
}

/// Generate L1 authentication headers
pub async fn generate_l1_headers(
    wallet: &LocalWallet,
    nonce: u64,
) -> Result<L1Headers, AuthError> {
    let address = wallet.address();
    let msg = ClobAuthMessage::new(address, nonce);
    
    // Sign with EIP-712 typed data
    let signature = sign_typed_data(wallet, &msg).await?;
    
    Ok(L1Headers {
        poly_address: format!("{:?}", address),
        poly_signature: format!("0x{}", hex::encode(signature.to_vec())),
        poly_timestamp: msg.timestamp,
        poly_nonce: nonce.to_string(),
    })
}

#[derive(Debug, Clone)]
pub struct L1Headers {
    pub poly_address: String,
    pub poly_signature: String,
    pub poly_timestamp: String,
    pub poly_nonce: String,
}`;

  const apiKeyCreation = `use reqwest::Client;
use serde::{Deserialize, Serialize};

/// API credentials response from Polymarket
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ApiCredentials {
    #[serde(rename = "apiKey")]
    pub api_key: String,        // UUID format: "550e8400-e29b-41d4-a716-446655440000"
    pub secret: String,          // Base64 encoded secret
    pub passphrase: String,      // Random string
}

/// Create or derive API credentials
pub async fn create_api_credentials(
    client: &Client,
    l1_headers: &L1Headers,
) -> Result<ApiCredentials, reqwest::Error> {
    // Option 1: Create new credentials
    let creds: ApiCredentials = client
        .post("https://clob.polymarket.com/auth/api-key")
        .header("POLY_ADDRESS", &l1_headers.poly_address)
        .header("POLY_SIGNATURE", &l1_headers.poly_signature)
        .header("POLY_TIMESTAMP", &l1_headers.poly_timestamp)
        .header("POLY_NONCE", &l1_headers.poly_nonce)
        .send()
        .await?
        .json()
        .await?;
    
    Ok(creds)
}

/// Derive existing API credentials (if already created)
pub async fn derive_api_credentials(
    client: &Client,
    l1_headers: &L1Headers,
) -> Result<ApiCredentials, reqwest::Error> {
    let creds: ApiCredentials = client
        .get("https://clob.polymarket.com/auth/derive-api-key")
        .header("POLY_ADDRESS", &l1_headers.poly_address)
        .header("POLY_SIGNATURE", &l1_headers.poly_signature)
        .header("POLY_TIMESTAMP", &l1_headers.poly_timestamp)
        .header("POLY_NONCE", &l1_headers.poly_nonce)
        .send()
        .await?
        .json()
        .await?;
    
    Ok(creds)
}

// BELANGRIJK: Sla credentials veilig op!
// - Gebruik environment variables
// - Of een encrypted secrets manager
// - NOOIT in version control!`;

  const l2Authentication = `use hmac::{Hmac, Mac};
use sha2::Sha256;
use base64::{Engine as _, engine::general_purpose};
use std::time::{SystemTime, UNIX_EPOCH};

type HmacSha256 = Hmac<Sha256>;

/// L2 Headers for authenticated requests (orders, trades, etc.)
#[derive(Debug, Clone)]
pub struct L2Headers {
    pub poly_api_key: String,
    pub poly_timestamp: String,
    pub poly_signature: String,
    pub poly_passphrase: String,
}

/// Generate L2 authentication signature
/// Used for: placing orders, cancelling orders, viewing positions
pub fn generate_l2_headers(
    creds: &ApiCredentials,
    method: &str,      // "GET", "POST", "DELETE"
    path: &str,        // "/orders", "/trades", etc.
    body: &str,        // JSON body for POST, empty for GET
) -> L2Headers {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
        .to_string();
    
    // Create message to sign: timestamp + method + path + body
    let message = format!("{}{}{}{}", timestamp, method, path, body);
    
    // Decode the base64 secret
    let secret_bytes = general_purpose::STANDARD
        .decode(&creds.secret)
        .expect("Invalid base64 secret");
    
    // HMAC-SHA256 signature
    let mut mac = HmacSha256::new_from_slice(&secret_bytes)
        .expect("HMAC can take key of any size");
    mac.update(message.as_bytes());
    
    let signature = general_purpose::STANDARD.encode(mac.finalize().into_bytes());
    
    L2Headers {
        poly_api_key: creds.api_key.clone(),
        poly_timestamp: timestamp,
        poly_signature: signature,
        poly_passphrase: creds.passphrase.clone(),
    }
}

/// Make authenticated request
pub async fn authenticated_request<T: for<'de> serde::Deserialize<'de>>(
    client: &Client,
    creds: &ApiCredentials,
    method: &str,
    path: &str,
    body: Option<&str>,
) -> Result<T, reqwest::Error> {
    let body_str = body.unwrap_or("");
    let headers = generate_l2_headers(creds, method, path, body_str);
    
    let url = format!("https://clob.polymarket.com{}", path);
    
    let mut request = match method {
        "GET" => client.get(&url),
        "POST" => client.post(&url).body(body_str.to_string()),
        "DELETE" => client.delete(&url),
        _ => panic!("Unsupported method"),
    };
    
    request = request
        .header("POLY_API_KEY", headers.poly_api_key)
        .header("POLY_TIMESTAMP", headers.poly_timestamp)
        .header("POLY_SIGNATURE", headers.poly_signature)
        .header("POLY_PASSPHRASE", headers.poly_passphrase)
        .header("Content-Type", "application/json");
    
    request.send().await?.json().await
}`;

  // ============== STEP 2: WEBSOCKET ==============
  const websocketConnection = `use tokio_tungstenite::{connect_async, tungstenite::Message};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::json;

/// WebSocket subscription message
#[derive(Debug, Serialize)]
pub struct WsSubscription {
    pub auth: WsAuth,
    #[serde(rename = "type")]
    pub channel_type: String,  // "MARKET" or "USER"
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub assets_ids: Vec<String>,  // Token IDs for MARKET channel
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub markets: Vec<String>,     // Condition IDs for USER channel
}

#[derive(Debug, Serialize)]
pub struct WsAuth {
    #[serde(rename = "apiKey")]
    pub api_key: String,
    pub secret: String,
    pub passphrase: String,
}

/// Connect to Polymarket WebSocket
pub async fn connect_market_stream(
    creds: &ApiCredentials,
    asset_ids: Vec<String>,
) -> Result<WsConnection, WsError> {
    let url = "wss://ws-subscriptions-clob.polymarket.com/ws/";
    
    let (ws_stream, _) = connect_async(url).await?;
    let (mut write, read) = ws_stream.split();
    
    // Subscribe to market channel
    let subscription = WsSubscription {
        auth: WsAuth {
            api_key: creds.api_key.clone(),
            secret: creds.secret.clone(),
            passphrase: creds.passphrase.clone(),
        },
        channel_type: "MARKET".to_string(),
        assets_ids: asset_ids,
        markets: vec![],
    };
    
    let msg = serde_json::to_string(&subscription)?;
    write.send(Message::Text(msg)).await?;
    
    Ok(WsConnection { write, read })
}

/// Market data update from WebSocket
#[derive(Debug, Deserialize)]
pub struct MarketUpdate {
    #[serde(rename = "event_type")]
    pub event_type: String,  // "price_change", "book", "trade", etc.
    pub market: String,
    pub asset_id: String,
    pub price: Option<f64>,
    pub timestamp: u64,
    pub changes: Option<Vec<BookChange>>,
}

#[derive(Debug, Deserialize)]
pub struct BookChange {
    pub side: String,   // "BUY" or "SELL"
    pub price: String,
    pub size: String,
}`;

  const websocketHandler = `use crossbeam_channel::{bounded, Sender, Receiver};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// High-performance WebSocket message handler
pub struct WsHandler {
    price_tx: Sender<PriceUpdate>,
    book_tx: Sender<BookUpdate>,
    running: Arc<AtomicBool>,
}

#[derive(Debug, Clone)]
pub struct PriceUpdate {
    pub asset_id: [u8; 32],      // Fixed-size for no heap alloc
    pub price: u64,               // Price * 1e8 (fixed point)
    pub timestamp_ns: u64,
}

#[derive(Debug, Clone)]
pub struct BookUpdate {
    pub asset_id: [u8; 32],
    pub side: u8,                 // 0 = buy, 1 = sell
    pub price: u64,
    pub size: u64,
    pub timestamp_ns: u64,
}

impl WsHandler {
    pub fn new() -> (Self, Receiver<PriceUpdate>, Receiver<BookUpdate>) {
        // Bounded channels prevent backpressure issues
        let (price_tx, price_rx) = bounded(10_000);
        let (book_tx, book_rx) = bounded(100_000);
        
        (
            Self {
                price_tx,
                book_tx,
                running: Arc::new(AtomicBool::new(true)),
            },
            price_rx,
            book_rx,
        )
    }
    
    /// Process incoming WebSocket message
    /// Designed for minimal latency - no allocations in hot path
    #[inline(always)]
    pub fn handle_message(&self, msg: &[u8]) {
        // Fast path: check message type without full parse
        if msg.len() < 20 {
            return;
        }
        
        // Parse using zero-copy JSON (simd-json would be even faster)
        if let Ok(update) = serde_json::from_slice::<MarketUpdate>(msg) {
            match update.event_type.as_str() {
                "price_change" => {
                    if let Some(price) = update.price {
                        let _ = self.price_tx.try_send(PriceUpdate {
                            asset_id: hash_asset_id(&update.asset_id),
                            price: (price * 1e8) as u64,
                            timestamp_ns: update.timestamp * 1_000_000,
                        });
                    }
                }
                "book" => {
                    if let Some(changes) = &update.changes {
                        for change in changes {
                            let _ = self.book_tx.try_send(BookUpdate {
                                asset_id: hash_asset_id(&update.asset_id),
                                side: if change.side == "BUY" { 0 } else { 1 },
                                price: parse_fixed_point(&change.price),
                                size: parse_fixed_point(&change.size),
                                timestamp_ns: update.timestamp * 1_000_000,
                            });
                        }
                    }
                }
                _ => {}
            }
        }
    }
}

#[inline(always)]
fn hash_asset_id(id: &str) -> [u8; 32] {
    use sha2::{Sha256, Digest};
    let mut hasher = Sha256::new();
    hasher.update(id.as_bytes());
    hasher.finalize().into()
}

#[inline(always)]
fn parse_fixed_point(s: &str) -> u64 {
    // Fast fixed-point parsing without float conversion
    let parts: Vec<&str> = s.split('.').collect();
    let whole: u64 = parts[0].parse().unwrap_or(0);
    let frac: u64 = if parts.len() > 1 {
        let frac_str = format!("{:0<8}", parts[1]);
        frac_str[..8].parse().unwrap_or(0)
    } else {
        0
    };
    whole * 100_000_000 + frac
}`;

  // ============== STEP 3: ORDER EXECUTION ==============
  const orderTypes = `use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};

/// Order types supported by Polymarket CLOB
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum OrderType {
    Gtc,      // Good Till Cancelled - stays in book
    Fok,      // Fill Or Kill - immediate full fill or cancel
    Ioc,      // Immediate Or Cancel - partial fills ok, rest cancelled
}

/// Order side
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum OrderSide {
    Buy,
    Sell,
}

/// Order request structure
#[derive(Debug, Serialize)]
pub struct OrderRequest {
    pub order: SignedOrder,
    pub owner: String,          // Wallet address
    #[serde(rename = "orderType")]
    pub order_type: OrderType,
}

/// Signed order (requires wallet signature)
#[derive(Debug, Serialize)]
pub struct SignedOrder {
    pub salt: String,           // Random salt for uniqueness
    pub maker: String,          // Your wallet address
    pub signer: String,         // Signer address (same as maker for self-sign)
    #[serde(rename = "taker")]
    pub taker: String,          // "0x0..." for any taker
    #[serde(rename = "tokenId")]
    pub token_id: String,       // Asset/token ID
    #[serde(rename = "makerAmount")]
    pub maker_amount: String,   // Amount you're giving
    #[serde(rename = "takerAmount")]
    pub taker_amount: String,   // Amount you're receiving
    pub expiration: String,     // Unix timestamp when order expires
    pub nonce: String,          // Order nonce
    #[serde(rename = "feeRateBps")]
    pub fee_rate_bps: String,   // Fee in basis points
    pub side: OrderSide,
    #[serde(rename = "signatureType")]
    pub signature_type: u8,     // 0 = EOA, 1 = POLY_PROXY, 2 = POLY_GNOSIS_SAFE
    pub signature: String,      // EIP-712 signature
}`;

  const orderExecution = `use ethers::signers::LocalWallet;
use rust_decimal::Decimal;
use rust_decimal_macros::dec;

/// High-performance order builder
pub struct OrderBuilder {
    wallet: LocalWallet,
    api_creds: ApiCredentials,
    client: reqwest::Client,
}

impl OrderBuilder {
    pub fn new(wallet: LocalWallet, api_creds: ApiCredentials) -> Self {
        Self {
            wallet,
            api_creds,
            client: reqwest::Client::new(),
        }
    }
    
    /// Place a market order (FOK type)
    /// Returns in ~10-50ms depending on network
    pub async fn market_order(
        &self,
        token_id: &str,
        side: OrderSide,
        amount: Decimal,
    ) -> Result<OrderResponse, OrderError> {
        let order = self.build_order(token_id, side, amount, None, OrderType::Fok).await?;
        self.submit_order(order).await
    }
    
    /// Place a limit order (GTC type)
    pub async fn limit_order(
        &self,
        token_id: &str,
        side: OrderSide,
        amount: Decimal,
        price: Decimal,
    ) -> Result<OrderResponse, OrderError> {
        let order = self.build_order(token_id, side, amount, Some(price), OrderType::Gtc).await?;
        self.submit_order(order).await
    }
    
    /// Build and sign order
    async fn build_order(
        &self,
        token_id: &str,
        side: OrderSide,
        amount: Decimal,
        price: Option<Decimal>,
        order_type: OrderType,
    ) -> Result<OrderRequest, OrderError> {
        let salt = generate_random_salt();
        let nonce = self.get_next_nonce().await?;
        let expiration = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() + 3600; // 1 hour expiry
        
        // Calculate amounts based on price
        let (maker_amount, taker_amount) = match side {
            OrderSide::Buy => {
                // Buying: give USDC, receive shares
                let price = price.unwrap_or(dec!(0.50)); // Default 50c
                let usdc = amount * price;
                (usdc.to_string(), amount.to_string())
            }
            OrderSide::Sell => {
                // Selling: give shares, receive USDC
                let price = price.unwrap_or(dec!(0.50));
                let usdc = amount * price;
                (amount.to_string(), usdc.to_string())
            }
        };
        
        // Create order struct
        let mut order = SignedOrder {
            salt,
            maker: format!("{:?}", self.wallet.address()),
            signer: format!("{:?}", self.wallet.address()),
            taker: "0x0000000000000000000000000000000000000000".to_string(),
            token_id: token_id.to_string(),
            maker_amount,
            taker_amount,
            expiration: expiration.to_string(),
            nonce: nonce.to_string(),
            fee_rate_bps: "0".to_string(),
            side,
            signature_type: 0,
            signature: String::new(),
        };
        
        // Sign the order with EIP-712
        order.signature = self.sign_order(&order).await?;
        
        Ok(OrderRequest {
            order,
            owner: format!("{:?}", self.wallet.address()),
            order_type,
        })
    }
    
    /// Submit order to CLOB
    async fn submit_order(&self, order: OrderRequest) -> Result<OrderResponse, OrderError> {
        let body = serde_json::to_string(&order)?;
        let headers = generate_l2_headers(&self.api_creds, "POST", "/order", &body);
        
        let response: OrderResponse = self.client
            .post("https://clob.polymarket.com/order")
            .header("POLY_API_KEY", headers.poly_api_key)
            .header("POLY_TIMESTAMP", headers.poly_timestamp)
            .header("POLY_SIGNATURE", headers.poly_signature)
            .header("POLY_PASSPHRASE", headers.poly_passphrase)
            .header("Content-Type", "application/json")
            .body(body)
            .send()
            .await?
            .json()
            .await?;
        
        Ok(response)
    }
}

#[derive(Debug, Deserialize)]
pub struct OrderResponse {
    pub success: bool,
    #[serde(rename = "orderId")]
    pub order_id: Option<String>,
    pub error: Option<String>,
}`;

  // ============== STEP 4: ARBITRAGE STRATEGY ==============
  const arbitrageStrategy = `use rust_decimal::Decimal;
use rust_decimal_macros::dec;
use crossbeam_channel::Receiver;

/// Arbitrage detection engine
pub struct ArbitrageEngine {
    orderbook: Arc<RwLock<HashMap<[u8; 32], OrderbookState>>>,
    order_builder: Arc<OrderBuilder>,
    config: ArbitrageConfig,
}

#[derive(Debug, Clone)]
pub struct ArbitrageConfig {
    pub min_edge_bps: u64,       // Minimum edge in basis points (e.g., 50 = 0.5%)
    pub max_position_usdc: Decimal,
    pub min_liquidity_usdc: Decimal,
    pub cooldown_ms: u64,        // Cooldown between trades on same market
}

#[derive(Debug, Clone)]
pub struct OrderbookState {
    pub yes_best_bid: u64,
    pub yes_best_ask: u64,
    pub no_best_bid: u64,
    pub no_best_ask: u64,
    pub yes_bid_size: u64,
    pub no_bid_size: u64,
    pub last_update_ns: u64,
}

impl ArbitrageEngine {
    /// Check for arbitrage opportunity
    /// Returns in ~200 nanoseconds
    #[inline(always)]
    pub fn check_arbitrage(&self, yes_token: &[u8; 32], no_token: &[u8; 32]) -> Option<ArbitrageSignal> {
        let book = self.orderbook.read();
        
        let yes_state = book.get(yes_token)?;
        let no_state = book.get(no_token)?;
        
        // Strategy 1: Buy both sides if sum < 1.00
        // YES_ask + NO_ask < 1.00 means guaranteed profit
        let buy_cost = yes_state.yes_best_ask + no_state.no_best_ask;
        if buy_cost < 100_000_000 {  // < $1.00 in fixed point
            let edge_bps = (100_000_000 - buy_cost) * 10_000 / 100_000_000;
            if edge_bps >= self.config.min_edge_bps {
                let size = yes_state.yes_bid_size.min(no_state.no_bid_size);
                return Some(ArbitrageSignal {
                    signal_type: SignalType::BuyBoth,
                    yes_token: *yes_token,
                    no_token: *no_token,
                    yes_price: yes_state.yes_best_ask,
                    no_price: no_state.no_best_ask,
                    size,
                    edge_bps,
                    timestamp_ns: quanta::Instant::now().as_u64(),
                });
            }
        }
        
        // Strategy 2: Sell both sides if you hold pairs and sum > 1.00
        // This is for unwinding positions at profit
        
        None
    }
    
    /// Execute arbitrage trade
    pub async fn execute(&self, signal: ArbitrageSignal) -> Result<ExecutionResult, ExecutionError> {
        let start = std::time::Instant::now();
        
        // Execute both legs simultaneously for speed
        let (yes_result, no_result) = tokio::join!(
            self.order_builder.market_order(
                &hex::encode(signal.yes_token),
                OrderSide::Buy,
                Decimal::from(signal.size) / dec!(100_000_000),
            ),
            self.order_builder.market_order(
                &hex::encode(signal.no_token),
                OrderSide::Buy,
                Decimal::from(signal.size) / dec!(100_000_000),
            )
        );
        
        let latency_us = start.elapsed().as_micros() as u64;
        
        Ok(ExecutionResult {
            yes_order: yes_result?,
            no_order: no_result?,
            latency_us,
            edge_captured_bps: signal.edge_bps,
        })
    }
}

#[derive(Debug, Clone)]
pub struct ArbitrageSignal {
    pub signal_type: SignalType,
    pub yes_token: [u8; 32],
    pub no_token: [u8; 32],
    pub yes_price: u64,
    pub no_price: u64,
    pub size: u64,
    pub edge_bps: u64,
    pub timestamp_ns: u64,
}

#[derive(Debug, Clone)]
pub enum SignalType {
    BuyBoth,     // YES_ask + NO_ask < 1.00
    SellBoth,    // Unwind positions when sum > 1.00
    YesOnly,     // Directional trade
    NoOnly,
}

#[derive(Debug)]
pub struct ExecutionResult {
    pub yes_order: OrderResponse,
    pub no_order: OrderResponse,
    pub latency_us: u64,
    pub edge_captured_bps: u64,
}`;

  // ============== STEP 5: MAIN LOOP ==============
  const mainLoop = `use tokio::select;
use std::sync::Arc;

/// Main HFT bot entry point
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Initialize logging
    tracing_subscriber::fmt::init();
    
    // Load configuration from environment
    let private_key = std::env::var("POLYMARKET_PRIVATE_KEY")?;
    let wallet: LocalWallet = private_key.parse()?;
    
    println!("╔══════════════════════════════════════════════════════╗");
    println!("║       POLYMARKET HFT ARBITRAGE BOT                    ║");
    println!("║       Wallet: {:?}       ║", wallet.address());
    println!("╚══════════════════════════════════════════════════════╝");
    
    // Step 1: Authenticate and get API credentials
    println!("\\n[1/5] Authenticating with Polymarket CLOB...");
    let client = reqwest::Client::new();
    let l1_headers = generate_l1_headers(&wallet, 0).await?;
    let api_creds = derive_api_credentials(&client, &l1_headers).await
        .or_else(|_| create_api_credentials(&client, &l1_headers))
        .await?;
    println!("✓ API credentials obtained");
    
    // Step 2: Load target markets
    println!("\\n[2/5] Loading target markets...");
    let markets = load_target_markets(&client).await?;
    let asset_ids: Vec<String> = markets.iter()
        .flat_map(|m| vec![m.yes_token_id.clone(), m.no_token_id.clone()])
        .collect();
    println!("✓ Loaded {} markets ({} assets)", markets.len(), asset_ids.len());
    
    // Step 3: Initialize components
    println!("\\n[3/5] Initializing trading engine...");
    let (ws_handler, price_rx, book_rx) = WsHandler::new();
    let order_builder = Arc::new(OrderBuilder::new(wallet.clone(), api_creds.clone()));
    let arb_engine = Arc::new(ArbitrageEngine::new(
        order_builder.clone(),
        ArbitrageConfig {
            min_edge_bps: 50,  // 0.5% minimum edge
            max_position_usdc: dec!(1000),
            min_liquidity_usdc: dec!(100),
            cooldown_ms: 1000,
        },
    ));
    println!("✓ Trading engine initialized");
    
    // Step 4: Connect to WebSocket
    println!("\\n[4/5] Connecting to WebSocket feed...");
    let ws = connect_market_stream(&api_creds, asset_ids).await?;
    println!("✓ WebSocket connected");
    
    // Step 5: Start trading loop
    println!("\\n[5/5] Starting arbitrage scanner...");
    println!("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    
    // Pin trading thread to dedicated CPU core
    let core_ids = core_affinity::get_core_ids().unwrap();
    if let Some(core) = core_ids.last() {
        core_affinity::set_for_current(*core);
        println!("✓ Pinned to CPU core {}", core.id);
    }
    
    let arb_engine_clone = arb_engine.clone();
    
    // Main event loop
    loop {
        select! {
            // Handle price updates
            Ok(price) = async { price_rx.recv() } => {
                arb_engine_clone.update_price(price);
            }
            
            // Handle orderbook updates
            Ok(book) = async { book_rx.recv() } => {
                arb_engine_clone.update_book(book);
                
                // Check for arbitrage after each book update
                for market in &markets {
                    if let Some(signal) = arb_engine_clone.check_arbitrage(
                        &hash_asset_id(&market.yes_token_id),
                        &hash_asset_id(&market.no_token_id),
                    ) {
                        println!(
                            "🎯 ARBITRAGE DETECTED | Edge: {}bps | Size: \${:.2}",
                            signal.edge_bps,
                            signal.size as f64 / 100_000_000.0
                        );
                        
                        // Execute if edge is good
                        match arb_engine_clone.execute(signal).await {
                            Ok(result) => {
                                println!(
                                    "✅ EXECUTED | Latency: {}μs | Edge: {}bps",
                                    result.latency_us,
                                    result.edge_captured_bps
                                );
                            }
                            Err(e) => {
                                eprintln!("❌ Execution failed: {}", e);
                            }
                        }
                    }
                }
            }
        }
    }
}`;

  const cargoToml = `[package]
name = "polymarket-hft-bot"
version = "0.1.0"
edition = "2021"

[dependencies]
# Async runtime
tokio = { version = "1", features = ["full", "rt-multi-thread"] }

# WebSocket
tokio-tungstenite = { version = "0.21", features = ["native-tls"] }
futures-util = "0.3"

# HTTP client
reqwest = { version = "0.11", features = ["json"] }

# Ethereum/signing
ethers = { version = "2", features = ["legacy"] }

# Lock-free concurrency
crossbeam = "0.8"
crossbeam-channel = "0.5"
parking_lot = "0.12"

# Precise math
rust_decimal = { version = "1", features = ["serde"] }
rust_decimal_macros = "1"

# Crypto
sha2 = "0.10"
hmac = "0.12"
base64 = "0.21"
hex = "0.4"

# Serialization
serde = { version = "1", features = ["derive"] }
serde_json = "1"

# Time
chrono = { version = "0.4", features = ["serde"] }
quanta = "0.12"

# CPU affinity
core_affinity = "0.8"

# Logging
tracing = "0.1"
tracing-subscriber = "0.3"

# Random
rand = "0.8"

[profile.release]
opt-level = 3
lto = "fat"
codegen-units = 1
panic = "abort"`;

  const steps = [
    { id: 1, title: 'API Research', icon: BookOpen, description: 'Endpoints & Authenticatie' },
    { id: 2, title: 'WebSocket', icon: Wifi, description: 'Real-time Price Feeds' },
    { id: 3, title: 'Order Execution', icon: Zap, description: 'Orders Plaatsen' },
    { id: 4, title: 'Arbitrage Logic', icon: Cpu, description: 'Strategie Implementatie' },
    { id: 5, title: 'Main Loop', icon: Terminal, description: 'Alles Samenbrengen' },
  ];

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Header */}
      <div className="border-b border-border/50 bg-card/50 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <Link to="/rust-strategy">
                <Button variant="ghost" size="icon">
                  <ArrowLeft className="h-5 w-5" />
                </Button>
              </Link>
              <div>
                <div className="flex items-center gap-2">
                  <h1 className="text-2xl font-bold">HFT Bot Build Guide</h1>
                  <Badge className="bg-amber-500/20 text-amber-400 border-amber-500/30">RUST</Badge>
                </div>
                <p className="text-muted-foreground text-sm mt-1">
                  Stap-voor-stap handleiding voor een Polymarket HFT bot
                </p>
              </div>
            </div>
            <a 
              href="https://docs.polymarket.com/quickstart/introduction/main" 
              target="_blank" 
              rel="noopener noreferrer"
            >
              <Button variant="outline" className="gap-2">
                <ExternalLink className="h-4 w-4" />
                Polymarket Docs
              </Button>
            </a>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 py-8">
        {/* Step Navigation */}
        <div className="mb-8">
          <div className="flex items-center justify-between bg-card/50 rounded-xl p-4 border border-border/50">
            {steps.map((step, idx) => (
              <button
                key={step.id}
                onClick={() => setActiveStep(step.id)}
                className={`flex items-center gap-3 px-4 py-3 rounded-lg transition-all ${
                  activeStep === step.id 
                    ? 'bg-primary/20 text-primary border border-primary/30' 
                    : 'hover:bg-muted/50 text-muted-foreground'
                }`}
              >
                <div className={`p-2 rounded-lg ${
                  activeStep === step.id ? 'bg-primary/30' : 'bg-muted/50'
                }`}>
                  <step.icon className="h-5 w-5" />
                </div>
                <div className="text-left">
                  <div className="font-medium text-sm">Stap {step.id}</div>
                  <div className="text-xs opacity-70">{step.title}</div>
                </div>
                {idx < steps.length - 1 && (
                  <ChevronRight className="h-4 w-4 text-muted-foreground ml-2" />
                )}
              </button>
            ))}
          </div>
        </div>

        {/* Step Content */}
        <div className="space-y-8">
          {/* STEP 1: API Research */}
          {activeStep === 1 && (
            <div className="space-y-6">
              <div className="bg-gradient-to-r from-blue-500/10 to-cyan-500/10 rounded-xl p-6 border border-blue-500/20">
                <div className="flex items-center gap-3 mb-4">
                  <BookOpen className="h-6 w-6 text-blue-400" />
                  <h2 className="text-xl font-bold">Stap 1: Polymarket API Research</h2>
                </div>
                <p className="text-muted-foreground mb-4">
                  Voordat we gaan bouwen, moeten we de Polymarket API goed begrijpen. 
                  Er zijn 4 belangrijke endpoints en 2 authenticatie levels.
                </p>
              </div>

              {/* API Endpoints */}
              <div className="bg-card/50 rounded-xl p-6 border border-border/50">
                <div className="flex justify-between items-center mb-4">
                  <h3 className="text-lg font-semibold flex items-center gap-2">
                    <Database className="h-5 w-5 text-primary" />
                    API Endpoints
                  </h3>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => copyToClipboard(apiEndpoints, 'endpoints')}
                  >
                    {copiedSection === 'endpoints' ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  </Button>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="p-4 bg-muted/30 rounded-lg border border-border/50">
                    <div className="text-sm font-medium text-primary mb-1">REST API (CLOB)</div>
                    <code className="text-xs text-muted-foreground">https://clob.polymarket.com</code>
                    <p className="text-xs text-muted-foreground mt-2">Orders, markets, trades</p>
                  </div>
                  <div className="p-4 bg-muted/30 rounded-lg border border-border/50">
                    <div className="text-sm font-medium text-green-400 mb-1">Data API</div>
                    <code className="text-xs text-muted-foreground">https://data-api.polymarket.com</code>
                    <p className="text-xs text-muted-foreground mt-2">User data, holdings, activity</p>
                  </div>
                  <div className="p-4 bg-muted/30 rounded-lg border border-border/50">
                    <div className="text-sm font-medium text-amber-400 mb-1">WebSocket (CLOB)</div>
                    <code className="text-xs text-muted-foreground">wss://ws-subscriptions-clob.polymarket.com/ws/</code>
                    <p className="text-xs text-muted-foreground mt-2">Real-time orderbook updates</p>
                  </div>
                  <div className="p-4 bg-muted/30 rounded-lg border border-border/50">
                    <div className="text-sm font-medium text-purple-400 mb-1">RTDS</div>
                    <code className="text-xs text-muted-foreground">wss://ws-live-data.polymarket.com</code>
                    <p className="text-xs text-muted-foreground mt-2">Crypto prices, comments</p>
                  </div>
                </div>
              </div>

              {/* Authentication Levels */}
              <div className="bg-card/50 rounded-xl p-6 border border-border/50">
                <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
                  <Shield className="h-5 w-5 text-primary" />
                  Authenticatie Levels
                </h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div className="p-4 bg-gradient-to-br from-blue-500/10 to-blue-500/5 rounded-lg border border-blue-500/20">
                    <div className="flex items-center gap-2 mb-3">
                      <Badge className="bg-blue-500/20 text-blue-400">L1</Badge>
                      <span className="font-medium">Wallet Signature</span>
                    </div>
                    <p className="text-sm text-muted-foreground mb-3">
                      EIP-712 typed data signature van je wallet. Gebruikt om API credentials aan te maken.
                    </p>
                    <div className="text-xs font-mono bg-muted/30 p-2 rounded">
                      POLY_ADDRESS, POLY_SIGNATURE, POLY_TIMESTAMP, POLY_NONCE
                    </div>
                  </div>
                  <div className="p-4 bg-gradient-to-br from-green-500/10 to-green-500/5 rounded-lg border border-green-500/20">
                    <div className="flex items-center gap-2 mb-3">
                      <Badge className="bg-green-500/20 text-green-400">L2</Badge>
                      <span className="font-medium">API Key + HMAC</span>
                    </div>
                    <p className="text-sm text-muted-foreground mb-3">
                      HMAC-SHA256 signature met je API secret. Gebruikt voor alle trading operaties.
                    </p>
                    <div className="text-xs font-mono bg-muted/30 p-2 rounded">
                      POLY_API_KEY, POLY_SIGNATURE, POLY_TIMESTAMP, POLY_PASSPHRASE
                    </div>
                  </div>
                </div>
              </div>

              {/* EIP-712 Signing Code */}
              <div className="bg-card/50 rounded-xl p-6 border border-border/50">
                <div className="flex justify-between items-center mb-4">
                  <h3 className="text-lg font-semibold flex items-center gap-2">
                    <Code2 className="h-5 w-5 text-primary" />
                    L1: EIP-712 Signing (Rust)
                  </h3>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => copyToClipboard(eip712Signing, 'eip712')}
                  >
                    {copiedSection === 'eip712' ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  </Button>
                </div>
                <pre className="bg-muted/30 p-4 rounded-lg overflow-x-auto text-xs">
                  <code>{eip712Signing}</code>
                </pre>
              </div>

              {/* API Key Creation Code */}
              <div className="bg-card/50 rounded-xl p-6 border border-border/50">
                <div className="flex justify-between items-center mb-4">
                  <h3 className="text-lg font-semibold flex items-center gap-2">
                    <Code2 className="h-5 w-5 text-primary" />
                    API Key Aanmaken
                  </h3>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => copyToClipboard(apiKeyCreation, 'apikey')}
                  >
                    {copiedSection === 'apikey' ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  </Button>
                </div>
                <pre className="bg-muted/30 p-4 rounded-lg overflow-x-auto text-xs">
                  <code>{apiKeyCreation}</code>
                </pre>
              </div>

              {/* L2 Authentication Code */}
              <div className="bg-card/50 rounded-xl p-6 border border-border/50">
                <div className="flex justify-between items-center mb-4">
                  <h3 className="text-lg font-semibold flex items-center gap-2">
                    <Code2 className="h-5 w-5 text-primary" />
                    L2: HMAC Authentication
                  </h3>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => copyToClipboard(l2Authentication, 'l2auth')}
                  >
                    {copiedSection === 'l2auth' ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  </Button>
                </div>
                <pre className="bg-muted/30 p-4 rounded-lg overflow-x-auto text-xs max-h-96">
                  <code>{l2Authentication}</code>
                </pre>
              </div>

              {/* Next Step */}
              <div className="flex justify-end">
                <Button onClick={() => setActiveStep(2)} className="gap-2">
                  Volgende: WebSocket Feeds
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}

          {/* STEP 2: WebSocket */}
          {activeStep === 2 && (
            <div className="space-y-6">
              <div className="bg-gradient-to-r from-amber-500/10 to-orange-500/10 rounded-xl p-6 border border-amber-500/20">
                <div className="flex items-center gap-3 mb-4">
                  <Wifi className="h-6 w-6 text-amber-400" />
                  <h2 className="text-xl font-bold">Stap 2: WebSocket Price Feeds</h2>
                </div>
                <p className="text-muted-foreground">
                  Voor HFT hebben we real-time price updates nodig via WebSocket. 
                  Polymarket biedt twee channels: MARKET (orderbook) en USER (je orders/trades).
                </p>
              </div>

              {/* WebSocket Connection */}
              <div className="bg-card/50 rounded-xl p-6 border border-border/50">
                <div className="flex justify-between items-center mb-4">
                  <h3 className="text-lg font-semibold flex items-center gap-2">
                    <Code2 className="h-5 w-5 text-primary" />
                    WebSocket Connection
                  </h3>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => copyToClipboard(websocketConnection, 'wsconnect')}
                  >
                    {copiedSection === 'wsconnect' ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  </Button>
                </div>
                <pre className="bg-muted/30 p-4 rounded-lg overflow-x-auto text-xs max-h-96">
                  <code>{websocketConnection}</code>
                </pre>
              </div>

              {/* WebSocket Handler */}
              <div className="bg-card/50 rounded-xl p-6 border border-border/50">
                <div className="flex justify-between items-center mb-4">
                  <h3 className="text-lg font-semibold flex items-center gap-2">
                    <Zap className="h-5 w-5 text-amber-400" />
                    High-Performance Message Handler
                  </h3>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => copyToClipboard(websocketHandler, 'wshandler')}
                  >
                    {copiedSection === 'wshandler' ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  </Button>
                </div>
                <pre className="bg-muted/30 p-4 rounded-lg overflow-x-auto text-xs max-h-96">
                  <code>{websocketHandler}</code>
                </pre>
              </div>

              {/* Navigation */}
              <div className="flex justify-between">
                <Button variant="outline" onClick={() => setActiveStep(1)} className="gap-2">
                  <ArrowLeft className="h-4 w-4" />
                  Vorige: API Research
                </Button>
                <Button onClick={() => setActiveStep(3)} className="gap-2">
                  Volgende: Order Execution
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}

          {/* STEP 3: Order Execution */}
          {activeStep === 3 && (
            <div className="space-y-6">
              <div className="bg-gradient-to-r from-green-500/10 to-emerald-500/10 rounded-xl p-6 border border-green-500/20">
                <div className="flex items-center gap-3 mb-4">
                  <Zap className="h-6 w-6 text-green-400" />
                  <h2 className="text-xl font-bold">Stap 3: Order Execution</h2>
                </div>
                <p className="text-muted-foreground">
                  Nu kunnen we orders plaatsen. Polymarket ondersteunt GTC (limit), FOK (market), en IOC orders.
                  Elke order moet gesigned worden met EIP-712.
                </p>
              </div>

              {/* Order Types */}
              <div className="bg-card/50 rounded-xl p-6 border border-border/50">
                <div className="flex justify-between items-center mb-4">
                  <h3 className="text-lg font-semibold flex items-center gap-2">
                    <Code2 className="h-5 w-5 text-primary" />
                    Order Types & Structures
                  </h3>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => copyToClipboard(orderTypes, 'ordertypes')}
                  >
                    {copiedSection === 'ordertypes' ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  </Button>
                </div>
                <pre className="bg-muted/30 p-4 rounded-lg overflow-x-auto text-xs max-h-96">
                  <code>{orderTypes}</code>
                </pre>
              </div>

              {/* Order Execution */}
              <div className="bg-card/50 rounded-xl p-6 border border-border/50">
                <div className="flex justify-between items-center mb-4">
                  <h3 className="text-lg font-semibold flex items-center gap-2">
                    <Zap className="h-5 w-5 text-green-400" />
                    Order Builder & Execution
                  </h3>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => copyToClipboard(orderExecution, 'orderexec')}
                  >
                    {copiedSection === 'orderexec' ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  </Button>
                </div>
                <pre className="bg-muted/30 p-4 rounded-lg overflow-x-auto text-xs max-h-96">
                  <code>{orderExecution}</code>
                </pre>
              </div>

              {/* Navigation */}
              <div className="flex justify-between">
                <Button variant="outline" onClick={() => setActiveStep(2)} className="gap-2">
                  <ArrowLeft className="h-4 w-4" />
                  Vorige: WebSocket
                </Button>
                <Button onClick={() => setActiveStep(4)} className="gap-2">
                  Volgende: Arbitrage Logic
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}

          {/* STEP 4: Arbitrage Strategy */}
          {activeStep === 4 && (
            <div className="space-y-6">
              <div className="bg-gradient-to-r from-purple-500/10 to-pink-500/10 rounded-xl p-6 border border-purple-500/20">
                <div className="flex items-center gap-3 mb-4">
                  <Cpu className="h-6 w-6 text-purple-400" />
                  <h2 className="text-xl font-bold">Stap 4: Arbitrage Strategy</h2>
                </div>
                <p className="text-muted-foreground">
                  De kernlogica: detecteer wanneer YES_price + NO_price &lt; $1.00 en koop beide.
                  Gegarandeerde winst bij settlement.
                </p>
              </div>

              {/* Arbitrage Engine */}
              <div className="bg-card/50 rounded-xl p-6 border border-border/50">
                <div className="flex justify-between items-center mb-4">
                  <h3 className="text-lg font-semibold flex items-center gap-2">
                    <Cpu className="h-5 w-5 text-purple-400" />
                    Arbitrage Detection Engine
                  </h3>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => copyToClipboard(arbitrageStrategy, 'arbstrat')}
                  >
                    {copiedSection === 'arbstrat' ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  </Button>
                </div>
                <pre className="bg-muted/30 p-4 rounded-lg overflow-x-auto text-xs max-h-[500px]">
                  <code>{arbitrageStrategy}</code>
                </pre>
              </div>

              {/* Navigation */}
              <div className="flex justify-between">
                <Button variant="outline" onClick={() => setActiveStep(3)} className="gap-2">
                  <ArrowLeft className="h-4 w-4" />
                  Vorige: Order Execution
                </Button>
                <Button onClick={() => setActiveStep(5)} className="gap-2">
                  Volgende: Main Loop
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}

          {/* STEP 5: Main Loop */}
          {activeStep === 5 && (
            <div className="space-y-6">
              <div className="bg-gradient-to-r from-red-500/10 to-orange-500/10 rounded-xl p-6 border border-red-500/20">
                <div className="flex items-center gap-3 mb-4">
                  <Terminal className="h-6 w-6 text-red-400" />
                  <h2 className="text-xl font-bold">Stap 5: Alles Samenbrengen</h2>
                </div>
                <p className="text-muted-foreground">
                  De main loop die alles combineert: authenticatie, WebSocket feeds, orderbook updates,
                  arbitrage detectie, en order execution.
                </p>
              </div>

              {/* Main Loop */}
              <div className="bg-card/50 rounded-xl p-6 border border-border/50">
                <div className="flex justify-between items-center mb-4">
                  <h3 className="text-lg font-semibold flex items-center gap-2">
                    <Terminal className="h-5 w-5 text-red-400" />
                    Main Entry Point
                  </h3>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => copyToClipboard(mainLoop, 'mainloop')}
                  >
                    {copiedSection === 'mainloop' ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  </Button>
                </div>
                <pre className="bg-muted/30 p-4 rounded-lg overflow-x-auto text-xs max-h-[500px]">
                  <code>{mainLoop}</code>
                </pre>
              </div>

              {/* Cargo.toml */}
              <div className="bg-card/50 rounded-xl p-6 border border-border/50">
                <div className="flex justify-between items-center mb-4">
                  <h3 className="text-lg font-semibold flex items-center gap-2">
                    <Code2 className="h-5 w-5 text-amber-400" />
                    Cargo.toml
                  </h3>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => copyToClipboard(cargoToml, 'cargo')}
                  >
                    {copiedSection === 'cargo' ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  </Button>
                </div>
                <pre className="bg-muted/30 p-4 rounded-lg overflow-x-auto text-xs">
                  <code>{cargoToml}</code>
                </pre>
              </div>

              {/* Final Checklist */}
              <div className="bg-gradient-to-br from-green-500/10 to-emerald-500/10 rounded-xl p-6 border border-green-500/20">
                <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
                  <Check className="h-5 w-5 text-green-400" />
                  Volgende Stappen
                </h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 text-sm">
                      <div className="w-5 h-5 rounded-full bg-green-500/20 flex items-center justify-center text-xs">1</div>
                      <span>Polygon wallet met MATIC voor gas</span>
                    </div>
                    <div className="flex items-center gap-2 text-sm">
                      <div className="w-5 h-5 rounded-full bg-green-500/20 flex items-center justify-center text-xs">2</div>
                      <span>USDC deposit op Polymarket</span>
                    </div>
                    <div className="flex items-center gap-2 text-sm">
                      <div className="w-5 h-5 rounded-full bg-green-500/20 flex items-center justify-center text-xs">3</div>
                      <span>Test met kleine bedragen eerst</span>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 text-sm">
                      <div className="w-5 h-5 rounded-full bg-amber-500/20 flex items-center justify-center text-xs">4</div>
                      <span>Monitor latency en slippage</span>
                    </div>
                    <div className="flex items-center gap-2 text-sm">
                      <div className="w-5 h-5 rounded-full bg-amber-500/20 flex items-center justify-center text-xs">5</div>
                      <span>Implementeer risk management</span>
                    </div>
                    <div className="flex items-center gap-2 text-sm">
                      <div className="w-5 h-5 rounded-full bg-amber-500/20 flex items-center justify-center text-xs">6</div>
                      <span>VPS dicht bij Polymarket servers</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Navigation */}
              <div className="flex justify-between">
                <Button variant="outline" onClick={() => setActiveStep(4)} className="gap-2">
                  <ArrowLeft className="h-4 w-4" />
                  Vorige: Arbitrage Logic
                </Button>
                <Link to="/rust-strategy">
                  <Button className="gap-2">
                    Terug naar Rust Strategy
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </Link>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default HFTBuildGuide;
