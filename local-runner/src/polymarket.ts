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
  failureReason?: 'no_liquidity' | 'cloudflare' | 'auth' | 'balance' | 'no_orderbook' | 'unknown';
}

export interface OrderbookDepth {
  tokenId: string;
  topAsk: number | null;
  topBid: number | null;
  askVolume: number; // Total volume at top 3 ask levels
  bidVolume: number; // Total volume at top 3 bid levels
  hasLiquidity: boolean;
  levels: { price: number; size: number }[];
}

// Singleton ClobClient instance
let clobClient: ClobClient | null = null;

// Simple in-process throttling/backoff to reduce WAF triggers
let lastOrderAttemptAtMs = 0;
let blockedUntilMs = 0;

// Cache for orderbook existence checks
const orderbookCache = new Map<string, boolean>();

// Dynamic credentials (can be auto-derived)
let derivedCreds: { key: string; secret: string; passphrase: string } | null = null;

async function orderbookExists(tokenId: string): Promise<boolean> {
  if (orderbookCache.has(tokenId)) {
    return orderbookCache.get(tokenId)!;
  }
  
  try {
    const res = await fetch(`${CLOB_URL}/book?token_id=${tokenId}`);
    const exists = res.status === 200;
    orderbookCache.set(tokenId, exists);
    
    if (!exists) {
      console.log(`📕 Orderbook check: tokenId ${tokenId.slice(0, 20)}... → ${res.status} (does not exist)`);
    }
    
    return exists;
  } catch (error) {
    console.error(`⚠️ Orderbook check failed for ${tokenId.slice(0, 20)}...:`, error);
    // Don't cache errors - allow retry
    return false;
  }
}

// Cache for orderbook depth (short TTL - 5 seconds)
const orderbookDepthCache = new Map<string, { depth: OrderbookDepth; fetchedAt: number }>();
const DEPTH_CACHE_TTL_MS = 5000;

/**
 * Fetch orderbook depth for a token - returns volume at top levels
 * Useful to check if there's enough liquidity before placing an order
 */
