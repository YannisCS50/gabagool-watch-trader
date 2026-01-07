/**
 * v8 Execution Adapter
 * 
 * Wraps the existing order placement infrastructure with v8-specific enforcement:
 * - INV-4: SINGLE OUTSTANDING ORDER per (market, token, intent)
 * - INV-3: BOOK FRESHNESS at last mile
 * - INV-2: NO-CROSSING validation
 * 
 * This adapter bridges between v8 types and the existing Polymarket CLOB client.
 */

import { V8 } from './config.js';
import { validateMakerPrice, isBookFresh, type BookTop } from './priceGuard.js';
import type { ExecutionV8, OrderReqV8, OrderResV8, TokenSide, Intent } from './types.js';

/**
 * Order tracking key
 */
function orderKey(marketId: string, token: TokenSide, intent: Intent): string {
  return `${marketId}|${token}|${intent}`;
}

/**
 * PlaceOrder function signature (matches existing polymarket.ts)
 */
export type PlaceOrderFn = (req: {
  tokenId: string;
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
  orderType?: 'GTC' | 'GTD' | 'FOK';
  intent?: string;
  spread?: number;
}) => Promise<{
  success: boolean;
  orderId?: string;
  avgPrice?: number;
  filledSize?: number;
  error?: string;
  status?: string;
  failureReason?: string;
}>;

/**
 * GetOrderbookDepth function signature
 */
export type GetOrderbookDepthFn = (tokenId: string) => Promise<{
  tokenId: string;
  topAsk: number | null;
  topBid: number | null;
  askVolume: number;
  bidVolume: number;
  hasLiquidity: boolean;
}>;

/**
 * Cancel orders function signature
 */
export type CancelOrdersFn = (orderIds: string[]) => Promise<void>;

/**
 * Token ID resolver
 */
export type TokenIdResolver = (marketId: string, token: TokenSide) => string | undefined;

/**
 * v8 Execution Adapter Configuration
 */
export interface ExecutionAdapterConfig {
  placeOrder: PlaceOrderFn;
  getOrderbookDepth: GetOrderbookDepthFn;
  cancelOrders?: CancelOrdersFn;
  resolveTokenId: TokenIdResolver;
}

/**
 * Order in flight tracking
 */
interface InFlightOrder {
  orderId: string;
  marketId: string;
  token: TokenSide;
  intent: Intent;
  placedTs: number;
  correlationId?: string;
}

/**
 * v8 Execution Adapter
 */
export class ExecutionAdapterV8 implements ExecutionV8 {
  private config: ExecutionAdapterConfig;
  
  // INV-4: Track open orders per (market, token, intent)
  private openOrders = new Map<string, InFlightOrder>();
  
  // Order ID to key mapping for cleanup
  private orderIdToKey = new Map<string, string>();
  
  constructor(config: ExecutionAdapterConfig) {
    this.config = config;
  }
  
  /**
   * Get number of open orders for a specific market/token/intent
   */
  getOpenOrders(marketId: string, token: TokenSide, intent: Intent): number {
    const key = orderKey(marketId, token, intent);
    return this.openOrders.has(key) ? 1 : 0;
  }
  
