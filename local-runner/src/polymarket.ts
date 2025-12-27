import crypto from 'node:crypto';
import { ClobClient, Side, OrderType } from '@polymarket/clob-client';
import { Wallet } from 'ethers';
import { config } from './config.js';

const CLOB_URL = 'https://clob.polymarket.com';
const CHAIN_ID = 137; // Polygon mainnet

// Polygon USDC (PoS) contract address; used by balance/allowance endpoints
const USDC_ASSET_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';

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

// Prevent infinite auth loops: we only attempt auto-derive a limited number of times per process.
let deriveAttempts = 0;
const MAX_DERIVE_ATTEMPTS = 1;

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
 * Validate API credentials manually using a direct fetch call.
 * This keeps the signing / header behavior explicit (useful for debugging).
 */
async function validateCredentialsManually(
  apiCreds: { key: string; secret: string; passphrase: string },
  signatureType: 0 | 1 | 2,
  polyAddressHeader: string
): Promise<{ ok: boolean; apiKeys?: string[]; error?: string }> {
  const toUrlSafeBase64KeepPadding = (b64: string) => b64.replace(/\+/g, '-').replace(/\//g, '_');

  const sanitizeBase64Secret = (secret: string) => {
    let s = secret.trim()
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      .replace(/[^A-Za-z0-9+/=]/g, '');

    const pad = s.length % 4;
    if (pad === 2) s += '==';
    if (pad === 3) s += '=';
    return s;
  };

  const buildSignature = (
    secretBytes: Buffer,
    timestampSeconds: string,
    method: string,
    requestPath: string
  ) => {
    const message = `${timestampSeconds}${method.toUpperCase()}${requestPath}`;
    const digest = crypto.createHmac('sha256', secretBytes).update(message).digest();
    const b64 = Buffer.from(digest).toString('base64');
    return toUrlSafeBase64KeepPadding(b64);
  };

  try {
    const requestPath = '/auth/api-keys';
    const timestampSeconds = String(Math.floor(Date.now() / 1000));

    const secretBytes = Buffer.from(sanitizeBase64Secret(apiCreds.secret), 'base64');
    if (!secretBytes?.length) {
      return { ok: false, error: 'Invalid API secret (base64 decode failed)' };
    }

    const signature = buildSignature(secretBytes, timestampSeconds, 'GET', requestPath);

    console.log(`   📡 Validating with POLY_ADDRESS: ${polyAddressHeader}`);

    const response = await fetch(`${CLOB_URL}${requestPath}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        POLY_ADDRESS: polyAddressHeader,
        POLY_API_KEY: apiCreds.key,
        POLY_PASSPHRASE: apiCreds.passphrase,
        POLY_SIGNATURE: signature,
        POLY_TIMESTAMP: timestampSeconds,
      } as any,
    });

    if (!response.ok) {
      const text = await response.text();
      console.error(`   ❌ Validation failed: HTTP ${response.status}`);
      console.error(`   Response: ${text.slice(0, 200)}`);
      return { ok: false, error: `HTTP ${response.status}: ${text.slice(0, 100)}` };
    }

    const data = await response.json();
    
    // Extract API keys from response (various possible shapes)
    let apiKeys: string[] = [];
    if (Array.isArray(data)) {
      if (data.length === 0) {
        apiKeys = [];
      } else if (typeof data[0] === 'string') {
        apiKeys = data;
      } else {
        apiKeys = data.map((x: any) => x?.apiKey).filter(Boolean);
      }
    } else if (Array.isArray(data?.apiKeys)) {
      apiKeys = data.apiKeys.filter((x: any) => typeof x === 'string');
    }

    return { ok: true, apiKeys };
  } catch (err: any) {
    return { ok: false, error: String(err?.message || err) };
  }
}

/**
 * Derive fresh API credentials using the private key.
 * This creates new CLOB API keys programmatically.
 * NOTE: This only works if the wallet is properly set up on Polymarket.
 * For Safe proxy wallets, you may need to create keys manually via the Polymarket UI.
 */
export async function deriveApiCredentials(): Promise<{ key: string; secret: string; passphrase: string }> {
  console.log(`\n🔄 AUTO-DERIVING NEW API CREDENTIALS...`);

  // Hard stop: Safe proxy wallets commonly cannot create/derive via API (HTTP 400: "Could not create api key").
  // In that case, credentials must be created manually and configured.
  const signer = new Wallet(config.polymarket.privateKey);
  const override = (config.polymarket as any).signatureType as (0 | 1 | 2 | undefined);
  const signatureType: 0 | 1 | 2 =
    override === 0 || override === 1 || override === 2
      ? override
      : signer.address.toLowerCase() === config.polymarket.address.toLowerCase()
        ? 0
        : 2;

  if (signatureType !== 0) {
    deriveAttempts = MAX_DERIVE_ATTEMPTS;
    throw new Error(
      'Auto-derive is disabled for proxy wallets (signatureType 1/2). Create API credentials in the Polymarket UI and set POLYMARKET_API_KEY/POLYMARKET_API_SECRET/POLYMARKET_PASSPHRASE.'
    );
  }

  if (deriveAttempts >= MAX_DERIVE_ATTEMPTS) {
    throw new Error(`Auto-derive blocked (max ${MAX_DERIVE_ATTEMPTS} attempt per process).`);
  }
  deriveAttempts += 1;

  // Create a temporary client without API creds to derive new ones
  // IMPORTANT: Must pass signatureType=0 (EOA) explicitly for proper key derivation
  const tempClient = new ClobClient(CLOB_URL, CHAIN_ID, signer, undefined, 0);
  
  try {
    const anyClient = tempClient as any;

    // IMPORTANT: Polymarket sometimes rejects *creating* new keys (HTTP 400: "Could not create api key")
    // and some SDK versions return error payloads instead of throwing.
    let newCreds: any;

    if (typeof anyClient.createOrDeriveApiKey === 'function') {
      console.log(`   🔑 Deriving or creating API key (createOrDeriveApiKey)...`);
      newCreds = await anyClient.createOrDeriveApiKey();
    } else if (typeof anyClient.createOrDeriveApiCreds === 'function') {
      console.log(`   🔑 Deriving or creating API creds (createOrDeriveApiCreds)...`);
      newCreds = await anyClient.createOrDeriveApiCreds();
    } else {
      console.log(`   🔑 Creating new API key (createApiKey)...`);
      newCreds = await anyClient.createApiKey();
    }

    // SDK may return { status, error } instead of throwing.
    if (newCreds?.error || (typeof newCreds?.status === 'number' && newCreds.status >= 400)) {
      throw new Error(String(newCreds?.error || `derive failed (status=${newCreds?.status})`));
    }

    const apiKey = newCreds?.apiKey ?? newCreds?.key;
    const secretRaw = newCreds?.secret;
    const passphrase = newCreds?.passphrase;

    // Normalize secret to standard base64 (the API sometimes returns base64url)
    const normalizeToBase64 = (input: string) => {
      let s = input.trim();
      if (s.includes('-') || s.includes('_')) {
        s = s.replace(/-/g, '+').replace(/_/g, '/');
      }
      const pad = s.length % 4;
      if (pad === 2) s += '==';
      if (pad === 3) s += '=';
      return s;
    };

    const secret = typeof secretRaw === 'string' ? normalizeToBase64(secretRaw) : secretRaw;

    if (!apiKey || !secret || !passphrase) {
      throw new Error('derive/create returned invalid response - manual key creation required');
    }

    console.log(`   ✅ API credentials ready!`);
    console.log(`      API Key: ${String(apiKey).slice(0, 12)}...`);
    console.log(`      Secret length: ${String(secret)?.length || 0} chars`);
    console.log(`      Passphrase length: ${String(passphrase)?.length || 0} chars`);

    derivedCreds = {
      key: apiKey,
      secret: String(secret),
      passphrase,
    };

    return derivedCreds;
  } catch (error: any) {
    const msg = String(error?.message || error);
    if (msg.toLowerCase().includes('could not create api key')) {
      deriveAttempts = MAX_DERIVE_ATTEMPTS;
    }

    console.error(`   ❌ Failed to derive credentials: ${msg}`);
    throw error;
  }
}

/**
 * Ensure valid CLOB API credentials exist.
 * Call this at startup BEFORE any trading to force credential validation.
 * Returns true if credentials are valid, false otherwise.
 */
export async function ensureValidCredentials(): Promise<boolean> {
  console.log(`\n🔐 VALIDATING API CREDENTIALS AT STARTUP...`);

  try {
    // Initializes client and validates API creds via getApiKeys()
    await getClient();

    // One balance check; do NOT loop auto-derive here (avoid infinite loops on Safe proxy accounts)
    const balanceResult = await getBalance();
    if (balanceResult.error?.includes('401')) {
      console.error(`❌ Balance check returned 401 after credential validation.`);
      console.error(`   This usually means POLY_ADDRESS/address mismatch (EOA vs Safe) or stale API key for this account.`);
      return false;
    }

    return true;
  } catch (error: any) {
    console.error(`❌ Credential validation failed: ${error?.message || error}`);
    return false;
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

  const override = (config.polymarket as any).signatureType as (0 | 1 | 2 | undefined);
  const signerIsFunder = signerAddress.toLowerCase() === config.polymarket.address.toLowerCase();

  let signatureType: 0 | 1 | 2;
  if (signerIsFunder) {
    // Force 0 for regular EOA regardless of override
    if (override !== undefined && override !== 0) {
      console.warn(
        `⚠️ POLYMARKET_SIGNATURE_TYPE=${override} ignored: signer == funder means regular EOA (signatureType=0).`
      );
    }
    signatureType = 0;
  } else {
    // Proxy wallet modes only apply when signer ≠ funder
    signatureType = override === 0 || override === 1 || override === 2 ? override : 2;
  }

  // Per Polymarket docs, POLY_ADDRESS header must be the Polygon SIGNER address (EOA)
  // even when trading with a proxy wallet (signatureType 1/2).
  const polyAddressHeader = signerAddress;

  console.log(`📍 Signer (from private key): ${signerAddress}`);
  console.log(`📍 POLYMARKET_ADDRESS (funder): ${config.polymarket.address}`);
  console.log(`📍 Signature type: ${signatureType}${override !== undefined ? ' (override)' : ''}`);
  
  // Use derived creds if available, otherwise use config
  let apiCreds = derivedCreds || {
    key: config.polymarket.apiKey,
    secret: config.polymarket.apiSecret,
    passphrase: config.polymarket.passphrase,
  };
  
  console.log(`📍 API Key: ${apiCreds.key?.slice(0, 12) || 'NOT SET'}...`);
  console.log(`📍 Passphrase: ${apiCreds.passphrase?.slice(0, 12) || 'NOT SET'}...`);
  console.log(`📍 POLY_ADDRESS (auth header): ${polyAddressHeader}`);
  
  // Critical validation:
  // - signatureType=0: regular EOA
  // - signatureType=1/2: proxy wallet (funder holds funds; signer signs)
  if (signatureType === 0) {
    console.log(`✅ Regular account mode (Signer == Funder)`);
  } else {
    console.log(`✅ Proxy wallet mode (Signer ≠ Funder)`);
    console.log(`   Signer (EOA): ${signerAddress}`);
    console.log(`   Funder: ${config.polymarket.address}`);
  }
  
  // Log current system time for timestamp debugging
  console.log(`\n⏰ System time: ${new Date().toISOString()}`);
  console.log(`   Unix timestamp (seconds): ${Math.floor(Date.now() / 1000)}`);
  console.log(`${'='.repeat(60)}\n`);

  // Check if we have valid credentials
  const hasValidCreds = apiCreds.key && apiCreds.secret && apiCreds.passphrase;
  
  if (!hasValidCreds) {
    console.error(`❌ No valid API credentials configured.`);
    if (signatureType === 0) {
      console.log(`   Attempting one-time auto-derive (regular account)...`);
      try {
        derivedCreds = await deriveApiCredentials();
        apiCreds = derivedCreds;
      } catch (e: any) {
        console.error(`   Auto-derive failed: ${e?.message || e}`);
        console.error(`   ❌ Cannot initialize client without credentials. Exiting.`);
        process.exit(1);
      }
    } else {
      console.error(`   Auto-derive disabled for Safe proxy wallets.`);
      console.error(`   ❌ Configure POLYMARKET_API_KEY/SECRET/PASSPHRASE for the Safe address and restart.`);
      process.exit(1);
    }
  }

  // IMPORTANT: clob-client uses apiCreds.address to set POLY_ADDRESS.
  // Provide both new and legacy field names for compatibility.
  const sdkCreds = {
    apiKey: apiCreds.key,
    apiSecret: apiCreds.secret,
    apiPassphrase: apiCreds.passphrase,
    address: polyAddressHeader,
    // legacy
    key: apiCreds.key,
    secret: apiCreds.secret,
    passphrase: apiCreds.passphrase,
  } as any;

  clobClient = signatureType === 0
    ? new ClobClient(CLOB_URL, CHAIN_ID, signer, sdkCreds, 0)
    : new ClobClient(CLOB_URL, CHAIN_ID, signer, sdkCreds, signatureType, config.polymarket.address);

  console.log(`✅ CLOB client initialized`);
  console.log(`   Signer (EOA): ${signerAddress}`);
  console.log(`   Funder: ${config.polymarket.address}`);

  // 🔐 Validate credentials with an authenticated API call
  // We use a manual fetch to keep the signing logic explicit and easy to debug.
  console.log(`\n🔐 VALIDATING CREDENTIALS...`);
  try {
    const validationResult = await validateCredentialsManually(apiCreds, signatureType, polyAddressHeader);
    
    if (!validationResult.ok) {
      throw { status: 401, data: { error: validationResult.error }, message: validationResult.error };
    }

    console.log(`✅ API credentials VALID!`);
    console.log(`   API keys found: ${validationResult.apiKeys?.length || 0}`);

    // Verify the API key belongs to the right address
    if (validationResult.apiKeys && Array.isArray(validationResult.apiKeys)) {
      const matchingKey = validationResult.apiKeys.find((k: string) => k === apiCreds.key);
      if (matchingKey) {
        console.log(`✅ Found matching API key for this config`);
      } else {
        console.warn(`⚠️ API key not found in getApiKeys response - may be stale`);
        console.warn(`   Expected: ${apiCreds.key?.slice(0, 12)}...`);
        console.warn(`   Available: ${validationResult.apiKeys.map((k: string) => k?.slice(0, 12) + '...').join(', ')}`);
      }
    }
  } catch (authError: any) {
    console.error(`\n❌ CREDENTIAL VALIDATION FAILED!`);
    console.error(`   Error: ${authError?.message || authError}`);

    const status = authError?.response?.status ?? authError?.status;
    const data = authError?.response?.data ?? authError?.data;
    if (status) console.error(`   HTTP Status: ${status}`);
    if (data) console.error(`   Response: ${JSON.stringify(data)}`);

    // For proxy wallets (signatureType 1/2): no auto-derive, just fail clearly
    if (signatureType !== 0) {
      console.error(`\n   ❌ Proxy wallet mode: credentials invalid.`);
      console.error(`      1. Verify signature type. For Google/Magic accounts set POLYMARKET_SIGNATURE_TYPE=1.`);
      console.error(`      2. Ensure API key/secret/passphrase were created for this funder: ${config.polymarket.address}`);
      console.error(`      3. Update /home/deploy/secrets/local-runner.env`);
      console.error(`      4. Restart: docker compose restart runner`);
    }
    // Keep clobClient set (don't null it) so we don't crash, but orders will fail
  }

  // CRITICAL: Ensure clobClient is never null after this function returns
  if (!clobClient) {
    console.error(`❌ FATAL: clobClient is null after initialization. This should not happen.`);
    process.exit(1);
  }

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
    
    // Use GTC (Good-Til-Cancelled) - orders stay in orderbook until filled
    // FOK fails if not enough liquidity at exact price, GTC waits for fills
    const effectiveOrderType = orderType; // Keep original (GTC by default)
    console.log(`   - Using order type: GTC (resting order - waits for fills)`);

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

export async function getBalance(): Promise<{ usdc: number; error?: string }> {
  // Return cached balance if fresh
  if (balanceCache && Date.now() - balanceCache.fetchedAt < BALANCE_CACHE_TTL_MS) {
    return { usdc: balanceCache.usdc };
  }

  const toUrlSafeBase64KeepPadding = (b64: string) => b64.replace(/\+/g, '-').replace(/\//g, '_');

  const sanitizeBase64Secret = (secret: string) => {
    let s = secret.trim()
      // Convert base64url → base64
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      // Remove any non-base64 characters (matches upstream SDK behavior)
      .replace(/[^A-Za-z0-9+/=]/g, '');

    // Add padding if missing
    const pad = s.length % 4;
    if (pad === 2) s += '==';
    if (pad === 3) s += '=';

    return s;
  };

  const buildSignature = (
    secretBytes: Buffer,
    timestampSeconds: string,
    method: string,
    requestPath: string,
    bodyString?: string
  ) => {
    // Upstream clob-client: message = timestamp + method + requestPath (+ body)
    let message = `${timestampSeconds}${method.toUpperCase()}${requestPath}`;
    if (bodyString !== undefined) message += bodyString;

    const digest = crypto.createHmac('sha256', secretBytes).update(message).digest();
    const b64 = Buffer.from(digest).toString('base64');

    // IMPORTANT: must be url-safe base64, but KEEP '=' padding (upstream behavior)
    return toUrlSafeBase64KeepPadding(b64);
  };

  const attemptBalanceFetch = async (apiCreds: { key: string; secret: string; passphrase: string }) => {
    const signer = new Wallet(config.polymarket.privateKey);

    // IMPORTANT: When signer == funder, ALWAYS use signatureType=0 (regular EOA).
    // An override of 1 or 2 only makes sense when signer ≠ funder (proxy wallet).
    const signerIsFunder = signer.address.toLowerCase() === config.polymarket.address.toLowerCase();
    const override = (config.polymarket as any).signatureType as (0 | 1 | 2 | undefined);

    let signatureType: 0 | 1 | 2;
    if (signerIsFunder) {
      // Force 0 for regular EOA regardless of override
      if (override !== undefined && override !== 0) {
        console.warn(`⚠️ POLYMARKET_SIGNATURE_TYPE=${override} ignored: signer == funder means regular EOA (signatureType=0).`);
      }
      signatureType = 0;
    } else {
      signatureType =
        override === 0 || override === 1 || override === 2
          ? override
          : 2; // default to Gnosis Safe for proxy
    }

    // Per Polymarket docs, POLY_ADDRESS is always the Polygon signer address.
    const polyAddressHeader = signer.address;

    // Balance is held by the funder for proxy wallet modes.
    const addressParam = signatureType === 0 ? signer.address : config.polymarket.address;

    // Build the query path with all required parameters
    // CLOB expects the collateral token address as `assetAddress` (camelCase). Some versions may also accept `asset_address`.
    const pathWithQuery = `/balance-allowance?asset_type=0&assetAddress=${encodeURIComponent(
      USDC_ASSET_ADDRESS
    )}&asset_address=${encodeURIComponent(USDC_ASSET_ADDRESS)}&signature_type=${signatureType}&address=${encodeURIComponent(addressParam)}`;

    // Debug: ensure our request actually includes assetAddress + address (helps diagnose 400 invalid params)
    console.log(`🔎 Balance request: ${CLOB_URL}${pathWithQuery}`);

    const timestampSeconds = String(Math.floor(Date.now() / 1000));

    // Build signature like upstream clob-client (url-safe base64 with '=' padding)
    const secretBytes = Buffer.from(sanitizeBase64Secret(apiCreds.secret), 'base64');
    if (!secretBytes?.length) {
      return { error: { status: 0, text: 'Invalid API secret (base64 decode failed)' } };
    }

    const fetchWithSignaturePath = async (signaturePath: string) => {
      const signature = buildSignature(secretBytes, timestampSeconds, 'GET', signaturePath);
      return fetch(`${CLOB_URL}${pathWithQuery}`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          POLY_ADDRESS: polyAddressHeader,
          POLY_API_KEY: apiCreds.key,
          POLY_PASSPHRASE: apiCreds.passphrase,
          POLY_SIGNATURE: signature,
          POLY_TIMESTAMP: timestampSeconds,
        } as any,
      });
    };

    // Some CLOB endpoints verify the signature against only the pathname (no query string).
    // Try the "full path" first, then retry once signing only the pathname.
    let response = await fetchWithSignaturePath(pathWithQuery);
    if (response.status === 401) {
      response = await fetchWithSignaturePath('/balance-allowance');
    }

    if (!response.ok) {
      const text = await response.text();
      return { error: { status: response.status, text } };
    }

    const data = await response.json();
    const rawBalance = (data as any)?.balance ?? (data as any)?.available_balance ?? '0';
    const balance = typeof rawBalance === 'number' ? rawBalance : parseFloat(String(rawBalance));

    console.log(`💰 CLOB Balance: $${balance.toFixed(2)} USDC`);

    balanceCache = { usdc: balance, fetchedAt: Date.now() };
    return { usdc: balance };
  };

  try {
    let apiCreds = derivedCreds || {
      key: config.polymarket.apiKey,
      secret: config.polymarket.apiSecret,
      passphrase: config.polymarket.passphrase,
    };

    if (!apiCreds.key || !apiCreds.secret || !apiCreds.passphrase) {
      // No credentials at all - try to derive
      console.log(`⚠️ No API credentials configured - attempting auto-derive...`);
      try {
        derivedCreds = await deriveApiCredentials();
        apiCreds = derivedCreds;
      } catch (deriveError) {
        return { usdc: 0, error: 'Missing API credentials and auto-derive failed' };
      }
    }

    // First attempt
    const result = await attemptBalanceFetch(apiCreds);
    
    if ('usdc' in result) {
      return result;
    }

    // If we got a 401, DO NOT try to create/derive API keys when:
    // - signatureType is proxy (1/2) (auto-derive is disabled and will just spam logs)
    // - the user already configured keys (likely stale/wrong account instead of "needs derive")
    if (result.error?.status === 401) {
      const signer = new Wallet(config.polymarket.privateKey);
      const override = (config.polymarket as any).signatureType as (0 | 1 | 2 | undefined);
      const signatureType: 0 | 1 | 2 =
        override === 0 || override === 1 || override === 2
          ? override
          : signer.address.toLowerCase() === config.polymarket.address.toLowerCase()
            ? 0
            : 2;

      if (signatureType !== 0) {
        console.error(`\n❌ Balance returned 401 (signatureType=${signatureType}) — auto-derive disabled for proxy wallets.`);
        console.error(`   Fix is almost always: API key belongs to a different account/address, or signatureType override is wrong.`);
        return { usdc: 0, error: 'HTTP 401 (balance)' };
      }

      const credsWereExplicitlyConfigured =
        !derivedCreds &&
        Boolean(config.polymarket.apiKey && config.polymarket.apiSecret && config.polymarket.passphrase);

      if (credsWereExplicitlyConfigured) {
        console.error(`\n❌ Balance returned 401 with configured API credentials (no auto-derive).`);
        console.error(`   This usually means the API key is for a different account/address or is stale/revoked.`);
        return { usdc: 0, error: 'HTTP 401 (balance)' };
      }

      console.log(`\n🔄 Balance returned 401 - auto-deriving new credentials...`);

      try {
        derivedCreds = await deriveApiCredentials();
        // Reset clobClient so it picks up new creds
        clobClient = null;

        // Retry with new credentials
        const retryResult = await attemptBalanceFetch(derivedCreds);
        if ('usdc' in retryResult) {
          return retryResult;
        }

        console.error(`❌ Balance still failing after auto-derive: HTTP ${retryResult.error?.status}`);
        return { usdc: 0, error: `HTTP ${retryResult.error?.status} after auto-derive` };
      } catch (deriveError: any) {
        console.error(`❌ Auto-derive failed: ${deriveError?.message || deriveError}`);
        return { usdc: 0, error: `401 and auto-derive failed: ${deriveError?.message}` };
      }
    }

    if (result.error?.status) {
      console.error(`❌ Balance fetch failed: HTTP ${result.error.status} - ${String(result.error.text).slice(0, 200)}`);
      return { usdc: 0, error: `HTTP ${result.error.status}` };
    }

    console.error('❌ Balance fetch failed: Unable to sign request');
    return { usdc: 0, error: 'Unable to sign request' };
  } catch (error: any) {
    console.error(`❌ Failed to fetch balance: ${error?.message || error}`);

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
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    // Test with a known public endpoint
    const response = await fetch(`${CLOB_URL}/markets?limit=1`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
    });

    clearTimeout(timeout);

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
  } catch (error: any) {
    if (String(error?.name) === 'AbortError') {
      console.error('❌ Connection timeout (15s) - likely IPv6/VPN routing issue');
      return false;
    }
    console.error('❌ Connection error:', error);
    return false;
  }
}
