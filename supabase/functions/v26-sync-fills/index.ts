import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const CLOB_BASE_URL = 'https://clob.polymarket.com';

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

interface AssociateTrade {
  match_time: number;
  price?: string;
  size?: string;
}

interface ClobOrderResponse {
  id: string;
  status: string;
  original_size: string;
  size_matched: string;
  associate_trades?: AssociateTrade[];
}

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

    // Get wallet address from bot_config
    const configRes = await supabase.from('bot_config').select('polymarket_address').limit(1).single();
    const walletAddress = configRes.data?.polymarket_address;
    
    if (!walletAddress) {
      console.error('[v26-sync-fills] No polymarket_address in bot_config');
      return new Response(
        JSON.stringify({ error: 'No wallet address configured in bot_config' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    
    console.log(`[v26-sync-fills] Using wallet address: ${walletAddress}`);

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
      const requestPath = `/order/${orderId}`;

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

        const orderData: ClobOrderResponse = await response.json();
        console.log(`[v26-sync-fills] Order ${orderId}:`, JSON.stringify(orderData).slice(0, 200));

        // Parse size_matched
        const sizeMatched = parseFloat(orderData.size_matched || '0');
        const originalSize = parseFloat(orderData.original_size || '0');

        // Find the last match time (max of all match_times)
        let lastMatchTimeMs: number | null = null;
        if (orderData.associate_trades && orderData.associate_trades.length > 0) {
          for (const at of orderData.associate_trades) {
            if (at.match_time) {
              // Normalize: if < 1e12, it's seconds, otherwise ms
              const matchMs = at.match_time < 1e12 ? at.match_time * 1000 : at.match_time;
              if (lastMatchTimeMs === null || matchMs > lastMatchTimeMs) {
                lastMatchTimeMs = matchMs;
              }
            }
          }
        }

        // Determine new status
        let newStatus = trade.status;
        if (sizeMatched >= originalSize && originalSize > 0) {
          newStatus = 'filled';
        } else if (sizeMatched > 0) {
          newStatus = 'partial';
        } else if (orderData.status === 'CANCELLED') {
          newStatus = 'cancelled';
        } else if (orderData.status === 'EXPIRED') {
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
