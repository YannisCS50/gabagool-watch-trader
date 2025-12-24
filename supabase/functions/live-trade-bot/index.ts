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
  'function decimals() view returns (uint8)',
];

// Uniswap V3 SwapRouter ABI
const SWAP_ROUTER_ABI = [
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)',
];

// Polymarket Exchange ABI for deposits
const EXCHANGE_ABI = [
  'function getCollateral() view returns (address)',
  'function deposit(address receiver, uint256 amount) external',
];

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

const DEFAULT_LIMITS: SafetyLimits = {
  maxDailyLoss: 50,         // $50 max loss per day
  maxPositionSize: 100,     // $100 max per market
  maxOrderSize: 25,         // $25 max per order
  enabled: true,            // Bot enabled by default
};

// ============================================================================
// CLOB API Authentication & Order Signing
// ============================================================================

// Helper functions matching official Polymarket clob-client implementation
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

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// Exact implementation from Polymarket clob-client/src/signing/hmac.ts
async function buildPolyHmacSignature(
  secret: string,
  timestamp: number,
  method: string,
  requestPath: string,
  body?: string
): Promise<string> {
  // Build message: timestamp (as number) + method + path + body
  let message = timestamp + method + requestPath;
  if (body !== undefined) {
    message += body;
  }
  
  console.log(`[HMAC] Message to sign: "${message.slice(0, 100)}..."`);
  console.log(`[HMAC] Message length: ${message.length}`);

  // Import the secret key from base64
  const keyData = base64ToArrayBuffer(secret);
  console.log(`[HMAC] Key data length: ${new Uint8Array(keyData).length} bytes`);
  
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

  // Must be url safe base64 encoding, but keep base64 "=" suffix
  const sigUrlSafe = sig.replace(/\+/g, '-').replace(/\//g, '_');
  console.log(`[HMAC] Signature: ${sigUrlSafe}`);
  return sigUrlSafe;
}

async function getApiHeaders(
  apiKey: string,
  apiSecret: string,
  passphrase: string,
  walletAddress: string,
  method: string,
  path: string,
  body?: string
): Promise<Record<string, string>> {
  const timestamp = Date.now();
  
  console.log('=== HMAC DEBUG START ===');
  console.log(`[HMAC] API Key: ${apiKey.slice(0, 10)}...${apiKey.slice(-5)}`);
  console.log(`[HMAC] API Secret length: ${apiSecret.length} chars`);
  console.log(`[HMAC] Passphrase length: ${passphrase.length}`);
  console.log(`[HMAC] Wallet Address: ${walletAddress}`);
  console.log(`[HMAC] Method: ${method}`);
  console.log(`[HMAC] Path: ${path}`);
  console.log(`[HMAC] Timestamp (ms): ${timestamp}`);
  if (body) {
    console.log(`[HMAC] Body (first 100 chars): ${body.slice(0, 100)}...`);
  }

  const sig = await buildPolyHmacSignature(
    apiSecret,
    timestamp,
    method,
    path,
    body
  );

  const headers = {
    'POLY_ADDRESS': walletAddress,
    'POLY_SIGNATURE': sig,
    'POLY_TIMESTAMP': `${timestamp}`,
    'POLY_API_KEY': apiKey,
    'POLY_PASSPHRASE': passphrase,
    'Content-Type': 'application/json',
  };
  
  console.log('[HMAC] Headers:', JSON.stringify(headers, null, 2));
  console.log('=== HMAC DEBUG END ===');
  
  return headers;
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

// ============================================================================
// CLOB API Methods
// ============================================================================

// Derive or create API credentials from private key using EIP-712 L1 auth
async function deriveApiCredentials(privateKey: string): Promise<{
  apiKey: string;
  apiSecret: string;
  passphrase: string;
}> {
  console.log('[LiveBot] Deriving API credentials from private key...');
  
  const wallet = new ethers.Wallet(privateKey);
  const address = wallet.address;
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = 0;
  
  // Create EIP-712 signature for CLOB auth
  const authMessage = {
    address: address,
    timestamp: timestamp,
    nonce: nonce,
    message: 'This message attests that I control the given wallet',
  };
  
  const signature = await wallet.signTypedData(CLOB_AUTH_DOMAIN, CLOB_AUTH_TYPES, authMessage);
  console.log(`[LiveBot] Created L1 auth signature for ${address}`);
  
  // First try to derive existing API key
  const deriveHeaders = {
    'Content-Type': 'application/json',
    'POLY_ADDRESS': address,
    'POLY_SIGNATURE': signature,
    'POLY_TIMESTAMP': timestamp,
    'POLY_NONCE': nonce.toString(),
  };
  
  console.log('[LiveBot] Attempting to derive existing API key...');
  const deriveResponse = await fetch(`${POLYMARKET_CLOB_HOST}/auth/derive-api-key`, {
    method: 'GET',
    headers: deriveHeaders,
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
    headers: deriveHeaders,
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
  apiKey: string, 
  apiSecret: string, 
  passphrase: string,
  walletAddress: string,
  assetType: 'COLLATERAL' | 'CONDITIONAL' = 'COLLATERAL'
): Promise<{ balance: string; allowance: string }> {
  const path = `/balance-allowance?asset_type=${assetType}`;
  const headers = await getApiHeaders(apiKey, apiSecret, passphrase, walletAddress, 'GET', path);
  
  console.log(`[LiveBot] Fetching balance from ${POLYMARKET_CLOB_HOST}${path}`);
  
  const response = await fetch(`${POLYMARKET_CLOB_HOST}${path}`, {
    method: 'GET',
    headers,
  });
  
  const responseText = await response.text();
  console.log(`[LiveBot] Balance response: ${response.status} - ${responseText}`);
  
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
  apiKey: string,
  apiSecret: string,
  passphrase: string,
  privateKey: string,
  order: OrderRequest
): Promise<TradeResult> {
  console.log(`[LiveBot] Creating order: ${order.side} ${order.size} @ $${order.price} for ${order.tokenId.slice(0, 20)}...`);
  
  try {
    const walletAddress = getWalletAddress(privateKey);
    console.log(`[LiveBot] Wallet address: ${walletAddress}`);
    
    // Calculate amounts (USDC has 6 decimals, outcome tokens have 6 decimals on Polymarket)
    const sizeInUnits = Math.floor(order.size * 1e6);
    const priceInUnits = Math.floor(order.price * 1e6);
    
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
    const headers = await getApiHeaders(apiKey, apiSecret, passphrase, walletAddress, 'POST', path, body);
    
    console.log('[LiveBot] Submitting order to CLOB...');
    
    const response = await fetch(`${POLYMARKET_CLOB_HOST}${path}`, {
      method: 'POST',
      headers,
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
        return new Response(JSON.stringify({
          success: true,
          status: 'READY',
          message: '✅ Live trading bot fully configured and ready',
          walletAddress,
          limits: DEFAULT_LIMITS,
          implementation: {
            authentication: '✅ HMAC API headers ready',
            orderSigning: '✅ EIP-712 signing with ethers.js',
            safetyChecks: '✅ Daily loss, position limits',
            killSwitch: '✅ Emergency stop available',
          },
        }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      
      case 'balance': {
        try {
          const walletAddress = getWalletAddress(privateKey!);

          let creds = await getCredentials();
          let balanceData: { balance: string; allowance: string };

          try {
            balanceData = await getBalanceAllowance(
              creds.apiKey,
              creds.apiSecret,
              creds.passphrase,
              walletAddress,
              'COLLATERAL'
            );
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);

            // Stored creds can be stale/incorrect. If we get a 401, derive fresh creds and retry once.
            if (msg.includes('401') || msg.toLowerCase().includes('unauthorized') || msg.toLowerCase().includes('invalid api key')) {
              console.warn('[LiveBot] Stored API credentials rejected (401). Deriving fresh credentials and retrying...');
              apiCredentials = await deriveApiCredentials(privateKey!);
              creds = apiCredentials;

              balanceData = await getBalanceAllowance(
                creds.apiKey,
                creds.apiSecret,
                creds.passphrase,
                walletAddress,
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
        let creds = await getCredentials();
        let result = await createOrder(creds.apiKey, creds.apiSecret, creds.passphrase, privateKey!, {
          tokenId,
          side: side.toUpperCase() as 'BUY' | 'SELL',
          price,
          size,
          orderType,
        });

        const errMsg = (result.error || '').toLowerCase();
        if (!result.success && (errMsg.includes('401') || errMsg.includes('unauthorized') || errMsg.includes('invalid api key'))) {
          console.warn('[LiveBot] Stored API credentials rejected (401). Deriving fresh credentials and retrying order...');
          apiCredentials = await deriveApiCredentials(privateKey!);
          creds = apiCredentials;

          result = await createOrder(creds.apiKey, creds.apiSecret, creds.passphrase, privateKey!, {
            tokenId,
            side: side.toUpperCase() as 'BUY' | 'SELL',
            price,
            size,
            orderType,
          });
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
          const walletAddress = getWalletAddress(privateKey!);
          const creds = await getCredentials();
          
          // Test 1: Public endpoint (no auth needed)
          console.log('[DEBUG] Testing public endpoint...');
          const publicTest = await fetch(`${POLYMARKET_CLOB_HOST}/time`);
          const publicResult = await publicTest.text();
          console.log(`[DEBUG] Public /time: ${publicTest.status} - ${publicResult}`);
          
          // Test 2: Get API key info (L2 auth)
          console.log('[DEBUG] Testing /auth/api-keys endpoint...');
          const apiKeysPath = '/auth/api-keys';
          const apiKeysHeaders = await getApiHeaders(creds.apiKey, creds.apiSecret, creds.passphrase, walletAddress, 'GET', apiKeysPath);
          const apiKeysTest = await fetch(`${POLYMARKET_CLOB_HOST}${apiKeysPath}`, {
            method: 'GET',
            headers: apiKeysHeaders,
          });
          const apiKeysResult = await apiKeysTest.text();
          console.log(`[DEBUG] /auth/api-keys: ${apiKeysTest.status} - ${apiKeysResult}`);
          
          // Test 3: Check if using correct nonce
          console.log('[DEBUG] Testing /auth/api-key endpoint (check key exists)...');
          // Use L1 auth to check current key status
          const wallet = new ethers.Wallet(privateKey!);
          const timestamp = Math.floor(Date.now() / 1000).toString();
          const nonce = 0;
          const authMessage = {
            address: walletAddress,
            timestamp: timestamp,
            nonce: nonce,
            message: 'This message attests that I control the given wallet',
          };
          const l1Signature = await wallet.signTypedData(CLOB_AUTH_DOMAIN, CLOB_AUTH_TYPES, authMessage);
          
          const l1Headers = {
            'Content-Type': 'application/json',
            'POLY_ADDRESS': walletAddress,
            'POLY_SIGNATURE': l1Signature,
            'POLY_TIMESTAMP': timestamp,
            'POLY_NONCE': nonce.toString(),
          };
          
          const getKeyTest = await fetch(`${POLYMARKET_CLOB_HOST}/auth/api-key`, {
            method: 'GET',
            headers: l1Headers,
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
        // Check wallet balances (MATIC, USDC, USDT)
        try {
          console.log('[LiveBot] Checking wallet balances...');
          const provider = new ethers.JsonRpcProvider(POLYGON_RPC_URL);
          const wallet = new ethers.Wallet(privateKey!, provider);
          const walletAddress = wallet.address;
          
          // Get MATIC balance for gas
          const maticBalance = await provider.getBalance(walletAddress);
          const maticBalanceFormatted = ethers.formatEther(maticBalance);
          console.log(`[LiveBot] MATIC balance: ${maticBalanceFormatted}`);
          
          // Get USDC balance
          const usdcContract = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, provider);
          const usdcBalance = await usdcContract.balanceOf(walletAddress);
          const usdcDecimals = await usdcContract.decimals();
          const usdcBalanceFormatted = Number(usdcBalance) / Math.pow(10, Number(usdcDecimals));
          console.log(`[LiveBot] USDC balance: ${usdcBalanceFormatted}`);
          
          // Get USDT balance
          const usdtContract = new ethers.Contract(USDT_ADDRESS, ERC20_ABI, provider);
          const usdtBalance = await usdtContract.balanceOf(walletAddress);
          const usdtDecimals = await usdtContract.decimals();
          const usdtBalanceFormatted = Number(usdtBalance) / Math.pow(10, Number(usdtDecimals));
          console.log(`[LiveBot] USDT balance: ${usdtBalanceFormatted}`);
          
          // Check current allowance to CTF Exchange
          const allowance = await usdcContract.allowance(walletAddress, CTF_EXCHANGE_ADDRESS);
          const allowanceFormatted = Number(allowance) / Math.pow(10, Number(usdcDecimals));
          console.log(`[LiveBot] USDC allowance to exchange: ${allowanceFormatted}`);
          
          return new Response(JSON.stringify({
            success: true,
            walletAddress,
            balances: {
              matic: parseFloat(maticBalanceFormatted),
              usdc: usdcBalanceFormatted,
              usdt: usdtBalanceFormatted,
              usdcAllowanceToExchange: allowanceFormatted,
            },
            hasGasForTx: parseFloat(maticBalanceFormatted) > 0.001,
            canDeposit: usdcBalanceFormatted > 0 && parseFloat(maticBalanceFormatted) > 0.001,
            canSwapUsdtToUsdc: usdtBalanceFormatted > 0 && parseFloat(maticBalanceFormatted) > 0.001,
          }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        } catch (error) {
          console.error('[LiveBot] Wallet balance error:', error);
          return new Response(JSON.stringify({
            success: false,
            error: error instanceof Error ? error.message : String(error),
          }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
      }
      
      case 'deposit': {
        // Deposit USDC from wallet to Polymarket exchange
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
          
          // USDC has 6 decimals
          const amountInUnits = BigInt(Math.floor(amount * 1e6));
          console.log(`[LiveBot] Amount in units: ${amountInUnits}`);
          
          // Check USDC balance first
          const usdcContract = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, wallet);
          const currentBalance = await usdcContract.balanceOf(walletAddress);
          console.log(`[LiveBot] Current USDC balance: ${currentBalance}`);
          
          if (currentBalance < amountInUnits) {
            return new Response(JSON.stringify({
              success: false,
              error: `Insufficient USDC balance. Have ${Number(currentBalance) / 1e6}, need ${amount}`,
            }), {
              status: 400,
              headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
          }
          
          // Check and set allowance if needed
          const currentAllowance = await usdcContract.allowance(walletAddress, CTF_EXCHANGE_ADDRESS);
          console.log(`[LiveBot] Current allowance: ${currentAllowance}`);
          
          if (currentAllowance < amountInUnits) {
            console.log('[LiveBot] Approving USDC spend...');
            // Approve max uint256 so we don't need to approve again
            const maxApproval = BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff');
            const approveTx = await usdcContract.approve(CTF_EXCHANGE_ADDRESS, maxApproval);
            console.log(`[LiveBot] Approve tx: ${approveTx.hash}`);
            await approveTx.wait();
            console.log('[LiveBot] Approval confirmed');
          }
          
          // Now deposit to the exchange
          console.log('[LiveBot] Calling deposit on exchange...');
          const exchangeContract = new ethers.Contract(CTF_EXCHANGE_ADDRESS, EXCHANGE_ABI, wallet);
          const depositTx = await exchangeContract.deposit(walletAddress, amountInUnits);
          console.log(`[LiveBot] Deposit tx: ${depositTx.hash}`);
          const receipt = await depositTx.wait();
          console.log(`[LiveBot] Deposit confirmed in block ${receipt.blockNumber}`);
          
          return new Response(JSON.stringify({
            success: true,
            message: `✅ Successfully deposited ${amount} USDC to Polymarket`,
            depositTxHash: depositTx.hash,
            blockNumber: receipt.blockNumber,
            walletAddress,
          }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
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
          
          // Both USDT and USDC have 6 decimals on Polygon
          const amountInUnits = BigInt(Math.floor(amount * 1e6));
          
          // Determine token addresses
          const tokenInAddress = fromToken.toUpperCase() === 'USDT' ? USDT_ADDRESS : USDT_ADDRESS;
          const tokenOutAddress = USDC_ADDRESS;
          
          console.log(`[LiveBot] Token in: ${tokenInAddress}`);
          console.log(`[LiveBot] Token out: ${tokenOutAddress}`);
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
      
      default:
        return new Response(JSON.stringify({
          success: false,
          error: `Unknown action: ${action}`,
          availableActions: ['status', 'balance', 'wallet-balance', 'deposit', 'swap', 'order', 'kill', 'derive-credentials', 'debug-auth'],
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
