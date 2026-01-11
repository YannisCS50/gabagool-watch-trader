import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import JSZip from "https://esm.sh/jszip@3.10.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface ExportRequest {
  wallet?: string;
  from_date?: string; // ISO string
  to_date?: string;   // ISO string
}

interface ConsistencyCheck {
  name: string;
  passed: boolean;
  expected?: number;
  actual?: number;
  tolerance?: number;
  message: string;
}

// Helper: convert array to CSV
function arrayToCSV(data: Record<string, unknown>[], columns: string[]): string {
  if (data.length === 0) {
    return columns.join(",") + "\n";
  }
  const header = columns.join(",");
  const rows = data.map((row) =>
    columns
      .map((col) => {
        const val = row[col];
        if (val === null || val === undefined) return "";
        if (typeof val === "string") return `"${val.replace(/"/g, '""')}"`;
        if (typeof val === "object") return `"${JSON.stringify(val).replace(/"/g, '""')}"`;
        return String(val);
      })
      .join(",")
  );
  return [header, ...rows].join("\n");
}

// Helper: SHA-256 hash
async function sha256(content: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(content);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const { wallet, from_date, to_date } = (await req.json()) as ExportRequest;

    // Wallet is optional: if not provided by the client, we fall back to the configured wallet.
    let walletOriginal = (wallet || "").trim();

    if (!walletOriginal) {
      const { data: cfgRows, error: cfgErr } = await supabase
        .from("bot_config")
        .select("polymarket_address, updated_at, created_at")
        .order("updated_at", { ascending: false })
        .order("created_at", { ascending: false })
        .limit(1);

      if (cfgErr) throw new Error(`bot_config: ${cfgErr.message}`);

      walletOriginal = (cfgRows?.[0]?.polymarket_address || "").trim();
    }

    if (!walletOriginal) {
      return new Response(
        JSON.stringify({
          error: "wallet is required (configure bot_config.polymarket_address or pass wallet in request)",
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const walletLower = walletOriginal.toLowerCase();
    const fromTs = from_date || "2020-01-01T00:00:00Z";
    const toTs = to_date || new Date().toISOString();

    console.log(`[v26-export] Exporting wallet=${walletLower} from=${fromTs} to=${toTs}`);

    const zip = new JSZip();
    const checksums: Record<string, string> = {};
    const fileCounts: Record<string, number> = {};
    const consistencyChecks: ConsistencyCheck[] = [];

    // ===== 1. RAW SUBGRAPH EVENTS =====
    const { data: rawEvents, error: rawEventsErr } = await supabase
      .from("raw_subgraph_events")
      .select("*")
      .eq("wallet", walletLower)
      .gte("timestamp", fromTs)
      .lte("timestamp", toTs)
      .order("timestamp", { ascending: true });

    if (rawEventsErr) throw new Error(`raw_subgraph_events: ${rawEventsErr.message}`);

    const rawEventsCols = [
      "id", "tx_hash", "timestamp", "event_type", "market_id", "outcome",
      "shares", "price", "amount_usd", "fee_usd", "ingested_at"
    ];
    const rawEventsCSV = arrayToCSV(rawEvents || [], rawEventsCols);
    zip.file("DATA/raw_subgraph_events.csv", rawEventsCSV);
    checksums["DATA/raw_subgraph_events.csv"] = await sha256(rawEventsCSV);
    fileCounts["raw_subgraph_events"] = rawEvents?.length || 0;

    // ===== 2. CASHFLOW LEDGER =====
    const { data: cashflows, error: cashflowErr } = await supabase
      .from("cashflow_ledger")
      .select("*")
      .eq("wallet", walletLower)
      .gte("timestamp", fromTs)
      .lte("timestamp", toTs)
      .order("timestamp", { ascending: true });

    if (cashflowErr) throw new Error(`cashflow_ledger: ${cashflowErr.message}`);

    const cashflowCols = [
      "id", "timestamp", "market_id", "outcome", "category", "direction",
      "amount_usd", "shares_delta", "source_event_id", "created_at"
    ];
    const cashflowCSV = arrayToCSV(cashflows || [], cashflowCols);
    zip.file("DATA/cashflow_ledger.csv", cashflowCSV);
    checksums["DATA/cashflow_ledger.csv"] = await sha256(cashflowCSV);
    fileCounts["cashflow_ledger"] = cashflows?.length || 0;

    // ===== 3. MARKET LIFECYCLE =====
    const { data: lifecycle, error: lifecycleErr } = await supabase
      .from("market_lifecycle")
      .select("*")
      .eq("wallet", walletLower)
      .order("created_at", { ascending: true });

    if (lifecycleErr) throw new Error(`market_lifecycle: ${lifecycleErr.message}`);

    const lifecycleCols = [
      "id", "market_id", "market_slug", "state", "resolved_outcome",
      "settlement_ts", "total_cost", "total_payout", "realized_pnl",
      "has_buy", "has_sell", "has_redeem", "is_claimed", "is_lost",
      "created_at", "updated_at"
    ];
    const lifecycleCSV = arrayToCSV(lifecycle || [], lifecycleCols);
    zip.file("DATA/market_lifecycle.csv", lifecycleCSV);
    checksums["DATA/market_lifecycle.csv"] = await sha256(lifecycleCSV);
    fileCounts["market_lifecycle"] = lifecycle?.length || 0;

    // ===== 4. MARKET P&L (from subgraph_pnl_markets) =====
    const { data: marketPnl, error: marketPnlErr } = await supabase
      .from("subgraph_pnl_markets")
      .select("*")
      .eq("wallet", walletLower)
      .order("created_at", { ascending: true });

    if (marketPnlErr) throw new Error(`subgraph_pnl_markets: ${marketPnlErr.message}`);

    const marketPnlCols = [
      "id", "market_id", "market_slug", "wallet",
      "up_shares", "down_shares", "avg_up_cost", "avg_down_cost", "total_cost",
      "realized_pnl_usd", "realized_confidence", "unrealized_pnl_usd", "unrealized_confidence",
      "mark_source", "mark_price_up", "mark_price_down", "mark_timestamp",
      "fees_known_usd", "fees_unknown_count", "is_settled", "settlement_outcome",
      "settlement_payout", "settled_at", "payout_ingested", "payout_amount_usd",
      "lifecycle_state", "confidence", "created_at", "updated_at"
    ];
    const marketPnlCSV = arrayToCSV(marketPnl || [], marketPnlCols);
    zip.file("DATA/market_pnl.csv", marketPnlCSV);
    checksums["DATA/market_pnl.csv"] = await sha256(marketPnlCSV);
    fileCounts["market_pnl"] = marketPnl?.length || 0;

    // ===== 5. DAILY P&L =====
    const { data: dailyPnl, error: dailyPnlErr } = await supabase
      .from("daily_pnl")
      .select("*")
      .eq("wallet", walletLower)
      .gte("date", fromTs.split("T")[0])
      .lte("date", toTs.split("T")[0])
      .order("date", { ascending: true });

    if (dailyPnlErr) throw new Error(`daily_pnl: ${dailyPnlErr.message}`);

    const dailyPnlCols = [
      "id", "date", "wallet", "realized_pnl", "unrealized_pnl", "total_pnl",
      "volume_traded", "markets_active", "buy_count", "sell_count", "redeem_count",
      "created_at", "updated_at"
    ];
    const dailyPnlCSV = arrayToCSV(dailyPnl || [], dailyPnlCols);
    zip.file("DATA/daily_pnl.csv", dailyPnlCSV);
    checksums["DATA/daily_pnl.csv"] = await sha256(dailyPnlCSV);
    fileCounts["daily_pnl"] = dailyPnl?.length || 0;

    // ===== 6. EXECUTION METRICS (from fill_attributions) =====
    const { data: fillAttr, error: fillAttrErr } = await supabase
      .from("fill_attributions")
      .select("*")
      .order("ts", { ascending: true })
      .limit(10000);

    if (fillAttrErr) throw new Error(`fill_attributions: ${fillAttrErr.message}`);

    const execCols = [
      "id", "created_at", "ts", "run_id", "correlation_id", "order_id",
      "market_id", "asset", "side", "price", "size", "liquidity",
      "fee_paid", "rebate_expected", "fill_cost_gross", "fill_cost_net",
      "updated_avg_up", "updated_avg_down", "updated_cpp_gross", "updated_cpp_net_expected"
    ];
    const execCSV = arrayToCSV(fillAttr || [], execCols);
    zip.file("DATA/execution_metrics.csv", execCSV);
    checksums["DATA/execution_metrics.csv"] = await sha256(execCSV);
    fileCounts["execution_metrics"] = fillAttr?.length || 0;

    // ===== 7. HEDGE METRICS (from hedge_intents) =====
    const { data: hedgeIntents, error: hedgeErr } = await supabase
      .from("hedge_intents")
      .select("*")
      .order("ts", { ascending: true })
      .limit(10000);

    if (hedgeErr) throw new Error(`hedge_intents: ${hedgeErr.message}`);

    const hedgeCols = [
      "id", "created_at", "ts", "correlation_id", "run_id", "market_id", "asset",
      "side", "intent_type", "intended_qty", "filled_qty", "status", "abort_reason",
      "price_at_intent", "price_at_resolution", "resolution_ts"
    ];
    const hedgeCSV = arrayToCSV(hedgeIntents || [], hedgeCols);
    zip.file("DATA/hedge_metrics.csv", hedgeCSV);
    checksums["DATA/hedge_metrics.csv"] = await sha256(hedgeCSV);
    fileCounts["hedge_metrics"] = hedgeIntents?.length || 0;

    // ===== 8. POSITIONS TIMESERIES (from canonical_positions) =====
    const { data: positions, error: posErr } = await supabase
      .from("canonical_positions")
      .select("*")
      .eq("wallet", walletLower)
      .order("updated_at", { ascending: true });

    if (posErr) throw new Error(`canonical_positions: ${posErr.message}`);

    const posCols = [
      "id", "market_id", "outcome", "wallet", "shares_held", "total_cost_usd",
      "avg_cost", "realized_pnl", "unrealized_pnl", "state", "last_fill_at",
      "created_at", "updated_at"
    ];
    const posCSV = arrayToCSV(positions || [], posCols);
    zip.file("DATA/positions_timeseries.csv", posCSV);
    checksums["DATA/positions_timeseries.csv"] = await sha256(posCSV);
    fileCounts["positions_timeseries"] = positions?.length || 0;

    // ===== 9. PNL SNAPSHOTS (if available) =====
    const { data: pnlSnapshots, error: pnlSnapErr } = await supabase
      .from("pnl_snapshots")
      .select("*")
      .eq("wallet", walletLower)
      .gte("timestamp", fromTs)
      .lte("timestamp", toTs)
      .order("timestamp", { ascending: true });

    // Table may not exist or have no data - that's ok
    const snapCols = ["id", "wallet", "timestamp", "realized_pnl", "unrealized_pnl", "total_pnl", "confidence", "created_at"];
    const snapCSV = arrayToCSV(pnlSnapshots || [], snapCols);
    zip.file("DATA/pnl_snapshots.csv", snapCSV);
    checksums["DATA/pnl_snapshots.csv"] = await sha256(snapCSV);
    fileCounts["pnl_snapshots"] = pnlSnapshots?.length || 0;

    // ===== CONSISTENCY CHECKS =====

    // Check 1: Sum(daily realized_pnl) == total realized_pnl
    const sumDailyRealized = (dailyPnl || []).reduce((sum, d) => sum + (Number(d.realized_pnl) || 0), 0);
    const sumMarketRealized = (marketPnl || []).reduce((sum, m) => sum + (Number(m.realized_pnl_usd) || 0), 0);
    const tolerance = 0.01;

    const dailyVsMarketDiff = Math.abs(sumDailyRealized - sumMarketRealized);
    consistencyChecks.push({
      name: "daily_vs_market_realized_pnl",
      passed: dailyVsMarketDiff <= tolerance * Math.max(Math.abs(sumDailyRealized), Math.abs(sumMarketRealized), 1),
      expected: sumMarketRealized,
      actual: sumDailyRealized,
      tolerance,
      message: dailyVsMarketDiff <= tolerance
        ? "Daily and market realized PnL match"
        : `Drift of $${dailyVsMarketDiff.toFixed(2)} between daily and market totals`
    });

    // Check 2: All cashflow entries link to raw events (where applicable)
    const cashflowsWithSource = (cashflows || []).filter(c => c.source_event_id);
    const rawEventIds = new Set((rawEvents || []).map(e => e.id));
    const orphanedCashflows = cashflowsWithSource.filter(c => !rawEventIds.has(c.source_event_id));
    consistencyChecks.push({
      name: "cashflow_source_linkage",
      passed: orphanedCashflows.length === 0,
      expected: 0,
      actual: orphanedCashflows.length,
      message: orphanedCashflows.length === 0
        ? "All cashflows link to raw events"
        : `${orphanedCashflows.length} cashflows reference missing raw events`
    });

    // Check 3: No empty required files when raw events exist
    const hasRawEvents = (rawEvents?.length || 0) > 0;
    const hasCashflows = (cashflows?.length || 0) > 0;
    consistencyChecks.push({
      name: "data_completeness",
      passed: !hasRawEvents || hasCashflows,
      message: !hasRawEvents
        ? "No raw events in range (expected for new wallets)"
        : hasCashflows
          ? "Cashflows populated from raw events"
          : "WARNING: Raw events exist but no cashflows - reducer may need to run"
    });

    // Check 4: Resolved markets appear in market_pnl
    const resolvedLifecycle = (lifecycle || []).filter(l => l.state === "SETTLED" || l.is_claimed || l.is_lost);
    const marketPnlIds = new Set((marketPnl || []).map(m => m.market_id));
    const missingResolved = resolvedLifecycle.filter(l => !marketPnlIds.has(l.market_id));
    consistencyChecks.push({
      name: "resolved_markets_in_pnl",
      passed: missingResolved.length === 0,
      expected: 0,
      actual: missingResolved.length,
      message: missingResolved.length === 0
        ? "All resolved markets have PnL records"
        : `${missingResolved.length} resolved markets missing from market_pnl`
    });

    const allChecksPassed = consistencyChecks.every(c => c.passed);

    // ===== METADATA =====
    const metadata = {
      export_version: "1.0.0",
      generated_at: new Date().toISOString(),
      wallet_lowercase: walletLower,
      wallet_original: walletOriginal,
      date_range: {
        from: fromTs,
        to: toTs,
        timezone: "UTC"
      },
      row_counts: fileCounts,
      consistency_checks: consistencyChecks,
      all_checks_passed: allChecksPassed,
      endpoints: {
        supabase_url: supabaseUrl
      }
    };
    const metadataJson = JSON.stringify(metadata, null, 2);
    zip.file("METADATA.json", metadataJson);
    checksums["METADATA.json"] = await sha256(metadataJson);

    // ===== SCHEMA =====
    const schema = {
      version: "1.0.0",
      files: {
        "DATA/raw_subgraph_events.csv": {
          description: "All ingested subgraph events for wallet",
          columns: rawEventsCols.map(c => ({ name: c, type: "string/number", nullable: true }))
        },
        "DATA/cashflow_ledger.csv": {
          description: "Normalized signed USD cashflows",
          columns: cashflowCols.map(c => ({ name: c, type: "string/number", nullable: true }))
        },
        "DATA/market_lifecycle.csv": {
          description: "Market resolution and lifecycle state",
          columns: lifecycleCols.map(c => ({ name: c, type: "string/number/boolean", nullable: true }))
        },
        "DATA/market_pnl.csv": {
          description: "Per-market P&L summary",
          columns: marketPnlCols.map(c => ({ name: c, type: "string/number", nullable: true }))
        },
        "DATA/daily_pnl.csv": {
          description: "Daily P&L aggregates (UTC)",
          columns: dailyPnlCols.map(c => ({ name: c, type: "string/number", nullable: true }))
        },
        "DATA/execution_metrics.csv": {
          description: "Fill-level execution metrics (maker/taker, fees)",
          columns: execCols.map(c => ({ name: c, type: "string/number", nullable: true }))
        },
        "DATA/hedge_metrics.csv": {
          description: "Hedge intent logs (if strategy logs exist)",
          columns: hedgeCols.map(c => ({ name: c, type: "string/number", nullable: true }))
        },
        "DATA/positions_timeseries.csv": {
          description: "Position snapshots over time",
          columns: posCols.map(c => ({ name: c, type: "string/number", nullable: true }))
        },
        "DATA/pnl_snapshots.csv": {
          description: "Point-in-time P&L snapshots",
          columns: snapCols.map(c => ({ name: c, type: "string/number", nullable: true }))
        }
      }
    };
    const schemaJson = JSON.stringify(schema, null, 2);
    zip.file("SCHEMA.json", schemaJson);
    checksums["SCHEMA.json"] = await sha256(schemaJson);

    // ===== README =====
    const readme = `
================================================================================
POLYMARKET EXPORT DATASET
================================================================================

Wallet: ${walletOriginal}
Wallet (normalized): ${walletLower}
Date Range: ${fromTs} to ${toTs}
Timezone: UTC (all timestamps are in UTC)
Generated: ${new Date().toISOString()}

================================================================================
FILE STRUCTURE
================================================================================

/METADATA.json    - Export metadata, row counts, consistency check results
/SCHEMA.json      - Column definitions for all CSV files
/CHECKSUMS.sha256 - SHA-256 checksums for file integrity verification
/DATA/            - Canonical accounting data (CSV format)

================================================================================
DATA FILES
================================================================================

raw_subgraph_events.csv (${fileCounts.raw_subgraph_events} rows)
  All ingested blockchain events: buys, sells, redeems, transfers

cashflow_ledger.csv (${fileCounts.cashflow_ledger} rows)
  Normalized signed USD cashflows with event linkage

market_lifecycle.csv (${fileCounts.market_lifecycle} rows)
  Per-market state: OPEN, SETTLED, CLAIMED, LOST

market_pnl.csv (${fileCounts.market_pnl} rows)
  Per-market P&L with realized/unrealized breakdown

daily_pnl.csv (${fileCounts.daily_pnl} rows)
  Daily aggregated P&L (UTC day boundaries)

execution_metrics.csv (${fileCounts.execution_metrics} rows)
  Fill-level metrics: maker/taker, fees, prices

hedge_metrics.csv (${fileCounts.hedge_metrics} rows)
  Hedge intent logs for strategy analysis

positions_timeseries.csv (${fileCounts.positions_timeseries} rows)
  Position snapshots over time

pnl_snapshots.csv (${fileCounts.pnl_snapshots} rows)
  Point-in-time P&L snapshots

================================================================================
DEFINITIONS
================================================================================

REALIZED_PNL
  Profit/loss from settled positions = payout - cost

UNREALIZED_PNL
  Mark-to-market P&L for open positions

TOTAL_PNL
  realized_pnl + unrealized_pnl

ACCRUED_PAYOUT vs CLAIMED_PAYOUT
  - Accrued: economic payout based on resolution
  - Claimed: actual USDC received via redemption

LOST
  Market resolved against our position (winning side ≠ our side)
  Results in realized_pnl = -total_cost

FEE HANDLING
  - Known fees are tracked in fee_paid/fees_known_usd
  - fees_unknown_count indicates missing fee data

================================================================================
CONSISTENCY CHECKS
================================================================================

${consistencyChecks.map(c => `[${c.passed ? "PASS" : "WARN"}] ${c.name}: ${c.message}`).join("\n")}

All checks passed: ${allChecksPassed ? "YES" : "NO (see METADATA.json for details)"}

================================================================================
KNOWN LIMITATIONS
================================================================================

1. Hedge metrics only available if bot decision logs are enabled
2. Position snapshots are current state, not historical timeseries
3. Fee data may be incomplete for older trades
4. Raw JSONL pages not included in this export version

================================================================================
`;
    zip.file("README.txt", readme.trim());
    checksums["README.txt"] = await sha256(readme.trim());

    // ===== CHECKSUMS =====
    const checksumContent = Object.entries(checksums)
      .map(([file, hash]) => `${hash}  ${file}`)
      .join("\n");
    zip.file("CHECKSUMS.sha256", checksumContent);

    // Generate ZIP as Uint8Array - CRITICAL: use "uint8array" type directly
    // This avoids base64 encoding/decoding which can cause corruption
    const filename = `polymarket_export_${walletLower.slice(0, 8)}_${fromTs.split("T")[0]}_${toTs.split("T")[0]}_${Date.now()}.zip`;
    
    console.log(`[v26-export] Building ZIP file: ${filename}`);
    
    // Generate complete ZIP as Uint8Array
    const zipBuffer: Uint8Array = await zip.generateAsync({ 
      type: "uint8array",
      compression: "DEFLATE",
      compressionOptions: { level: 6 }
    });
    
    // Verify ZIP is valid before returning
    if (!zipBuffer || zipBuffer.length === 0) {
      throw new Error("ZIP generation failed: empty buffer");
    }
    
    // Basic ZIP header validation (PK\x03\x04 signature)
    if (zipBuffer[0] !== 0x50 || zipBuffer[1] !== 0x4B) {
      throw new Error("ZIP generation failed: invalid ZIP signature");
    }
    
    const zipSize = zipBuffer.length;
    console.log(`[v26-export] Generated ${filename} (${zipSize} bytes, valid ZIP signature)`);

    // Return with explicit Content-Length for reliable transport
    // Create a new ArrayBuffer from Uint8Array to ensure valid BodyInit type
    const responseBuffer = new ArrayBuffer(zipSize);
    new Uint8Array(responseBuffer).set(zipBuffer);
    
    return new Response(responseBuffer, {
      headers: {
        ...corsHeaders,
        "Content-Type": "application/zip",
        "Content-Length": String(zipSize),
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-cache, no-store, must-revalidate",
      },
    });
  } catch (error) {
    console.error("[v26-export] Error:", error);
    return new Response(JSON.stringify({ error: String(error) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
