// ============================================================
// V35 MARKET PRICING HELPERS
// ============================================================
// Shared logic to determine the "expensive" vs "cheap" side of a market.
// We keep this separate so both quoting-engine and runner use the exact
// same definition.

import type { V35Market, V35Side } from './types.js';

export interface V35SidePricing {
  avgUpPrice: number;
  avgDownPrice: number;
  upLivePrice: number;
  downLivePrice: number;
  upIsExpensive: boolean;
  expensiveSide: V35Side;
  cheapSide: V35Side;
  expensiveQty: number;
  cheapQty: number;
}

export function getV35SidePricing(market: V35Market): V35SidePricing {
  const avgUpPrice = market.upQty > 0 ? market.upCost / market.upQty : 0;
  const avgDownPrice = market.downQty > 0 ? market.downCost / market.downQty : 0;

  // Use best-bid as a "live" anchor (best bid is what inventory can be sold at).
  const upLivePrice = market.upBestBid || avgUpPrice;
  const downLivePrice = market.downBestBid || avgDownPrice;

  // Expensive side based on blended (avg fill + live bid) to avoid flip-flops.
  const upIsExpensive = (avgUpPrice + upLivePrice) / 2 >= (avgDownPrice + downLivePrice) / 2;
  const expensiveSide: V35Side = upIsExpensive ? 'UP' : 'DOWN';
  const cheapSide: V35Side = upIsExpensive ? 'DOWN' : 'UP';

  const expensiveQty = expensiveSide === 'UP' ? market.upQty : market.downQty;
  const cheapQty = cheapSide === 'UP' ? market.upQty : market.downQty;

  return {
    avgUpPrice,
    avgDownPrice,
    upLivePrice,
    downLivePrice,
    upIsExpensive,
    expensiveSide,
    cheapSide,
    expensiveQty,
    cheapQty,
  };
}
