import crypto from 'node:crypto';
import { ClobClient, Side, OrderType } from '@polymarket/clob-client';
import { Wallet } from 'ethers';
import { config } from './config.js';

const CLOB_URL = 'https://clob.polymarket.com';
const CHAIN_ID = 137; // Polygon mainnet

// Use centralized config for USDC collateral address (validated + lowercase there)
const USDC_ASSET_ADDRESS = config.polymarket.usdcAddress;

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

// Exponential backoff state (to stop endless spam when API returns null/no orderId)
let invalidPayloadStreak = 0;
let noOrderIdStreak = 0;

function computeBackoffMs(baseMs: number, streak: number, maxMs: number): number {
  // base, 2x, 4x, 8x ... up to max
  const s = Math.max(1, streak);
  const pow = Math.min(6, s - 1); // cap exponent
  return Math.min(maxMs, Math.floor(baseMs * Math.pow(2, pow)));
}

function applyBackoff(reason: 'invalid_payload' | 'no_order_id' | 'cloudflare', baseMs: number): number {
  const maxMs = Math.max(5_000, config.trading.cloudflareBackoffMs || 60_000);

  if (reason === 'invalid_payload' || reason === 'cloudflare') {
    invalidPayloadStreak = Math.min(50, invalidPayloadStreak + 1);
    noOrderIdStreak = 0;
    const ms = computeBackoffMs(baseMs, invalidPayloadStreak, maxMs);
    blockedUntilMs = Date.now() + ms;
    return ms;
  }

  noOrderIdStreak = Math.min(50, noOrderIdStreak + 1);
  invalidPayloadStreak = 0;
  const ms = computeBackoffMs(baseMs, noOrderIdStreak, maxMs);
  blockedUntilMs = Date.now() + ms;
  return ms;
}

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

  // CRITICAL: Validate price before proceeding (NaN check)
  if (!Number.isFinite(order.price) || order.price < 0.01 || order.price > 0.99) {
    console.error(`❌ Order failed: invalid price (${order.price}), min: 0.01 - max: 0.99`);
    return {
      success: false,
      error: `Invalid price (${order.price}), min: 0.01 - max: 0.99`,
      failureReason: 'invalid_price',
    };
  }

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

    // Capture response details; only print them verbosely when something looks wrong.
    const actualResponse = (response as any)?.data ?? response;

    const responseType = typeof response;
    const actualType = typeof actualResponse;
    const responseKeys = response && responseType === 'object' ? Object.keys(response as any) : [];
    const actualKeys = actualResponse && actualType === 'object' ? Object.keys(actualResponse as any) : [];

    const debugDump = () => {
      console.log(`\n📋 RAW RESPONSE TYPE: ${responseType}`);
      console.log(`📋 RAW RESPONSE (JSON):`);
      console.log(JSON.stringify(response, null, 2));
      console.log(`\n📋 ACTUAL RESPONSE (after .data check):`);
      console.log(JSON.stringify(actualResponse, null, 2));
      console.log(`\n📋 RESPONSE KEYS: ${responseKeys.length ? responseKeys.join(', ') : 'none'}`);
      console.log(`📋 ACTUAL RESPONSE KEYS: ${actualKeys.length ? actualKeys.join(', ') : 'none'}`);
    };

    // Normalize response: some SDK/network layers may return string or null
    let resp: any = actualResponse;
    if (typeof resp === 'string') {
      const s = resp;
      // If it's JSON in a string, parse it
      try {
        resp = JSON.parse(s);
      } catch {
        // keep as string
        resp = s;
      }
    }

    const respType = typeof resp;
    const respKeys = resp && respType === 'object' ? Object.keys(resp as any) : [];

    const respString = typeof resp === 'string' ? resp : '';
    const looksHtmlOrWaf = typeof resp === 'string'
      ? /<html|cloudflare|attention required|access denied/i.test(resp)
      : false;

    // Empty/invalid payload is usually transient WAF/network weirdness – apply backoff to avoid spam
    if (resp == null || (respType === 'object' && respKeys.length === 0) || looksHtmlOrWaf) {
      debugDump();
      const preview = respType === 'string' ? String(resp).slice(0, 200) : JSON.stringify(resp).slice(0, 200);
      const backoffMs = applyBackoff(looksHtmlOrWaf ? 'cloudflare' : 'invalid_payload', 10_000);

      console.error(`❌ Order returned empty/invalid payload (cooldown ${Math.ceil(backoffMs / 1000)}s)`);
      console.error(`   payloadType=${respType} keys=${respKeys.join(', ') || 'none'} preview=${preview}`);

      return {
        success: false,
        error: `Empty/invalid order response (cooldown ${Math.ceil(backoffMs / 1000)}s)`,
        failureReason: looksHtmlOrWaf ? 'cloudflare' : 'unknown',
      };
    }

    // Explicit failure
    if ((resp as any)?.success === false || (resp as any)?.errorMsg || (resp as any)?.error) {
      debugDump();
      const msg = String((resp as any)?.errorMsg || (resp as any)?.error || 'Order failed');
      console.error(`❌ Order failed: ${msg}`);
      return { success: false, error: msg };
    }

    // Extract order ID - check multiple variants
    const orderId =
      (resp as any)?.orderID ||
      (resp as any)?.orderId ||
      (resp as any)?.order_id ||
      (resp as any)?.id ||
      (resp as any)?.order?.id ||
      (response as any)?.orderID ||
      (response as any)?.orderId;

    if (!orderId || (typeof orderId === 'string' && orderId.trim() === '')) {
      debugDump();
      const backoffMs = applyBackoff('no_order_id', 5_000);

      // Try to surface a useful reason if it looks like a WAF payload in string fields
      const maybeText =
        typeof (resp as any)?.message === 'string'
          ? (resp as any).message
          : typeof (resp as any)?.msg === 'string'
            ? (resp as any).msg
            : respString;
      const looksWafObj = /cloudflare|attention required|access denied/i.test(String(maybeText || ''));

      console.error('❌ Order response had no order ID - order likely NOT placed');
      console.error(`   📊 Orderbook state: topAsk=${depth.topAsk?.toFixed(2) || 'none'}, askVol=${depth.askVolume.toFixed(0)}`);
      console.error(`   📋 Response keys: ${respKeys.join(', ') || 'none'}`);
      console.error(`   ⏳ Cooling down ${Math.ceil(backoffMs / 1000)}s to avoid repeated failures`);

      return {
        success: false,
        error: `No order ID returned - order not placed (liquidity: ${depth.askVolume.toFixed(0)} shares)`,
        failureReason: looksWafObj ? 'cloudflare' : 'unknown',
      };
    }

    // Success: reset failure streaks
    invalidPayloadStreak = 0;
    noOrderIdStreak = 0;

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

