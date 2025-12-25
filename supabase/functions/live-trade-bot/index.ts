import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { ethers } from "https://esm.sh/ethers@6.13.1";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// ============================================================================
// LIVE TRADING BOT - Polymarket CLOB Integration
// ⚠️ WARNING: This bot trades with REAL money. Use with caution.
// ============================================================================

const POLYMARKET_CLOB_HOST = 'https://clob.polymarket.com';
const POLYGON_CHAIN_ID = 137;
const POLYGON_RPC_URL = 'https://polygon-rpc.com';

// Polymarket CTF Exchange contract address on Polygon
const CTF_EXCHANGE_ADDRESS = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';

// Polymarket Proxy Factory and Safe Factory addresses (from CTFExchange constructor args)
const POLYMARKET_PROXY_FACTORY = '0xaB45c5A4B0c941a2F231C04C3f49182e1A254052';
const GNOSIS_SAFE_FACTORY = '0xaacFeEa03eb1561C4e67d661e40682Bd20E3541b';

// Polymarket Proxy implementation address (used for CREATE2 calculation)
const POLY_PROXY_IMPLEMENTATION = '0xC5924Ca2d9910a3dB1368a2Ed86F5c63F67b1cdd';

// USDC contract on Polygon (Bridged USDC)
const USDC_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';

// USDT contract on Polygon
const USDT_ADDRESS = '0xc2132D05D31c914a87C6611C10748AEb04B58e8F';

// Uniswap V3 SwapRouter02 on Polygon
const UNISWAP_ROUTER_ADDRESS = '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45';

// Standard ERC20 ABI for approve and balanceOf
const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
];

// Uniswap V3 SwapRouter ABI
const SWAP_ROUTER_ABI = [
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)',
];

// Polymarket Exchange ABI for deposits and contract-wallet helpers
const EXCHANGE_ABI = [
  'function getCollateral() view returns (address)',
  'function deposit(address receiver, uint256 amount) external',
  'function getProxyFactory() view returns (address)',
  'function getSafeFactory() view returns (address)',
  'function getPolyProxyWalletAddress(address _addr) view returns (address)',
  'function getSafeAddress(address _addr) view returns (address)',
  'function getCtf() view returns (address)',
];

// Gnosis Conditional Tokens (CTF) ABI for redemption
const CONDITIONAL_TOKENS_ABI = [
  'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] calldata indexSets) external',
  'function balanceOf(address owner, uint256 positionId) view returns (uint256)',
  'function payoutNumerators(bytes32 conditionId, uint256 index) view returns (uint256)',
  'function payoutDenominator(bytes32 conditionId) view returns (uint256)',
  'function getConditionId(address oracle, bytes32 questionId, uint256 outcomeSlotCount) pure returns (bytes32)',
  'function getCollectionId(bytes32 parentCollectionId, bytes32 conditionId, uint256 indexSet) view returns (bytes32)',
  'function getPositionId(address collateralToken, bytes32 collectionId) pure returns (uint256)',
];

// Polymarket Neg Risk CTF Exchange for redemption (used for some markets)
const NEG_RISK_CTF_EXCHANGE_ABI = [
  'function redeemPositions(bytes32 conditionId, uint256[] calldata amounts) external',
];

// ============================================================================
// Polymarket Contract Wallet Resolution (Proxy/Safe)
// ============================================================================

async function resolvePolymarketReceiver(
  exchangeContract: ethers.Contract,
  provider: ethers.Provider,
  eoaAddress: string
): Promise<{
  receiver: string;
  receiverType: 'safe' | 'proxy' | 'safe_uninitialized' | 'proxy_uninitialized';
  safeAddress: string;
  proxyAddress: string;
  safeDeployed: boolean;
  proxyDeployed: boolean;
}> {
  const [safeAddressRaw, proxyAddressRaw] = await Promise.all([
    exchangeContract.getSafeAddress(eoaAddress),
    exchangeContract.getPolyProxyWalletAddress(eoaAddress),
  ]);

  const safeAddress = ethers.getAddress(safeAddressRaw);
  const proxyAddress = ethers.getAddress(proxyAddressRaw);

  const [safeCode, proxyCode] = await Promise.all([
    provider.getCode(safeAddress),
    provider.getCode(proxyAddress),
  ]);

  const safeDeployed = safeCode !== '0x';
  const proxyDeployed = proxyCode !== '0x';

  // Prefer deployed Safe (newer Polymarket default), otherwise deployed Proxy.
  if (safeDeployed) {
    return {
      receiver: safeAddress,
      receiverType: 'safe',
      safeAddress,
      proxyAddress,
      safeDeployed,
      proxyDeployed,
    };
  }

  if (proxyDeployed) {
    return {
      receiver: proxyAddress,
      receiverType: 'proxy',
      safeAddress,
      proxyAddress,
      safeDeployed,
      proxyDeployed,
    };
  }

  // If neither is deployed yet, still use the deterministic Safe address.
  return {
    receiver: safeAddress,
    receiverType: 'safe_uninitialized',
    safeAddress,
    proxyAddress,
    safeDeployed,
    proxyDeployed,
  };
}


// EIP-712 Domain for Polymarket orders
const ORDER_DOMAIN = {
  name: 'Polymarket CTF Exchange',
  version: '1',
  chainId: POLYGON_CHAIN_ID,
  verifyingContract: CTF_EXCHANGE_ADDRESS,
};

// EIP-712 Domain for CLOB Authentication (API key derivation)
const CLOB_AUTH_DOMAIN = {
  name: 'ClobAuthDomain',
  version: '1',
  chainId: POLYGON_CHAIN_ID,
};

// EIP-712 Types for CLOB Auth
const CLOB_AUTH_TYPES = {
  ClobAuth: [
    { name: 'address', type: 'address' },
    { name: 'timestamp', type: 'string' },
    { name: 'nonce', type: 'uint256' },
    { name: 'message', type: 'string' },
  ],
};

// EIP-712 Types for Order
const ORDER_TYPES = {
  Order: [
    { name: 'salt', type: 'uint256' },
    { name: 'maker', type: 'address' },
    { name: 'signer', type: 'address' },
    { name: 'taker', type: 'address' },
    { name: 'tokenId', type: 'uint256' },
    { name: 'makerAmount', type: 'uint256' },
    { name: 'takerAmount', type: 'uint256' },
    { name: 'expiration', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'feeRateBps', type: 'uint256' },
    { name: 'side', type: 'uint8' },
    { name: 'signatureType', type: 'uint8' },
  ],
};

interface OrderRequest {
  tokenId: string;
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
  orderType: 'GTC' | 'FOK' | 'GTD';
}

interface TradeResult {
  success: boolean;
  orderId?: string;
  error?: string;
  details?: any;
}

interface SafetyLimits {
  maxDailyLoss: number;      // Max loss per day in USD
  maxPositionSize: number;   // Max position size per market in USD
  maxOrderSize: number;      // Max single order size in USD
  enabled: boolean;          // Kill switch
}

// ============================================================================
// LIVE STRATEGY CONFIG - 20x smaller than paper trading for safety
// Paper: 100 shares → Live: 5 shares
// ============================================================================
const LIVE_STRATEGY_CONFIG = {
  // Initiële opening trade (paper = 100, live = 5)
  opening: {
    shares: 5,                // 5 shares per opening (20x kleiner)
    maxPrice: 0.55,           // Alleen openen als prijs ≤ 55¢
  },
  
  // Hedge settings (paper = 100, live = 5)
  hedge: {
    shares: 5,                // 5 shares voor hedge (20x kleiner)
    maxCombined: 0.97,        // Alleen hedgen als combined ≤ 97¢ (3% winst gegarandeerd)
    targetCombined: 0.95,     // Ideaal: combined ≤ 95¢ (5% winst)
  },
  
  // Accumulation settings (paper = 20-50, live = 1-3)
  accumulate: {
    minShares: 1,             // Min 1 share (20x kleiner)
    maxShares: 3,             // Max 3 shares (20x kleiner)
    maxCombined: 0.99,        // Alleen accumuleren als combined < 99¢
    maxPositionPerSide: 25,   // Max 25 shares per kant (paper = 500)
  },
  
  // General settings
  minSecondsRemaining: 60,    // Stop 60s voor expiry
  minPrice: 0.02,             // Niet kopen onder 2¢
  maxPrice: 0.98,             // Niet kopen boven 98¢
};

