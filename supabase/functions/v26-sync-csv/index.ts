import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Parse CSV content into rows
function parseCSV(content: string): Record<string, string>[] {
  const lines = content.trim().split('\n');
  if (lines.length < 2) return [];

  // Parse header (handle BOM)
  const headerLine = lines[0].replace(/^\uFEFF/, '');
  const headers = parseCSVLine(headerLine);

  const rows: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i]);
    if (values.length !== headers.length) continue;

    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = values[j];
    }
    rows.push(row);
  }
  return rows;
}

// Parse a single CSV line handling quoted values
function parseCSVLine(line: string): string[] {
  const values: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      values.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  values.push(current.trim());
  return values;
}

// Extract asset from marketName: "Solana Up or Down - January 7, 5:45PM-6:00PM ET" -> "SOL"
function extractAsset(marketName: string): string | null {
  const lower = marketName.toLowerCase();
  if (lower.includes('bitcoin')) return 'BTC';
  if (lower.includes('ethereum')) return 'ETH';
  if (lower.includes('solana')) return 'SOL';
  if (lower.includes('xrp')) return 'XRP';
  return null;
}

// Extract event start time from marketName: "Solana Up or Down - January 7, 5:45PM-6:00PM ET"
// Returns ISO string in UTC
function extractEventStartTime(marketName: string): string | null {
  // Pattern: "AssetName Up or Down - Month Day, StartTime-EndTime ET"
  const match = marketName.match(/(\w+)\s+(\d+),\s*(\d{1,2}):?(\d{2})?(AM|PM)-(\d{1,2}):?(\d{2})?(AM|PM)\s+ET/i);
  if (!match) return null;

  const monthName = match[1];
  const day = parseInt(match[2]);
  const startHour = parseInt(match[3]);
  const startMinute = match[4] ? parseInt(match[4]) : 0;
  const startAmPm = match[5].toUpperCase();

  // Convert to 24-hour format
  let hour24 = startHour;
  if (startAmPm === 'PM' && startHour !== 12) hour24 += 12;
  if (startAmPm === 'AM' && startHour === 12) hour24 = 0;

  // Month mapping
  const months: Record<string, number> = {
    'january': 0, 'february': 1, 'march': 2, 'april': 3, 'may': 4, 'june': 5,
    'july': 6, 'august': 7, 'september': 8, 'october': 9, 'november': 10, 'december': 11
  };
  const month = months[monthName.toLowerCase()];
  if (month === undefined) return null;

  // Assume current year (2026)
  const year = 2026;

  // Create date in ET (America/New_York) and convert to UTC
  // ET is UTC-5 (EST) or UTC-4 (EDT). For January, it's EST (UTC-5)
  const etOffset = 5; // hours behind UTC in EST
  const utcHour = hour24 + etOffset;
  
  const date = new Date(Date.UTC(year, month, day, utcHour, startMinute, 0));
  return date.toISOString();
}

