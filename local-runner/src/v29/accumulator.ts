/**
 * V29 Accumulator Strategy
 * 
 * Core concept: Instead of sell, we HEDGE by buying the opposite side.
 * 
 * Example:
 * - Buy UP @ 62¢ → Instead of selling at 68¢, buy DOWN @ 32¢
 * - Result: Locked in 6¢ profit (UP 62¢ + DOWN 32¢ = 94¢ cost for 100¢ payout)
 * 
 * Benefits:
 * - No sell fees (market maker rebate on buys)
 * - Keep optionality - can keep accumulating
 * - Progressive hedging at lower prices (32¢ → 20¢ → 10¢)
 */

import type { Asset } from './config.js';
import type { AggregatePosition, MarketInfo, PriceState } from './types.js';
import { placeBuyOrder, setFillContext, clearFillContext } from './trading.js';
import { getDb } from './db.js';

// ============================================
// TYPES
// ============================================

export interface AccumulatorConfig {
  // Minimum profit margin before hedging (in cents)
  // e.g., 4¢ profit needed before we hedge
  min_hedge_profit_cents: number;
  
  // Maximum hedge price (don't hedge if opposite side > this)
  max_hedge_price: number; // e.g., 0.40 = 40¢
  
  // Progressive hedge thresholds (buy more hedge at lower prices)
  hedge_tiers: Array<{
    max_price: number;  // Trigger when price <= this
    share_pct: number;  // Hedge this % of unhedged shares
  }>;
  
  // Maximum total exposure per asset (shares)
  max_exposure_per_asset: number;
  
  // Maximum total cost per asset (USD)
  max_cost_per_asset: number;
}

export const DEFAULT_ACCUMULATOR_CONFIG: AccumulatorConfig = {
  min_hedge_profit_cents: 4,
  max_hedge_price: 0.40,
  hedge_tiers: [
    { max_price: 0.35, share_pct: 0.33 },  // Hedge 33% when < 35¢
    { max_price: 0.25, share_pct: 0.50 },  // Hedge 50% more when < 25¢
    { max_price: 0.15, share_pct: 1.00 },  // Hedge remaining when < 15¢
  ],
  max_exposure_per_asset: 100,
  max_cost_per_asset: 50,
};

// In-memory aggregate positions by asset+side
const aggregatePositions = new Map<string, AggregatePosition>();

// ============================================
// POSITION KEY
// ============================================

function positionKey(asset: Asset, side: 'UP' | 'DOWN', marketSlug: string): string {
  return `${asset}:${side}:${marketSlug}`;
}

// ============================================
// LOAD/SAVE POSITIONS FROM DB
// ============================================

export async function loadAggregatePositions(runId: string): Promise<void> {
  const db = getDb();
  if (!db) return;
  
  try {
    const { data, error } = await db
      .from('v29_aggregate_positions')
      .select('*')
      .eq('run_id', runId)
      .neq('state', 'closed');
    
    if (error) {
      console.error('[Accumulator] Failed to load positions:', error);
      return;
    }
    
    aggregatePositions.clear();
    
    for (const row of data || []) {
      const pos: AggregatePosition = {
        id: row.id,
        runId: row.run_id,
        asset: row.asset as Asset,
        side: row.side as 'UP' | 'DOWN',
        marketSlug: row.market_slug,
        tokenId: row.token_id,
        totalShares: Number(row.total_shares),
        totalCost: Number(row.total_cost),
        avgEntryPrice: Number(row.avg_entry_price),
        hedgeShares: Number(row.hedge_shares),
        hedgeCost: Number(row.hedge_cost),
        isFullyHedged: row.is_fully_hedged,
        createdAt: new Date(row.created_at),
        updatedAt: new Date(row.updated_at),
      };
      
      const key = positionKey(pos.asset, pos.side, pos.marketSlug);
      aggregatePositions.set(key, pos);
    }
    
    console.log(`[Accumulator] Loaded ${aggregatePositions.size} open positions`);
  } catch (err) {
    console.error('[Accumulator] Load error:', err);
  }
}

