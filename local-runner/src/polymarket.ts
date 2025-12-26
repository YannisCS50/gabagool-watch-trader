import { ClobClient, Side, OrderType } from '@polymarket/clob-client';
import { Wallet } from 'ethers';
import { config } from './config.js';

const CLOB_URL = 'https://clob.polymarket.com';
const CHAIN_ID = 137; // Polygon mainnet

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

// Singleton ClobClient instance
let clobClient: ClobClient | null = null;

async function getClient(): Promise<ClobClient> {
  if (clobClient) {
    return clobClient;
  }

  console.log('🔧 Initializing Polymarket CLOB client...');

  const signer = new Wallet(config.polymarket.privateKey);

  // API credentials from Polymarket
  const apiCreds = {
    key: config.polymarket.apiKey,
    secret: config.polymarket.apiSecret,
    passphrase: config.polymarket.passphrase,
  };

  // Signature type 2 = Safe proxy wallet (Polymarket default)
  // Funder address = your Polymarket wallet address
  clobClient = new ClobClient(
    CLOB_URL,
    CHAIN_ID,
    signer,
    apiCreds,
    2, // signatureType: 2 for Safe proxy
    config.polymarket.address // funder address (your Polymarket profile address)
  );

  console.log(`✅ CLOB client initialized for ${config.polymarket.address}`);
  return clobClient;
}

export async function placeOrder(order: OrderRequest): Promise<OrderResponse> {
  console.log(`📤 Placing order: ${order.side} ${order.size} @ ${(order.price * 100).toFixed(0)}¢`);

  try {
    const client = await getClient();

    const side = order.side === 'BUY' ? Side.BUY : Side.SELL;
    let orderType: OrderType;
    switch (order.orderType) {
      case 'FOK':
        orderType = OrderType.FOK;
        break;
      case 'GTD':
        orderType = OrderType.GTD;
        break;
      default:
        orderType = OrderType.GTC;
    }

    // Use createAndPostOrder which handles order signing
    console.log(`\n${'='.repeat(60)}`);
    console.log(`🔍 POLYMARKET API DEBUG - ${new Date().toISOString()}`);
    console.log(`${'='.repeat(60)}`);
    console.log(`📤 Request parameters:`);
    console.log(`   - tokenID: ${order.tokenId}`);
    console.log(`   - price: ${order.price}`);
    console.log(`   - size: ${order.size}`);
    console.log(`   - side: ${side}`);
    console.log(`   - orderType: ${orderType}`);
    
    const response = await client.createAndPostOrder(
      {
        tokenID: order.tokenId,
        price: order.price,
        size: order.size,
        side,
      },
      {
        tickSize: '0.01', // Standard tick size for most markets
        negRisk: false,   // Set based on market type
      },
      orderType
    );

    // Log EVERYTHING about the response
    console.log(`\n📋 RAW RESPONSE TYPE: ${typeof response}`);
    console.log(`📋 RAW RESPONSE (JSON):`);
    console.log(JSON.stringify(response, null, 2));
    
    console.log(`\n📋 RESPONSE KEYS: ${response ? Object.keys(response).join(', ') : 'null/undefined'}`);
    
    if (response && typeof response === 'object') {
      console.log(`\n📋 INDIVIDUAL FIELDS:`);
      console.log(`   - response.success: ${(response as any).success}`);
      console.log(`   - response.orderID: ${(response as any).orderID}`);
      console.log(`   - response.orderId: ${(response as any).orderId}`);
      console.log(`   - response.order_id: ${(response as any).order_id}`);
      console.log(`   - response.id: ${(response as any).id}`);
      console.log(`   - response.errorMsg: ${(response as any).errorMsg}`);
      console.log(`   - response.error: ${(response as any).error}`);
      console.log(`   - response.order: ${JSON.stringify((response as any).order)}`);
      console.log(`   - response.data: ${JSON.stringify((response as any).data)}`);
      console.log(`   - response.result: ${JSON.stringify((response as any).result)}`);
      console.log(`   - response.orderIds: ${JSON.stringify((response as any).orderIds)}`);
      
      // Check if response is an array
      if (Array.isArray(response)) {
        console.log(`\n📋 RESPONSE IS AN ARRAY with ${response.length} items:`);
        response.forEach((item, i) => {
          console.log(`   [${i}]: ${JSON.stringify(item)}`);
        });
      }
    }
    console.log(`${'='.repeat(60)}\n`);

    if ((response as any).success === false || (response as any).errorMsg) {
      console.error(`❌ Order failed: ${(response as any).errorMsg || 'Unknown error'}`);
      return { success: false, error: (response as any).errorMsg || 'Order failed' };
    }

    const extractOrderId = (resp: any): string | undefined => {
      if (!resp) return undefined;
      if (Array.isArray(resp)) return extractOrderId(resp[0]);

      const candidates: unknown[] = [
        resp.orderID,
        resp.orderId,
        resp.order_id,
        resp.id,
        resp?.data?.orderID,
        resp?.data?.orderId,
        resp?.data?.order_id,
        resp?.data?.id,
        resp?.order?.orderID,
        resp?.order?.orderId,
        resp?.order?.order_id,
        resp?.order?.id,
        resp?.result?.orderID,
        resp?.result?.orderId,
        resp?.result?.order_id,
        resp?.result?.id,
        resp?.orderIds?.[0],
        resp?.data?.orderIds?.[0],
      ];

      const found = candidates.find((x) =>
        (typeof x === 'string' && x.trim().length > 0) || typeof x === 'number' || typeof x === 'bigint'
      );
      return found !== undefined ? String(found) : undefined;
    };

    // Extract order ID from various possible response formats
    const orderId = extractOrderId(response);

    if (!orderId) {
      console.error('❌ Order response had no order ID; treating as failure to avoid false "filled" status.');
      return { success: false, error: 'No order id returned by Polymarket API' };
    }

    console.log(`✅ Order placed: ${orderId}`);

    return {
      success: true,
      orderId,
      avgPrice: order.price,
      filledSize: order.size,
    };
  } catch (error: any) {
    const errorMsg = error?.message || String(error);
    console.error(`❌ Order error:`, errorMsg);

    // Check for common errors
    if (errorMsg.includes('Cloudflare') || errorMsg.includes('blocked')) {
      return { success: false, error: 'Cloudflare blocked - check your IP/VPN' };
    }
    if (errorMsg.includes('401') || errorMsg.includes('Unauthorized')) {
      return { success: false, error: 'Invalid API key - regenerate on Polymarket' };
    }
    if (errorMsg.includes('insufficient')) {
      return { success: false, error: 'Insufficient balance' };
    }

    return { success: false, error: errorMsg };
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
    // Test with a known public endpoint
    const response = await fetch(`${CLOB_URL}/markets?limit=1`, {
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