// Build market_slug from asset and event_start_time: "sol-updown-15m-1767825900"
function buildMarketSlug(asset: string, eventStartTime: string): string {
  const assetLower = asset.toLowerCase();
  const startTs = Math.floor(new Date(eventStartTime).getTime() / 1000);
  return `${assetLower}-updown-15m-${startTs}`;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Get CSV content from request body
    const body = await req.json();
    const csvContent = body.csv as string;

    if (!csvContent) {
      return new Response(
        JSON.stringify({ error: 'Missing csv in request body' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log('[v26-sync-csv] Parsing CSV...');
    const rows = parseCSV(csvContent);
    console.log(`[v26-sync-csv] Parsed ${rows.length} rows from CSV`);

    // Filter to Buy actions only (these have real fill times)
    const buyRows = rows.filter(r => r.action === 'Buy');
    console.log(`[v26-sync-csv] Found ${buyRows.length} Buy transactions`);

    // Build lookup: market_slug -> { fillTimestamp, shares, price }
    interface CsvFill {
      fillTimestampSec: number;
      tokenAmount: number;
      usdcAmount: number;
      tokenName: string;
      txHash: string;
    }
    const fillLookup = new Map<string, CsvFill>();

    for (const row of buyRows) {
      const asset = extractAsset(row.marketName);
      const eventStartTime = extractEventStartTime(row.marketName);
      
      if (!asset || !eventStartTime) {
        console.log(`[v26-sync-csv] Could not parse: ${row.marketName}`);
        continue;
      }

      const marketSlug = buildMarketSlug(asset, eventStartTime);
      const fillTs = parseInt(row.timestamp);
      const tokenAmount = parseFloat(row.tokenAmount);
      const usdcAmount = parseFloat(row.usdcAmount);

      const existing = fillLookup.get(marketSlug);
      if (!existing || fillTs > existing.fillTimestampSec) {
        // Use latest fill for this market
        fillLookup.set(marketSlug, {
          fillTimestampSec: fillTs,
          tokenAmount,
          usdcAmount,
          tokenName: row.tokenName,
          txHash: row.hash,
        });
      } else if (fillTs === existing.fillTimestampSec) {
        // Same timestamp, aggregate
        existing.tokenAmount += tokenAmount;
        existing.usdcAmount += usdcAmount;
      }
    }

    console.log(`[v26-sync-csv] Built fill lookup for ${fillLookup.size} markets`);

    // Fetch v26_trades that could match
    const marketSlugs = Array.from(fillLookup.keys());
    if (marketSlugs.length === 0) {
      return new Response(
        JSON.stringify({ success: true, synced: 0, failed: 0, total: 0, message: 'No Buy transactions found' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const { data: trades, error: fetchError } = await supabase
      .from('v26_trades')
      .select('id, market_slug, event_start_time, event_end_time, status, filled_shares, fill_matched_at')
      .in('market_slug', marketSlugs);

    if (fetchError) {
      console.error('[v26-sync-csv] Error fetching trades:', fetchError);
      return new Response(
        JSON.stringify({ error: fetchError.message }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`[v26-sync-csv] Found ${trades?.length || 0} matching v26_trades`);

    const results: Array<{
      market_slug: string;
      success: boolean;
      error?: string;
      fill_matched_at?: string;
      fill_offset_sec?: number;
    }> = [];

    for (const trade of trades || []) {
      const fill = fillLookup.get(trade.market_slug);
      if (!fill) {
        results.push({ market_slug: trade.market_slug, success: false, error: 'No CSV match' });
        continue;
      }

      // Convert fill timestamp (seconds) to ISO
      const fillMatchedAt = new Date(fill.fillTimestampSec * 1000).toISOString();
      const eventStartMs = new Date(trade.event_start_time).getTime();
      const fillOffsetSec = fill.fillTimestampSec - Math.floor(eventStartMs / 1000);

      // Calculate fill_time_ms (time from order placement to fill)
      // We don't have order placement time in CSV, so we'll use event_start offset
      const fillTimeMs = fillOffsetSec > 0 ? fillOffsetSec * 1000 : null;

      const updateData: Record<string, any> = {
        fill_matched_at: fillMatchedAt,
        filled_shares: Math.round(fill.tokenAmount),
        status: fill.tokenAmount > 0 ? 'filled' : trade.status,
      };

      if (fillTimeMs !== null && fillTimeMs > 0) {
        updateData.fill_time_ms = fillTimeMs;
      }

      const { error: updateError } = await supabase
        .from('v26_trades')
        .update(updateData)
        .eq('id', trade.id);

      if (updateError) {
        console.error(`[v26-sync-csv] Update failed for ${trade.market_slug}:`, updateError);
        results.push({ market_slug: trade.market_slug, success: false, error: updateError.message });
      } else {
        console.log(
          `[v26-sync-csv] Updated ${trade.market_slug}: fill_matched_at=${fillMatchedAt}, offset=${fillOffsetSec}s`
        );
        results.push({
          market_slug: trade.market_slug,
          success: true,
          fill_matched_at: fillMatchedAt,
          fill_offset_sec: fillOffsetSec,
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
        csv_buys: buyRows.length,
        markets_in_csv: fillLookup.size,
        results,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('[v26-sync-csv] Unexpected error:', error);
    return new Response(
      JSON.stringify({ error: String(error) }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
