import crypto from 'crypto';
import { config } from './config.js';

const CLOB_URL = 'https://clob.polymarket.com';

interface OrderRequest {
  tokenId: string;
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
  orderType?: 'GTC' | 'GTD' | 'FOK';
}

interface OrderResponse {
  success: boolean;
  orderId?: string;
  avgPrice?: number;
  filledSize?: number;
  error?: string;
}

// Generate L1 authentication headers for Polymarket CLOB
function generateAuthHeaders(method: string, path: string, body?: string): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const message = timestamp + method + path + (body || '');
  
  const signature = crypto
    .createHmac('sha256', Buffer.from(config.polymarket.apiSecret, 'base64'))
    .update(message)
    .digest('base64');

  return {
    'POLY_API_KEY': config.polymarket.apiKey,
    'POLY_SIGNATURE': signature,
    'POLY_TIMESTAMP': timestamp,
    'POLY_PASSPHRASE': config.polymarket.passphrase,
    'Content-Type': 'application/json',
  };
}

export async function placeOrder(order: OrderRequest): Promise<OrderResponse> {
  const path = '/order';
  const body = JSON.stringify({
    token_id: order.tokenId,
    side: order.side,
    price: order.price.toString(),
    size: order.size.toString(),
    type: order.orderType || 'GTC',
  });

  const headers = generateAuthHeaders('POST', path, body);

  console.log(`📤 Placing order: ${order.side} ${order.size} @ ${(order.price * 100).toFixed(0)}¢`);

  try {
    const response = await fetch(`${CLOB_URL}${path}`, {
      method: 'POST',
      headers,
      body,
    });

    const responseText = await response.text();
    
    if (!response.ok) {
      console.error(`❌ Order failed (${response.status}): ${responseText.slice(0, 200)}`);
      
      // Check for Cloudflare block
      if (responseText.includes('Cloudflare') || responseText.includes('blocked')) {
        return { success: false, error: 'Cloudflare blocked - check your IP/VPN' };
      }
      
      return { success: false, error: `HTTP ${response.status}: ${responseText.slice(0, 100)}` };
    }

    const data = JSON.parse(responseText);
    console.log(`✅ Order placed: ${data.id || 'unknown'}`);
    
    return {
      success: true,
      orderId: data.id,
      avgPrice: parseFloat(data.avg_price || order.price),
      filledSize: parseFloat(data.filled_size || order.size),
    };
  } catch (error) {
    console.error(`❌ Order error:`, error);
    return { success: false, error: String(error) };
  }
}

export async function getBalance(): Promise<{ usdc: number; error?: string }> {
  // Note: Balance check requires wallet address - for now just return 0
  // Real balance would come from on-chain or Polymarket portfolio API
  return { usdc: 0 };
}

export async function testConnection(): Promise<boolean> {
  console.log('🔌 Testing Polymarket connection...');
  
  try {
    // Test with the public orderbook endpoint (no auth needed)
    const response = await fetch(`${CLOB_URL}/tick-sizes`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });

    if (!response.ok) {
      const text = await response.text();
      if (text.includes('Cloudflare') || text.includes('blocked')) {
        console.error('❌ Cloudflare blocked - you need a VPN or residential IP');
        return false;
      }
      console.error(`❌ Connection failed: HTTP ${response.status}`);
      return false;
    }

    console.log('✅ Connected to Polymarket CLOB!');
    return true;
  } catch (error) {
    console.error('❌ Connection error:', error);
    return false;
  }
}