/**
 * Fetches the USDC collateral balance using the official clob-client SDK.
 * Uses getBalanceAllowance({ asset_type: 'COLLATERAL' }) which handles all URL encoding internally.
 */
export async function getBalance(): Promise<{ usdc: number; error?: string }> {
  // Return cached balance if fresh
  if (balanceCache && Date.now() - balanceCache.fetchedAt < BALANCE_CACHE_TTL_MS) {
    return { usdc: balanceCache.usdc };
  }

  try {
    const client = await getClient();

    // SDK v5+ uses getBalanceAllowance with asset_type: 'COLLATERAL'
    // This handles all URL building, signing, and parameter encoding internally
    const result = await (client as any).getBalanceAllowance({ asset_type: 'COLLATERAL' });

    // Handle SDK returning error payloads instead of throwing
    if (result?.error || (typeof result?.status === 'number' && result.status >= 400)) {
      const errMsg = result?.error ?? `status=${result?.status}`;
      console.error(`❌ SDK getBalanceAllowance error: ${errMsg}`);
      return { usdc: 0, error: String(errMsg) };
    }

    const rawBalance = result?.balance ?? result?.available_balance ?? '0';
    const balance = typeof rawBalance === 'number' ? rawBalance : parseFloat(String(rawBalance));

    console.log(`💰 CLOB Balance: $${balance.toFixed(2)} USDC`);
    balanceCache = { usdc: balance, fetchedAt: Date.now() };
    return { usdc: balance };
  } catch (error: any) {
    const msg = String(error?.message || error);
    console.error('❌ Failed to fetch balance:', msg);

    // Return stale cache if available
    if (balanceCache) {
      console.log(`   Using stale cached balance: $${balanceCache.usdc.toFixed(2)}`);
      return { usdc: balanceCache.usdc };
    }

    return { usdc: 0, error: msg };
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
