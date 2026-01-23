import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Gabagool preset tables
const GABAGOOL_TABLES = [
  "trades", "positions", "position_snapshots",
  "price_ticks", "chainlink_prices",
  "v29_ticks_response", "v29_ticks",
  "market_history", "market_lifecycle", "strike_prices",
  "v29_signals_response", "v29_signals",
  "fill_logs", "live_trades", "live_trade_results",
  "raw_subgraph_events", "cashflow_ledger", "subgraph_fills",
  "bot_positions", "canonical_positions",
  "signal_quality_analysis", "bucket_statistics", "gabagool_metrics",
  "tracked_wallet_trades",
];

const DEFAULT_META: Record<string, { category: string; description: string }> = {
  trades: { category: "Gabagool", description: "All trades" },
  positions: { category: "Gabagool", description: "Positions" },
  position_snapshots: { category: "Gabagool", description: "Position snapshots" },
  price_ticks: { category: "Prices", description: "Price ticks" },
  chainlink_prices: { category: "Prices", description: "Chainlink prices" },
  v29_ticks_response: { category: "V29", description: "V29R ticks" },
  v29_ticks: { category: "V29", description: "V29 ticks" },
  market_history: { category: "Markets", description: "Market history" },
  market_lifecycle: { category: "Markets", description: "Market lifecycle" },
  strike_prices: { category: "Markets", description: "Strike prices" },
  v29_signals_response: { category: "V29", description: "V29R signals" },
  v29_signals: { category: "V29", description: "V29 signals" },
  fill_logs: { category: "Trades", description: "Fill logs" },
  live_trades: { category: "Trades", description: "Live trades" },
  live_trade_results: { category: "Trades", description: "Trade results" },
  raw_subgraph_events: { category: "Onchain", description: "Subgraph events" },
  cashflow_ledger: { category: "Onchain", description: "Cashflow ledger" },
  subgraph_fills: { category: "Onchain", description: "Subgraph fills" },
  bot_positions: { category: "Positions", description: "Bot positions" },
  canonical_positions: { category: "Positions", description: "Canonical positions" },
  signal_quality_analysis: { category: "Analysis", description: "Signal quality" },
  bucket_statistics: { category: "Analysis", description: "Bucket stats" },
  gabagool_metrics: { category: "Analysis", description: "Gabagool metrics" },
  tracked_wallet_trades: { category: "Gabagool", description: "Tracked wallet trades" },
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    if (!supabaseUrl || !serviceRoleKey) {
      return new Response(
        JSON.stringify({ error: "Missing Supabase configuration" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const url = new URL(req.url);
    const preset = url.searchParams.get("preset");
    const singleTable = url.searchParams.get("table");
    const useGzip = req.headers.get("accept-encoding")?.includes("gzip") ?? false;

    let tables: string[];
    let tableMeta: Record<string, { category: string; description: string }>;

    // Single table mode
    if (singleTable) {
      tables = [singleTable];
      tableMeta = { [singleTable]: DEFAULT_META[singleTable] || { category: "misc", description: "" } };
      console.log(`[database-export] Single table mode: ${singleTable}`);
    } else if (req.method === "GET" && preset === "gabagool") {
      tables = GABAGOOL_TABLES;
      tableMeta = DEFAULT_META;
      console.log(`[database-export] GET preset=gabagool, ${tables.length} tables`);
    } else if (req.method === "POST") {
      const body = await req.json();
      tables = body.tables || [];
      tableMeta = body.tableMeta || DEFAULT_META;
    } else {
      // Return list of available tables for easy discovery
      return new Response(
        JSON.stringify({ 
          available_tables: GABAGOOL_TABLES,
          usage: {
            all_tables: "GET ?preset=gabagool",
            single_table: "GET ?table=trades",
            custom: "POST with {tables: [...], tableMeta: {...}}"
          }
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!tables || tables.length === 0) {
      return new Response(
        JSON.stringify({ error: "No tables specified" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`[database-export] Starting NDJSON export of ${tables.length} tables, gzip=${useGzip}`);

    const encoder = new TextEncoder();
    
    const dataStream = new ReadableStream({
      async start(controller) {
        controller.enqueue(encoder.encode(JSON.stringify({ 
          type: "header", 
          exported_at: new Date().toISOString(),
          tables: tables.length 
        }) + "\n"));

        const manifest: Record<string, { rows: number; category: string; description: string; error?: string }> = {};

        for (const tableName of tables) {
          const meta = tableMeta[tableName] || { category: "misc", description: "" };
          let totalRows = 0;
          let hasError = false;
          let errorMsg = "";

          try {
            console.log(`[database-export] Streaming ${tableName}...`);
            
            const pageSize = 500;
            let page = 0;
            let hasMore = true;

            while (hasMore) {
              const { data, error } = await supabase
                .from(tableName)
                .select("*")
                .range(page * pageSize, (page + 1) * pageSize - 1);

              if (error) {
                hasError = true;
                errorMsg = error.message || error.details || String(error);
                console.error(`[database-export] Error on ${tableName}: ${errorMsg}`);
                break;
              }

              if (data && data.length > 0) {
                for (const row of data) {
                  controller.enqueue(encoder.encode(JSON.stringify({
                    type: "row",
                    table: tableName,
                    category: meta.category,
                    data: row
                  }) + "\n"));
                  totalRows++;
                }
                hasMore = data.length === pageSize;
                page++;
              } else {
                hasMore = false;
              }
            }

            console.log(`[database-export] ${tableName}: ${totalRows} rows streamed`);
          } catch (err) {
            hasError = true;
            errorMsg = err instanceof Error ? err.message : String(err);
            console.error(`[database-export] Exception on ${tableName}: ${errorMsg}`);
          }

          manifest[tableName] = {
            rows: totalRows,
            category: meta.category,
            description: meta.description,
            ...(hasError && { error: errorMsg })
          };

          controller.enqueue(encoder.encode(JSON.stringify({
            type: "table_complete",
            table: tableName,
            rows: totalRows,
            error: hasError ? errorMsg : null
          }) + "\n"));
        }

        controller.enqueue(encoder.encode(JSON.stringify({
          type: "footer",
          manifest,
          total_rows: Object.values(manifest).reduce((sum, t) => sum + t.rows, 0)
        }) + "\n"));

        controller.close();
      }
    });

    // Apply gzip compression if supported
    const outputStream = useGzip 
      ? dataStream.pipeThrough(new CompressionStream("gzip"))
      : dataStream;

    const filename = singleTable 
      ? `${singleTable}-${new Date().toISOString().slice(0, 10)}.ndjson${useGzip ? '.gz' : ''}`
      : `polytracker-export-${new Date().toISOString().slice(0, 10)}.ndjson${useGzip ? '.gz' : ''}`;

    return new Response(outputStream, {
      headers: {
        ...corsHeaders,
        "Content-Type": useGzip ? "application/gzip" : "application/x-ndjson",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Transfer-Encoding": "chunked",
        ...(useGzip && { "Content-Encoding": "gzip" }),
      },
    });
  } catch (err) {
    console.error("[database-export] Error:", err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
