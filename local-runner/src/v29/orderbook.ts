/**
 * V29 Orderbook Fetcher
 * 
 * Simple HTTP fetches to get current best bid/ask from Polymarket CLOB
 */

import { getClient } from '../polymarket.js';
import { Asset } from './config.js';
import type { MarketInfo, PriceState } from './types.js';

const CLOB_API = 'https://clob.polymarket.com';

function log(msg: string): void {
  console.log(`[V29:Orderbook] ${msg}`);
}

interface OrderbookResponse {
  market: string;
  asset_id: string;
  bids: Array<{ price: string; size: string }>;
  asks: Array<{ price: string; size: string }>;
}

/**
 * Fetch best bid/ask for a token
 */
async function fetchTokenOrderbook(tokenId: string): Promise<{ bestBid: number | null; bestAsk: number | null }> {
  try {
    const res = await fetch(`${CLOB_API}/book?token_id=${tokenId}`, {
      headers: { 'Accept': 'application/json' }
    });
    
    if (!res.ok) {
      return { bestBid: null, bestAsk: null };
    }
    
    const data: OrderbookResponse = await res.json();
    
    const bestBid = data.bids?.length > 0 ? parseFloat(data.bids[0].price) : null;
    const bestAsk = data.asks?.length > 0 ? parseFloat(data.asks[0].price) : null;
    
    return { bestBid, bestAsk };
  } catch (err) {
    return { bestBid: null, bestAsk: null };
  }
}

/**
 * Fetch orderbook for a market (both UP and DOWN tokens)
 */
export async function fetchMarketOrderbook(market: MarketInfo): Promise<Partial<PriceState>> {
  const [upBook, downBook] = await Promise.all([
    fetchTokenOrderbook(market.upTokenId),
    fetchTokenOrderbook(market.downTokenId),
  ]);
  
  return {
    upBestBid: upBook.bestBid,
    upBestAsk: upBook.bestAsk,
    downBestBid: downBook.bestBid,
    downBestAsk: downBook.bestAsk,
    lastUpdate: Date.now(),
  };
}

/**
 * Fetch orderbooks for all markets
 */
export async function fetchAllOrderbooks(
  markets: Map<Asset, MarketInfo>
): Promise<Map<Asset, Partial<PriceState>>> {
  const results = new Map<Asset, Partial<PriceState>>();
  
  const promises = Array.from(markets.entries()).map(async ([asset, market]) => {
    const book = await fetchMarketOrderbook(market);
    results.set(asset, book);
  });
  
  await Promise.all(promises);
  
  return results;
}
