import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface TableMeta {
  category: string;
  description: string;
}

interface ExportRequest {
  tables: string[];
  tableMeta: Record<string, TableMeta>;
}

// Simple NDJSON streaming export - no ZIP, no memory issues
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

    const body: ExportRequest = await req.json();
    const { tables, tableMeta } = body;

    if (!tables || tables.length === 0) {
      return new Response(
        JSON.stringify({ error: "No tables specified" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`[database-export] Starting NDJSON export of ${tables.length} tables`);

    // Stream response - each line is a JSON object
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const manifest: Record<string, { rows: number; category: string; description: string; error?: string }> = {};
        
        // Write header
        controller.enqueue(encoder.encode(JSON.stringify({ 
          type: "header", 
          exported_at: new Date().toISOString(),
          tables: tables.length 
        }) + "\n"));

        // Process tables sequentially to minimize memory
        for (const tableName of tables) {
          const meta = tableMeta[tableName] || { category: "misc", description: "" };
          let totalRows = 0;
          let hasError = false;
          let errorMsg = "";

          try {
            console.log(`[database-export] Streaming ${tableName}...`);
            
            // Fetch in pages and stream immediately
            const pageSize = 500; // Smaller pages for memory efficiency
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
                // Stream each row immediately
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

          // Send table completion marker
          controller.enqueue(encoder.encode(JSON.stringify({
            type: "table_complete",
            table: tableName,
            rows: totalRows,
            error: hasError ? errorMsg : null
          }) + "\n"));
        }

        // Write footer with manifest
        controller.enqueue(encoder.encode(JSON.stringify({
          type: "footer",
          manifest,
          total_rows: Object.values(manifest).reduce((sum, t) => sum + t.rows, 0)
        }) + "\n"));

        controller.close();
      }
    });

    return new Response(stream, {
      headers: {
        ...corsHeaders,
        "Content-Type": "application/x-ndjson",
        "Content-Disposition": `attachment; filename="polytracker-export-${new Date().toISOString().slice(0, 10)}.ndjson"`,
        "Transfer-Encoding": "chunked",
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