async function saveAggregatePosition(pos: AggregatePosition): Promise<string | null> {
  const db = getDb();
  if (!db) return null;
  
  try {
    const { data, error } = await db
      .from('v29_aggregate_positions')
      .upsert({
        id: pos.id,
        run_id: pos.runId,
        asset: pos.asset,
        side: pos.side,
        market_slug: pos.marketSlug,
        token_id: pos.tokenId,
        total_shares: pos.totalShares,
        total_cost: pos.totalCost,
        hedge_shares: pos.hedgeShares,
        hedge_cost: pos.hedgeCost,
        is_fully_hedged: pos.isFullyHedged,
        state: pos.isFullyHedged ? 'fully_hedged' : (pos.hedgeShares > 0 ? 'partially_hedged' : 'accumulating'),
        last_entry_ts: new Date().toISOString(),
      }, { onConflict: 'run_id,asset,side,market_slug' })
      .select('id')
      .single();
    
    if (error) {
      console.error('[Accumulator] Save error:', error);
      return null;
    }
    
    return data?.id || null;
  } catch (err) {
    console.error('[Accumulator] Save error:', err);
    return null;
  }
}

// ============================================
// CORE FUNCTIONS
// ============================================

/**
 * Get or create aggregate position for asset/side
 */
export function getOrCreatePosition(
  runId: string,
  asset: Asset,
  side: 'UP' | 'DOWN',
  marketSlug: string,
  tokenId: string
): AggregatePosition {
  const key = positionKey(asset, side, marketSlug);
  
  let pos = aggregatePositions.get(key);
  if (!pos) {
    pos = {
      id: crypto.randomUUID(),
      runId,
      asset,
      side,
      marketSlug,
      tokenId,
      totalShares: 0,
      totalCost: 0,
      avgEntryPrice: 0,
      hedgeShares: 0,
      hedgeCost: 0,
      isFullyHedged: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    aggregatePositions.set(key, pos);
  }
  
  return pos;
}

/**
 * Get existing position (if any)
 */
export function getPosition(asset: Asset, side: 'UP' | 'DOWN', marketSlug: string): AggregatePosition | null {
  const key = positionKey(asset, side, marketSlug);
  return aggregatePositions.get(key) || null;
}

/**
 * Get all open positions for an asset
 */
export function getAssetPositions(asset: Asset): AggregatePosition[] {
  const positions: AggregatePosition[] = [];
  for (const [key, pos] of aggregatePositions) {
    if (key.startsWith(`${asset}:`)) {
      positions.push(pos);
    }
  }
  return positions;
}

/**
 * Get unhedged shares for a position
 */
export function getUnhedgedShares(pos: AggregatePosition): number {
  // We need to find the opposite side position to check hedge status
  const oppositeSide = pos.side === 'UP' ? 'DOWN' : 'UP';
  const hedgePos = getPosition(pos.asset, oppositeSide, pos.marketSlug);
  
  if (!hedgePos) return pos.totalShares;
  
  // Min of our shares vs their shares = hedged
  const hedgedShares = Math.min(pos.totalShares, hedgePos.totalShares);
  return pos.totalShares - hedgedShares;
}

/**
 * Calculate current CPP (Cost Per Pair) for a market
 * Lower CPP = better (< 100¢ = profit locked)
 */
export function calculateCPP(asset: Asset, marketSlug: string): { cpp: number; pairedShares: number; unpairedShares: number } | null {
  const upPos = getPosition(asset, 'UP', marketSlug);
  const downPos = getPosition(asset, 'DOWN', marketSlug);
  
  if (!upPos && !downPos) return null;
  
  const upShares = upPos?.totalShares || 0;
  const downShares = downPos?.totalShares || 0;
  const upCost = upPos?.totalCost || 0;
  const downCost = downPos?.totalCost || 0;
  
  const pairedShares = Math.min(upShares, downShares);
  const unpairedShares = Math.abs(upShares - downShares);
  
  if (pairedShares === 0) {
    return { cpp: 0, pairedShares: 0, unpairedShares };
  }
  
  // CPP = (upCost + downCost) / pairedShares (should be < 100¢ for profit)
  const totalCost = upCost + downCost;
  const cpp = (totalCost / pairedShares) * 100; // in cents
  
  return { cpp, pairedShares, unpairedShares };
}

// ============================================
// ACCUMULATION
// ============================================

/**
 * Add shares to an aggregate position
 */
export async function accumulateShares(
  runId: string,
  asset: Asset,
  side: 'UP' | 'DOWN',
  market: MarketInfo,
  shares: number,
  price: number,
  config: AccumulatorConfig
): Promise<{ success: boolean; position: AggregatePosition; error?: string }> {
  const tokenId = side === 'UP' ? market.upTokenId : market.downTokenId;
  const pos = getOrCreatePosition(runId, asset, side, market.slug, tokenId);
  
  // Check exposure limits
  const newTotalShares = pos.totalShares + shares;
  const newTotalCost = pos.totalCost + (shares * price);
  
  if (newTotalShares > config.max_exposure_per_asset) {
    return { 
      success: false, 
      position: pos, 
      error: `Exposure limit: ${newTotalShares} > ${config.max_exposure_per_asset} shares` 
    };
  }
  
  if (newTotalCost > config.max_cost_per_asset) {
    return { 
      success: false, 
      position: pos, 
      error: `Cost limit: $${newTotalCost.toFixed(2)} > $${config.max_cost_per_asset}` 
    };
  }
  
  // Update position
  pos.totalShares = newTotalShares;
  pos.totalCost = newTotalCost;
  pos.avgEntryPrice = pos.totalCost / pos.totalShares;
  pos.updatedAt = new Date();
  
  // Save to DB
  await saveAggregatePosition(pos);
  
  console.log(`[Accumulator] ${asset} ${side}: +${shares} @ ${(price * 100).toFixed(1)}¢ | Total: ${pos.totalShares} @ avg ${(pos.avgEntryPrice * 100).toFixed(1)}¢`);
  
  return { success: true, position: pos };
}

// ============================================
// HEDGE LOGIC
// ============================================

/**
 * Check if we should hedge and how much
 */
export function checkHedgeOpportunity(
  asset: Asset,
  market: MarketInfo,
  priceState: PriceState,
  config: AccumulatorConfig
): { shouldHedge: boolean; hedgeSide: 'UP' | 'DOWN'; hedgeShares: number; hedgePrice: number; reason: string } | null {
  
  const upPos = getPosition(asset, 'UP', market.slug);
  const downPos = getPosition(asset, 'DOWN', market.slug);
  
  // Check if we have unhedged UP position and DOWN is cheap
  if (upPos && upPos.totalShares > 0) {
    const downAsk = priceState.downBestAsk;
    if (downAsk && downAsk <= config.max_hedge_price) {
      // Calculate potential profit if we hedge now
      const potentialCPP = (upPos.avgEntryPrice + downAsk) * 100;
      const profitCents = 100 - potentialCPP;
      
      if (profitCents >= config.min_hedge_profit_cents) {
        // Determine how much to hedge based on price tier
        const unhedgedShares = getUnhedgedShares(upPos);
        if (unhedgedShares <= 0) return null;
        
        let hedgePct = 0;
        for (const tier of config.hedge_tiers) {
          if (downAsk <= tier.max_price) {
            hedgePct = Math.max(hedgePct, tier.share_pct);
          }
        }
        
        if (hedgePct === 0) hedgePct = 0.33; // Default 33%
        
        const hedgeShares = Math.ceil(unhedgedShares * hedgePct);
        
        return {
          shouldHedge: true,
          hedgeSide: 'DOWN',
          hedgeShares,
          hedgePrice: downAsk,
          reason: `UP ${(upPos.avgEntryPrice * 100).toFixed(0)}¢ + DOWN ${(downAsk * 100).toFixed(0)}¢ = ${potentialCPP.toFixed(0)}¢ CPP (+${profitCents.toFixed(0)}¢)`,
        };
      }
    }
  }
  
  // Check if we have unhedged DOWN position and UP is cheap
  if (downPos && downPos.totalShares > 0) {
    const upAsk = priceState.upBestAsk;
    if (upAsk && upAsk <= config.max_hedge_price) {
      const potentialCPP = (downPos.avgEntryPrice + upAsk) * 100;
      const profitCents = 100 - potentialCPP;
      
      if (profitCents >= config.min_hedge_profit_cents) {
        const unhedgedShares = getUnhedgedShares(downPos);
        if (unhedgedShares <= 0) return null;
        
        let hedgePct = 0;
        for (const tier of config.hedge_tiers) {
          if (upAsk <= tier.max_price) {
            hedgePct = Math.max(hedgePct, tier.share_pct);
          }
        }
        
        if (hedgePct === 0) hedgePct = 0.33;
        
        const hedgeShares = Math.ceil(unhedgedShares * hedgePct);
        
        return {
          shouldHedge: true,
          hedgeSide: 'UP',
          hedgeShares,
          hedgePrice: upAsk,
          reason: `DOWN ${(downPos.avgEntryPrice * 100).toFixed(0)}¢ + UP ${(upAsk * 100).toFixed(0)}¢ = ${potentialCPP.toFixed(0)}¢ CPP (+${profitCents.toFixed(0)}¢)`,
        };
      }
    }
  }
  
  return null;
}

/**
 * Execute hedge buy
 */
export async function executeHedge(
  runId: string,
  asset: Asset,
  hedgeSide: 'UP' | 'DOWN',
  market: MarketInfo,
  shares: number,
  price: number,
  config: AccumulatorConfig
): Promise<{ success: boolean; filledShares: number; avgPrice: number; error?: string }> {
  
  const tokenId = hedgeSide === 'UP' ? market.upTokenId : market.downTokenId;
  
  console.log(`[Accumulator] 🛡️ HEDGE: ${asset} ${hedgeSide} ${shares} @ ${(price * 100).toFixed(1)}¢`);
  
  // Set context for fill logging
  setFillContext({
    runId,
    marketSlug: market.slug,
  });
  
  const result = await placeBuyOrder(tokenId, price, shares, asset, hedgeSide);
  
  clearFillContext();
  
  if (!result.success) {
    return { success: false, filledShares: 0, avgPrice: 0, error: result.error };
  }
  
  // Update the hedge position
  const filledShares = result.filledSize || shares;
  const filledPrice = result.avgPrice || price;
  
  await accumulateShares(runId, asset, hedgeSide, market, filledShares, filledPrice, config);
  
  // Calculate new CPP
  const cppInfo = calculateCPP(asset, market.slug);
  if (cppInfo) {
    console.log(`[Accumulator] 📊 ${asset} CPP: ${cppInfo.cpp.toFixed(1)}¢ | Paired: ${cppInfo.pairedShares} | Unpaired: ${cppInfo.unpairedShares}`);
  }
  
  return { success: true, filledShares, avgPrice: filledPrice };
}

/**
 * Get status summary for logging
 */
export function getPositionsSummary(): string {
  const lines: string[] = [];
  
  const byAsset = new Map<Asset, { up?: AggregatePosition; down?: AggregatePosition }>();
  
  for (const pos of aggregatePositions.values()) {
    if (!byAsset.has(pos.asset)) {
      byAsset.set(pos.asset, {});
    }
    const entry = byAsset.get(pos.asset)!;
    if (pos.side === 'UP') entry.up = pos;
    else entry.down = pos;
  }
  
  for (const [asset, positions] of byAsset) {
    const up = positions.up;
    const down = positions.down;
    
    const upStr = up ? `UP: ${up.totalShares}@${(up.avgEntryPrice * 100).toFixed(0)}¢` : 'UP: -';
    const downStr = down ? `DOWN: ${down.totalShares}@${(down.avgEntryPrice * 100).toFixed(0)}¢` : 'DOWN: -';
    
    const cppInfo = calculateCPP(asset, up?.marketSlug || down?.marketSlug || '');
    const cppStr = cppInfo ? `CPP: ${cppInfo.cpp.toFixed(0)}¢` : '';
    
    lines.push(`${asset}: ${upStr} | ${downStr} | ${cppStr}`);
  }
  
  return lines.join(' || ');
}

/**
 * Clear positions for a market (when market expires)
 */
export function clearMarketPositions(asset: Asset, marketSlug: string): void {
  const upKey = positionKey(asset, 'UP', marketSlug);
  const downKey = positionKey(asset, 'DOWN', marketSlug);
  
  aggregatePositions.delete(upKey);
  aggregatePositions.delete(downKey);
  
  console.log(`[Accumulator] Cleared ${asset} positions for ${marketSlug}`);
}