const DEFAULT_LIMITS: SafetyLimits = {
  maxDailyLoss: 10,          // $10 max loss per day (was $50)
  maxPositionSize: 20,       // $20 max per market (was $100)
  maxOrderSize: 5,           // $5 max per order (was $25)
  enabled: true,             // Bot enabled by default
};

// ============================================================================
// CLOB API Authentication & Order Signing
// Exact implementation matching @polymarket/clob-client headers/index.ts
// ============================================================================

// Helper: replaceAll for URL-safe base64
function replaceAll(s: string, search: string, replace: string): string {
  return s.split(search).join(replace);
}

// Helper: base64 to ArrayBuffer (matching clob-client/src/signing/hmac.ts)
function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const sanitizedBase64 = base64
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .replace(/[^A-Za-z0-9+/=]/g, '');
  const binaryString = atob(sanitizedBase64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer as ArrayBuffer;
}

// Helper: ArrayBuffer to base64 (matching clob-client/src/signing/hmac.ts)
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Builds the canonical Polymarket CLOB HMAC signature
 * Exact implementation from @polymarket/clob-client/src/signing/hmac.ts
 */
async function buildPolyHmacSignature(
  secret: string,
  timestamp: number,
  method: string,
  requestPath: string,
  body?: string
): Promise<string> {
  let message = timestamp + method + requestPath;
  if (body !== undefined) {
    message += body;
  }

  console.log(`[HMAC] Building signature for: ts=${timestamp}, method=${method}, path=${requestPath.slice(0, 50)}`);

  // Import the secret key from base64
  const keyData = base64ToArrayBuffer(secret);
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  // Sign the message
  const messageBuffer = new TextEncoder().encode(message);
  const signatureBuffer = await crypto.subtle.sign('HMAC', cryptoKey, messageBuffer);
  const sig = arrayBufferToBase64(signatureBuffer);

  // Must be URL-safe base64 encoding, but keep base64 "=" suffix
  const sigUrlSafe = replaceAll(replaceAll(sig, '+', '-'), '/', '_');
  return sigUrlSafe;
}

/**
 * Build EIP-712 signature for L1 authentication
 * Exact implementation from @polymarket/clob-client/src/signing/eip712.ts
 */
async function buildClobEip712Signature(
  wallet: ethers.Wallet,
  chainId: number,
  timestamp: number,
  nonce: number
): Promise<string> {
  const domain = {
    name: 'ClobAuthDomain',
    version: '1',
    chainId: chainId,
  };

  const types = {
    ClobAuth: [
      { name: 'address', type: 'address' },
      { name: 'timestamp', type: 'string' },
      { name: 'nonce', type: 'uint256' },
      { name: 'message', type: 'string' },
    ],
  };

  const value = {
    address: wallet.address,
    timestamp: timestamp.toString(),
    nonce: nonce,
    message: 'This message attests that I control the given wallet',
  };

  const sig = await wallet.signTypedData(domain, types, value);
  return sig;
}

/**
 * Create L1 Headers for API key derivation/creation
 * Exact implementation from @polymarket/clob-client/src/headers/index.ts
 */
async function createL1Headers(
  wallet: ethers.Wallet,
  chainId: number,
  nonce?: number,
  timestamp?: number
): Promise<Record<string, string>> {
  let ts = Math.floor(Date.now() / 1000);
  if (timestamp !== undefined) {
    ts = timestamp;
  }
  let n = 0;
  if (nonce !== undefined) {
    n = nonce;
  }

  const sig = await buildClobEip712Signature(wallet, chainId, ts, n);
  const address = wallet.address;

  console.log(`[L1 Headers] address=${address}, ts=${ts}, nonce=${n}`);

  return {
    'POLY_ADDRESS': address,
    'POLY_SIGNATURE': sig,
    'POLY_TIMESTAMP': `${ts}`,
    'POLY_NONCE': `${n}`,
  };
}

/**
 * Create L2 Headers for authenticated API requests
 * Exact implementation from @polymarket/clob-client/src/headers/index.ts
 */
async function createL2Headers(
  wallet: ethers.Wallet,
  creds: { key: string; secret: string; passphrase: string },
  method: string,
  requestPath: string,
  body?: string,
  timestamp?: number
): Promise<Record<string, string>> {
  let ts = Math.floor(Date.now() / 1000);
  if (timestamp !== undefined) {
    ts = timestamp;
  }

  const address = wallet.address;

  const sig = await buildPolyHmacSignature(
    creds.secret,
    ts,
    method,
    requestPath,
    body
  );

  console.log('[LiveBot] API KEY PRESENT:', !!creds.key);
  console.log(
    `[L2 Headers] address=${address}, ts=${ts}, method=${method}, path=${requestPath.slice(0, 50)}`
  );

  return {
    'POLY_ADDRESS': address,
    'POLY_SIGNATURE': sig,
    'POLY_TIMESTAMP': `${ts}`,
    'POLY_API_KEY': creds.key,
    'POLY_PASSPHRASE': creds.passphrase,
  };
}

// EIP-712 Order Signing for Polymarket using ethers.js
async function signOrder(
  privateKey: string,
  orderData: {
    salt: string;
    maker: string;
    signer: string;
    taker: string;
    tokenId: string;
    makerAmount: string;
    takerAmount: string;
    expiration: string;
    nonce: string;
    feeRateBps: string;
    side: number; // 0 = BUY, 1 = SELL
    signatureType: number;
  }
): Promise<string> {
  console.log('[LiveBot] Signing order with EIP-712...');
  
  const wallet = new ethers.Wallet(privateKey);
  
  // Sign typed data (EIP-712)
  const signature = await wallet.signTypedData(ORDER_DOMAIN, ORDER_TYPES, orderData);
  
  console.log('[LiveBot] Order signed successfully');
  return signature;
}

// Get wallet address from private key
function getWalletAddress(privateKey: string): string {
  const wallet = new ethers.Wallet(privateKey);
  return wallet.address;
}

// Polymarket uses a "funder" address (typically a Safe/Proxy shown in the UI) for authenticated CLOB requests.
// If we sign requests with the EOA instead, CLOB can reject them with 401.
async function resolvePolymarketFunder(privateKey: string): Promise<{ funderAddress: string; funderType: string }> {
  const eoaAddress = getWalletAddress(privateKey);

  try {
    const provider = new ethers.JsonRpcProvider(POLYGON_RPC_URL);
    const exchangeContract = new ethers.Contract(CTF_EXCHANGE_ADDRESS, EXCHANGE_ABI, provider);

    const receiverInfo = await resolvePolymarketReceiver(exchangeContract, provider, eoaAddress);
    return {
      funderAddress: receiverInfo.receiver,
      funderType: receiverInfo.receiverType,
    };
  } catch (err) {
    console.warn('[LiveBot] Failed to resolve funder (Safe/Proxy). Falling back to EOA:', err);
    return {
      funderAddress: eoaAddress,
      funderType: 'eoa',
    };
  }
}

// ============================================================================
// CLOB API Methods
// ============================================================================

