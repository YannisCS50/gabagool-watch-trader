/**
 * V29 Trading Functions
 * 
 * Direct order placement on Polymarket CLOB
 * No pre-signing, just real-time orders at best ask + buffer
 */

import { getClient } from '../polymarket.js';
import { Side, OrderType } from '@polymarket/clob-client';
import type { Asset } from './config.js';
import type { Signal, Position } from './types.js';

function log(msg: string): void {
  console.log(`[V29:Trade] ${msg}`);
}

interface OrderResult {
  success: boolean;
  orderId?: string;
  avgPrice?: number;
  filledSize?: number;
  error?: string;
  latencyMs: number;
}

/**
 * Place a BUY order at a specific price
 * Uses GTC (Good-Till-Cancelled) for partial fills
 */
export async function placeBuyOrder(
  tokenId: string,
  price: number,
  shares: number
): Promise<OrderResult> {
  const start = Date.now();
  
  try {
    const client = await getClient();
    
    // Round price to 2 decimals (tick size)
    const roundedPrice = Math.round(price * 100) / 100;
    
    // Round shares to whole numbers (safest for USDC precision)
    const roundedShares = Math.floor(shares);
    
    if (roundedShares < 1) {
      return {
        success: false,
        error: 'Shares < 1 after rounding',
        latencyMs: Date.now() - start,
      };
    }
    
    log(`📤 BUY ${roundedShares} shares @ ${(roundedPrice * 100).toFixed(1)}¢`);
    
    // Create and post order
    const signedOrder = await client.createOrder(
      {
        tokenID: tokenId,
        price: roundedPrice,
        size: roundedShares,
        side: Side.BUY,
      },
      {
        tickSize: '0.01',
        negRisk: false,
      }
    );
    
    // Post the order
    const response = await client.postOrder(signedOrder, OrderType.GTC);
    
    const latencyMs = Date.now() - start;
    
    // Check response
    if (response.success) {
      const filledSize = response.orderID ? roundedShares : 0;
      
      log(`✅ Order placed: ${response.orderID ?? 'no-id'} (${latencyMs}ms)`);
      
      return {
        success: true,
        orderId: response.orderID,
        avgPrice: roundedPrice,
        filledSize,
        latencyMs,
      };
    } else {
      log(`❌ Order failed: ${response.errorMsg ?? 'unknown'}`);
      return {
        success: false,
        error: response.errorMsg ?? 'Order rejected',
        latencyMs,
      };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`❌ Order error: ${msg}`);
    return {
      success: false,
      error: msg,
      latencyMs: Date.now() - start,
    };
  }
}

/**
 * Place a SELL order to close a position
 */
export async function placeSellOrder(
  tokenId: string,
  price: number,
  shares: number
): Promise<OrderResult> {
  const start = Date.now();
  
  try {
    const client = await getClient();
    
    const roundedPrice = Math.round(price * 100) / 100;
    const roundedShares = Math.floor(shares);
    
    if (roundedShares < 1) {
      return {
        success: false,
        error: 'Shares < 1',
        latencyMs: Date.now() - start,
      };
    }
    
    log(`📤 SELL ${roundedShares} shares @ ${(roundedPrice * 100).toFixed(1)}¢`);
    
    const signedOrder = await client.createOrder(
      {
        tokenID: tokenId,
        price: roundedPrice,
        size: roundedShares,
        side: Side.SELL,
      },
      {
        tickSize: '0.01',
        negRisk: false,
      }
    );
    
    const response = await client.postOrder(signedOrder, OrderType.GTC);
    
    const latencyMs = Date.now() - start;
    
    if (response.success) {
      log(`✅ Sell order: ${response.orderID ?? 'no-id'} (${latencyMs}ms)`);
      return {
        success: true,
        orderId: response.orderID,
        avgPrice: roundedPrice,
        filledSize: roundedShares,
        latencyMs,
      };
    } else {
      return {
        success: false,
        error: response.errorMsg ?? 'Sell rejected',
        latencyMs,
      };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: msg,
      latencyMs: Date.now() - start,
    };
  }
}

/**
 * Get current wallet balance
 */
export async function getBalance(): Promise<number> {
  try {
    const client = await getClient();
    const balances = await client.getBalanceAllowance();
    
    // balances can be number or string
    const available = typeof balances === 'number' 
      ? balances 
      : parseFloat(String(balances)) || 0;
    
    return available;
  } catch (err) {
    log(`⚠️ Balance fetch failed: ${err}`);
    return 0;
  }
}
