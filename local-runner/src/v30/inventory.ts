/**
 * V30 Inventory Manager
 * 
 * Tracks positions and calculates exposure
 */

import type { Asset, V30Config, V30Position, Inventory } from './types.js';

export class InventoryManager {
  private positions: Map<string, V30Position> = new Map();
  private config: V30Config;

  constructor(config: V30Config) {
    this.config = config;
  }

  /**
   * Generate position key
   */
  private key(asset: Asset, marketSlug: string, direction: 'UP' | 'DOWN'): string {
    return `${asset}:${marketSlug}:${direction}`;
  }

  /**
   * Get inventory for an asset in a specific market
   */
  getInventory(asset: Asset, marketSlug: string, secRemaining: number): Inventory {
    const upKey = this.key(asset, marketSlug, 'UP');
    const downKey = this.key(asset, marketSlug, 'DOWN');
    
    const upPos = this.positions.get(upKey);
    const downPos = this.positions.get(downKey);
    
    const up = upPos?.shares ?? 0;
    const down = downPos?.shares ?? 0;
    
    return {
      up,
      down,
      net: up - down,
      i_max: this.getIMax(secRemaining),
    };
  }

  /**
   * Get total inventory across all markets for an asset
   */
  getTotalInventory(asset: Asset, secRemaining: number): Inventory {
    let up = 0;
    let down = 0;
    
    for (const [key, pos] of this.positions) {
      if (key.startsWith(`${asset}:`)) {
        if (pos.direction === 'UP') {
          up += pos.shares;
        } else {
          down += pos.shares;
        }
      }
    }
    
    return {
      up,
      down,
      net: up - down,
      i_max: this.getIMax(secRemaining),
    };
  }

  /**
   * Calculate max inventory based on time remaining
   * Shrinks as we approach expiry
   */
  getIMax(secRemaining: number): number {
    // Linear decay from full to 20% at expiry
    const decay = Math.max(0.2, secRemaining / 900);
    return Math.floor(this.config.i_max_base * decay);
  }

  /**
   * Add or update a position
   */
  addPosition(
    runId: string,
    asset: Asset,
    marketSlug: string,
    direction: 'UP' | 'DOWN',
    shares: number,
    price: number
  ): V30Position {
    const k = this.key(asset, marketSlug, direction);
    const existing = this.positions.get(k);
    
    if (existing) {
      // Update existing position
      const newShares = existing.shares + shares;
      const newTotalCost = existing.total_cost + (shares * price);
      const newAvgPrice = newTotalCost / newShares;
      
      const updated: V30Position = {
        ...existing,
        shares: newShares,
        avg_entry_price: newAvgPrice,
        total_cost: newTotalCost,
      };
      this.positions.set(k, updated);
      return updated;
    } else {
      // Create new position
      const pos: V30Position = {
        run_id: runId,
        asset,
        market_slug: marketSlug,
        direction,
        shares,
        avg_entry_price: price,
        total_cost: shares * price,
      };
      this.positions.set(k, pos);
      return pos;
    }
  }

  /**
   * Reduce a position (sell shares)
   */
  reducePosition(
    asset: Asset,
    marketSlug: string,
    direction: 'UP' | 'DOWN',
    sharesToSell: number
  ): { soldShares: number; remainingShares: number; avgPrice: number } {
    const k = this.key(asset, marketSlug, direction);
    const pos = this.positions.get(k);
    
    if (!pos || pos.shares <= 0) {
      return { soldShares: 0, remainingShares: 0, avgPrice: 0 };
    }
    
    const actualSold = Math.min(sharesToSell, pos.shares);
    const remaining = pos.shares - actualSold;
    
    if (remaining <= 0) {
      this.positions.delete(k);
    } else {
      pos.shares = remaining;
      pos.total_cost = remaining * pos.avg_entry_price;
      this.positions.set(k, pos);
    }
    
    return {
      soldShares: actualSold,
      remainingShares: remaining,
      avgPrice: pos.avg_entry_price,
    };
  }

  /**
   * Clear positions for a market (after settlement)
   */
  clearMarket(asset: Asset, marketSlug: string): void {
    const upKey = this.key(asset, marketSlug, 'UP');
    const downKey = this.key(asset, marketSlug, 'DOWN');
    this.positions.delete(upKey);
    this.positions.delete(downKey);
  }

  /**
   * Get all positions
   */
  getAllPositions(): V30Position[] {
    return Array.from(this.positions.values());
  }

  /**
   * Get positions for a market
   */
  getMarketPositions(asset: Asset, marketSlug: string): {
    up: V30Position | null;
    down: V30Position | null;
  } {
    return {
      up: this.positions.get(this.key(asset, marketSlug, 'UP')) ?? null,
      down: this.positions.get(this.key(asset, marketSlug, 'DOWN')) ?? null,
    };
  }

  /**
   * Load positions from database
   */
  loadPositions(positions: V30Position[]): void {
    this.positions.clear();
    for (const pos of positions) {
      const k = this.key(pos.asset, pos.market_slug, pos.direction);
      this.positions.set(k, pos);
    }
  }

  /**
   * Check available space in inventory for new position
   */
  getAvailableSpace(
    asset: Asset,
    marketSlug: string,
    direction: 'UP' | 'DOWN',
    secRemaining: number
  ): number {
    const inv = this.getInventory(asset, marketSlug, secRemaining);
    
    // If buying UP, net increases; if buying DOWN, net decreases
    const currentNet = inv.net;
    const maxNet = inv.i_max;
    
    if (direction === 'UP') {
      // Net would increase, check upper bound
      return Math.max(0, maxNet - currentNet);
    } else {
      // Net would decrease, check lower bound
      return Math.max(0, maxNet + currentNet);
    }
  }

  /**
   * Update config
   */
  updateConfig(config: Partial<V30Config>): void {
    this.config = { ...this.config, ...config };
  }
}
