/**
 * positions-sync.ts
 * --------------------------------------------------------------------------
 * Syncs real positions and fills from Polymarket APIs to our database.
 * This ensures our P/L calculations match actual on-chain/API state.
 * 
 * APIs used:
 * - Data API: https://data-api.polymarket.com/positions?user={wallet}
 * - CLOB API: https://clob.polymarket.com/orders (for order status)
 */

import { config } from './config.js';
import { createClient } from '@supabase/supabase-js';

const DATA_API_URL = 'https://data-api.polymarket.com';
const CLOB_URL = 'https://clob.polymarket.com';

// Initialize Supabase client for database writes (lazy - only when needed)
let supabaseClient: ReturnType<typeof createClient> | null = null;

function getSupabaseClient() {
  if (!supabaseClient) {
    const supabaseUrl = process.env.SUPABASE_URL || '';
    const supabaseKey = process.env.SUPABASE_SERVICE_KEY || '';
    
    if (!supabaseUrl || !supabaseKey) {
      console.warn('⚠️ SUPABASE_URL or SUPABASE_SERVICE_KEY not configured - position sync to DB disabled');
      return null;
    }
    
    supabaseClient = createClient(supabaseUrl, supabaseKey);
  }
  return supabaseClient;
}

// ============================================================
// TYPES
// ============================================================

export interface PolymarketPosition {
  asset: string;             // Token contract address
  conditionId: string;       // Market condition ID
  market: string;            // Human-readable market name
  outcomeIndex: number;      // 0 = first outcome, 1 = second
  outcome: string;           // "Yes"/"No" or "Up"/"Down"
  size: number;              // Number of shares held
  avgPrice: number;          // Average entry price
  initialValue: number;      // Cost basis
  currentValue: number;      // Current market value
  cashPnl: number;           // Realized P/L
  percentPnl: number;        // Percent change
  totalBought: number;       // Total shares bought
  totalSold: number;         // Total shares sold
  redeemable: boolean;       // Can be claimed (market resolved)
  mergeable: boolean;        // Can be merged
  proxyWallet: string;       // Wallet address
  curPrice: number;          // Current market price
  eventSlug?: string;        // Event slug (if available)
}

export interface PolymarketOrder {
  id: string;
  status: 'OPEN' | 'FILLED' | 'CANCELED' | 'EXPIRED' | 'MATCHED';
  market: string;
  asset_id: string;          // Token ID
  side: 'BUY' | 'SELL';
  original_size: string;
  size_matched: string;
  price: string;
  outcome: string;
  created_at: number;
  expiration?: number;
  associate_trades?: {
    id: string;
    price: string;
    size: string;
    side: string;
    match_time: number;
  }[];
}

export interface SyncResult {
  positions: PolymarketPosition[];
  openOrders: PolymarketOrder[];
  filledOrders: PolymarketOrder[];
  syncedAt: Date;
  summary: {
    totalPositions: number;
    totalValue: number;
    totalInvested: number;
    unrealizedPnl: number;
    openOrderCount: number;
    recentFillCount: number;
  };
}

// ============================================================
// FETCH POSITIONS FROM DATA API
// ============================================================

/**
 * Fetch all positions for a wallet from Polymarket Data API
 */
