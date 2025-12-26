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
  status?: 'filled' | 'partial' | 'open' | 'pending' | 'unknown';
}

// Singleton ClobClient instance
let clobClient: ClobClient | null = null;

// Simple in-process throttling/backoff to reduce WAF triggers
let lastOrderAttemptAtMs = 0;
let blockedUntilMs = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getClient(): Promise<ClobClient> {
  if (clobClient) {
    return clobClient;
  }

  console.log('🔧 Initializing Polymarket CLOB client...');
  console.log(`\n${'='.repeat(60)}`);
  console.log(`🔐 AUTH CONFIGURATION DEBUG`);
  console.log(`${'='.repeat(60)}`);

  const signer = new Wallet(config.polymarket.privateKey);
  const signerAddress = signer.address;

  console.log(`📍 Signer (from private key): ${signerAddress}`);
  console.log(`📍 POLYMARKET_ADDRESS (funder): ${config.polymarket.address}`);
  console.log(`📍 API Key: ${config.polymarket.apiKey.slice(0, 12)}...`);
  console.log(`📍 Passphrase: ${config.polymarket.passphrase.slice(0, 12)}...`);
  
  // Critical validation: for signature type 2 (Safe proxy):
  // - signer = your EOA (private key holder, does the signing)
  // - funder = your Polymarket Safe wallet address (where funds are)
  // - API key must be registered for the funder address
  
  if (signerAddress.toLowerCase() === config.polymarket.address.toLowerCase()) {
    console.log(`⚠️ WARNING: Signer and funder are the SAME address.`);
    console.log(`   This is only correct if you're NOT using a Safe proxy wallet.`);
    console.log(`   For Polymarket, you typically have:`);
    console.log(`   - Signer: your EOA (MetaMask wallet)`);
    console.log(`   - Funder: your Polymarket Safe proxy`);
  } else {
    console.log(`✅ Signer ≠ Funder (correct for Safe proxy setup)`);
    console.log(`   Signer (EOA): ${signerAddress}`);
    console.log(`   Funder (Safe): ${config.polymarket.address}`);
  }
  
  // Log current system time for timestamp debugging
  console.log(`\n⏰ System time: ${new Date().toISOString()}`);
  console.log(`   Unix timestamp (seconds): ${Math.floor(Date.now() / 1000)}`);
  console.log(`${'='.repeat(60)}\n`);

  // API credentials from Polymarket
  const apiCreds = {
    key: config.polymarket.apiKey,
    secret: config.polymarket.apiSecret,
    passphrase: config.polymarket.passphrase,
  };

  // Signature type 2 = Safe proxy wallet (Polymarket default)
  // - signer: EOA that controls the Safe
  // - funder: The Safe proxy wallet address where USDC lives
  clobClient = new ClobClient(
    CLOB_URL,
    CHAIN_ID,
    signer,
    apiCreds,
    2, // signatureType: 2 for Safe proxy
    config.polymarket.address // funder address (your Polymarket Safe address)
  );

  console.log(`✅ CLOB client initialized`);
  console.log(`   Signer (EOA): ${signerAddress}`);
  console.log(`   Funder (Safe): ${config.polymarket.address}`);
  return clobClient;
}