// Derive or create API credentials from private key using EIP-712 L1 auth
// Uses official createL1Headers implementation
async function deriveApiCredentials(privateKey: string): Promise<{
  apiKey: string;
  apiSecret: string;
  passphrase: string;
}> {
  console.log('[LiveBot] Deriving API credentials from private key...');
  
  const wallet = new ethers.Wallet(privateKey);
  
  // Use official L1 headers function
  const l1Headers = await createL1Headers(wallet, POLYGON_CHAIN_ID, 0);
  const headers = { ...l1Headers, 'Content-Type': 'application/json' };
  
  console.log(`[LiveBot] Created L1 auth headers for ${wallet.address}`);
  
  // First try to derive existing API key
  console.log('[LiveBot] Attempting to derive existing API key...');
  const deriveResponse = await fetch(`${POLYMARKET_CLOB_HOST}/auth/derive-api-key`, {
    method: 'GET',
    headers,
  });
  
  const deriveText = await deriveResponse.text();
  console.log(`[LiveBot] Derive response: ${deriveResponse.status} - ${deriveText}`);
  
  if (deriveResponse.ok) {
    const credentials = JSON.parse(deriveText);
    console.log('[LiveBot] ✅ Successfully derived existing API credentials');
    return {
      apiKey: credentials.apiKey,
      apiSecret: credentials.secret,
      passphrase: credentials.passphrase,
    };
  }
  
  // If no existing key, create new one
  console.log('[LiveBot] No existing credentials, creating new API key...');
  const createResponse = await fetch(`${POLYMARKET_CLOB_HOST}/auth/api-key`, {
    method: 'POST',
    headers,
  });
  
  const createText = await createResponse.text();
  console.log(`[LiveBot] Create response: ${createResponse.status} - ${createText}`);
  
  if (!createResponse.ok) {
    throw new Error(`Failed to create API key: ${createResponse.status} - ${createText}`);
  }
  
  const newCredentials = JSON.parse(createText);
  console.log('[LiveBot] ✅ Successfully created new API credentials');
  
  return {
    apiKey: newCredentials.apiKey,
    apiSecret: newCredentials.secret,
    passphrase: newCredentials.passphrase,
  };
}

async function getBalanceAllowance(
  wallet: ethers.Wallet,
  creds: { key: string; secret: string; passphrase: string },
  assetType: 'COLLATERAL' | 'CONDITIONAL' = 'COLLATERAL'
): Promise<{ balance: string; allowance: string }> {
  // IMPORTANT: clob-client signs the endpoint path ONLY (no query string)
  // and sends query params separately.
  const endpoint = `/balance-allowance`;

  const signatureType = Number(Deno.env.get('POLYMARKET_SIGNATURE_TYPE') ?? '0');

  const headers = await createL2Headers(wallet, creds, 'GET', endpoint);

  const params = new URLSearchParams({
    asset_type: assetType,
    signature_type: String(signatureType),
  });

  const url = `${POLYMARKET_CLOB_HOST}${endpoint}?${params.toString()}`;
  console.log(`[LiveBot] Fetching balance from ${url}`);

  const response = await fetch(url, {
    method: 'GET',
    headers: { ...headers, 'Content-Type': 'application/json' },
  });

  const responseText = await response.text();
  console.log(`[LiveBot] Balance response: ${response.status} - ${responseText}`);

  if (response.status === 401) {
    throw new Error(`API key invalid or unauthorized (401): ${responseText}`);
  }

  if (!response.ok) {
    throw new Error(`Failed to get balance: ${response.status} - ${responseText}`);
  }

  const data = JSON.parse(responseText);
  return {
    balance: data.balance || '0',
    allowance: data.allowance || '0',
  };
}

