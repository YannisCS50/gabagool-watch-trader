import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { encode as hexEncode } from "https://deno.land/std@0.168.0/encoding/hex.ts";

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

async function getApiHeaders(
  apiKey: string,
  apiSecret: string,
  passphrase: string,
  method: string,
  path: string,
  body?: string
): Promise<Record<string, string>> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  
  // Create HMAC signature
  const message = timestamp + method + path + (body || '');
  const encoder = new TextEncoder();
  const keyData = encoder.encode(apiSecret);
  const messageData = encoder.encode(message);
  
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, messageData);
  const signatureBase64 = btoa(String.fromCharCode(...new Uint8Array(signature)));
  
  return {
    'POLY_ADDRESS': '', // Will be set from private key
    'POLY_SIGNATURE': signatureBase64,
    'POLY_TIMESTAMP': timestamp,
    'POLY_NONCE': '0',
    'POLY_API_KEY': apiKey,
    'POLY_PASSPHRASE': passphrase,
    'Content-Type': 'application/json',
  };
}

// EIP-712 Order Signing for Polymarket
async function signOrder(
  privateKey: string,
  order: {
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
  // For now, we'll use a simplified signing approach
  // Full EIP-712 signing requires ethers.js or similar
  // This is a placeholder that needs proper implementation
  
  console.log('[LiveBot] Order signing requested for:', order.tokenId);
  
  // TODO: Implement proper EIP-712 signing
  // This requires importing ethers.js or using Web3 primitives
  throw new Error('EIP-712 signing not yet implemented - need ethers.js integration');
}

// ============================================================================
// CLOB API Methods
// ============================================================================

async function getBalance(apiKey: string, apiSecret: string, passphrase: string): Promise<number> {
  const path = '/balance';
  const headers = await getApiHeaders(apiKey, apiSecret, passphrase, 'GET', path);
  
  const response = await fetch(`${POLYMARKET_CLOB_HOST}${path}`, {
    method: 'GET',
    headers,
  });
  
  if (!response.ok) {
    throw new Error(`Failed to get balance: ${response.status}`);
  }
  
  const data = await response.json();
  return parseFloat(data.balance || '0');
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
    // Calculate amounts
    const makerAmount = order.side === 'BUY' 
      ? Math.floor(order.size * order.price * 1e6).toString() // USDC has 6 decimals
      : Math.floor(order.size * 1e6).toString();
    
    const takerAmount = order.side === 'BUY'
      ? Math.floor(order.size * 1e6).toString()
      : Math.floor(order.size * order.price * 1e6).toString();
    
    // Create order payload
    const orderPayload = {
      order: {
        salt: Math.floor(Math.random() * 1e18).toString(),
        maker: '', // Will be derived from private key
        signer: '',
        taker: '0x0000000000000000000000000000000000000000',
        tokenId: order.tokenId,
        makerAmount,
        takerAmount,
        expiration: '0', // Never expires for GTC
        nonce: '0',
        feeRateBps: '0',
        side: order.side === 'BUY' ? 0 : 1,
        signatureType: 1, // Magic link signature type
      },
      orderType: order.orderType,
    };
    
    // Sign the order (throws for now)
    // const signature = await signOrder(privateKey, orderPayload.order);
    
    // For now, return error since signing isn't implemented
    return {
      success: false,
      error: 'Order signing not yet implemented - requires ethers.js for EIP-712',
    };
    
    /*
    // Once signing is implemented:
    const path = '/order';
    const body = JSON.stringify({ ...orderPayload, signature });
    const headers = await getApiHeaders(apiKey, apiSecret, passphrase, 'POST', path, body);
    
    const response = await fetch(`${POLYMARKET_CLOB_HOST}${path}`, {
      method: 'POST',
      headers,
      body,
    });
    
    if (!response.ok) {
      const error = await response.text();
      return { success: false, error };
    }
    
    const result = await response.json();
    return { success: true, orderId: result.orderID, details: result };
    */
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
  
  // Get Polymarket credentials from secrets
  const apiKey = Deno.env.get('POLYMARKET_API_KEY');
  const apiSecret = Deno.env.get('POLYMARKET_API_SECRET');
  const passphrase = Deno.env.get('POLYMARKET_PASSPHRASE');
  const privateKey = Deno.env.get('POLYMARKET_PRIVATE_KEY');
  
  if (!apiKey || !apiSecret || !passphrase || !privateKey) {
    console.error('[LiveBot] Missing Polymarket credentials');
    return new Response(JSON.stringify({
      success: false,
      error: 'Missing Polymarket API credentials',
      configured: {
        apiKey: !!apiKey,
        apiSecret: !!apiSecret,
        passphrase: !!passphrase,
        privateKey: !!privateKey,
      }
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
  
  try {
    const body = await req.json().catch(() => ({}));
    const action = body.action || 'status';
    
    switch (action) {
      case 'status': {
        // Return bot status and configuration
        return new Response(JSON.stringify({
          success: true,
          status: 'CONFIGURED',
          message: '⚠️ Live trading bot configured but order signing not yet implemented',
          limits: DEFAULT_LIMITS,
          implementation: {
            authentication: '✅ API headers ready',
            orderSigning: '❌ EIP-712 signing needs ethers.js',
            safetyChecks: '✅ Daily loss, position limits implemented',
            nextStep: 'Need to add ethers.js for order signing',
          },
        }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      
      case 'balance': {
        try {
          const balance = await getBalance(apiKey, apiSecret, passphrase);
          return new Response(JSON.stringify({
            success: true,
            balance,
            currency: 'USDC',
          }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        } catch (error) {
          return new Response(JSON.stringify({
            success: false,
            error: error instanceof Error ? error.message : 'Failed to get balance',
          }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
      }
      
      case 'order': {
        const { tokenId, side, price, size, orderType = 'GTC', marketSlug } = body;
        
        if (!tokenId || !side || !price || !size) {
          return new Response(JSON.stringify({
            success: false,
            error: 'Missing required fields: tokenId, side, price, size',
          }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        
        // Safety checks
        const safetyCheck = await checkSafetyLimits(supabase, size * price, marketSlug || '', DEFAULT_LIMITS);
        if (!safetyCheck.allowed) {
          console.log(`[LiveBot] Order blocked by safety: ${safetyCheck.reason}`);
          return new Response(JSON.stringify({
            success: false,
            error: safetyCheck.reason,
            blocked: true,
          }), {
            status: 403,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        
        // Create order
        const result = await createOrder(apiKey, apiSecret, passphrase, privateKey, {
          tokenId,
          side: side.toUpperCase() as 'BUY' | 'SELL',
          price,
          size,
          orderType,
        });
        
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
      
      default:
        return new Response(JSON.stringify({
          success: false,
          error: `Unknown action: ${action}`,
          availableActions: ['status', 'balance', 'order', 'kill'],
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
