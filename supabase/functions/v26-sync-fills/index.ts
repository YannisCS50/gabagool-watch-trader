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

    console.log('[v26-sync-fills] Using fill_logs as source of truth for fill_matched_at');

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

    if (!trades || trades.length === 0) {
      return new Response(
        JSON.stringify({ success: true, synced: 0, failed: 0, total: 0, results: [] }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Get all order_ids to look up in fill_logs
    const orderIds = trades.map(t => t.order_id).filter(Boolean) as string[];
    const orderIdsDistinct = Array.from(new Set(orderIds));

    console.log(
      `[v26-sync-fills] Looking up fill_logs for ${orderIdsDistinct.length} distinct order_ids (sample): ${orderIdsDistinct
        .slice(0, 5)
        .join(', ')}`
    );

    // Fetch matching fill_logs entries
    const { data: fillLogs, error: fillError } = await supabase
      .from('fill_logs')
      .select('order_id, ts, iso, fill_qty, fill_price')
      .in('order_id', orderIdsDistinct);

    if (fillError) {
      console.error('[v26-sync-fills] Error fetching fill_logs:', fillError);
      return new Response(
        JSON.stringify({ error: fillError.message }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`[v26-sync-fills] Found ${fillLogs?.length || 0} matching fill_logs entries`);

    // Build a map of order_id -> fill info (aggregate if multiple fills per order)
    interface FillInfo {
      matchTimeMs: number;
      iso: string;
      totalShares: number;
    }
    const orderFillInfo = new Map<string, FillInfo>();

    for (const fl of fillLogs || []) {
      const orderId = fl.order_id?.toLowerCase();
      if (!orderId) continue;

      const ts = Number(fl.ts);
      const shares = Number(fl.fill_qty) || 0;
      const existing = orderFillInfo.get(orderId);

      if (!existing) {
        orderFillInfo.set(orderId, {
          matchTimeMs: ts,
          iso: fl.iso,
          totalShares: shares,
        });
      } else {
        // Use latest timestamp, aggregate shares
        if (ts > existing.matchTimeMs) {
          existing.matchTimeMs = ts;
          existing.iso = fl.iso;
        }
        existing.totalShares += shares;
      }
    }

    console.log(`[v26-sync-fills] Aggregated fill info for ${orderFillInfo.size} orders`);

    const missingTradesAll = trades.filter(t => {
      const id = (t.order_id || '').toLowerCase();
      return !id || !orderFillInfo.has(id);
    });

    if (missingTradesAll.length > 0) {
      const missingSample = missingTradesAll.slice(0, 10).map(t => ({
        id: t.id,
        order_id: t.order_id,
        status: t.status,
        filled_shares: t.filled_shares,
        fill_matched_at: t.fill_matched_at,
      }));
      console.log(
        `[v26-sync-fills] Missing fill_logs match for ${missingTradesAll.length} orders (sample up to 10):`,
        missingSample
      );
    }

    const results: Array<{ id: string; order_id: string; success: boolean; error?: string; fill_matched_at?: string }> = [];

    // Update v26_trades with fill info from fill_logs
    for (const trade of trades) {
      const orderId = trade.order_id?.toLowerCase();
      if (!orderId) {
        results.push({ id: trade.id, order_id: trade.order_id || '', success: false, error: 'No order_id' });
        continue;
      }

      const fillInfo = orderFillInfo.get(orderId);

      if (!fillInfo) {
        results.push({ id: trade.id, order_id: trade.order_id!, success: false, error: 'No fill_logs match' });
        continue;
      }

      // Convert timestamp (ms) to ISO string
      const fillMatchedAt = new Date(fillInfo.matchTimeMs).toISOString();

      const updateData: Record<string, any> = {
        fill_matched_at: fillMatchedAt,
        filled_shares: Math.round(fillInfo.totalShares),
        status: fillInfo.totalShares > 0 ? 'filled' : trade.status,
      };

      const { error: updateError } = await supabase
        .from('v26_trades')
        .update(updateData)
        .eq('id', trade.id);

      if (updateError) {
        console.error(`[v26-sync-fills] Update failed for ${trade.order_id}:`, updateError);
        results.push({ id: trade.id, order_id: trade.order_id!, success: false, error: updateError.message });
      } else {
        console.log(
          `[v26-sync-fills] Updated ${trade.order_id}: fill_matched_at=${fillMatchedAt} (src_ts=${fillInfo.matchTimeMs}, src_iso=${fillInfo.iso}), filled=${updateData.filled_shares}`
        );
        results.push({
          id: trade.id,
          order_id: trade.order_id!,
          success: true,
          fill_matched_at: fillMatchedAt,
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
        total: trades.length,
        diagnostics: {
          order_ids_distinct: orderIdsDistinct.length,
          fill_logs_rows: fillLogs?.length || 0,
          fill_logs_orders_aggregated: orderFillInfo.size,
          missing_fill_logs_matches: missingTradesAll.length,
        },
        results,
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