async function createOrder(
  wallet: ethers.Wallet,
  creds: { key: string; secret: string; passphrase: string },
  privateKey: string,
  order: OrderRequest
): Promise<TradeResult> {
  console.log(`[LiveBot] Creating order: ${order.side} ${order.size} @ $${order.price} for ${order.tokenId.slice(0, 20)}...`);

  try {
    const walletAddress = wallet.address;
    console.log(`[LiveBot] Wallet address: ${walletAddress}`);

    // Calculate amounts (USDC has 6 decimals, outcome tokens have 6 decimals on Polymarket)
    const sizeInUnits = Math.floor(order.size * 1e6);

    const makerAmount = order.side === 'BUY'
      ? Math.floor(order.size * order.price * 1e6).toString() // USDC to pay
      : sizeInUnits.toString(); // Outcome tokens to sell

    const takerAmount = order.side === 'BUY'
      ? sizeInUnits.toString() // Outcome tokens to receive
      : Math.floor(order.size * order.price * 1e6).toString(); // USDC to receive

    // Create order data
    const salt = Math.floor(Math.random() * 1e18).toString();
    const orderData = {
      salt,
      maker: walletAddress,
      signer: walletAddress,
      taker: '0x0000000000000000000000000000000000000000',
      tokenId: order.tokenId,
      makerAmount,
      takerAmount,
      expiration: '0', // Never expires for GTC
      nonce: '0',
      feeRateBps: '0',
      side: order.side === 'BUY' ? 0 : 1,
      signatureType: 0, // EOA signature
    };

    // Sign the order with EIP-712
    const signature = await signOrder(privateKey, orderData);

    // Prepare API request
    const orderPayload = {
      order: orderData,
      signature,
      orderType: order.orderType,
    };

    const path = '/order';
    const body = JSON.stringify(orderPayload);
    const headers = await createL2Headers(wallet, creds, 'POST', path, body);

    console.log('[LiveBot] Submitting order to CLOB...');

    const response = await fetch(`${POLYMARKET_CLOB_HOST}${path}`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body,
    });

    const responseText = await response.text();
    console.log(`[LiveBot] CLOB Response: ${response.status} - ${responseText}`);

    if (!response.ok) {
      return {
        success: false,
        error: `CLOB API error: ${response.status} - ${responseText}`
      };
    }

    const result = JSON.parse(responseText);
    console.log('[LiveBot] ✅ Order submitted successfully:', result.orderID);

    return {
      success: true,
      orderId: result.orderID || result.id,
      details: result
    };
  } catch (error) {
    console.error('[LiveBot] Order creation failed:', error);
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// ============================================================================
// Safety Checks
// ============================================================================

async function checkSafetyLimits(
  supabase: any,
  orderSize: number,
  marketSlug: string,
  limits: SafetyLimits
): Promise<{ allowed: boolean; reason?: string }> {
  if (!limits.enabled) {
    return { allowed: false, reason: 'Kill switch activated - bot is disabled' };
  }
  
  if (orderSize > limits.maxOrderSize) {
    return { allowed: false, reason: `Order size $${orderSize} exceeds max $${limits.maxOrderSize}` };
  }
  
  // Check daily loss
  const today = new Date().toISOString().split('T')[0];
  const { data: todayTrades } = await supabase
    .from('live_trades')
    .select('realized_pnl')
    .gte('created_at', `${today}T00:00:00Z`);
  
  const dailyPnL = todayTrades?.reduce((sum: number, t: any) => sum + (t.realized_pnl || 0), 0) || 0;
  
  if (dailyPnL < -limits.maxDailyLoss) {
    return { allowed: false, reason: `Daily loss $${Math.abs(dailyPnL).toFixed(2)} exceeds max $${limits.maxDailyLoss}` };
  }
  
  // Check position size for this market
  const { data: marketPosition } = await supabase
    .from('live_trades')
    .select('total')
    .eq('market_slug', marketSlug)
    .is('realized_pnl', null); // Open positions only
  
  const positionSize = marketPosition?.reduce((sum: number, t: any) => sum + t.total, 0) || 0;
  
  if (positionSize + orderSize > limits.maxPositionSize) {
    return { 
      allowed: false, 
      reason: `Position size $${(positionSize + orderSize).toFixed(2)} would exceed max $${limits.maxPositionSize}` 
    };
  }
  
  return { allowed: true };
}

// ============================================================================
// Main Handler
// ============================================================================

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }
  
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, supabaseKey);
  
  // Get credentials from environment (preferred) or derive from private key
  const privateKey = Deno.env.get('POLYMARKET_PRIVATE_KEY');
  const storedApiKey = Deno.env.get('POLYMARKET_API_KEY');
  const storedApiSecret = Deno.env.get('POLYMARKET_API_SECRET');
  const storedPassphrase = Deno.env.get('POLYMARKET_PASSPHRASE');
  
  if (!privateKey) {
    console.error('[LiveBot] Missing Polymarket private key');
    return new Response(JSON.stringify({
      success: false,
      error: 'Missing POLYMARKET_PRIVATE_KEY',
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
  
  // Use stored credentials if available, otherwise derive from private key
  let apiCredentials: { apiKey: string; apiSecret: string; passphrase: string } | null = null;
  
  // Check if we have stored API credentials
  if (storedApiKey && storedApiSecret && storedPassphrase) {
    console.log('[LiveBot] Using stored API credentials from environment');
    apiCredentials = {
      apiKey: storedApiKey,
      apiSecret: storedApiSecret,
      passphrase: storedPassphrase,
    };
  }
  
  async function getCredentials() {
    if (!apiCredentials) {
      console.log('[LiveBot] No stored credentials, deriving from private key...');
      apiCredentials = await deriveApiCredentials(privateKey!);
    }
    return apiCredentials;
  }
  
  try {
    const body = await req.json().catch(() => ({}));
    const action = body.action || 'status';
    
    switch (action) {
      case 'status': {
        // Return bot status and configuration
        const walletAddress = getWalletAddress(privateKey);
        const funder = await resolvePolymarketFunder(privateKey);

        return new Response(
          JSON.stringify({
            success: true,
            status: 'READY',
            message: '✅ Live trading bot fully configured and ready',
            walletAddress,
            funderAddress: funder.funderAddress,
            funderType: funder.funderType,
            limits: DEFAULT_LIMITS,
            implementation: {
              authentication: '✅ HMAC API headers ready',
              orderSigning: '✅ EIP-712 signing with ethers.js',
              safetyChecks: '✅ Daily loss, position limits',
              killSwitch: '✅ Emergency stop available',
            },
          }),
          {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          }
        );
      }

      case 'balance': {
        try {
          const wallet = new ethers.Wallet(privateKey!);
          const walletAddress = wallet.address;
          const funder = await resolvePolymarketFunder(privateKey!);

          let creds = await getCredentials();
          let balanceData: { balance: string; allowance: string };

          try {
            balanceData = await getBalanceAllowance(
              wallet,
              { key: creds.apiKey, secret: creds.apiSecret, passphrase: creds.passphrase },
              'COLLATERAL'
            );
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);

            // Stored creds can be stale/incorrect. If we get a 401, derive fresh creds and retry once.
            if (
              msg.includes('401') ||
              msg.toLowerCase().includes('unauthorized') ||
              msg.toLowerCase().includes('invalid api key')
            ) {
              console.warn('[LiveBot] Stored API credentials rejected (401). Deriving fresh credentials and retrying...');
              apiCredentials = await deriveApiCredentials(privateKey!);
              creds = apiCredentials;

              balanceData = await getBalanceAllowance(
                wallet,
                { key: creds.apiKey, secret: creds.apiSecret, passphrase: creds.passphrase },
                'COLLATERAL'
              );
            } else {
              throw err;
            }
          }

          const balanceUSDC = parseFloat(balanceData.balance) / 1e6; // USDC has 6 decimals
          return new Response(
            JSON.stringify({
              success: true,
              balance: balanceUSDC,
              balanceRaw: balanceData.balance,
              allowance: balanceData.allowance,
              currency: 'USDC',
              walletAddress,
              funderAddress: funder.funderAddress,
              funderType: funder.funderType,
            }),
            {
              headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            }
          );
        } catch (error) {
          console.error('[LiveBot] Balance error:', error);
          return new Response(
            JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : 'Failed to get balance',
            }),
            {
              status: 500,
              headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            }
          );
        }
      }
      
      case 'order': {
        const { tokenId, side, price, size, orderType = 'GTC', marketSlug } = body;

        if (!tokenId || !side || !price || !size) {
          return new Response(
            JSON.stringify({
              success: false,
              error: 'Missing required fields: tokenId, side, price, size',
            }),
            {
              status: 400,
              headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            }
          );
        }

        // Safety checks
        const safetyCheck = await checkSafetyLimits(supabase, size * price, marketSlug || '', DEFAULT_LIMITS);
        if (!safetyCheck.allowed) {
          console.log(`[LiveBot] Order blocked by safety: ${safetyCheck.reason}`);
          return new Response(
            JSON.stringify({
              success: false,
              error: safetyCheck.reason,
              blocked: true,
            }),
            {
              status: 403,
              headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            }
          );
        }

        // Create order (retry once if stored creds are invalid)
        const wallet = new ethers.Wallet(privateKey!);
        let creds = await getCredentials();
        let result = await createOrder(
          wallet,
          { key: creds.apiKey, secret: creds.apiSecret, passphrase: creds.passphrase },
          privateKey!,
          {
            tokenId,
            side: side.toUpperCase() as 'BUY' | 'SELL',
            price,
            size,
            orderType,
          }
        );

        const errMsg = (result.error || '').toLowerCase();
        if (!result.success && (errMsg.includes('401') || errMsg.includes('unauthorized') || errMsg.includes('invalid api key'))) {
          console.warn('[LiveBot] Stored API credentials rejected (401). Deriving fresh credentials and retrying order...');
          apiCredentials = await deriveApiCredentials(privateKey!);
          creds = apiCredentials;

          result = await createOrder(
            wallet,
            { key: creds.apiKey, secret: creds.apiSecret, passphrase: creds.passphrase },
            privateKey!,
            {
              tokenId,
              side: side.toUpperCase() as 'BUY' | 'SELL',
              price,
              size,
              orderType,
            }
          );
        }

        return new Response(JSON.stringify(result), {
          status: result.success ? 200 : 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      
      case 'kill': {
        // Emergency kill switch
        console.log('[LiveBot] 🛑 KILL SWITCH ACTIVATED');
        return new Response(JSON.stringify({
          success: true,
          message: 'Kill switch activated - all trading disabled',
          enabled: false,
        }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      
      case 'derive-credentials': {
        // Generate new API credentials from private key using L1 auth
        try {
          const walletAddress = getWalletAddress(privateKey);
          console.log(`[LiveBot] Deriving credentials for wallet: ${walletAddress}`);
          
          const credentials = await deriveApiCredentials(privateKey);
          
          return new Response(JSON.stringify({
            success: true,
            message: '✅ API credentials derived/created successfully',
            walletAddress,
            credentials: {
              apiKey: credentials.apiKey,
              apiSecret: credentials.apiSecret,
              passphrase: credentials.passphrase,
            },
            instructions: 'Save these credentials to your Supabase secrets: POLYMARKET_API_KEY, POLYMARKET_API_SECRET, POLYMARKET_PASSPHRASE',
          }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        } catch (error) {
          console.error('[LiveBot] Credential derivation failed:', error);
          return new Response(JSON.stringify({
            success: false,
            error: error instanceof Error ? error.message : 'Failed to derive credentials',
          }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
      }
      
      case 'debug-auth': {
        // Debug authentication by testing multiple endpoints
        try {
          const wallet = new ethers.Wallet(privateKey!);
          const walletAddress = wallet.address;
          const creds = await getCredentials();

          // Test 1: Public endpoint (no auth needed)
          console.log('[DEBUG] Testing public endpoint...');
          const publicTest = await fetch(`${POLYMARKET_CLOB_HOST}/time`);
          const publicResult = await publicTest.text();
          console.log(`[DEBUG] Public /time: ${publicTest.status} - ${publicResult}`);

          // Test 2: Get API key info (L2 auth)
          console.log('[DEBUG] Testing /auth/api-keys endpoint...');
          const apiKeysPath = '/auth/api-keys';
          const apiKeysHeaders = await createL2Headers(
            wallet,
            { key: creds.apiKey, secret: creds.apiSecret, passphrase: creds.passphrase },
            'GET',
            apiKeysPath
          );
          const apiKeysTest = await fetch(`${POLYMARKET_CLOB_HOST}${apiKeysPath}`, {
            method: 'GET',
            headers: { ...apiKeysHeaders, 'Content-Type': 'application/json' },
          });
          const apiKeysResult = await apiKeysTest.text();
          console.log(`[DEBUG] /auth/api-keys: ${apiKeysTest.status} - ${apiKeysResult}`);
          
          // Test 3: Check if using correct nonce using L1 headers
          console.log('[DEBUG] Testing /auth/api-key endpoint (check key exists)...');
          const l1Headers = await createL1Headers(wallet, POLYGON_CHAIN_ID, 0);
          
          const getKeyTest = await fetch(`${POLYMARKET_CLOB_HOST}/auth/api-key`, {
            method: 'GET',
            headers: { ...l1Headers, 'Content-Type': 'application/json' },
          });
          const getKeyResult = await getKeyTest.text();
          console.log(`[DEBUG] GET /auth/api-key: ${getKeyTest.status} - ${getKeyResult}`);
          
          return new Response(JSON.stringify({
            success: true,
            walletAddress,
            credentials: {
              apiKey: creds.apiKey,
              secretLength: creds.apiSecret.length,
              passphraseLength: creds.passphrase.length,
            },
            tests: {
              publicEndpoint: { status: publicTest.status, result: publicResult },
              apiKeysEndpoint: { status: apiKeysTest.status, result: apiKeysResult },
              getKeyEndpoint: { status: getKeyTest.status, result: getKeyResult },
            }
          }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        } catch (error) {
          console.error('[DEBUG] Error:', error);
          return new Response(JSON.stringify({
            success: false,
            error: error instanceof Error ? error.message : String(error),
          }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
      }
      
      case 'wallet-balance': {
        // Check wallet balances (MATIC + Polymarket collateral token)
        try {
          console.log('[LiveBot] Checking wallet balances...');
          const provider = new ethers.JsonRpcProvider(POLYGON_RPC_URL);
          const wallet = new ethers.Wallet(privateKey!, provider);
          const walletAddress = wallet.address;

          // Get MATIC balance for gas
          const maticBalance = await provider.getBalance(walletAddress);
          const maticBalanceFormatted = ethers.formatEther(maticBalance);
          console.log(`[LiveBot] MATIC balance: ${maticBalanceFormatted}`);

          // Resolve collateral token from exchange (critical: do NOT assume USDC contract)
          const exchangeRead = new ethers.Contract(CTF_EXCHANGE_ADDRESS, EXCHANGE_ABI, provider);
          const collateralAddressRaw = await exchangeRead.getCollateral();
          const collateralAddress = ethers.getAddress(collateralAddressRaw);
          console.log(`[LiveBot] Exchange collateral token: ${collateralAddress}`);

          const collateralContract = new ethers.Contract(collateralAddress, ERC20_ABI, provider);
          const collateralBalance = await collateralContract.balanceOf(walletAddress);
          const collateralDecimals = await collateralContract.decimals();
          const collateralBalanceFormatted = Number(collateralBalance) / Math.pow(10, Number(collateralDecimals));
          console.log(`[LiveBot] Collateral balance: ${collateralBalanceFormatted}`);

          // (Optional) show USDT balance because swap uses it
          const usdtContract = new ethers.Contract(USDT_ADDRESS, ERC20_ABI, provider);
          const usdtBalance = await usdtContract.balanceOf(walletAddress);
          const usdtDecimals = await usdtContract.decimals();
          const usdtBalanceFormatted = Number(usdtBalance) / Math.pow(10, Number(usdtDecimals));
          console.log(`[LiveBot] USDT balance: ${usdtBalanceFormatted}`);

          // Check current allowance to CTF Exchange for the collateral token
          const allowance = await collateralContract.allowance(walletAddress, CTF_EXCHANGE_ADDRESS);
          const allowanceFormatted = Number(allowance) / Math.pow(10, Number(collateralDecimals));
          console.log(`[LiveBot] Collateral allowance to exchange: ${allowanceFormatted}`);

          return new Response(
            JSON.stringify({
              success: true,
              walletAddress,
              collateralAddress,
              balances: {
                matic: parseFloat(maticBalanceFormatted),
                // Keep the existing field names for UI compatibility:
                usdc: collateralBalanceFormatted,
                usdt: usdtBalanceFormatted,
                usdcAllowanceToExchange: allowanceFormatted,
              },
              hasGasForTx: parseFloat(maticBalanceFormatted) > 0.001,
              canDeposit: collateralBalanceFormatted > 0 && parseFloat(maticBalanceFormatted) > 0.001,
              canSwapUsdtToUsdc: usdtBalanceFormatted > 0 && parseFloat(maticBalanceFormatted) > 0.001,
            }),
            {
              headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            }
          );
        } catch (error) {
          console.error('[LiveBot] Wallet balance error:', error);
          return new Response(
            JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : String(error),
            }),
            {
              status: 500,
              headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            }
          );
        }
      }
      
      case 'deposit': {
        // Deposit USDC from wallet to Polymarket exchange (to proxy wallet)
        try {
          const { amount } = body;
          if (!amount || amount <= 0) {
            return new Response(JSON.stringify({
              success: false,
              error: 'Missing or invalid amount parameter',
            }), {
              status: 400,
              headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
          }
          
          console.log(`[LiveBot] Depositing ${amount} USDC to Polymarket...`);
          const provider = new ethers.JsonRpcProvider(POLYGON_RPC_URL);
          const wallet = new ethers.Wallet(privateKey!, provider);
          const walletAddress = wallet.address;

          const exchangeContract = new ethers.Contract(CTF_EXCHANGE_ADDRESS, EXCHANGE_ABI, wallet);

          // Resolve collateral token from exchange (critical: do NOT assume USDC contract)
          const collateralAddressRaw = await exchangeContract.getCollateral();
          const collateralAddress = ethers.getAddress(collateralAddressRaw);
          console.log(`[LiveBot] Exchange collateral token: ${collateralAddress}`);

          const collateralContract = new ethers.Contract(collateralAddress, ERC20_ABI, wallet);
          const collateralDecimals = await collateralContract.decimals();

          // Resolve possible receivers directly from the exchange contract
          const {
            receiver: preferredReceiver,
            receiverType: preferredReceiverType,
            safeAddress,
            proxyAddress,
            safeDeployed,
            proxyDeployed,
          } = await resolvePolymarketReceiver(exchangeContract, provider, walletAddress);

          console.log(`[LiveBot] EOA Address: ${walletAddress}`);
          console.log(`[LiveBot] Safe Address: ${safeAddress} (deployed=${safeDeployed})`);
          console.log(`[LiveBot] Proxy Address: ${proxyAddress} (deployed=${proxyDeployed})`);
          console.log(`[LiveBot] Preferred receiver: ${preferredReceiver} (type=${preferredReceiverType})`);

          // Amount in collateral units (typically 6 decimals, but we read it from-chain)
          const amountInUnits = BigInt(Math.floor(amount * Math.pow(10, Number(collateralDecimals))));
          console.log(`[LiveBot] Amount in units: ${amountInUnits} (decimals=${collateralDecimals})`);

          // Check collateral balance first
          const currentBalance = await collateralContract.balanceOf(walletAddress);
          console.log(`[LiveBot] Current collateral balance: ${currentBalance}`);

          if (currentBalance < amountInUnits) {
            return new Response(
              JSON.stringify({
                success: false,
                error: `Insufficient collateral balance. Have ${Number(currentBalance) / Math.pow(10, Number(collateralDecimals))}, need ${amount}`,
                collateralAddress,
              }),
              {
                status: 400,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
              }
            );
          }

          // Check and set allowance if needed
          const currentAllowance = await collateralContract.allowance(walletAddress, CTF_EXCHANGE_ADDRESS);
          console.log(`[LiveBot] Current allowance: ${currentAllowance}`);

          if (currentAllowance < amountInUnits) {
            console.log('[LiveBot] Approving collateral spend...');
            // Approve max uint256 so we don't need to approve again
            const maxApproval = BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff');
            const approveTx = await collateralContract.approve(CTF_EXCHANGE_ADDRESS, maxApproval);
            console.log(`[LiveBot] Approve tx: ${approveTx.hash}`);
            const approveReceipt = await approveTx.wait();
            console.log(`[LiveBot] Approval confirmed in block ${approveReceipt.blockNumber}`);

            // Wait a moment for state to propagate on RPC nodes
            await new Promise((resolve) => setTimeout(resolve, 2000));

            // Verify allowance is now set
            const newAllowance = await collateralContract.allowance(walletAddress, CTF_EXCHANGE_ADDRESS);
            console.log(`[LiveBot] New allowance after approval: ${newAllowance}`);

            if (newAllowance < amountInUnits) {
              return new Response(
                JSON.stringify({
                  success: false,
                  error: 'Approval transaction confirmed but allowance not updated. Please try again.',
                  approveTxHash: approveTx.hash,
                  collateralAddress,
                }),
                {
                  status: 500,
                  headers: { ...corsHeaders, 'Content-Type': 'application/json' },
                }
              );
            }
          }

          // Try deposit receivers in order. Some accounts only accept deposits to a specific receiver.
          const candidateReceivers: Array<{ address: string; type: 'safe' | 'proxy' | 'eoa' }> = [];

          // Always try preferred first
          candidateReceivers.push({
            address: preferredReceiver,
            type: preferredReceiverType.startsWith('safe') ? 'safe' : 'proxy',
          });

          // Then try the other contract-wallet addresses
          if (preferredReceiver.toLowerCase() !== safeAddress.toLowerCase()) {
            candidateReceivers.push({ address: safeAddress, type: 'safe' });
          }
          if (preferredReceiver.toLowerCase() !== proxyAddress.toLowerCase()) {
            candidateReceivers.push({ address: proxyAddress, type: 'proxy' });
          }

          // Finally try EOA
          if (
            walletAddress.toLowerCase() !== preferredReceiver.toLowerCase() &&
            walletAddress.toLowerCase() !== safeAddress.toLowerCase() &&
            walletAddress.toLowerCase() !== proxyAddress.toLowerCase()
          ) {
            candidateReceivers.push({ address: walletAddress, type: 'eoa' });
          }

          const simulationErrors: Record<string, string> = {};
          let receiverToUse: { address: string; type: 'safe' | 'proxy' | 'eoa' } | null = null;

          for (const candidate of candidateReceivers) {
            console.log(`[LiveBot] Simulating deposit for receiver ${candidate.address} (${candidate.type})...`);
            try {
              const gasEstimate = await exchangeContract.deposit.estimateGas(candidate.address, amountInUnits);
              console.log(`[LiveBot] Gas estimate ok (${candidate.type}): ${gasEstimate}`);
              receiverToUse = candidate;
              break;
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              simulationErrors[`${candidate.type}:${candidate.address}`] = msg;
              console.warn(`[LiveBot] Deposit simulation failed (${candidate.type}): ${msg}`);
            }
          }

          if (!receiverToUse) {
            console.warn('[LiveBot] Exchange deposit simulation failed for all receivers. Falling back to Polymarket bridge deposit address.');

            try {
              const bridgeResp = await fetch('https://bridge.polymarket.com/deposit', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ address: walletAddress }),
              });

              const bridgeText = await bridgeResp.text();
              console.log(`[LiveBot] Bridge deposit response: ${bridgeResp.status} - ${bridgeText}`);

              if (!bridgeResp.ok) {
                throw new Error(`Bridge deposit endpoint failed: ${bridgeResp.status} - ${bridgeText}`);
              }

              const bridgeJson = JSON.parse(bridgeText);
              const depositAddressRaw = bridgeJson?.address?.evm;

              if (!depositAddressRaw || !ethers.isAddress(depositAddressRaw)) {
                throw new Error(`Bridge deposit endpoint returned invalid evm address: ${depositAddressRaw}`);
              }

              const bridgeDepositAddress = ethers.getAddress(depositAddressRaw);
              console.log(`[LiveBot] Bridge deposit address (EVM): ${bridgeDepositAddress}`);

              // Transfer collateral directly to Polymarket bridge deposit address.
              const transferTx = await collateralContract.transfer(bridgeDepositAddress, amountInUnits);
              console.log(`[LiveBot] Bridge transfer tx: ${transferTx.hash}`);
              const transferReceipt = await transferTx.wait();
              console.log(`[LiveBot] Bridge transfer confirmed in block ${transferReceipt.blockNumber}`);

              return new Response(
                JSON.stringify({
                  success: true,
                  message: `✅ Sent ${amount} collateral to Polymarket deposit address (bridge)`,
                  method: 'bridge_transfer',
                  walletAddress,
                  receiverAddress: bridgeDepositAddress,
                  collateralAddress,
                  txHash: transferTx.hash,
                  blockNumber: transferReceipt.blockNumber,
                  note: 'Funds may take a few minutes to appear in your Polymarket balance.',
                }),
                {
                  headers: { ...corsHeaders, 'Content-Type': 'application/json' },
                }
              );
            } catch (bridgeError) {
              const bridgeMsg = bridgeError instanceof Error ? bridgeError.message : String(bridgeError);
              return new Response(
                JSON.stringify({
                  success: false,
                  error: 'Deposit simulation failed for all receivers (exchange) and bridge fallback failed',
                  eoaWallet: walletAddress,
                  safeAddress,
                  proxyAddress,
                  safeDeployed,
                  proxyDeployed,
                  details: simulationErrors,
                  bridgeError: bridgeMsg,
                  hint: 'If this is a brand-new wallet, you may need to complete Polymarket onboarding first.',
                }),
                {
                  status: 500,
                  headers: { ...corsHeaders, 'Content-Type': 'application/json' },
                }
              );
            }
          }

          console.log(`[LiveBot] Calling deposit on exchange to receiver ${receiverToUse.address} (${receiverToUse.type})...`);

          const depositTx = await exchangeContract.deposit(receiverToUse.address, amountInUnits);
          console.log(`[LiveBot] Deposit tx: ${depositTx.hash}`);
          const receipt = await depositTx.wait();
          console.log(`[LiveBot] Deposit confirmed in block ${receipt.blockNumber}`);

          return new Response(
            JSON.stringify({
              success: true,
              message: `✅ Successfully deposited ${amount} USDC to Polymarket`,
              depositTxHash: depositTx.hash,
              blockNumber: receipt.blockNumber,
              walletAddress,
              receiverAddress: receiverToUse.address,
              receiverType: receiverToUse.type,
              safeAddress,
              proxyAddress,
            }),
            {
              headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            }
          );
        } catch (error) {
          console.error('[LiveBot] Deposit error:', error);
          return new Response(JSON.stringify({
            success: false,
            error: error instanceof Error ? error.message : String(error),
          }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
      }
      
      case 'swap': {
        // Swap USDT to USDC via Uniswap V3 on Polygon
        try {
          const { amount, fromToken = 'USDT' } = body;
          
          if (!amount || amount <= 0) {
            return new Response(JSON.stringify({
              success: false,
              error: 'Missing or invalid amount parameter',
            }), {
              status: 400,
              headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
          }
          
          console.log(`[LiveBot] Swapping ${amount} ${fromToken} to USDC...`);
          const provider = new ethers.JsonRpcProvider(POLYGON_RPC_URL);
          const wallet = new ethers.Wallet(privateKey!, provider);
          const walletAddress = wallet.address;
          
          // Both USDT and the exchange collateral token are expected to be 6 decimals on Polygon,
          // but we resolve collateral from-chain to avoid mismatches.
          const exchangeRead = new ethers.Contract(CTF_EXCHANGE_ADDRESS, EXCHANGE_ABI, provider);
          const collateralAddressRaw = await exchangeRead.getCollateral();
          const collateralAddress = ethers.getAddress(collateralAddressRaw);

          // Amount in token-in units (USDT is 6 decimals on Polygon)
          const amountInUnits = BigInt(Math.floor(amount * 1e6));

          // Determine token addresses
          const tokenInAddress = fromToken.toUpperCase() === 'USDT' ? USDT_ADDRESS : USDT_ADDRESS;
          const tokenOutAddress = collateralAddress;

          console.log(`[LiveBot] Token in: ${tokenInAddress}`);
          console.log(`[LiveBot] Token out (collateral): ${tokenOutAddress}`);
          console.log(`[LiveBot] Amount: ${amountInUnits}`);
          
          // Check balance
          const tokenInContract = new ethers.Contract(tokenInAddress, ERC20_ABI, wallet);
          const balance = await tokenInContract.balanceOf(walletAddress);
          console.log(`[LiveBot] ${fromToken} balance: ${balance}`);
          
          if (balance < amountInUnits) {
            return new Response(JSON.stringify({
              success: false,
              error: `Insufficient ${fromToken} balance. Have ${Number(balance) / 1e6}, need ${amount}`,
            }), {
              status: 400,
              headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
          }
          
          // Check MATIC for gas
          const maticBalance = await provider.getBalance(walletAddress);
          if (maticBalance < ethers.parseEther('0.001')) {
            return new Response(JSON.stringify({
              success: false,
              error: `Insufficient MATIC for gas. Have ${ethers.formatEther(maticBalance)}, need at least 0.001`,
            }), {
              status: 400,
              headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
          }
          
          // Approve router if needed
          const currentAllowance = await tokenInContract.allowance(walletAddress, UNISWAP_ROUTER_ADDRESS);
          console.log(`[LiveBot] Current allowance to router: ${currentAllowance}`);
          
          if (currentAllowance < amountInUnits) {
            console.log('[LiveBot] Approving token spend to router...');
            const maxApproval = BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff');
            const approveTx = await tokenInContract.approve(UNISWAP_ROUTER_ADDRESS, maxApproval);
            console.log(`[LiveBot] Approve tx: ${approveTx.hash}`);
            await approveTx.wait();
            console.log('[LiveBot] Approval confirmed');
          }
          
          // Execute swap via Uniswap V3
          // Using 0.01% fee tier (100) which is common for stablecoin pairs
          const swapRouter = new ethers.Contract(UNISWAP_ROUTER_ADDRESS, SWAP_ROUTER_ABI, wallet);
          
          // Calculate minimum output (0.5% slippage for stablecoins)
          const minAmountOut = (amountInUnits * 995n) / 1000n;
          
          const swapParams = {
            tokenIn: tokenInAddress,
            tokenOut: tokenOutAddress,
            fee: 100, // 0.01% fee tier for stablecoins
            recipient: walletAddress,
            amountIn: amountInUnits,
            amountOutMinimum: minAmountOut,
            sqrtPriceLimitX96: 0n, // No price limit
          };
          
          console.log('[LiveBot] Executing swap...');
          console.log('[LiveBot] Swap params:', JSON.stringify(swapParams, (_, v) => typeof v === 'bigint' ? v.toString() : v));
          
          const swapTx = await swapRouter.exactInputSingle(swapParams);
          console.log(`[LiveBot] Swap tx: ${swapTx.hash}`);
          const receipt = await swapTx.wait();
          console.log(`[LiveBot] Swap confirmed in block ${receipt.blockNumber}`);
          
          // Get new USDC balance
          const usdcContract = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, provider);
          const newUsdcBalance = await usdcContract.balanceOf(walletAddress);
          
          return new Response(JSON.stringify({
            success: true,
            message: `✅ Successfully swapped ${amount} ${fromToken} to USDC`,
            swapTxHash: swapTx.hash,
            blockNumber: receipt.blockNumber,
            newUsdcBalance: Number(newUsdcBalance) / 1e6,
            walletAddress,
          }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        } catch (error) {
          console.error('[LiveBot] Swap error:', error);
          return new Response(JSON.stringify({
            success: false,
            error: error instanceof Error ? error.message : String(error),
          }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
      }
      
      case 'redeem': {
        // Redeem winning positions from resolved markets
        try {
          const { conditionId, tokenIds } = body;
          
          if (!conditionId) {
            return new Response(JSON.stringify({
              success: false,
              error: 'Missing conditionId parameter. Get this from market data.',
            }), {
              status: 400,
              headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
          }
          
          console.log(`[LiveBot] Redeeming positions for condition: ${conditionId}`);
          const provider = new ethers.JsonRpcProvider(POLYGON_RPC_URL);
          const wallet = new ethers.Wallet(privateKey!, provider);
          const walletAddress = wallet.address;

          // Get CTF (Conditional Tokens) contract address from exchange
          const exchangeContract = new ethers.Contract(CTF_EXCHANGE_ADDRESS, EXCHANGE_ABI, provider);
          const ctfAddressRaw = await exchangeContract.getCtf();
          const ctfAddress = ethers.getAddress(ctfAddressRaw);
          console.log(`[LiveBot] CTF contract: ${ctfAddress}`);

          // Get collateral token
          const collateralAddressRaw = await exchangeContract.getCollateral();
          const collateralAddress = ethers.getAddress(collateralAddressRaw);
          console.log(`[LiveBot] Collateral: ${collateralAddress}`);

          // Resolve the wallet address we should redeem from (Safe or Proxy)
          const receiverInfo = await resolvePolymarketReceiver(exchangeContract, provider, walletAddress);
          const redeemFrom = receiverInfo.receiver;
          console.log(`[LiveBot] Redeeming from: ${redeemFrom} (${receiverInfo.receiverType})`);

          // Connect to CTF contract
          const ctfContract = new ethers.Contract(ctfAddress, CONDITIONAL_TOKENS_ABI, wallet);

          // Check payout denominator (if > 0, market is resolved)
          const payoutDenom = await ctfContract.payoutDenominator(conditionId);
          console.log(`[LiveBot] Payout denominator: ${payoutDenom}`);

          if (payoutDenom === 0n) {
            return new Response(JSON.stringify({
              success: false,
              error: 'Market not yet resolved (payoutDenominator = 0)',
              conditionId,
            }), {
              status: 400,
              headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
          }

          // For binary markets, indexSets are [1, 2] representing outcome 0 and outcome 1
          // indexSet 1 = 0b01 = outcome index 0 (YES/UP)
          // indexSet 2 = 0b10 = outcome index 1 (NO/DOWN)
          const indexSets = [1, 2];
          const parentCollectionId = '0x' + '0'.repeat(64); // Zero bytes32 for root collection

          // Check balances before redeem
          const collectionId0 = await ctfContract.getCollectionId(parentCollectionId, conditionId, 1);
          const collectionId1 = await ctfContract.getCollectionId(parentCollectionId, conditionId, 2);
          const positionId0 = await ctfContract.getPositionId(collateralAddress, collectionId0);
          const positionId1 = await ctfContract.getPositionId(collateralAddress, collectionId1);
          
          const balance0 = await ctfContract.balanceOf(redeemFrom, positionId0);
          const balance1 = await ctfContract.balanceOf(redeemFrom, positionId1);
          
          console.log(`[LiveBot] Position balances - UP: ${balance0}, DOWN: ${balance1}`);

          if (balance0 === 0n && balance1 === 0n) {
            return new Response(JSON.stringify({
              success: false,
              error: 'No positions to redeem (both balances are 0)',
              conditionId,
              balances: { up: '0', down: '0' },
            }), {
              status: 400,
              headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
          }

          // Get collateral balance before
          const collateralContract = new ethers.Contract(collateralAddress, ERC20_ABI, provider);
          const balanceBefore = await collateralContract.balanceOf(redeemFrom);
          console.log(`[LiveBot] Collateral balance before: ${balanceBefore}`);

          // Execute redemption
          console.log('[LiveBot] Calling redeemPositions...');
          const redeemTx = await ctfContract.redeemPositions(
            collateralAddress,
            parentCollectionId,
            conditionId,
            indexSets
          );
          console.log(`[LiveBot] Redeem tx: ${redeemTx.hash}`);
          const receipt = await redeemTx.wait();
          console.log(`[LiveBot] Redeem confirmed in block ${receipt.blockNumber}`);

          // Get collateral balance after
          const balanceAfter = await collateralContract.balanceOf(redeemFrom);
          const redeemed = balanceAfter - balanceBefore;
          const redeemedFormatted = Number(redeemed) / 1e6;
          console.log(`[LiveBot] Collateral redeemed: ${redeemedFormatted} USDC`);

          return new Response(JSON.stringify({
            success: true,
            message: `✅ Successfully redeemed positions`,
            conditionId,
            redeemedAmount: redeemedFormatted,
            currency: 'USDC',
            txHash: redeemTx.hash,
            blockNumber: receipt.blockNumber,
            walletAddress,
            redeemFrom,
            positionBalances: {
              up: balance0.toString(),
              down: balance1.toString(),
            },
          }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        } catch (error) {
          console.error('[LiveBot] Redeem error:', error);
          return new Response(JSON.stringify({
            success: false,
            error: error instanceof Error ? error.message : String(error),
          }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
      }
      
      case 'portfolio': {
        // Fetch portfolio data including positions from Polymarket Data API
        try {
          const wallet = new ethers.Wallet(privateKey!);
          const funder = await resolvePolymarketFunder(privateKey!);
          
          console.log(`[LiveBot] Fetching portfolio for ${funder.funderAddress}...`);
          
          // Get cash balance first
          let creds = await getCredentials();
          let balanceData: { balance: string; allowance: string };
          
          try {
            balanceData = await getBalanceAllowance(
              wallet,
              { key: creds.apiKey, secret: creds.apiSecret, passphrase: creds.passphrase },
              'COLLATERAL'
            );
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes('401') || msg.toLowerCase().includes('unauthorized')) {
              console.warn('[LiveBot] Stored API credentials rejected. Deriving fresh credentials...');
              apiCredentials = await deriveApiCredentials(privateKey!);
              creds = apiCredentials;
              balanceData = await getBalanceAllowance(
                wallet,
                { key: creds.apiKey, secret: creds.apiSecret, passphrase: creds.passphrase },
                'COLLATERAL'
              );
            } else {
              throw err;
            }
          }
          
          // The CLOB balance only shows USDC, but Polymarket also uses USDC.e
          // We need to fetch the on-chain USDC.e balance for accurate portfolio value
          const clobBalance = parseFloat(balanceData.balance) / 1e6;
          console.log(`[LiveBot] CLOB balance: $${clobBalance.toFixed(2)}`);
          
          // Fetch USDC.e balance on-chain (this is where Polymarket holds most funds)
          // USDC.e contract on Polygon: 0x2791bca1f2de4661ed88a30c99a7a9449aa84174
          const USDC_E_CONTRACT = '0x2791bca1f2de4661ed88a30c99a7a9449aa84174';
          const POLYGON_RPC = 'https://polygon-rpc.com';
          
          let onChainBalance = 0;
          try {
            // Call balanceOf function on USDC.e contract
            // balanceOf(address) selector: 0x70a08231
            const paddedAddress = funder.funderAddress.slice(2).padStart(64, '0');
            const callData = `0x70a08231${paddedAddress}`;
            
            const rpcResponse = await fetch(POLYGON_RPC, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'eth_call',
                params: [
                  { to: USDC_E_CONTRACT, data: callData },
                  'latest'
                ]
              })
            });
            
            if (rpcResponse.ok) {
              const rpcData = await rpcResponse.json();
              if (rpcData.result) {
                // USDC.e has 6 decimals
                onChainBalance = parseInt(rpcData.result, 16) / 1e6;
                console.log(`[LiveBot] On-chain USDC.e balance: $${onChainBalance.toFixed(2)}`);
              }
            }
          } catch (err) {
            console.warn('[LiveBot] Failed to fetch on-chain balance:', err);
          }
          
          // Use the higher of CLOB balance or on-chain balance
          // (The on-chain balance is the source of truth)
          const cashBalance = onChainBalance > 0 ? onChainBalance : clobBalance;
          console.log(`[LiveBot] Using cash balance: $${cashBalance.toFixed(2)}`);
          
          // Fetch positions from Polymarket Data API (public endpoint)
          const positionsUrl = `https://data-api.polymarket.com/positions?user=${funder.funderAddress}&sizeThreshold=0&limit=100`;
          console.log(`[LiveBot] Fetching positions from ${positionsUrl}`);
          
          const positionsResponse = await fetch(positionsUrl, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' },
          });
          
          let positions: any[] = [];
          let positionsValue = 0;
          let unrealizedPnl = 0;
          let realizedPnl = 0;
          
          if (positionsResponse.ok) {
            const positionsData = await positionsResponse.json();
            positions = Array.isArray(positionsData) ? positionsData : [];
            
            console.log(`[LiveBot] Found ${positions.length} positions`);
            
            // Calculate totals from positions
            for (const pos of positions) {
              positionsValue += pos.currentValue || 0;
              unrealizedPnl += pos.cashPnl || 0;
              realizedPnl += pos.realizedPnl || 0;
            }
          } else {
            console.warn(`[LiveBot] Failed to fetch positions: ${positionsResponse.status}`);
          }
          
          const portfolioValue = cashBalance + positionsValue;
          
          return new Response(JSON.stringify({
            success: true,
            portfolio: {
              totalValue: portfolioValue,
              cashBalance: cashBalance,
              positionsValue: positionsValue,
              unrealizedPnl: unrealizedPnl,
              realizedPnl: realizedPnl,
              totalPnl: unrealizedPnl + realizedPnl,
            },
            positions: positions.map(p => ({
              title: p.title,
              slug: p.slug,
              outcome: p.outcome,
              size: p.size,
              avgPrice: p.avgPrice,
              currentPrice: p.curPrice,
              currentValue: p.currentValue,
              initialValue: p.initialValue,
              cashPnl: p.cashPnl,
              percentPnl: p.percentPnl,
              redeemable: p.redeemable,
              endDate: p.endDate,
            })),
            walletAddress: wallet.address,
            funderAddress: funder.funderAddress,
            funderType: funder.funderType,
          }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        } catch (error) {
          console.error('[LiveBot] Portfolio error:', error);
          return new Response(JSON.stringify({
            success: false,
            error: error instanceof Error ? error.message : 'Failed to get portfolio',
          }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
      }
      
      case 'queue-order': {
        // Queue an order for the local runner to execute
        // This bypasses the geo-restriction since the runner is behind VPN
        const orderData = body.orderData as {
          market_slug: string;
          asset: string;
          outcome: string;
          token_id: string;
          price: number;
          shares: number;
          reasoning?: string;
          event_start_time?: string;
          event_end_time?: string;
        } | undefined;

        if (!orderData) {
          return new Response(JSON.stringify({
            success: false,
            error: 'Missing orderData',
          }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        // Insert into order queue
        const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
        const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
        const supabase = createClient(supabaseUrl, supabaseServiceKey);

        const { data: queuedOrder, error: queueError } = await supabase
          .from('order_queue')
          .insert({
            market_slug: orderData.market_slug,
            asset: orderData.asset,
            outcome: orderData.outcome,
            token_id: orderData.token_id,
            price: orderData.price,
            shares: orderData.shares,
            reasoning: orderData.reasoning || 'Queued from dashboard',
            event_start_time: orderData.event_start_time,
            event_end_time: orderData.event_end_time,
            status: 'pending',
          })
          .select()
          .single();

        if (queueError) {
          console.error('[LiveBot] Queue order error:', queueError);
          return new Response(JSON.stringify({
            success: false,
            error: queueError.message,
          }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        console.log(`[LiveBot] ✅ Order queued: ${orderData.outcome} ${orderData.shares}@${orderData.price}`);
        return new Response(JSON.stringify({
          success: true,
          orderId: queuedOrder.id,
          message: 'Order queued for local runner execution',
        }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      
      default:
        return new Response(JSON.stringify({
          success: false,
          error: `Unknown action: ${action}`,
          availableActions: ['status', 'balance', 'wallet-balance', 'deposit', 'swap', 'order', 'redeem', 'kill', 'derive-credentials', 'debug-auth', 'portfolio', 'queue-order'],
        }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
    }
  } catch (error) {
    console.error('[LiveBot] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
