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

    // Get API credentials
    const apiKey = Deno.env.get('POLYMARKET_API_KEY');
    const apiSecret = Deno.env.get('POLYMARKET_API_SECRET');
    const passphrase = Deno.env.get('POLYMARKET_PASSPHRASE');
    const privateKey = Deno.env.get('POLYMARKET_PRIVATE_KEY');

    if (!apiKey || !apiSecret || !passphrase || !privateKey) {
      console.error('[v26-sync-fills] Missing Polymarket credentials');
      return new Response(
        JSON.stringify({ error: 'Missing Polymarket credentials' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // L2 auth is tied to the address the API key was derived for.
    // In our setup that's the EOA from POLYMARKET_PRIVATE_KEY.
    const eoaAddress = new ethers.Wallet(privateKey).address;

    const configRes = await supabase.from('bot_config').select('polymarket_address').limit(1).single();
    const configuredAddress = !configRes.error ? (configRes.data?.polymarket_address ?? null) : null;
    if (configRes.error) {
      console.warn('[v26-sync-fills] Could not read bot_config.polymarket_address:', configRes.error);
    }

    const walletAddress = eoaAddress;

    console.log(`[v26-sync-fills] EOA address: ${eoaAddress}`);
    if (configuredAddress) {
      console.log(`[v26-sync-fills] bot_config.polymarket_address: ${configuredAddress}`);
    }
    console.log(`[v26-sync-fills] Using POLY_ADDRESS (EOA): ${walletAddress}`);

    const creds = { key: apiKey, secret: apiSecret, passphrase };

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

    const results: Array<{ id: string; order_id: string; success: boolean; error?: string; fill_matched_at?: string }> = [];

    for (const trade of trades || []) {
      const orderId = trade.order_id;
      const requestPath = `/data/order/${orderId}`;

      try {
        const headers = await createL2Headers(walletAddress, creds, 'GET', requestPath);
        
        const response = await fetch(`${CLOB_BASE_URL}${requestPath}`, {
          method: 'GET',
          headers: {
            ...headers,
            'Content-Type': 'application/json',
          },
        });

        if (!response.ok) {
          const errorText = await response.text();
          console.error(`[v26-sync-fills] Order ${orderId} fetch failed:`, response.status, errorText);
          results.push({ id: trade.id, order_id: orderId, success: false, error: `HTTP ${response.status}` });
          continue;
        }

        const orderRes: GetOrderResponse = await response.json();
        const order: OpenOrder | null = (orderRes as any)?.order ?? (orderRes as any);

        if (!order?.id) {
          console.error(`[v26-sync-fills] Unexpected get-order response for ${orderId}:`, JSON.stringify(orderRes).slice(0, 300));
          results.push({ id: trade.id, order_id: orderId, success: false, error: 'Bad get-order response' });
          continue;
        }

        console.log(`[v26-sync-fills] Order ${orderId}:`, JSON.stringify(order).slice(0, 200));

        // Parse size_matched
        const sizeMatched = parseFloat(order.size_matched || '0');
        const originalSize = parseFloat(order.original_size || '0');

        // Find the last match time by looking up each associated trade's match_time
        let lastMatchTimeMs: number | null = null;
        const associatedTradeIds = Array.isArray(order.associate_trades) ? order.associate_trades : [];

        for (const tradeId of associatedTradeIds) {
          const tradePath = `/data/trades?id=${encodeURIComponent(tradeId)}`;
          const tradeHeaders = await createL2Headers(walletAddress, creds, 'GET', tradePath);

          const tRes = await fetch(`${CLOB_BASE_URL}${tradePath}`, {
            method: 'GET',
            headers: {
              ...tradeHeaders,
              'Content-Type': 'application/json',
            },
          });

          if (!tRes.ok) {
            const tErr = await tRes.text();
            console.warn(`[v26-sync-fills] Trade ${tradeId} fetch failed:`, tRes.status, tErr);
            continue;
          }

          const tradesPayload: any = await tRes.json();
          const tradeArr: any[] = Array.isArray(tradesPayload) ? tradesPayload : [];

          for (const t of tradeArr) {
            const raw = t?.match_time;
            if (raw == null) continue;

            let ms: number | null = null;
            const n = Number(raw);
            if (Number.isFinite(n)) {
              ms = n < 1e12 ? n * 1000 : n;
            } else {
              const parsed = Date.parse(String(raw));
              if (Number.isFinite(parsed)) ms = parsed;
            }

            if (ms !== null && (lastMatchTimeMs === null || ms > lastMatchTimeMs)) {
              lastMatchTimeMs = ms;
            }
          }

          // small delay to be gentle with rate limiting
          await new Promise((resolve) => setTimeout(resolve, 50));
        }

        // Determine new status
        let newStatus = trade.status;
        if (sizeMatched >= originalSize && originalSize > 0) {
          newStatus = 'filled';
        } else if (sizeMatched > 0) {
          newStatus = 'partial';
        } else if (String(order.status).toUpperCase() === 'CANCELLED') {
          newStatus = 'cancelled';
        } else if (String(order.status).toUpperCase() === 'EXPIRED') {
          newStatus = 'expired';
        }

        // Build update object
        const updateData: Record<string, any> = {
          filled_shares: Math.round(sizeMatched),
          status: newStatus,
        };

        if (lastMatchTimeMs !== null) {
          updateData.fill_matched_at = new Date(lastMatchTimeMs).toISOString();
        }

        // Update the trade
        const { error: updateError } = await supabase
          .from('v26_trades')
          .update(updateData)
          .eq('id', trade.id);

        if (updateError) {
          console.error(`[v26-sync-fills] Update failed for ${orderId}:`, updateError);
          results.push({ id: trade.id, order_id: orderId, success: false, error: updateError.message });
        } else {
          console.log(`[v26-sync-fills] Updated ${orderId}: status=${newStatus}, filled=${Math.round(sizeMatched)}, match_at=${updateData.fill_matched_at || 'null'}`);
          results.push({ 
            id: trade.id, 
            order_id: orderId, 
            success: true, 
            fill_matched_at: updateData.fill_matched_at 
          });
        }

        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 100));

      } catch (err) {
        console.error(`[v26-sync-fills] Error processing ${orderId}:`, err);
        results.push({ id: trade.id, order_id: orderId, success: false, error: String(err) });
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
