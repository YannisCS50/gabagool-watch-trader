/**
 * benchmark-gabagool.ts
 * --------------------------------------------------------------------------
 * READ-ONLY benchmark logging for gabagool22's public trades on Polymarket.
 * 
 * Purpose: Track a successful trader's executions as a benchmark reference.
 * 
 * NO EFFECT on bot strategy or execution - pure observation.
 * 
 * Markets: BTC & ETH 15-min Up/Down only
 * User: gabagool22 (wallet: 0x...)
 */

import fs from 'fs';
import path from 'path';

// gabagool22's known wallet address on Polymarket
const GABAGOOL_ADDRESS = '0x6031b6eed1c97e853c6e0f03ad3ce3529351f96d';

const BENCHMARK_LOGS_DIR = path.join(process.cwd(), 'logs');
const POLL_INTERVAL_MS = 10000; // Poll every 10 seconds

// Ensure logs directory exists
if (!fs.existsSync(BENCHMARK_LOGS_DIR)) {
  fs.mkdirSync(BENCHMARK_LOGS_DIR, { recursive: true });
}

// Track seen trade IDs to avoid duplicates
const seenTradeIds = new Set<string>();
let lastPollTime = 0;

// ---------- Types ----------

export interface GabagoolTrade {
  ts: number;                    // epoch ms
  iso: string;                   // ISO timestamp
  marketId: string;              // Market slug/condition ID
  asset: 'BTC' | 'ETH';
  timeframe: '15m';
  user: 'gabagool22';
  side: 'UP' | 'DOWN';
  price: number;
  shares: number;
  notional: number;
  // Enriched from our nearest snapshot
  secondsRemaining: number | null;
  spotPrice: number | null;
  strikePrice: number | null;
  delta: number | null;
  upBestAsk: number | null;
  downBestAsk: number | null;
  cheapestAskPlusOtherMid: number | null;
}

interface SnapshotContext {
  secondsRemaining: number;
  spotPrice: number | null;
  strikePrice: number | null;
  delta: number | null;
  upBestAsk: number | null;
  downBestAsk: number | null;
  cheapestAskPlusOtherMid: number | null;
}

// In-memory snapshot cache for enrichment (keyed by marketId)
const latestSnapshots = new Map<string, { ts: number; ctx: SnapshotContext }>();

// ---------- Logging ----------

function getDateString(): string {
  return new Date().toISOString().slice(0, 10);
}

function appendBenchmarkLog(trade: GabagoolTrade): void {
  const dateStr = getDateString();
  const filePath = path.join(BENCHMARK_LOGS_DIR, `benchmark_trades_gabagool22_${dateStr}.jsonl`);
  const line = JSON.stringify(trade) + '\n';
  
  fs.appendFile(filePath, line, (err) => {
    if (err) {
      console.error(`❌ Benchmark log error:`, err.message);
    }
  });
}

// ---------- API Polling ----------

interface PolymarketTradeResponse {
  proxyWallet: string;
  timestamp: number;
  conditionId: string;
  type: string;
  size: number;
  usdcSize: number;
  transactionHash: string;
  price: number;
  asset: string;
  side: string;  // 'BUY' | 'SELL'
  outcomeIndex: number;
  title: string;
  slug: string;
  eventSlug: string;
  outcome: string;
}

/**
 * Fetch recent trades for gabagool22 from Polymarket API
 */
async function fetchGabagoolTrades(): Promise<PolymarketTradeResponse[]> {
  try {
    // Polymarket activity endpoint for user trades
    const url = `https://gamma-api.polymarket.com/activity?user=${GABAGOOL_ADDRESS}&limit=50&type=TRADE`;
    
    const response = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'PolymarketBot/1.0'
      }
    });
    
    if (!response.ok) {
      console.error(`⚠️ Gabagool API error: ${response.status}`);
      return [];
    }
    
    const data = await response.json();
    return Array.isArray(data) ? data : [];
  } catch (error) {
    console.error('⚠️ Gabagool fetch error:', error);
    return [];
  }
}

/**
 * Determine if trade is for 15m BTC/ETH market based on slug/title
 */
function is15mCryptoTrade(trade: PolymarketTradeResponse): { valid: boolean; asset: 'BTC' | 'ETH' | null } {
  const slug = (trade.slug || trade.eventSlug || trade.title || '').toLowerCase();
  
  // Check for 15-minute crypto markets
  const isBTC = slug.includes('btc') || slug.includes('bitcoin');
  const isETH = slug.includes('eth') || slug.includes('ethereum');
  const is15m = slug.includes('15') && (slug.includes('min') || slug.includes('minute'));
  
  if (is15m && isBTC) return { valid: true, asset: 'BTC' };
  if (is15m && isETH) return { valid: true, asset: 'ETH' };
  
  return { valid: false, asset: null };
}

