import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Parse CSV content into rows
function parseCSV(content: string): Record<string, string>[] {
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  const lines = normalized
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0);

  if (lines.length < 2) return [];

  // Parse header (handle BOM)
  const headerLine = lines[0].replace(/^\uFEFF/, '').trim();
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

    // Separate by action type
    const buyRows = rows.filter(r => r.action === 'Buy');
    const lostRows = rows.filter(r => r.action === 'Lost');
    const redeemRows = rows.filter(r => r.action === 'Redeem');
    console.log(`[v26-sync-csv] Found ${buyRows.length} Buy, ${lostRows.length} Lost, ${redeemRows.length} Redeem`);

    // Build lookup: market_slug -> fill info (from Buy)
    interface CsvFill {
      fillTimestampSec: number;
      tokenAmount: number;
      usdcAmount: number;
      tokenName: string;
      txHash: string;
      asset: string;
      eventStartTime: string;
      eventEndTime: string;
    }
    const fillLookup = new Map<string, CsvFill>();

    for (const row of buyRows) {
      const asset = extractAsset(row.marketName);
      const eventStartTime = extractEventStartTime(row.marketName);
      
      if (!asset || !eventStartTime) {
        console.log(`[v26-sync-csv] Could not parse Buy: ${row.marketName}`);
        continue;
      }

      // Calculate event end time (15 min after start)
      const startMs = new Date(eventStartTime).getTime();
      const eventEndTime = new Date(startMs + 15 * 60 * 1000).toISOString();

      const marketSlug = buildMarketSlug(asset, eventStartTime);
      const fillTs = parseInt(row.timestamp);
      const tokenAmount = parseFloat(row.tokenAmount);
      const usdcAmount = parseFloat(row.usdcAmount);

      // Always aggregate all fills for the same market (not just same timestamp)
      const existing = fillLookup.get(marketSlug);
      if (!existing) {
        fillLookup.set(marketSlug, {
          fillTimestampSec: fillTs,
          tokenAmount,
          usdcAmount,
          tokenName: row.tokenName,
          txHash: row.hash,
          asset,
          eventStartTime,
          eventEndTime,
        });
      } else {
        // Aggregate: add shares and usdc, keep latest timestamp
        existing.tokenAmount += tokenAmount;
        existing.usdcAmount += usdcAmount;
        if (fillTs > existing.fillTimestampSec) {
          existing.fillTimestampSec = fillTs;
          existing.txHash = row.hash;
        }
      }
    }

    // Build lookup: market_slug -> settlement info (from Lost/Redeem)
    interface CsvSettlement {
      result: 'won' | 'lost';
      settledAtSec: number;
      payout: number; // USDC received (0 for lost)
      shares: number;
    }
    const settlementLookup = new Map<string, CsvSettlement>();

    for (const row of lostRows) {
      const asset = extractAsset(row.marketName);
      const eventStartTime = extractEventStartTime(row.marketName);
      if (!asset || !eventStartTime) continue;

      const marketSlug = buildMarketSlug(asset, eventStartTime);
      const settledTs = parseInt(row.timestamp);
      const shares = parseFloat(row.tokenAmount);
      const cost = parseFloat(row.usdcAmount);

      const existing = settlementLookup.get(marketSlug);
      if (!existing) {
        settlementLookup.set(marketSlug, {
          result: 'lost',
          settledAtSec: settledTs,
          payout: 0,
          shares,
        });
      } else {
        // Aggregate if multiple Lost entries
        existing.shares += shares;
      }
    }

    for (const row of redeemRows) {
      const asset = extractAsset(row.marketName);
      const eventStartTime = extractEventStartTime(row.marketName);
      if (!asset || !eventStartTime) continue;

      const payout = parseFloat(row.usdcAmount);
      const shares = parseFloat(row.tokenAmount);

      // IGNORE bogus redeems with 0 payout and 0 shares (duplicate tx rows)
      if (payout === 0 && shares === 0) {
        console.log(`[v26-sync-csv] Ignoring 0/0 Redeem for: ${row.marketName}`);
        continue;
      }

      const marketSlug = buildMarketSlug(asset, eventStartTime);
      const settledTs = parseInt(row.timestamp);

      const existing = settlementLookup.get(marketSlug);
      if (!existing) {
        settlementLookup.set(marketSlug, {
          result: 'won',
          settledAtSec: settledTs,
          payout,
          shares,
        });
      } else {
        // Upgrade lost to won if we also have a redeem (partial hedge)
        existing.result = 'won';
        existing.payout += payout;
        existing.shares += shares;
      }
    }

    console.log(`[v26-sync-csv] Fill lookup: ${fillLookup.size} markets, Settlement lookup: ${settlementLookup.size} markets`);

    // Combine all market slugs
    const allSlugs = new Set([...fillLookup.keys(), ...settlementLookup.keys()]);
    const marketSlugs = Array.from(allSlugs);
    
    if (marketSlugs.length === 0) {
      return new Response(
        JSON.stringify({ success: true, synced: 0, message: 'No transactions found' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const { data: trades, error: fetchError } = await supabase
      .from('v26_trades')
      .select('id, market_slug, event_start_time, event_end_time, status, filled_shares, fill_matched_at, result, settled_at, pnl, notional');

    if (fetchError) {
      console.error('[v26-sync-csv] Error fetching trades:', fetchError);
      return new Response(
        JSON.stringify({ error: fetchError.message }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Create slug->trade mapping
    const tradesBySlug = new Map<string, typeof trades[0]>();
    for (const t of trades || []) {
      tradesBySlug.set(t.market_slug, t);
    }

    console.log(`[v26-sync-csv] Loaded ${trades?.length || 0} v26_trades`);

    const results: Array<{
      market_slug: string;
      action: string;
      success: boolean;
      error?: string;
      details?: Record<string, any>;
    }> = [];

    // Process fills (Buy) - UPDATE existing or INSERT new
    for (const [slug, fill] of fillLookup) {
      const trade = tradesBySlug.get(slug);
      const fillMatchedAt = new Date(fill.fillTimestampSec * 1000).toISOString();
      const eventStartMs = new Date(fill.eventStartTime).getTime();
      const fillOffsetSec = fill.fillTimestampSec - Math.floor(eventStartMs / 1000);

      if (trade) {
        // UPDATE existing trade (notional is a generated column, don't update it)
        const avgFillPrice = fill.usdcAmount / fill.tokenAmount;
        const updateData: Record<string, any> = {
          fill_matched_at: fillMatchedAt,
          filled_shares: Math.round(fill.tokenAmount),
          avg_fill_price: Math.round(avgFillPrice * 100) / 100,
          status: 'filled',
        };

        const { error: updateError } = await supabase
          .from('v26_trades')
          .update(updateData)
          .eq('id', trade.id);

        if (updateError) {
          results.push({ market_slug: slug, action: 'fill_update', success: false, error: updateError.message });
        } else {
          console.log(`[v26-sync-csv] Fill UPDATE: ${slug} → offset=${fillOffsetSec}s, shares=${fill.tokenAmount}`);
          results.push({ 
            market_slug: slug, 
            action: 'fill_update', 
            success: true, 
            details: { fill_offset_sec: fillOffsetSec, filled_shares: fill.tokenAmount } 
          });
        }
      } else {
        // INSERT new trade from CSV
        const side = fill.tokenName === 'Up' ? 'UP' : 'DOWN';
        const price = fill.usdcAmount / fill.tokenAmount;

        const insertData = {
          market_slug: slug,
          asset: fill.asset,
          event_start_time: fill.eventStartTime,
          event_end_time: fill.eventEndTime,
          market_id: slug, // Use slug as market_id placeholder
          side,
          price: Math.round(price * 100) / 100,
          shares: Math.round(fill.tokenAmount),
          filled_shares: Math.round(fill.tokenAmount),
          // notional is a generated column, don't insert it
          fill_matched_at: fillMatchedAt,
          status: 'filled',
        };

        const { error: insertError } = await supabase
          .from('v26_trades')
          .insert(insertData);

        if (insertError) {
          console.error(`[v26-sync-csv] Insert failed for ${slug}:`, insertError);
          results.push({ market_slug: slug, action: 'fill_insert', success: false, error: insertError.message });
        } else {
          console.log(`[v26-sync-csv] Fill INSERT: ${slug} → ${side} ${fill.tokenAmount} shares @ ${price.toFixed(2)}`);
          results.push({ 
            market_slug: slug, 
            action: 'fill_insert', 
            success: true, 
            details: { side, shares: fill.tokenAmount, price, fill_offset_sec: fillOffsetSec } 
          });
          // Add to tradesBySlug so settlement can find it
          tradesBySlug.set(slug, { 
            id: '', // Will be fetched if needed
            market_slug: slug, 
            event_start_time: fill.eventStartTime, 
            event_end_time: fill.eventEndTime, 
            status: 'filled', 
            filled_shares: fill.tokenAmount, 
            fill_matched_at: fillMatchedAt, 
            result: null, 
            settled_at: null, 
            pnl: null, 
            notional: fill.usdcAmount 
          } as any);
        }
      }
    }

    // Re-fetch trades to get IDs and side of newly inserted ones
    const { data: updatedTrades } = await supabase
      .from('v26_trades')
      .select('id, market_slug, notional, side')
      .in('market_slug', marketSlugs);
    
    const updatedTradesBySlug = new Map<string, { id: string; notional: number | null; side: string | null }>();
    for (const t of updatedTrades || []) {
      updatedTradesBySlug.set(t.market_slug, { id: t.id, notional: t.notional, side: t.side });
    }

    // Process settlements (Lost/Redeem)
    for (const [slug, settlement] of settlementLookup) {
      const trade = updatedTradesBySlug.get(slug);
      if (!trade) {
        results.push({ market_slug: slug, action: 'settlement', success: false, error: 'No matching v26_trade' });
        continue;
      }

      const settledAt = new Date(settlement.settledAtSec * 1000).toISOString();
      
      // Calculate PnL: payout - cost (notional)
      const cost = trade.notional || 0;
      const pnl = settlement.result === 'won' ? settlement.payout - cost : -cost;

      // Normalize result to market winning side (UP/DOWN) instead of won/lost
      // This makes reasoning consistent: if our side matches result, we won
      const tradeSide = (trade.side || '').toUpperCase();
      let marketWinner: string;
      if (settlement.result === 'won') {
        // We won, so market winner = our side
        marketWinner = tradeSide || 'UP'; // fallback shouldn't happen
      } else {
        // We lost, so market winner = opposite of our side
        marketWinner = tradeSide === 'UP' ? 'DOWN' : 'UP';
      }

      const updateData: Record<string, any> = {
        result: marketWinner, // Store UP/DOWN instead of won/lost
        settled_at: settledAt,
        pnl: Math.round(pnl * 100) / 100,
        status: 'settled',
      };

      const { error: updateError } = await supabase
        .from('v26_trades')
        .update(updateData)
        .eq('id', trade.id);

      if (updateError) {
        results.push({ market_slug: slug, action: 'settlement', success: false, error: updateError.message });
      } else {
        console.log(`[v26-sync-csv] Settlement: ${slug} → winner=${marketWinner} (was ${settlement.result}), pnl=${pnl}`);
        results.push({ 
          market_slug: slug, 
          action: 'settlement', 
          success: true, 
          details: { result: marketWinner, pnl, payout: settlement.payout, original_outcome: settlement.result } 
        });
      }
    }

    const fillsUpdated = results.filter(r => r.action === 'fill_update' && r.success).length;
    const fillsInserted = results.filter(r => r.action === 'fill_insert' && r.success).length;
    const settlementsSynced = results.filter(r => r.action === 'settlement' && r.success).length;
    const failCount = results.filter(r => !r.success).length;

    return new Response(
      JSON.stringify({
        success: true,
        fills_updated: fillsUpdated,
        fills_inserted: fillsInserted,
        settlements_synced: settlementsSynced,
        failed: failCount,
        csv_buys: buyRows.length,
        csv_lost: lostRows.length,
        csv_redeem: redeemRows.length,
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