  /**
   * Place a limit order with v8 enforcement
   */
  async placeLimit(req: OrderReqV8): Promise<OrderResV8> {
    const key = orderKey(req.marketId, req.token, req.intent);
    
    // INV-4: Check for existing order
    if (this.openOrders.has(key)) {
      console.log(`[V8_EXEC] Blocked: order already in flight for ${key}`);
      return { ok: false, reason: 'ORDER_IN_FLIGHT' };
    }
    
    // Resolve token ID
    const tokenId = this.config.resolveTokenId(req.marketId, req.token);
    if (!tokenId) {
      return { ok: false, reason: 'TOKEN_NOT_FOUND' };
    }
    
    // INV-3: Last-mile book freshness check
    const depth = await this.config.getOrderbookDepth(tokenId);
    if (depth.topBid === null || depth.topAsk === null) {
      return { ok: false, reason: 'NO_BOOK' };
    }
    
    // INV-2: Last-mile no-crossing check
    const book: BookTop = {
      bestBid: depth.topBid,
      bestAsk: depth.topAsk,
      ageMs: 0, // Fresh from API
    };
    
    const validation = validateMakerPrice(req.side, req.price, V8.execution.tick, book);
    if (!validation.ok) {
      console.log(`[V8_EXEC] Price validation failed: ${validation.reason} for ${req.marketId} ${req.token}`);
      return { ok: false, reason: validation.reason };
    }
    
    // Use validated price
    const finalPrice = validation.price;
    
    try {
      // Mark order as in flight BEFORE placing
      const tempOrder: InFlightOrder = {
        orderId: 'pending',
        marketId: req.marketId,
        token: req.token,
        intent: req.intent,
        placedTs: Date.now(),
        correlationId: req.correlationId,
      };
      this.openOrders.set(key, tempOrder);
      
      // Place order through existing infrastructure
      const result = await this.config.placeOrder({
        tokenId,
        side: req.side,
        price: finalPrice,
        size: req.size,
        orderType: 'GTC',
        intent: req.intent,
        spread: book.bestAsk - book.bestBid,
      });
      
      if (result.success && result.orderId) {
        // Update with actual order ID
        const order: InFlightOrder = {
          orderId: result.orderId,
          marketId: req.marketId,
          token: req.token,
          intent: req.intent,
          placedTs: Date.now(),
          correlationId: req.correlationId,
        };
        this.openOrders.set(key, order);
        this.orderIdToKey.set(result.orderId, key);
        
        console.log(`[V8_EXEC] Order placed: ${result.orderId} ${req.marketId} ${req.token} ${req.intent} @ ${(finalPrice * 100).toFixed(0)}¢`);
        
        return {
          ok: true,
          orderId: result.orderId,
          avgPrice: result.avgPrice,
          filledSize: result.filledSize,
        };
      } else {
        // Failed - remove from tracking
        this.openOrders.delete(key);
        
        return {
          ok: false,
          reason: result.error ?? result.failureReason ?? 'UNKNOWN_ERROR',
        };
      }
    } catch (error: any) {
      // Error - remove from tracking
      this.openOrders.delete(key);
      
      console.error(`[V8_EXEC] Order error: ${error.message}`);
      return { ok: false, reason: error.message };
    }
  }
  
  /**
   * Cancel orders by intent
   */
  async cancelIntent(marketId: string, token: TokenSide, intent: Intent): Promise<void> {
    const key = orderKey(marketId, token, intent);
    const order = this.openOrders.get(key);
    
    if (!order || !this.config.cancelOrders) {
      return;
    }
    
    try {
      await this.config.cancelOrders([order.orderId]);
      this.openOrders.delete(key);
      this.orderIdToKey.delete(order.orderId);
      console.log(`[V8_EXEC] Cancelled ${order.orderId} for ${key}`);
    } catch (error: any) {
      console.error(`[V8_EXEC] Cancel error: ${error.message}`);
    }
  }
  
  /**
   * Mark order as filled/completed (called by fill handler)
   */
  onOrderComplete(orderId: string): void {
    const key = this.orderIdToKey.get(orderId);
    if (key) {
      this.openOrders.delete(key);
      this.orderIdToKey.delete(orderId);
    }
  }
  
  /**
   * Mark order as cancelled
   */
  onOrderCancelled(orderId: string): void {
    this.onOrderComplete(orderId);
  }
  
  /**
   * Clean up stale orders (orders older than timeout)
   */
  cleanupStaleOrders(timeoutMs: number = 60_000): number {
    const now = Date.now();
    let cleaned = 0;
    
    for (const [key, order] of this.openOrders) {
      if (now - order.placedTs > timeoutMs) {
        this.openOrders.delete(key);
        this.orderIdToKey.delete(order.orderId);
        cleaned++;
        console.log(`[V8_EXEC] Cleaned stale order: ${order.orderId}`);
      }
    }
    
    return cleaned;
  }
  
  /**
   * Get all open orders (for debugging)
   */
  getAllOpenOrders(): InFlightOrder[] {
    return Array.from(this.openOrders.values());
  }
  
  /**
   * Clear all tracking (for cleanup/shutdown)
   */
  clear(): void {
    this.openOrders.clear();
    this.orderIdToKey.clear();
  }
}

/**
 * Create execution adapter with dependency injection
 */
export function createExecutionAdapter(config: ExecutionAdapterConfig): ExecutionAdapterV8 {
  return new ExecutionAdapterV8(config);
}