export async function fetchPositions(walletAddress: string): Promise<PolymarketPosition[]> {
  const positions: PolymarketPosition[] = [];
  let cursor: string | null = null;
  let pageCount = 0;
  const maxPages = 20;

  console.log(`\n📊 Fetching positions for ${walletAddress.slice(0, 10)}...`);

  while (pageCount < maxPages) {
    pageCount++;
    let url = `${DATA_API_URL}/positions?user=${walletAddress}&sizeThreshold=0&limit=500`;
    if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`;

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
      });

      if (!response.ok) {
        console.error(`❌ Positions API error: HTTP ${response.status}`);
        break;
      }

      const data = await response.json();
      
      let items: any[];
      let nextCursor: string | null = null;

      if (Array.isArray(data)) {
        items = data;
      } else if (data.positions && Array.isArray(data.positions)) {
        items = data.positions;
        nextCursor = data.next_cursor || data.nextCursor || null;
      } else {
        break;
      }

      for (const p of items) {
        // Only include positions with actual shares
        if (p.size > 0) {
          positions.push({
            asset: p.asset || '',
            conditionId: p.conditionId || '',
            market: p.title || p.market || '',
            outcomeIndex: p.outcomeIndex || 0,
            outcome: p.outcome || (p.outcomeIndex === 0 ? 'Yes' : 'No'),
            size: parseFloat(p.size) || 0,
            avgPrice: parseFloat(p.avgPrice) || 0,
            initialValue: parseFloat(p.initialValue) || 0,
            currentValue: parseFloat(p.currentValue) || 0,
            cashPnl: parseFloat(p.cashPnl) || 0,
            percentPnl: parseFloat(p.percentPnl) || 0,
            totalBought: parseFloat(p.totalBought) || 0,
            totalSold: parseFloat(p.totalSold) || 0,
            redeemable: p.redeemable || false,
            mergeable: p.mergeable || false,
            proxyWallet: p.proxyWallet || walletAddress,
            curPrice: parseFloat(p.curPrice) || 0,
            eventSlug: p.eventSlug || p.slug || undefined,
          });
        }
      }

      console.log(`   Page ${pageCount}: ${items.length} items, ${positions.length} total positions`);

      if (!nextCursor || nextCursor === cursor || items.length === 0) break;
      cursor = nextCursor;
    } catch (e) {
      console.error(`❌ Error fetching positions:`, e);
      break;
    }
  }

  console.log(`   ✅ Fetched ${positions.length} total positions`);
  return positions;
}

// ============================================================
// FETCH ORDERS FROM CLOB API
// ============================================================

/**
 * Fetch open and recent orders from CLOB API
 */
export async function fetchOrders(walletAddress: string): Promise<{
  open: PolymarketOrder[];
  filled: PolymarketOrder[];
}> {
  const open: PolymarketOrder[] = [];
  const filled: PolymarketOrder[] = [];

  console.log(`\n📋 Fetching orders for ${walletAddress.slice(0, 10)}...`);

  try {
    // Note: The CLOB orders endpoint requires authentication
    // For now, we'll try the public endpoint
    const response = await fetch(`${CLOB_URL}/orders?maker=${walletAddress}`, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
    });

    if (!response.ok) {
      // This might require auth - log and continue without order data
      console.log(`   ⚠️ Orders API requires auth (HTTP ${response.status}), skipping order sync`);
      return { open, filled };
    }

    const data = await response.json();
    const orders: any[] = Array.isArray(data) ? data : (data.orders || []);

    for (const o of orders) {
      const order: PolymarketOrder = {
        id: o.id || o.order_id || '',
        status: o.status || 'OPEN',
        market: o.market || '',
        asset_id: o.asset_id || o.token_id || '',
        side: o.side || 'BUY',
        original_size: o.original_size || o.size || '0',
        size_matched: o.size_matched || '0',
        price: o.price || '0',
        outcome: o.outcome || '',
        created_at: o.created_at || Date.now(),
        expiration: o.expiration,
        associate_trades: o.associate_trades || [],
      };

      if (order.status === 'OPEN') {
        open.push(order);
      } else if (order.status === 'FILLED' || order.status === 'MATCHED') {
        filled.push(order);
      }
    }

    console.log(`   ✅ Fetched ${open.length} open orders, ${filled.length} filled orders`);
  } catch (e) {
    console.error(`❌ Error fetching orders:`, e);
  }

  return { open, filled };
}

// ============================================================
// FETCH RECENT ACTIVITY (TRADES)
// ============================================================

export interface PolymarketTrade {
  id: string;
  market: string;
  asset_id: string;
  side: 'BUY' | 'SELL';
  size: number;
  price: number;
  fee_rate_bps: number;
  outcome: string;
  type: string;
  timestamp: number;
  transaction_hash: string;
  status: string;
}

/**
 * Fetch recent activity/trades for a wallet
 */
export async function fetchRecentActivity(walletAddress: string, limit: number = 100): Promise<PolymarketTrade[]> {
  const trades: PolymarketTrade[] = [];

  console.log(`\n📈 Fetching recent activity for ${walletAddress.slice(0, 10)}...`);

  try {
    // Try the activity endpoint
    const response = await fetch(
      `${DATA_API_URL}/activity?user=${walletAddress}&limit=${limit}`,
      {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
      }
    );

    if (!response.ok) {
      console.log(`   ⚠️ Activity API returned HTTP ${response.status}`);
      return trades;
    }

    const data = await response.json();
    const items: any[] = Array.isArray(data) ? data : (data.activities || data.history || []);

    for (const t of items) {
      // Only include trade types (not deposits, withdrawals, etc)
      const tradeType = t.type?.toLowerCase() || '';
      if (tradeType.includes('buy') || tradeType.includes('sell') || tradeType.includes('trade')) {
        trades.push({
          id: t.id || '',
          market: t.title || t.market || '',
          asset_id: t.asset_id || t.asset || '',
          side: t.side?.toUpperCase() === 'SELL' ? 'SELL' : 'BUY',
          size: parseFloat(t.size) || parseFloat(t.amount) || 0,
          price: parseFloat(t.price) || 0,
          fee_rate_bps: parseFloat(t.feeRateBps) || 0,
          outcome: t.outcome || '',
          type: t.type || 'trade',
          timestamp: t.timestamp || t.createdAt || Date.now(),
          transaction_hash: t.transactionHash || t.txHash || '',
          status: t.status || 'completed',
        });
      }
    }

    console.log(`   ✅ Fetched ${trades.length} recent trades`);
  } catch (e) {
    console.error(`❌ Error fetching activity:`, e);
  }

  return trades;
}

// ============================================================
// MAIN SYNC FUNCTION
// ============================================================

/**
 * Full sync: fetch positions, orders, and activity from Polymarket APIs
 */
export async function syncPositions(walletAddress?: string): Promise<SyncResult> {
  const wallet = walletAddress || config.polymarket.address;
  
  console.log(`\n${'='.repeat(60)}`);
  console.log(`🔄 SYNCING POSITIONS FROM POLYMARKET`);
  console.log(`   Wallet: ${wallet}`);
  console.log(`   Time: ${new Date().toISOString()}`);
  console.log(`${'='.repeat(60)}`);

  // Fetch all data in parallel
  const [positions, orders] = await Promise.all([
    fetchPositions(wallet),
    fetchOrders(wallet),
  ]);

  // Calculate summary
  const totalValue = positions.reduce((sum, p) => sum + p.currentValue, 0);
  const totalInvested = positions.reduce((sum, p) => sum + p.initialValue, 0);
  const unrealizedPnl = totalValue - totalInvested;

  const result: SyncResult = {
    positions,
    openOrders: orders.open,
    filledOrders: orders.filled,
    syncedAt: new Date(),
    summary: {
      totalPositions: positions.length,
      totalValue,
      totalInvested,
      unrealizedPnl,
      openOrderCount: orders.open.length,
      recentFillCount: orders.filled.length,
    },
  };

  console.log(`\n📊 SYNC SUMMARY:`);
  console.log(`   Positions: ${result.summary.totalPositions}`);
  console.log(`   Total Value: $${result.summary.totalValue.toFixed(2)}`);
  console.log(`   Total Invested: $${result.summary.totalInvested.toFixed(2)}`);
  console.log(`   Unrealized P/L: $${result.summary.unrealizedPnl.toFixed(2)}`);
  console.log(`   Open Orders: ${result.summary.openOrderCount}`);
  console.log(`${'='.repeat(60)}\n`);

  return result;
}

// ============================================================
// FILTER FOR 15M MARKETS
// ============================================================

/**
 * Filter positions for 15-minute crypto markets only
 */
export function filter15mPositions(positions: PolymarketPosition[]): PolymarketPosition[] {
  return positions.filter(p => {
    const market = p.market.toLowerCase();
    const slug = (p.eventSlug || '').toLowerCase();
    
    // Check for 15m market patterns
    return (
      market.includes('15m') ||
      market.includes('15 min') ||
      market.includes(':00am-') ||
      market.includes(':15am-') ||
      market.includes(':30am-') ||
      market.includes(':45am-') ||
      slug.includes('15m') ||
      slug.includes('-updown-15m-')
    );
  });
}

/**
 * Get net position for each market (UP shares - DOWN shares value)
 */
export function getNetPositions(positions: PolymarketPosition[]): Map<string, {
  upShares: number;
  downShares: number;
  upValue: number;
  downValue: number;
  upCost: number;
  downCost: number;
  netValue: number;
  isHedged: boolean;
}> {
  const byMarket = new Map<string, typeof positions>();

  // Group by market
  for (const p of positions) {
    const key = p.conditionId || p.market;
    if (!byMarket.has(key)) {
      byMarket.set(key, []);
    }
    byMarket.get(key)!.push(p);
  }

  // Calculate net position per market
  const result = new Map<string, {
    upShares: number;
    downShares: number;
    upValue: number;
    downValue: number;
    upCost: number;
    downCost: number;
    netValue: number;
    isHedged: boolean;
  }>();

  for (const [key, marketPositions] of byMarket) {
    let upShares = 0, downShares = 0;
    let upValue = 0, downValue = 0;
    let upCost = 0, downCost = 0;

    for (const p of marketPositions) {
      const outcome = p.outcome.toLowerCase();
      if (outcome === 'up' || outcome === 'yes') {
        upShares += p.size;
        upValue += p.currentValue;
        upCost += p.initialValue;
      } else {
        downShares += p.size;
        downValue += p.currentValue;
        downCost += p.initialValue;
      }
    }

    const netValue = upValue + downValue;
    const totalShares = upShares + downShares;
    const skew = totalShares > 0 ? Math.abs(upShares - downShares) / totalShares : 0;
    const isHedged = skew < 0.2; // Less than 20% skew = hedged

    result.set(key, {
      upShares,
      downShares,
      upValue,
      downValue,
      upCost,
      downCost,
      netValue,
      isHedged,
    });
  }

  return result;
}

// ============================================================
// PRINT POSITIONS REPORT
// ============================================================

export function printPositionsReport(result: SyncResult): void {
  console.log('\n' + '='.repeat(70));
  console.log('LIVE POSITIONS REPORT');
  console.log('='.repeat(70));

  if (result.positions.length === 0) {
    console.log('\n   No open positions');
    return;
  }

  // Filter for 15m markets
  const positions15m = filter15mPositions(result.positions);
  const otherPositions = result.positions.filter(p => !positions15m.includes(p));

  if (positions15m.length > 0) {
    console.log('\n📊 15M CRYPTO MARKETS:');
    const netPositions = getNetPositions(positions15m);
    
    for (const [market, net] of netPositions) {
      const pnl = net.netValue - (net.upCost + net.downCost);
      const pnlStr = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;
      const hedgeIcon = net.isHedged ? '🛡️' : '⚠️';
      
      console.log(`\n   ${hedgeIcon} ${market.slice(0, 50)}`);
      console.log(`      UP: ${net.upShares.toFixed(1)} shares ($${net.upValue.toFixed(2)} value, $${net.upCost.toFixed(2)} cost)`);
      console.log(`      DOWN: ${net.downShares.toFixed(1)} shares ($${net.downValue.toFixed(2)} value, $${net.downCost.toFixed(2)} cost)`);
      console.log(`      Net Value: $${net.netValue.toFixed(2)} | P/L: ${pnlStr}`);
    }
  }

  if (otherPositions.length > 0) {
    console.log('\n📋 OTHER POSITIONS:');
    for (const p of otherPositions.slice(0, 10)) {
      const pnl = p.currentValue - p.initialValue;
      const pnlStr = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;
      console.log(`   • ${p.outcome}: ${p.size.toFixed(1)} @ ${p.market.slice(0, 40)}...`);
      console.log(`     Value: $${p.currentValue.toFixed(2)} | Cost: $${p.initialValue.toFixed(2)} | P/L: ${pnlStr}`);
    }
    if (otherPositions.length > 10) {
      console.log(`   ... and ${otherPositions.length - 10} more positions`);
    }
  }

  console.log('\n' + '='.repeat(70));
  console.log(`TOTALS: ${result.summary.totalPositions} positions | $${result.summary.totalValue.toFixed(2)} value | $${result.summary.unrealizedPnl.toFixed(2)} unrealized P/L`);
  console.log('='.repeat(70) + '\n');
}

// ============================================================
// SYNC POSITIONS TO DATABASE
// ============================================================

/**
 * Extract market slug from position data
 */
function extractMarketSlug(position: PolymarketPosition): string {
  // Try eventSlug first
  if (position.eventSlug) {
    return position.eventSlug;
  }
  
  // Try to extract from market name
  const market = position.market.toLowerCase();
  
  // Handle 15m format: "Bitcoin Up or Down - December 30, 2:00AM-2:15AM ET"
  // Convert to slug format: btc-updown-15m-{timestamp}
  if (market.includes('bitcoin') && market.includes('up or down')) {
    // Try to extract time from market name
    const timeMatch = market.match(/(\d{1,2}):(\d{2})(am|pm)/i);
    if (timeMatch) {
      return `btc-updown-15m-${Date.now()}`; // Fallback, will be updated
    }
  }
  
  if (market.includes('ethereum') && market.includes('up or down')) {
    const timeMatch = market.match(/(\d{1,2}):(\d{2})(am|pm)/i);
    if (timeMatch) {
      return `eth-updown-15m-${Date.now()}`; // Fallback
    }
  }
  
  // Create a simple slug from market name
  return position.market
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 100);
}

/**
 * Write synced positions to the bot_positions table
 */
export async function writePositionsToDatabase(
  positions: PolymarketPosition[],
  walletAddress: string
): Promise<{ success: boolean; upserted: number; deleted: number; error?: string }> {
  console.log(`\n💾 Writing ${positions.length} positions to database...`);
  
  const supabase = getSupabaseClient();
  if (!supabase) {
    console.log('   ⚠️ Supabase not configured, skipping database write');
    return { success: false, upserted: 0, deleted: 0, error: 'Supabase not configured' };
  }
  
  try {
    // Prepare position records for upsert
    const records = positions.map(p => ({
      wallet_address: walletAddress,
      market_slug: extractMarketSlug(p),
      outcome: p.outcome,
      shares: p.size,
      avg_price: p.avgPrice,
      current_price: p.curPrice,
      value: p.currentValue,
      cost: p.initialValue,
      pnl: p.cashPnl,
      pnl_percent: p.percentPnl,
      token_id: p.asset,
      synced_at: new Date().toISOString(),
    }));
    
    // Upsert positions
    const { error: upsertError } = await supabase
      .from('bot_positions')
      .upsert(records, {
        onConflict: 'wallet_address,market_slug,outcome',
        ignoreDuplicates: false,
      });
    
    if (upsertError) {
      console.error('   ❌ Upsert error:', upsertError);
      return { success: false, upserted: 0, deleted: 0, error: upsertError.message };
    }
    
    // Get current market slugs from synced positions
    const currentSlugs = new Set(records.map(r => `${r.market_slug}:${r.outcome}`));
    
    // Fetch all positions for this wallet from database
    const { data: existingPositions, error: fetchError } = await supabase
      .from('bot_positions')
      .select('id, market_slug, outcome')
      .eq('wallet_address', walletAddress);
    
    if (fetchError) {
      console.error('   ⚠️ Error fetching existing positions:', fetchError);
    }
    
    // Delete positions that no longer exist on Polymarket
    let deletedCount = 0;
    if (existingPositions) {
      const toDelete = existingPositions.filter(
        ep => !currentSlugs.has(`${ep.market_slug}:${ep.outcome}`)
      );
      
      if (toDelete.length > 0) {
        const deleteIds = toDelete.map(d => d.id);
        const { error: deleteError } = await supabase
          .from('bot_positions')
          .delete()
          .in('id', deleteIds);
        
        if (deleteError) {
          console.error('   ⚠️ Error deleting old positions:', deleteError);
        } else {
          deletedCount = toDelete.length;
        }
      }
    }
    
    console.log(`   ✅ Upserted ${records.length} positions, deleted ${deletedCount} stale positions`);
    return { success: true, upserted: records.length, deleted: deletedCount };
    
  } catch (e) {
    console.error('   ❌ Database write error:', e);
    return { success: false, upserted: 0, deleted: 0, error: String(e) };
  }
}

/**
 * Full sync with database write
 */
export async function syncPositionsToDatabase(walletAddress?: string): Promise<SyncResult & { dbResult?: { success: boolean; upserted: number; deleted: number } }> {
  const result = await syncPositions(walletAddress);
  
  // Write to database
  const wallet = walletAddress || config.polymarket.address;
  const dbResult = await writePositionsToDatabase(result.positions, wallet);
  
  return { ...result, dbResult };
}
