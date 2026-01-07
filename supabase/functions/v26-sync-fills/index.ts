import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { ethers } from "https://esm.sh/ethers@6.13.1";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const CLOB_BASE_URL = 'https://clob.polymarket.com';

// Onchain: resolve correct Polymarket "funder" address (Safe/Proxy) for L2 auth
const POLYGON_RPC_URL = 'https://polygon-rpc.com';
const CTF_EXCHANGE_ADDRESS = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';
const EXCHANGE_ABI = [
  'function getPolyProxyWalletAddress(address _addr) view returns (address)',
  'function getSafeAddress(address _addr) view returns (address)',
];

async function resolvePolymarketFunderAddress(eoaAddress: string): Promise<string> {
  const provider = new ethers.JsonRpcProvider(POLYGON_RPC_URL);
  const exchangeContract = new ethers.Contract(CTF_EXCHANGE_ADDRESS, EXCHANGE_ABI, provider);

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

  // Prefer deployed Safe, otherwise deployed Proxy. If neither deployed yet, use deterministic Safe.
  if (safeDeployed) return safeAddress;
  if (proxyDeployed) return proxyAddress;
  return safeAddress;
}

// Helper: replaceAll for URL-safe base64
function replaceAll(s: string, search: string, replace: string): string {
  return s.split(search).join(replace);
}

// Helper: base64 to ArrayBuffer
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

// Helper: ArrayBuffer to base64
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

  const keyData = base64ToArrayBuffer(secret);
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const messageBuffer = new TextEncoder().encode(message);
  const signatureBuffer = await crypto.subtle.sign('HMAC', cryptoKey, messageBuffer);
  const sig = arrayBufferToBase64(signatureBuffer);

  // URL-safe base64 encoding
  return replaceAll(replaceAll(sig, '+', '-'), '/', '_');
}

const POLYGON_CHAIN_ID = 137;

/**
 * Build EIP-712 signature for L1 authentication (derive-api-key)
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

  return await wallet.signTypedData(domain, types, value);
}

/**
 * Create L1 Headers for API key derivation
 */
async function createL1Headers(
  wallet: ethers.Wallet,
  chainId: number,
  nonce: number = 0
): Promise<Record<string, string>> {
  const ts = Math.floor(Date.now() / 1000);
  const sig = await buildClobEip712Signature(wallet, chainId, ts, nonce);

  return {
    'POLY_ADDRESS': wallet.address,
    'POLY_SIGNATURE': sig,
    'POLY_TIMESTAMP': `${ts}`,
    'POLY_NONCE': `${nonce}`,
  };
}

/**
 * Derive API credentials from private key using L1 auth
 */
async function deriveApiCredentials(privateKey: string): Promise<{
  apiKey: string;
  apiSecret: string;
  passphrase: string;
}> {
  console.log('[v26-sync-fills] Deriving API credentials from private key...');

  const wallet = new ethers.Wallet(privateKey);
  const l1Headers = await createL1Headers(wallet, POLYGON_CHAIN_ID, 0);
  const headers = { ...l1Headers, 'Content-Type': 'application/json' };

  console.log(`[v26-sync-fills] Created L1 auth headers for ${wallet.address}`);

  // First try to derive existing API key
  const deriveResponse = await fetch(`${CLOB_BASE_URL}/auth/derive-api-key`, {
    method: 'GET',
    headers,
  });

  const deriveText = await deriveResponse.text();
  console.log(`[v26-sync-fills] Derive response: ${deriveResponse.status} - ${deriveText.slice(0, 200)}`);

  if (deriveResponse.ok) {
    const credentials = JSON.parse(deriveText);
    console.log('[v26-sync-fills] ✅ Successfully derived existing API credentials');
    return {
      apiKey: credentials.apiKey,
      apiSecret: credentials.secret,
      passphrase: credentials.passphrase,
    };
  }

  // If no existing key, create new one
  console.log('[v26-sync-fills] No existing credentials, creating new API key...');
  const createResponse = await fetch(`${CLOB_BASE_URL}/auth/api-key`, {
    method: 'POST',
    headers,
  });

  const createText = await createResponse.text();
  console.log(`[v26-sync-fills] Create response: ${createResponse.status} - ${createText.slice(0, 200)}`);

  if (!createResponse.ok) {
    throw new Error(`Failed to create API key: ${createResponse.status} - ${createText}`);
  }

  const newCredentials = JSON.parse(createText);
  console.log('[v26-sync-fills] ✅ Successfully created new API credentials');

  return {
    apiKey: newCredentials.apiKey,
    apiSecret: newCredentials.secret,
    passphrase: newCredentials.passphrase,
  };
}