export async function getOrderbookDepth(tokenId: string): Promise<OrderbookDepth> {
  const cached = orderbookDepthCache.get(tokenId);
  if (cached && Date.now() - cached.fetchedAt < DEPTH_CACHE_TTL_MS) {
    return cached.depth;
  }

  const emptyDepth: OrderbookDepth = {
    tokenId,
    topAsk: null,
    topBid: null,
    askVolume: 0,
    bidVolume: 0,
    hasLiquidity: false,
    levels: [],
  };

  try {
    const res = await fetch(`${CLOB_URL}/book?token_id=${tokenId}`);
    if (res.status !== 200) {
      console.log(`📕 No orderbook for ${tokenId.slice(0, 20)}... (${res.status})`);
      return emptyDepth;
    }

    const book = await res.json();
    const asks = (book.asks || []) as { price: string; size: string }[];
    const bids = (book.bids || []) as { price: string; size: string }[];

    // Sum volume at top 3 levels
    const topAsks = asks.slice(0, 3);
    const topBids = bids.slice(0, 3);
    
    const askVolume = topAsks.reduce((sum, l) => sum + parseFloat(l.size), 0);
    const bidVolume = topBids.reduce((sum, l) => sum + parseFloat(l.size), 0);
    
    const topAsk = asks.length > 0 ? parseFloat(asks[0].price) : null;
    const topBid = bids.length > 0 ? parseFloat(bids[0].price) : null;

    const depth: OrderbookDepth = {
      tokenId,
      topAsk,
      topBid,
      askVolume,
      bidVolume,
      hasLiquidity: askVolume >= 10, // At least 10 shares available
      levels: topAsks.map(l => ({ price: parseFloat(l.price), size: parseFloat(l.size) })),
    };

    orderbookDepthCache.set(tokenId, { depth, fetchedAt: Date.now() });
    
    console.log(`📊 Orderbook depth for ${tokenId.slice(0, 20)}...: ask=${topAsk?.toFixed(2) || 'none'} (${askVolume.toFixed(0)} vol), bid=${topBid?.toFixed(2) || 'none'} (${bidVolume.toFixed(0)} vol)`);
    
    return depth;
  } catch (error) {
    console.error(`⚠️ Failed to fetch orderbook depth for ${tokenId.slice(0, 20)}...:`, error);
    return emptyDepth;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isUnauthorizedError(err: any): boolean {
  const status = err?.response?.status ?? err?.status;
  const dataError = err?.response?.data?.error ?? err?.data?.error;
  const msg = String(err?.message || '').toLowerCase();

  if (status === 401) return true;
  if (msg.includes('401') || msg.includes('unauthorized')) return true;
  if (typeof dataError === 'string' && dataError.toLowerCase().includes('unauthorized')) return true;

  return false;
}

function isUnauthorizedPayload(payload: any): boolean {
  if (!payload) return false;
  const status = payload?.status;
  const err = payload?.error;

  if (status === 401) return true;
  if (typeof err === 'string' && err.toLowerCase().includes('unauthorized')) return true;

  return false;
}

/**
 * Derive fresh API credentials using the private key.
 * This creates new CLOB API keys programmatically.
 * NOTE: This only works if the wallet is properly set up on Polymarket.
 * For Safe proxy wallets, you may need to create keys manually via the Polymarket UI.
 */
async function deriveApiCredentials(): Promise<{ key: string; secret: string; passphrase: string }> {
  console.log(`\n🔄 AUTO-DERIVING NEW API CREDENTIALS...`);
  
  const signer = new Wallet(config.polymarket.privateKey);
  
  // Create a temporary client without API creds to derive new ones
  const tempClient = new ClobClient(
    CLOB_URL,
    CHAIN_ID,
    signer,
    undefined, // No creds yet
    2, // signatureType for Safe proxy
    config.polymarket.address
  );
  
  try {
    // First, delete any existing API keys for this address
    console.log(`   🗑️ Deleting existing API keys...`);
    try {
      await tempClient.deleteApiKey();
      console.log(`   ✅ Old API keys deleted`);
    } catch (deleteError: any) {
      // Ignore errors - may not have existing keys
      console.log(`   ⚠️ No existing keys to delete or delete failed`);
    }
    
    // Create new API key
    console.log(`   🔑 Creating new API key...`);
    const newCreds = await tempClient.createApiKey();
    
    // Validate response - SDK may return error payload instead of throwing
    if (!newCreds || !newCreds.apiKey || !newCreds.secret || !newCreds.passphrase) {
      const errPayload = newCreds as any;
      throw new Error(
        errPayload?.error || 
        'createApiKey returned invalid response - manual key creation required'
      );
    }
    
    console.log(`   ✅ New API credentials created!`);
    console.log(`      API Key: ${newCreds.apiKey.slice(0, 12)}...`);
    console.log(`      Secret length: ${newCreds.secret?.length || 0} chars`);
    console.log(`      Passphrase length: ${newCreds.passphrase?.length || 0} chars`);
    
    return {
      key: newCreds.apiKey,
      secret: newCreds.secret,
      passphrase: newCreds.passphrase,
    };
  } catch (error: any) {
    console.error(`   ❌ Failed to derive credentials: ${error?.message || error}`);
    console.error(`\n   🚨 MANUAL KEY CREATION REQUIRED:`);
    console.error(`      1. Go to https://polymarket.com and log in with the wallet that owns the funds (your Safe / funder).`);
    console.error(`      2. Open DevTools (F12) → Application → Local Storage`);
    console.error(`      3. Find the object that contains: key, secret, passphrase`);
    console.error(`      4. Update /home/deploy/secrets/local-runner.env with:`);
    console.error(`         POLYMARKET_API_KEY=<key>`);
    console.error(`         POLYMARKET_API_SECRET=<secret>`);
    console.error(`         POLYMARKET_PASSPHRASE=<passphrase>`);
    console.error(`      5. Restart: docker compose restart runner`);
    throw error;
  }
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
  
  // Use derived creds if available, otherwise use config
  let apiCreds = derivedCreds || {
    key: config.polymarket.apiKey,
    secret: config.polymarket.apiSecret,
    passphrase: config.polymarket.passphrase,
  };
  
  console.log(`📍 API Key: ${apiCreds.key?.slice(0, 12) || 'NOT SET'}...`);
  console.log(`📍 Passphrase: ${apiCreds.passphrase?.slice(0, 12) || 'NOT SET'}...`);
  
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

  // Check if we have valid credentials, if not try to derive
  const hasValidCreds = apiCreds.key && apiCreds.secret && apiCreds.passphrase;
  
  if (!hasValidCreds) {
    console.log(`⚠️ No valid API credentials configured - attempting auto-derive...`);
    try {
      derivedCreds = await deriveApiCredentials();
      apiCreds = derivedCreds;
    } catch (deriveError) {
      console.error(`❌ Auto-derive failed, continuing with invalid creds`);
    }
  }

  // Signature type 2 = Safe proxy wallet (Polymarket default)
  // - signer: EOA that controls the Safe
  // - funder: The Safe proxy wallet address where USDC lives
  clobClient = new ClobClient(
    CLOB_URL,
    CHAIN_ID,
    signer,
    { key: apiCreds.key, secret: apiCreds.secret, passphrase: apiCreds.passphrase },
    2, // signatureType: 2 for Safe proxy
    config.polymarket.address // funder address (your Polymarket Safe address)
  );

  console.log(`✅ CLOB client initialized`);
  console.log(`   Signer (EOA): ${signerAddress}`);
  console.log(`   Funder (Safe): ${config.polymarket.address}`);

  // 🔐 Validate credentials with an authenticated API call BEFORE any orders
  console.log(`\n🔐 VALIDATING CREDENTIALS...`);
  try {
    // getApiKeys() sometimes returns an error payload instead of throwing.
    const apiKeys = await clobClient.getApiKeys();

    if (isUnauthorizedPayload(apiKeys)) {
      throw { status: 401, data: apiKeys, message: 'Unauthorized/Invalid api key' };
    }

    console.log(`✅ API credentials VALID!`);
    console.log(`   API keys response:`, JSON.stringify(apiKeys, null, 2));

    // Also verify the API key belongs to the right address
    if (apiKeys && Array.isArray(apiKeys)) {
      const matchingKey = apiKeys.find((k: any) => k.apiKey === apiCreds.key);
      if (matchingKey) {
        console.log(`✅ Found matching API key for this config`);
      } else {
        console.warn(`⚠️ API key not found in getApiKeys response - may be stale`);
      }
    }
  } catch (authError: any) {
    console.error(`\n❌ CREDENTIAL VALIDATION FAILED!`);
    console.error(`   Error: ${authError?.message || authError}`);

    const unauthorized = isUnauthorizedError(authError);

    // Best-effort HTTP details (the SDK doesn't always throw Axios-style errors)
    const status = authError?.response?.status ?? authError?.status;
    const data = authError?.response?.data ?? authError?.data;
    if (status) console.error(`   HTTP Status: ${status}`);
    if (data) console.error(`   Response: ${JSON.stringify(data)}`);

    if (unauthorized) {
      console.log(`\n   🔄 Unauthorized - Attempting auto-derive of new credentials...`);

      // Reset client and try to derive new credentials
      clobClient = null;

      try {
        derivedCreds = await deriveApiCredentials();

        // Recreate client with new creds
        clobClient = new ClobClient(
          CLOB_URL,
          CHAIN_ID,
          signer,
          { key: derivedCreds.key, secret: derivedCreds.secret, passphrase: derivedCreds.passphrase },
          2,
          config.polymarket.address
        );

        // Validate new credentials
        const newApiKeys = await clobClient.getApiKeys();
        console.log(`   ✅ Auto-derived credentials VALID!`);
        console.log(`   API keys response:`, JSON.stringify(newApiKeys, null, 2));
      } catch (deriveError: any) {
        console.error(`   ❌ Auto-derive failed: ${deriveError?.message || deriveError}`);
        console.error(`   ⚠️ Continuing with existing client, but orders will likely fail\n`);
        
        // Re-create client with original (invalid) creds so we don't crash on null
        clobClient = new ClobClient(
          CLOB_URL,
          CHAIN_ID,
          signer,
          { key: apiCreds.key, secret: apiCreds.secret, passphrase: apiCreds.passphrase },
          2,
          config.polymarket.address
        );
      }
    } else {
      console.error(`   ⚠️ Continuing anyway, but orders will likely fail\n`);
    }
  }

  return clobClient!;
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

  // Price improvement: add 1-2¢ to increase fill probability
  // Higher prices (>50¢) are more volatile, use 2¢ improvement
  const priceImprovement = order.price > 0.50 ? 0.02 : 0.01;
  const adjustedPrice = Math.min(order.price + priceImprovement, 0.99);
  
  console.log(`📤 Placing order: ${order.side} ${order.size} @ ${(order.price * 100).toFixed(0)}¢ → ${(adjustedPrice * 100).toFixed(0)}¢ (+${(priceImprovement * 100).toFixed(0)}¢ improvement)`);

  // Check if orderbook exists and has liquidity before placing order
  const depth = await getOrderbookDepth(order.tokenId);
  if (!depth.hasLiquidity) {
    console.log(`⛔ Skip: insufficient liquidity for tokenId ${order.tokenId.slice(0, 30)}...`);
    console.log(`   📊 Orderbook state: topAsk=${depth.topAsk?.toFixed(2) || 'none'}, askVol=${depth.askVolume.toFixed(0)}, levels=${depth.levels.length}`);
    return { 
      success: false, 
      error: `Insufficient liquidity (only ${depth.askVolume.toFixed(0)} shares available, need 10+)`,
      failureReason: 'no_liquidity',
    };
  }

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
    const effectiveApiKey = derivedCreds?.key || config.polymarket.apiKey;

    console.log(`🔐 AUTH CONTEXT:`);
    console.log(`   - POLY_ADDRESS header will be: ${signer.address}`);
    console.log(`   - API Key (owner): ${effectiveApiKey.slice(0, 12)}...`);
    console.log(`   - Order maker (Safe): ${config.polymarket.address}`);
    console.log(`   - Order signer (EOA): ${signer.address}`);
    console.log(`   - Current timestamp (s): ${Math.floor(Date.now() / 1000)}`);

    // Verify API key format (should be UUID)
    const apiKeyIsUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(effectiveApiKey);
    console.log(`   - API Key is valid UUID: ${apiKeyIsUUID}`);
    
    console.log(`\n📤 Order parameters:`);
    console.log(`   - tokenID: ${order.tokenId}`);
    console.log(`   - price: ${order.price}`);
    console.log(`   - size: ${order.size}`);
    console.log(`   - side: ${side}`);
    console.log(`   - orderType: ${orderType}`);
    
    // Use FOK (Fill-or-Kill) for immediate feedback unless explicitly GTC
    const effectiveOrderType = order.orderType === 'GTC' ? OrderType.FOK : orderType;
    console.log(`   - Using order type: ${effectiveOrderType === OrderType.FOK ? 'FOK' : orderType} (original: ${order.orderType || 'GTC'})`);

    const postOnce = async (c: ClobClient) =>
      c.createAndPostOrder(
        {
          tokenID: order.tokenId,
          price: adjustedPrice, // Use improved price
          size: order.size,
          side,
        },
        {
          tickSize: '0.01', // Standard tick size for most markets
          negRisk: false,   // Set based on market type
        },
        effectiveOrderType // Use FOK for immediate fills
      );

    let response = await postOnce(client);

    // The SDK may return an error payload instead of throwing.
    const firstResp = (response as any)?.data ?? response;
    if (isUnauthorizedPayload(firstResp)) {
      console.log(`\n🔄 Order request unauthorized - auto-deriving credentials and retrying once...`);
      clobClient = null;
      derivedCreds = await deriveApiCredentials();
      const freshClient = await getClient();
      response = await postOnce(freshClient);
    }

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
      console.error(`   📊 Orderbook state at failure: topAsk=${depth.topAsk?.toFixed(2) || 'none'}, askVol=${depth.askVolume.toFixed(0)}`);
      console.error(`   🔎 Possible reasons:`);
      console.error(`      - Price ${order.price} may be too low for current market`);
      console.error(`      - Order size ${order.size} may exceed available liquidity`);
      console.error(`      - Market conditions changed during order submission`);
      return { 
        success: false, 
        error: `No order ID returned - order not placed (liquidity: ${depth.askVolume.toFixed(0)} shares)`,
        failureReason: 'unknown',
      };
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
      return { success: false, error: 'Invalid API key - regenerate on Polymarket', failureReason: 'auth' };
    }
    if (errorMsg.includes('insufficient')) {
      return { success: false, error: 'Insufficient balance', failureReason: 'balance' };
    }

    return { success: false, error: errorMsg, failureReason: 'unknown' };
  }
}