/**
 * Parse outcome to UP/DOWN
 */
function parseOutcome(outcome: string): 'UP' | 'DOWN' | null {
  const upper = outcome.toUpperCase();
  if (upper.includes('UP') || upper === 'YES' || upper === 'HIGHER') return 'UP';
  if (upper.includes('DOWN') || upper === 'NO' || upper === 'LOWER') return 'DOWN';
  return null;
}

/**
 * Update snapshot context for a market (called from main runner)
 */
export function updateBenchmarkSnapshot(
  marketId: string,
  ctx: SnapshotContext
): void {
  latestSnapshots.set(marketId, { ts: Date.now(), ctx });
}

/**
 * Get nearest snapshot for enrichment
 */
function getNearestSnapshot(marketId: string, tradeTs: number): SnapshotContext | null {
  const snap = latestSnapshots.get(marketId);
  if (!snap) return null;
  
  // Only use if snapshot is within 30 seconds of trade
  const age = Math.abs(tradeTs - snap.ts);
  if (age > 30000) return null;
  
  return snap.ctx;
}

/**
 * Process and log new trades
 */
async function processTrades(): Promise<void> {
  const trades = await fetchGabagoolTrades();
  let newCount = 0;
  
  for (const trade of trades) {
    // Use transactionHash as unique ID (API doesn't provide an 'id' field)
    const tradeId = trade.transactionHash || `${trade.timestamp}-${trade.conditionId}-${trade.size}`;
    
    // Skip if already seen
    if (seenTradeIds.has(tradeId)) continue;
    seenTradeIds.add(tradeId);
    
    // Only TRADE type (already filtered in API call, but double-check)
    if (trade.type !== 'TRADE') continue;
    
    // Filter to 15m BTC/ETH only
    const { valid, asset } = is15mCryptoTrade(trade);
    if (!valid || !asset) continue;
    
    // Parse outcome
    const side = parseOutcome(trade.outcome);
    if (!side) continue;
    
    // Parse trade data (timestamp is already a number from API)
    const tradeTs = typeof trade.timestamp === 'number' 
      ? trade.timestamp * 1000  // Convert seconds to ms
      : Date.now();
    const price = trade.price;
    const shares = trade.size;
    const notional = trade.usdcSize || (price * shares);
    
    // Get market slug for snapshot lookup
    const marketSlug = trade.slug || trade.eventSlug || trade.conditionId;
    
    // Get enrichment from nearest snapshot
    const snap = getNearestSnapshot(marketSlug, tradeTs);
    
    const benchmarkTrade: GabagoolTrade = {
      ts: tradeTs,
      iso: new Date(tradeTs).toISOString(),
      marketId: marketSlug,
      asset,
      timeframe: '15m',
      user: 'gabagool22',
      side,
      price,
      shares,
      notional,
      secondsRemaining: snap?.secondsRemaining ?? null,
      spotPrice: snap?.spotPrice ?? null,
      strikePrice: snap?.strikePrice ?? null,
      delta: snap?.delta ?? null,
      upBestAsk: snap?.upBestAsk ?? null,
      downBestAsk: snap?.downBestAsk ?? null,
      cheapestAskPlusOtherMid: snap?.cheapestAskPlusOtherMid ?? null,
    };
    
    appendBenchmarkLog(benchmarkTrade);
    newCount++;
    
    console.log(`📊 GABAGOOL: ${asset} ${side} ${shares.toFixed(1)}@${(price * 100).toFixed(1)}¢ = $${notional.toFixed(2)}`);
  }
  
  if (newCount > 0) {
    console.log(`📊 Logged ${newCount} new gabagool22 trades`);
  }
}

// ---------- Polling Loop ----------

let pollInterval: NodeJS.Timeout | null = null;

/**
 * Start the benchmark polling loop
 * READ-ONLY: No effect on strategy
 */
export function startBenchmarkPolling(): void {
  console.log('📊 Starting gabagool22 benchmark tracking (read-only)');
  
  // Initial poll
  processTrades();
  
  // Start interval
  pollInterval = setInterval(() => {
    processTrades();
  }, POLL_INTERVAL_MS);
}

/**
 * Stop the benchmark polling loop
 */
export function stopBenchmarkPolling(): void {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
    console.log('📊 Stopped gabagool22 benchmark tracking');
  }
}

/**
 * Get count of logged trades (for stats)
 */
export function getBenchmarkTradeCount(): number {
  return seenTradeIds.size;
}