/**
 * Create L2 Headers for authenticated API requests
 */
async function createL2Headers(
  address: string,
  creds: { key: string; secret: string; passphrase: string },
  method: string,
  requestPath: string,
  body?: string
): Promise<Record<string, string>> {
  const ts = Math.floor(Date.now() / 1000);

  const sig = await buildPolyHmacSignature(
    creds.secret,
    ts,
    method,
    requestPath,
    body
  );

  return {
    'POLY_ADDRESS': address,
    'POLY_SIGNATURE': sig,
    'POLY_TIMESTAMP': `${ts}`,
    'POLY_API_KEY': creds.key,
    'POLY_PASSPHRASE': creds.passphrase,
  };
}

interface OpenOrder {
  id: string;
  status: string;
  original_size: string;
  size_matched: string;
  associate_trades?: string[];
}

type GetOrderResponse = {
  order?: OpenOrder;
} | OpenOrder;

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // We need the private key to derive fresh API credentials
    const privateKey = Deno.env.get('POLYMARKET_PRIVATE_KEY');

    if (!privateKey) {
      console.error('[v26-sync-fills] Missing POLYMARKET_PRIVATE_KEY');
      return new Response(
        JSON.stringify({ error: 'Missing POLYMARKET_PRIVATE_KEY' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Derive fresh API credentials using L1 auth
    let creds: { key: string; secret: string; passphrase: string };
    try {
      const derived = await deriveApiCredentials(privateKey);
      creds = { key: derived.apiKey, secret: derived.apiSecret, passphrase: derived.passphrase };
    } catch (err) {
      console.error('[v26-sync-fills] Failed to derive API credentials:', err);
      return new Response(
        JSON.stringify({ error: `Failed to derive API credentials: ${err}` }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // L2 auth is tied to the EOA. But trades are placed via Safe/Proxy address.
    const wallet = new ethers.Wallet(privateKey);
    const eoaAddress = wallet.address;

    // Get the funder address (Safe/Proxy) from bot_config
    const configRes = await supabase.from('bot_config').select('polymarket_address').limit(1).single();
    const funderAddress = configRes.data?.polymarket_address || eoaAddress;

    console.log(`[v26-sync-fills] EOA: ${eoaAddress}, Funder (trades lookup): ${funderAddress}`);

    // Fetch trades that need syncing
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    
    const { data: trades, error: fetchError } = await supabase
      .from('v26_trades')
      .select('id, order_id, event_start_time, event_end_time, status, filled_shares, fill_matched_at')
      .not('order_id', 'is', null)
      .gte('event_start_time', sevenDaysAgo)
      .or('fill_matched_at.is.null,status.in.(placed,open,partial),filled_shares.eq.0')
      .limit(100);

    if (fetchError) {
      console.error('[v26-sync-fills] Error fetching trades:', fetchError);
      return new Response(
        JSON.stringify({ error: fetchError.message }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`[v26-sync-fills] Found ${trades?.length || 0} trades to sync`);

    // Build a map of order_id -> v26_trade for quick lookup
    const orderIdToTrade = new Map<string, typeof trades[0]>();
    for (const t of trades || []) {
      if (t.order_id) {
        orderIdToTrade.set(t.order_id.toLowerCase(), t);
      }
    }

    // Fetch all trades for this wallet from CLOB (last 7 days)
    // Use maker param since our orders are maker orders
    const sevenDaysAgoUnix = Math.floor((Date.now() - 7 * 24 * 60 * 60 * 1000) / 1000);
    const tradesPath = `/data/trades`;

    // Fetch trades where we are the taker (market orders) - this is how v26 places orders
    // Use funderAddress (Safe/Proxy) for trade lookup, EOA for L2 auth
    const tradesUrl = `${CLOB_BASE_URL}${tradesPath}?taker=${encodeURIComponent(funderAddress)}&after=${sevenDaysAgoUnix}`;
    console.log(`[v26-sync-fills] Fetching CLOB trades (taker) from: ${tradesUrl}`);

    const tradesHeaders = await createL2Headers(eoaAddress, creds, 'GET', tradesPath);
    const tradesRes = await fetch(tradesUrl, {
      method: 'GET',
      headers: {
        ...tradesHeaders,
        'Content-Type': 'application/json',
      },
    });

    if (!tradesRes.ok) {
      const errText = await tradesRes.text();
      console.error(`[v26-sync-fills] Failed to fetch CLOB trades:`, tradesRes.status, errText);
      return new Response(
        JSON.stringify({ error: `Failed to fetch CLOB trades: ${tradesRes.status}` }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const clobTradesRaw = await tradesRes.json();
    // Ensure it's an array
    const clobTrades: any[] = Array.isArray(clobTradesRaw) ? clobTradesRaw : [];
    console.log(`[v26-sync-fills] Got ${clobTrades.length} CLOB trades (taker)`);

    // Build a map of order_id -> { match_time, size } from CLOB trades
    // CLOB trades have: maker_orders[].order_id (for maker fills)
    // and taker_order_id (for taker fills)
    interface MatchInfo {
      matchTimeMs: number;
      sizeMatched: number;
    }
    const orderMatchInfo = new Map<string, MatchInfo>();

    for (const ct of clobTrades || []) {
      const matchTimeRaw = ct?.match_time;
      let matchTimeMs: number | null = null;

      if (matchTimeRaw != null) {
        const n = Number(matchTimeRaw);
        if (Number.isFinite(n)) {
          matchTimeMs = n < 1e12 ? n * 1000 : n;
        } else {
          const parsed = Date.parse(String(matchTimeRaw));
          if (Number.isFinite(parsed)) matchTimeMs = parsed;
        }
      }

      if (matchTimeMs === null) continue;

      // Check taker_order_id
      const takerOrderId = ct?.taker_order_id?.toLowerCase();
      if (takerOrderId && orderIdToTrade.has(takerOrderId)) {
        const existing = orderMatchInfo.get(takerOrderId);
        const size = parseFloat(ct?.size || '0');
        if (!existing || matchTimeMs > existing.matchTimeMs) {
          orderMatchInfo.set(takerOrderId, {
            matchTimeMs,
            sizeMatched: (existing?.sizeMatched || 0) + size,
          });
        } else {
          existing.sizeMatched += size;
        }
      }

      // Check maker_orders
      const makerOrders = ct?.maker_orders;
      if (Array.isArray(makerOrders)) {
        for (const mo of makerOrders) {
          const moOrderId = mo?.order_id?.toLowerCase();
          if (moOrderId && orderIdToTrade.has(moOrderId)) {
            const existing = orderMatchInfo.get(moOrderId);
            const size = parseFloat(mo?.matched_amount || '0');
            if (!existing || matchTimeMs > existing.matchTimeMs) {
              orderMatchInfo.set(moOrderId, {
                matchTimeMs,
                sizeMatched: (existing?.sizeMatched || 0) + size,
              });
            } else {
              existing.sizeMatched += size;
            }
          }
        }
      }
    }

    console.log(`[v26-sync-fills] Found match info for ${orderMatchInfo.size} orders`);

    const results: Array<{ id: string; order_id: string; success: boolean; error?: string; fill_matched_at?: string }> = [];

    // Update v26_trades with match info
    for (const trade of trades || []) {
      const orderId = trade.order_id?.toLowerCase();
      if (!orderId) continue;

      const matchInfo = orderMatchInfo.get(orderId);

      if (!matchInfo) {
        // No CLOB trade found for this order - could be unfilled or from different API key
        results.push({ id: trade.id, order_id: trade.order_id, success: false, error: 'No CLOB match found' });
        continue;
      }

      const updateData: Record<string, any> = {
        fill_matched_at: new Date(matchInfo.matchTimeMs).toISOString(),
        filled_shares: Math.round(matchInfo.sizeMatched),
        status: matchInfo.sizeMatched > 0 ? 'filled' : trade.status,
      };

      const { error: updateError } = await supabase
        .from('v26_trades')
        .update(updateData)
        .eq('id', trade.id);

      if (updateError) {
        console.error(`[v26-sync-fills] Update failed for ${trade.order_id}:`, updateError);
        results.push({ id: trade.id, order_id: trade.order_id, success: false, error: updateError.message });
      } else {
        console.log(`[v26-sync-fills] Updated ${trade.order_id}: match_at=${updateData.fill_matched_at}, filled=${updateData.filled_shares}`);
        results.push({
          id: trade.id,
          order_id: trade.order_id,
          success: true,
          fill_matched_at: updateData.fill_matched_at,
        });
      }
    }

    const successCount = results.filter(r => r.success).length;
    const failCount = results.filter(r => !r.success).length;

    return new Response(
      JSON.stringify({ 
        success: true, 
        synced: successCount, 
        failed: failCount,
        total: trades?.length || 0,
        results 
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('[v26-sync-fills] Unexpected error:', error);
    return new Response(
      JSON.stringify({ error: String(error) }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