// Cache for balance (short TTL - 10 seconds)
let balanceCache: { usdc: number; fetchedAt: number } | null = null;
const BALANCE_CACHE_TTL_MS = 10000;

// Polymarket USDC.e contract address on Polygon
const USDC_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';

export async function getBalance(): Promise<{ usdc: number; error?: string }> {
  // Return cached balance if fresh
  if (balanceCache && Date.now() - balanceCache.fetchedAt < BALANCE_CACHE_TTL_MS) {
    return { usdc: balanceCache.usdc };
  }

  try {
    const client = await getClient();
    
    // Use the CLOB API to get balance/allowance for USDC collateral.
    // IMPORTANT: for collateral, Polymarket expects ONLY asset_type (no token_id/assetAddress).
    const balanceAllowance = await client.getBalanceAllowance({
      asset_type: 0, // AssetType.COLLATERAL = 0 (USDC)
    } as any);
    
    // The balance is returned as a string, convert to number
    const balance = parseFloat(balanceAllowance?.balance || '0');
    
    console.log(`💰 CLOB Balance: $${balance.toFixed(2)} USDC`);
    
    // Cache the result
    balanceCache = { usdc: balance, fetchedAt: Date.now() };
    
    return { usdc: balance };
  } catch (error: any) {
    console.error(`❌ Failed to fetch balance: ${error?.message || error}`);
    
    // Return cached balance if available (even if stale)
    if (balanceCache) {
      console.log(`   Using stale cached balance: $${balanceCache.usdc.toFixed(2)}`);
      return { usdc: balanceCache.usdc };
    }
    
    return { usdc: 0, error: error?.message };
  }
}

// Invalidate balance cache (call after trades)
export function invalidateBalanceCache(): void {
  balanceCache = null;
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