export async function placeOrder(order: OrderRequest): Promise<OrderResponse> {
  const nowMs = Date.now();

  // Hard backoff after Cloudflare/WAF blocks
  if (blockedUntilMs && nowMs < blockedUntilMs) {
    const remainingMs = blockedUntilMs - nowMs;
    return {
      success: false,
      error: `Cloudflare blocked (cooldown ${Math.ceil(remainingMs / 1000)}s)`,
    };
  }

  // Throttle order attempts to avoid spamming WAF
  const minIntervalMs = Math.max(0, config.trading.minOrderIntervalMs || 0);
  const sinceLastMs = nowMs - lastOrderAttemptAtMs;
  if (lastOrderAttemptAtMs > 0 && sinceLastMs < minIntervalMs) {
    const waitMs = minIntervalMs - sinceLastMs;
    console.log(`⏱️ Throttling order: waiting ${waitMs}ms`);
    await sleep(waitMs);
  }
  lastOrderAttemptAtMs = Date.now();

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
    console.log(`🔍 POLYMARKET ORDER REQUEST - ${new Date().toISOString()}`);
    console.log(`${'='.repeat(60)}`);
    
    // Log auth context for debugging 401s
    const signer = new Wallet(config.polymarket.privateKey);
    console.log(`🔐 AUTH CONTEXT:`);
    console.log(`   - POLY_ADDRESS header will be: ${signer.address}`);
    console.log(`   - API Key (owner): ${config.polymarket.apiKey.slice(0, 12)}...`);
    console.log(`   - Order maker (Safe): ${config.polymarket.address}`);
    console.log(`   - Order signer (EOA): ${signer.address}`);
    console.log(`   - Current timestamp (s): ${Math.floor(Date.now() / 1000)}`);
    
    // Verify API key format (should be UUID)
    const apiKeyIsUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(config.polymarket.apiKey);
    console.log(`   - API Key is valid UUID: ${apiKeyIsUUID}`);
    
    console.log(`\n📤 Order parameters:`);
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
    
    // Also check if response is wrapped in .data (Axios style)
    const actualResponse = (response as any)?.data ?? response;
    console.log(`\n📋 ACTUAL RESPONSE (after .data check):`);
    console.log(JSON.stringify(actualResponse, null, 2));
    
    console.log(`\n📋 RESPONSE KEYS: ${response ? Object.keys(response).join(', ') : 'null/undefined'}`);
    console.log(`📋 ACTUAL RESPONSE KEYS: ${actualResponse ? Object.keys(actualResponse).join(', ') : 'null/undefined'}`);
    
    // Check all possible locations for order ID and status
    console.log(`\n📋 FIELD SEARCH:`);
    console.log(`   - response.success: ${(response as any)?.success}`);
    console.log(`   - response.orderID: ${(response as any)?.orderID}`);
    console.log(`   - response.orderId: ${(response as any)?.orderId}`);
    console.log(`   - response.status: ${(response as any)?.status}`);
    console.log(`   - response.errorMsg: ${(response as any)?.errorMsg}`);
    console.log(`   - actualResponse.success: ${actualResponse?.success}`);
    console.log(`   - actualResponse.orderID: ${actualResponse?.orderID}`);
    console.log(`   - actualResponse.orderId: ${actualResponse?.orderId}`);
    console.log(`   - actualResponse.status: ${actualResponse?.status}`);
    console.log(`   - actualResponse.errorMsg: ${actualResponse?.errorMsg}`);
    console.log(`${'='.repeat(60)}\n`);

    // Use actualResponse for all checks
    const resp = actualResponse;

    // Check for explicit failure
    if (resp?.success === false || resp?.errorMsg) {
      console.error(`❌ Order failed: ${resp?.errorMsg || 'Unknown error'}`);
      return { success: false, error: resp?.errorMsg || 'Order failed' };
    }

    // Extract order ID - check both SDK (orderID) and REST (orderId) formats
    const orderId = resp?.orderID || resp?.orderId || (response as any)?.orderID || (response as any)?.orderId;

    if (!orderId || (typeof orderId === 'string' && orderId.trim() === '')) {
      console.error('❌ Order response had no order ID - NOT treating as filled');
      console.error('   This means the order was likely NOT placed successfully');
      return { success: false, error: 'No order ID returned - order not placed' };
    }

    console.log(`✅ Order placed with ID: ${orderId}`);
    console.log(`   Status from response: ${resp?.status || 'unknown'}`);

    // Now verify the order exists and get fill status
    try {
      console.log(`🔍 Verifying order ${orderId} via getOrder()...`);
      const orderDetails = await client.getOrder(orderId);
      console.log(`📋 Order details:`, JSON.stringify(orderDetails, null, 2));
      
      const originalSize = parseFloat(orderDetails?.original_size || orderDetails?.originalSize || '0');
      const sizeMatched = parseFloat(orderDetails?.size_matched || orderDetails?.sizeMatched || '0');
      const orderStatus = orderDetails?.status;
      
      console.log(`   - Original size: ${originalSize}`);
      console.log(`   - Size matched: ${sizeMatched}`);
      console.log(`   - Order status: ${orderStatus}`);
      
      // Determine actual fill status
      let fillStatus: 'filled' | 'partial' | 'open' | 'unknown';
      if (sizeMatched >= originalSize && originalSize > 0) {
        fillStatus = 'filled';
      } else if (sizeMatched > 0) {
        fillStatus = 'partial';
      } else if (orderStatus === 'live') {
        fillStatus = 'open';
      } else {
        fillStatus = 'unknown';
      }
      
      console.log(`   ➡️ Fill status: ${fillStatus}`);
      
      return {
        success: true,
        orderId,
        avgPrice: order.price,
        filledSize: sizeMatched > 0 ? sizeMatched : undefined,
        status: fillStatus,
      };
    } catch (verifyError: any) {
      console.warn(`⚠️ Could not verify order: ${verifyError?.message}`);
      // Order was placed but we couldn't verify - return as pending
      return {
        success: true,
        orderId,
        avgPrice: order.price,
        status: 'pending',
      };
    }
  } catch (error: any) {
    const errorMsg = error?.message || String(error);
    
    // Enhanced error logging for Cloudflare/WAF detection
    console.error(`\n${'='.repeat(60)}`);
    console.error(`❌ ORDER ERROR - ${new Date().toISOString()}`);
    console.error(`${'='.repeat(60)}`);
    console.error(`   Message: ${errorMsg}`);
    
    // Check for HTTP response details (Axios-style errors)
    if (error?.response) {
      const status = error.response.status;
      const contentType = error.response.headers?.['content-type'] || 'unknown';
      const dataPreview = typeof error.response.data === 'string' 
        ? error.response.data.slice(0, 300) 
        : JSON.stringify(error.response.data)?.slice(0, 300);
      
      console.error(`   HTTP Status: ${status}`);
      console.error(`   Content-Type: ${contentType}`);
      console.error(`   Response Preview: ${dataPreview}`);
      
      // Detect Cloudflare block
      if (status === 403 && (contentType.includes('text/html') || dataPreview?.includes('Cloudflare') || dataPreview?.includes('blocked'))) {
        blockedUntilMs = Date.now() + Math.max(1000, config.trading.cloudflareBackoffMs || 60000);

        console.error(`\n   🚨 CLOUDFLARE WAF BLOCK DETECTED!`);
        console.error(`   Your IP is blocked by Polymarket's Cloudflare protection.`);
        console.error(`   Cooling down for ${Math.ceil((blockedUntilMs - Date.now()) / 1000)}s to avoid repeated blocks.`);
        console.error(`   Solutions:`);
        console.error(`     1. Use a VPN with residential IP`);
        console.error(`     2. Don't run from datacenter IPs`);
        console.error(`     3. Contact Polymarket support with Ray ID from response`);
        return { success: false, error: 'Cloudflare blocked - use VPN with residential IP' };
      }
    }
    
    // Check for fetch-style errors
    if (errorMsg.includes('403') || errorMsg.includes('Forbidden')) {
      console.error(`   🚨 Likely Cloudflare block (403 in message)`);
      return { success: false, error: 'Cloudflare blocked - check your IP/VPN' };
    }
    
    if (errorMsg.includes('Cloudflare') || errorMsg.includes('blocked') || errorMsg.includes('Ray ID')) {
      console.error(`   🚨 Cloudflare block detected in error message`);
      return { success: false, error: 'Cloudflare blocked - use VPN with residential IP' };
    }
    
    console.error(`${'='.repeat(60)}\n`);

    // Other common errors
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
