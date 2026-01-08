import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { ethers } from "https://esm.sh/ethers@6.13.1";

/**
 * v26-sync-fills: Robust fill synchronization
 * 
 * This function syncs trade data by:
 * 1. Querying Polymarket CLOB API directly for order status
 * 2. Updating v26_trades with correct fill data (matched_at, filled_shares, avg_price)
 * 3. Falling back to fill_logs if CLOB API fails
 * 
 * Run periodically (every 5-15 min) to catch any missed fills.
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const CLOB_BASE_URL = 'https://clob.polymarket.com';
const POLYGON_CHAIN_ID = 137;

// Resolve Polymarket funder address
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
  if (safeCode !== '0x') return safeAddress;
  if (proxyCode !== '0x') return proxyAddress;
  return safeAddress;
}

// Base64 helpers
function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const sanitizedBase64 = base64.replace(/-/g, '+').replace(/_/g, '/').replace(/[^A-Za-z0-9+/=]/g, '');
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

// HMAC signature for L2 auth
async function buildPolyHmacSignature(
  secret: string,
  timestamp: number,
  method: string,
  requestPath: string,
  body?: string
): Promise<string> {
  let message = timestamp + method + requestPath;
  if (body !== undefined) message += body;
  const keyData = base64ToArrayBuffer(secret);
  const cryptoKey = await crypto.subtle.importKey('raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const messageBuffer = new TextEncoder().encode(message);
  const signatureBuffer = await crypto.subtle.sign('HMAC', cryptoKey, messageBuffer);
  const sig = arrayBufferToBase64(signatureBuffer);
  return sig.split('+').join('-').split('/').join('_');
}

// EIP-712 signature for L1 auth
async function buildClobEip712Signature(
  wallet: ethers.Wallet,
  chainId: number,
  timestamp: number,
  nonce: number
): Promise<string> {
  const domain = { name: 'ClobAuthDomain', version: '1', chainId };
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
    nonce,
    message: 'This message attests that I control the given wallet',
  };
  return await wallet.signTypedData(domain, types, value);
}

// L1 Headers for API key derivation
async function createL1Headers(wallet: ethers.Wallet, chainId: number, nonce = 0): Promise<Record<string, string>> {
  const ts = Math.floor(Date.now() / 1000);
  const sig = await buildClobEip712Signature(wallet, chainId, ts, nonce);
  return {
    'POLY_ADDRESS': wallet.address,
    'POLY_SIGNATURE': sig,
    'POLY_TIMESTAMP': `${ts}`,
    'POLY_NONCE': `${nonce}`,
  };
}

// Derive API credentials from private key
async function deriveApiCredentials(privateKey: string): Promise<{ apiKey: string; apiSecret: string; passphrase: string }> {
  const wallet = new ethers.Wallet(privateKey);
  const l1Headers = await createL1Headers(wallet, POLYGON_CHAIN_ID, 0);
  const headers = { ...l1Headers, 'Content-Type': 'application/json' };

  const deriveResponse = await fetch(`${CLOB_BASE_URL}/auth/derive-api-key`, { method: 'GET', headers });
  const deriveText = await deriveResponse.text();

  if (deriveResponse.ok) {
    const credentials = JSON.parse(deriveText);
    return { apiKey: credentials.apiKey, apiSecret: credentials.secret, passphrase: credentials.passphrase };
  }

  // Create new key if none exists
  const createResponse = await fetch(`${CLOB_BASE_URL}/auth/api-key`, { method: 'POST', headers });
  const createText = await createResponse.text();
  if (!createResponse.ok) throw new Error(`Failed to create API key: ${createResponse.status} - ${createText}`);
  const newCredentials = JSON.parse(createText);
  return { apiKey: newCredentials.apiKey, apiSecret: newCredentials.secret, passphrase: newCredentials.passphrase };
}

// L2 Headers for authenticated requests
async function createL2Headers(
  address: string,
  creds: { key: string; secret: string; passphrase: string },
  method: string,
  requestPath: string,
  body?: string
): Promise<Record<string, string>> {
  const ts = Math.floor(Date.now() / 1000);
  const sig = await buildPolyHmacSignature(creds.secret, ts, method, requestPath, body);
  return {
    'POLY_ADDRESS': address,
    'POLY_SIGNATURE': sig,
    'POLY_TIMESTAMP': `${ts}`,
    'POLY_API_KEY': creds.key,
    'POLY_PASSPHRASE': creds.passphrase,
  };
}

// CLOB order response types
interface ClobOrder {
  id: string;
  status: 'OPEN' | 'MATCHED' | 'CANCELLED' | 'EXPIRED' | 'LIVE';
  original_size: string;
  size_matched: string;
  price: string;
  associate_trades?: Array<{
    id: string;
    price: string;
    size: string;
    match_time: string; // ISO timestamp
  }>;
  created_at?: string;
}

// Fetch single order from CLOB API
async function fetchOrderFromClob(
  orderId: string,
  funderAddress: string,
  creds: { key: string; secret: string; passphrase: string }
): Promise<ClobOrder | null> {
  try {
    // Correct endpoint per docs: GET /data/order/{order_hash}
    const requestPath = `/data/order/${orderId}`;

    // 1) Try without auth headers first (public endpoints often work; avoids "bad key" breaking reads)
    {
      const response = await fetch(`${CLOB_BASE_URL}${requestPath}`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      });

      if (response.ok) {
        const data = await response.json();
        return (data?.order || data) as ClobOrder;
      }

      // If not authorized, fall through to authenticated call
      if (response.status !== 401 && response.status !== 403) {
        const text = await response.text();
        console.log(
          `[v26-sync-fills] Public CLOB order ${orderId.slice(0, 10)}... returned ${response.status}: ${text.slice(0, 120)}`
        );
      }
    }

    // 2) Authenticated request (requires valid API key derived from POLYMARKET_PRIVATE_KEY)
    const headers = await createL2Headers(funderAddress, creds, 'GET', requestPath);

    const response = await fetch(`${CLOB_BASE_URL}${requestPath}`, {
      method: 'GET',
      headers: { ...headers, 'Content-Type': 'application/json' },
    });

    if (!response.ok) {
      const text = await response.text();
      console.log(
        `[v26-sync-fills] CLOB order ${orderId.slice(0, 10)}... returned ${response.status}: ${text.slice(0, 120)}`
      );
      return null;
    }

    const data = await response.json();
    // Response might be { order: {...} } or directly the order object
    return (data?.order || data) as ClobOrder;
  } catch (error) {
    console.error(`[v26-sync-fills] Error fetching order ${orderId}:`, error);
    return null;
  }
}

// Extract fill info from CLOB order
function extractFillInfo(order: ClobOrder): {
  status: 'filled' | 'cancelled' | 'open' | 'partial';
  filledShares: number;
  avgFillPrice: number | null;
  matchedAt: string | null;
} {
  const originalSize = parseFloat(order.original_size) || 0;
  const sizeMatchedRaw = parseFloat(order.size_matched) || 0;
  // v26_trades.filled_shares is an integer column; normalize here.
  const sizeMatched = Math.round(sizeMatchedRaw);

  // Determine status
  let status: 'filled' | 'cancelled' | 'open' | 'partial';
  if (order.status === 'CANCELLED' || order.status === 'EXPIRED') {
    status = sizeMatched > 0 ? 'partial' : 'cancelled';
  } else if (order.status === 'MATCHED' || sizeMatchedRaw >= originalSize * 0.99) {
    status = 'filled';
  } else if (sizeMatchedRaw > 0) {
    status = 'partial';
  } else {
    status = 'open';
  }

  // Calculate avg fill price from associate_trades
  let avgFillPrice: number | null = null;
  let matchedAt: string | null = null;

  if (order.associate_trades && order.associate_trades.length > 0) {
    let totalValue = 0;
    let totalSize = 0;
    let latestMatchTime: Date | null = null;

    for (const trade of order.associate_trades) {
      const price = parseFloat(trade.price) || 0;
      const size = parseFloat(trade.size) || 0;
      totalValue += price * size;
      totalSize += size;

      if (trade.match_time) {
        const matchTime = new Date(trade.match_time);
        if (!latestMatchTime || matchTime > latestMatchTime) {
          latestMatchTime = matchTime;
        }
      }
    }

    if (totalSize > 0) {
      avgFillPrice = totalValue / totalSize;
    }
    if (latestMatchTime) {
      matchedAt = latestMatchTime.toISOString();
    }
  }

  return { status, filledShares: sizeMatched, avgFillPrice, matchedAt };
}

interface ClobTrade {
  id: string;
  market: string;
  price: string;
  size: string;
  side: string; // buy | sell
  outcome: string;
  match_time: string; // ISO timestamp
}

async function fetchTradesFromClob(params: {
  funderAddress: string;
  creds: { key: string; secret: string; passphrase: string };
  maker?: string;
  taker?: string;
  market: string;
  after: number; // unix seconds
  before: number; // unix seconds
}): Promise<ClobTrade[]> {
  try {
    const qs = new URLSearchParams();
    if (params.maker) qs.set('maker', params.maker);
    if (params.taker) qs.set('taker', params.taker);
    qs.set('market', params.market);
    qs.set('after', String(params.after));
    qs.set('before', String(params.before));

    const requestPath = `/data/trades?${qs.toString()}`;
    const headers = await createL2Headers(params.funderAddress, params.creds, 'GET', requestPath);

    const response = await fetch(`${CLOB_BASE_URL}${requestPath}`, {
      method: 'GET',
      headers: { ...headers, 'Content-Type': 'application/json' },
    });

    if (!response.ok) {
      const text = await response.text();
      console.log(`[v26-sync-fills] CLOB trades returned ${response.status}: ${text.slice(0, 120)}`);
      return [];
    }

    const data = await response.json();
    return Array.isArray(data) ? (data as ClobTrade[]) : ((data?.trades as ClobTrade[]) || []);
  } catch (error) {
    console.error('[v26-sync-fills] Error fetching trades:', error);
    return [];
  }
}

function aggregateTradesForOutcome(trades: ClobTrade[], wantedOutcome: string): {
  filledSharesRaw: number;
  filledShares: number;
  avgFillPrice: number | null;
  matchedAt: string | null;
} {
  const wanted = (wantedOutcome || '').trim().toUpperCase();
  let totalShares = 0;
  let totalValue = 0;
  let latest: Date | null = null;

  for (const t of trades) {
    const outcome = (t.outcome || '').trim().toUpperCase();
    if (outcome !== wanted) continue;

    const size = parseFloat(t.size) || 0;
    const price = parseFloat(t.price) || 0;

    totalShares += size;
    totalValue += size * price;

    if (t.match_time) {
      const mt = new Date(t.match_time);
      if (!latest || mt > latest) latest = mt;
    }
  }

  const avgFillPrice = totalShares > 0 ? totalValue / totalShares : null;
  // v26_trades.filled_shares is an integer column; round to nearest share.
  const filledShares = Math.round(totalShares);

  return {
    filledSharesRaw: totalShares,
    filledShares,
    avgFillPrice,
    matchedAt: latest ? latest.toISOString() : null,
  };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const privateKey = Deno.env.get('POLYMARKET_PRIVATE_KEY');
    const supabase = createClient(supabaseUrl, supabaseKey);

    console.log('[v26-sync-fills] Starting robust fill sync...');
    
    // Check for required secrets
    const useClobApi = !!privateKey;
    if (!useClobApi) {
      console.log('[v26-sync-fills] No POLYMARKET_PRIVATE_KEY - falling back to fill_logs only');
    }

    // Get wallet address from bot_config
    const { data: botConfig } = await supabase
      .from('bot_config')
      .select('polymarket_address')
      .single();
    
    const walletAddress = botConfig?.polymarket_address;
    console.log(`[v26-sync-fills] Using wallet: ${walletAddress?.slice(0, 10)}...`);

    // Fetch trades that need syncing (last 7 days, missing fill data or not final status)
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    
    // STRATEGY 0: First sync trades WITHOUT order_id that are past their end time + 30 minutes
    const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    
    const { data: noOrderIdTrades } = await supabase
      .from('v26_trades')
      .select('id, market_id, market_slug, side, shares, event_start_time, event_end_time, status, filled_shares')
      .is('order_id', null)
      .eq('status', 'placed')
      .lt('event_end_time', thirtyMinutesAgo)
      .gte('event_start_time', sevenDaysAgo)
      .limit(20);
    
    console.log(`[v26-sync-fills] Found ${noOrderIdTrades?.length || 0} trades without order_id to check via fill_logs`);
    
    // For trades without order_id, check fill_logs by market_id + time window
    for (const trade of noOrderIdTrades || []) {
      const startTime = new Date(trade.event_start_time).getTime();
      const endTime = new Date(trade.event_end_time).getTime();
      
      // Look for fills in this market during the event window
      const { data: fills } = await supabase
        .from('fill_logs')
        .select('fill_qty, fill_price, ts, side')
        .eq('market_id', trade.market_id)
        // NOTE: fill_logs.side for this runner is UP/DOWN (not BUY/SELL)
        .eq('side', trade.side)
        .gte('ts', startTime - 60000) // 1 min before
        .lte('ts', endTime + 60000);  // 1 min after

      if (fills && fills.length > 0) {
        let totalSharesRaw = 0;
        let totalValue = 0;
        let latestTs = 0;

        for (const fill of fills) {
          const qty = Number(fill.fill_qty) || 0;
          const price = Number(fill.fill_price) || 0;
          const ts = Number(fill.ts) || 0;

          totalSharesRaw += qty;
          totalValue += qty * price;
          if (ts > latestTs) latestTs = ts;
        }

        const filledShares = Math.round(totalSharesRaw);
        const avgPrice = totalSharesRaw > 0 ? totalValue / totalSharesRaw : 0.48;
        const matchedAt = latestTs ? new Date(latestTs).toISOString() : new Date().toISOString();

        console.log(
          `[v26-sync-fills] ✓ Found ${fills.length} fills for ${trade.market_slug} → ${filledShares} shares (raw ${totalSharesRaw.toFixed(6)}) @ ${avgPrice.toFixed(3)}`
        );

        await supabase
          .from('v26_trades')
          .update({
            status: 'filled',
            filled_shares: filledShares,
            avg_fill_price: avgPrice,
            fill_matched_at: matchedAt,
          })
          .eq('id', trade.id);
      } else {
        // No fills found - mark as cancelled
        console.log(`[v26-sync-fills] ✗ No fills found for ${trade.market_slug} - marking as cancelled`);

        await supabase
          .from('v26_trades')
          .update({ status: 'cancelled' })
          .eq('id', trade.id);
      }
    }
    
    // Continue with existing logic for trades WITH order_id
    const { data: trades, error: fetchError } = await supabase
      .from('v26_trades')
      .select('id, order_id, market_slug, event_start_time, event_end_time, status, filled_shares, avg_fill_price, fill_matched_at')
      .not('order_id', 'is', null)
      .gte('event_start_time', sevenDaysAgo)
      .or('fill_matched_at.is.null,status.in.(placed,open,partial,processing),filled_shares.eq.0')
      .limit(50);

    if (fetchError) {
      console.error('[v26-sync-fills] Error fetching trades:', fetchError);
      return new Response(JSON.stringify({ error: fetchError.message }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    console.log(`[v26-sync-fills] Found ${trades?.length || 0} trades with order_id to sync`);

    if ((!trades || trades.length === 0) && (!noOrderIdTrades || noOrderIdTrades.length === 0)) {
      return new Response(JSON.stringify({ success: true, synced: 0, failed: 0, source: 'none' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    
    if (!trades || trades.length === 0) {
      return new Response(JSON.stringify({ 
        success: true, 
        synced: noOrderIdTrades?.length || 0, 
        failed: 0, 
        source: 'fill_logs_by_market',
        noOrderIdSynced: noOrderIdTrades?.length || 0
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const results: Array<{
      id: string;
      order_id: string;
      success: boolean;
      source: 'clob' | 'fill_logs' | null;
      status?: string;
      error?: string;
    }> = [];

    // Strategy 1: Use CLOB API for RECENT orders only (last 4 hours)
    // Polymarket deletes order data after a few hours, so older orders will 404
    const fourHoursAgo = Date.now() - 4 * 60 * 60 * 1000;
    const recentTrades = trades.filter(t => new Date(t.event_end_time).getTime() > fourHoursAgo);
    const olderTrades = trades.filter(t => new Date(t.event_end_time).getTime() <= fourHoursAgo);
    
    console.log(`[v26-sync-fills] Split: ${recentTrades.length} recent (CLOB eligible), ${olderTrades.length} older (fill_logs only)`);
    
    if (useClobApi && recentTrades.length > 0) {
      console.log('[v26-sync-fills] Using CLOB API for recent orders...');
      
      try {
        const wallet = new ethers.Wallet(privateKey!);
        const funderAddress = await resolvePolymarketFunderAddress(wallet.address);
        const creds = await deriveApiCredentials(privateKey!);
        const credsForL2 = { key: creds.apiKey, secret: creds.apiSecret, passphrase: creds.passphrase };
        
        console.log(`[v26-sync-fills] Authenticated as ${funderAddress.slice(0, 10)}...`);
        
        // Process only recent trades via CLOB
        for (const trade of recentTrades) {
          if (!trade.order_id) continue;
          
          // Rate limit: small delay between requests
          await new Promise(r => setTimeout(r, 100));
          
          const clobOrder = await fetchOrderFromClob(trade.order_id, funderAddress, credsForL2);
          
          if (!clobOrder) {
            // Don't mark as failed - will try fill_logs fallback
            console.log(`[v26-sync-fills] CLOB 404 for ${trade.order_id.slice(0, 10)}... - will try fill_logs`);
            continue;
          }
          
          const fillInfo = extractFillInfo(clobOrder);
          
          // Determine if we should update
          const needsUpdate = 
            fillInfo.status !== trade.status ||
            fillInfo.filledShares !== trade.filled_shares ||
            (fillInfo.matchedAt && !trade.fill_matched_at);
          
          if (!needsUpdate) {
            results.push({ id: trade.id, order_id: trade.order_id, success: true, source: 'clob', status: fillInfo.status });
            continue;
          }
          
          // Build update data
          const updateData: Record<string, unknown> = { status: fillInfo.status };
          
          if (fillInfo.filledShares > 0) {
            updateData.filled_shares = fillInfo.filledShares;
          }
          if (fillInfo.avgFillPrice !== null) {
            updateData.avg_fill_price = fillInfo.avgFillPrice;
          }
          if (fillInfo.matchedAt) {
            updateData.fill_matched_at = fillInfo.matchedAt;
          }
          
          const { error: updateError } = await supabase
            .from('v26_trades')
            .update(updateData)
            .eq('id', trade.id);
          
          if (updateError) {
            results.push({ id: trade.id, order_id: trade.order_id, success: false, source: 'clob', error: updateError.message });
          } else {
            console.log(`[v26-sync-fills] ✓ ${trade.order_id.slice(0, 10)}... → ${fillInfo.status} (${fillInfo.filledShares} shares @ ${fillInfo.avgFillPrice?.toFixed(2) || '?'})`);
            results.push({ id: trade.id, order_id: trade.order_id, success: true, source: 'clob', status: fillInfo.status });
          }
        }
      } catch (clobError) {
        console.error('[v26-sync-fills] CLOB API error, falling back to fill_logs:', clobError);
        // Fall through to fill_logs strategy
      }
    }
    
    // Strategy 2: Fallback to fill_logs for any trades not yet processed
    const processedIds = new Set(results.map(r => r.id));
    const remainingTrades = trades.filter(t => !processedIds.has(t.id));
    
    if (remainingTrades.length > 0) {
      console.log(`[v26-sync-fills] Using fill_logs fallback for ${remainingTrades.length} trades`);
      
      const orderIds = remainingTrades.map(t => t.order_id).filter(Boolean) as string[];
      
      const { data: fillLogs } = await supabase
        .from('fill_logs')
        .select('order_id, ts, iso, fill_qty, fill_price')
        .in('order_id', orderIds);
      
      // Aggregate fill_logs by order_id
      const fillMap = new Map<string, { ts: number; totalShares: number; totalValue: number }>();
      for (const fl of fillLogs || []) {
        const orderId = fl.order_id?.toLowerCase();
        if (!orderId) continue;
        const ts = Number(fl.ts) || 0;
        const shares = Number(fl.fill_qty) || 0;
        const price = Number(fl.fill_price) || 0;
        const existing = fillMap.get(orderId);
        if (!existing) {
          fillMap.set(orderId, { ts, totalShares: shares, totalValue: shares * price });
        } else {
          if (ts > existing.ts) existing.ts = ts;
          existing.totalShares += shares;
          existing.totalValue += shares * price;
        }
      }
      
      for (const trade of remainingTrades) {
        const orderId = trade.order_id?.toLowerCase();
        if (!orderId) {
          results.push({ id: trade.id, order_id: trade.order_id || '', success: false, source: null, error: 'No order_id' });
          continue;
        }
        
        const fill = fillMap.get(orderId);
        if (!fill) {
          results.push({ id: trade.id, order_id: trade.order_id!, success: false, source: 'fill_logs', error: 'No fill_logs match' });
          continue;
        }
        
        const avgPrice = fill.totalShares > 0 ? fill.totalValue / fill.totalShares : null;
        const matchedAt = new Date(fill.ts).toISOString();
        const filledShares = Math.round(fill.totalShares);

        const { error: updateError } = await supabase
          .from('v26_trades')
          .update({
            filled_shares: filledShares,
            avg_fill_price: avgPrice,
            fill_matched_at: matchedAt,
            status: filledShares > 0 ? 'filled' : trade.status,
          })
          .eq('id', trade.id);
        
        if (updateError) {
          results.push({ id: trade.id, order_id: trade.order_id!, success: false, source: 'fill_logs', error: updateError.message });
        } else {
          console.log(`[v26-sync-fills] ✓ ${trade.order_id!.slice(0, 10)}... → filled via fill_logs`);
          results.push({ id: trade.id, order_id: trade.order_id!, success: true, source: 'fill_logs', status: 'filled' });
        }
      }
    }

    const successCount = results.filter(r => r.success).length;
    const failCount = results.filter(r => !r.success).length;

    console.log(`[v26-sync-fills] Done: ${successCount} synced, ${failCount} failed`);

    return new Response(JSON.stringify({
      success: true,
      synced: successCount,
      failed: failCount,
      total: trades.length,
      usedClobApi: useClobApi,
      results,
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  } catch (error) {
    console.error('[v26-sync-fills] Unexpected error:', error);
    return new Response(JSON.stringify({ error: String(error) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});
