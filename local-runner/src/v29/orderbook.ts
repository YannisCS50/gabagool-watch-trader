/**
 * V29 Orderbook Fetcher
 * 
 * Simple HTTP fetches to get current best bid/ask from Polymarket CLOB
 */

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

interface TokenBook {
  ok: boolean;
  bestBid: number | null;
  bestAsk: number | null;
  status?: number;
}

const ORDERBOOK_ERROR_LOG_THROTTLE_MS = 30_000;
const lastErrorLogAt = new Map<string, number>();

function shouldLogError(key: string): boolean {
  const now = Date.now();
  const last = lastErrorLogAt.get(key) ?? 0;
  if (now - last < ORDERBOOK_ERROR_LOG_THROTTLE_MS) return false;
  lastErrorLogAt.set(key, now);
  return true;
}

/**
 * Fetch best bid/ask for a token.
 * IMPORTANT: on transient HTTP failures (429/5xx/etc), we return ok=false so callers
 * can keep the previous cached bestBid/bestAsk instead of overwriting with null.
 */
async function fetchTokenOrderbook(tokenId: string): Promise<TokenBook> {
  try {
    const res = await fetch(`${CLOB_API}/book?token_id=${tokenId}`, {
      headers: { Accept: 'application/json' },
    });

    if (!res.ok) {
      if (shouldLogError(tokenId)) {
        log(`⚠️ Orderbook fetch failed (${res.status}) for tokenId ${tokenId.slice(0, 18)}...`);
      }
      return { ok: false, bestBid: null, bestAsk: null, status: res.status };
    }

    const data: OrderbookResponse = await res.json();

    // The CLOB API does not guarantee array ordering.
    // Compute best levels defensively: bestBid = max(bids), bestAsk = min(asks).
    const bidPrices = (data.bids ?? [])
      .map((x) => Number.parseFloat(x.price))
      .filter((p) => Number.isFinite(p) && p > 0);

    const askPrices = (data.asks ?? [])
      .map((x) => Number.parseFloat(x.price))
      .filter((p) => Number.isFinite(p) && p > 0);

    const bestBid = bidPrices.length > 0 ? Math.max(...bidPrices) : null;
    const bestAsk = askPrices.length > 0 ? Math.min(...askPrices) : null;

    return { ok: true, bestBid, bestAsk };
  } catch (err) {
    if (shouldLogError(tokenId)) {
      log(`⚠️ Orderbook fetch error for tokenId ${tokenId.slice(0, 18)}... (${String(err)})`);
    }
    return { ok: false, bestBid: null, bestAsk: null };
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

  const out: Partial<PriceState> = {
    lastUpdate: Date.now(),
  };

  // Only overwrite cached prices when the HTTP call succeeded.
  if (upBook.ok) {
    out.upBestBid = upBook.bestBid;
    out.upBestAsk = upBook.bestAsk;
  }
  if (downBook.ok) {
    out.downBestBid = downBook.bestBid;
    out.downBestAsk = downBook.bestAsk;
  }

  return out;
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

