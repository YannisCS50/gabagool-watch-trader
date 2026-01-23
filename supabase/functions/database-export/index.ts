import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
// @deno-types="https://esm.sh/jszip@3.10.1"
import JSZip from "https://esm.sh/jszip@3.10.1";

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

function generateReadme(manifest: Record<string, { rows: number; description: string; category: string; pages?: number; error?: string }>) {
  let readme = `# PolyTracker Database Export\n\n`;
  readme += `**Exported at:** ${new Date().toISOString()}\n\n`;
  readme += `## Contents\n\n`;

  const byCategory: Record<string, string[]> = {};
  Object.entries(manifest).forEach(([table, info]) => {
    if (!byCategory[info.category]) byCategory[info.category] = [];
    byCategory[info.category].push(`- **${table}** (${info.rows} rows): ${info.description}`);
  });

  Object.entries(byCategory).forEach(([category, tables]) => {
    readme += `### ${category}\n\n`;
    tables.forEach((t) => {
      readme += `${t}\n`;
    });
    readme += `\n`;
  });

  readme += `## Data Dictionary\n\n`;
  readme += `### Key Tables\n\n`;
  readme += `#### v29_signals_response\n`;
  readme += `De **primaire tabel** voor trade analyse. Elke rij is één trade poging.\n\n`;
  readme += `| Column | Description |\n`;
  readme += `|--------|-------------|\n`;
  readme += `| id | Unieke signal ID |\n`;
  readme += `| asset | BTC of ETH |\n`;
  readme += `| direction | UP of DOWN |\n`;
  readme += `| entry_price | Entry prijs in cents |\n`;
  readme += `| exit_price | Exit prijs in cents |\n`;
  readme += `| net_pnl | Netto PnL in USD |\n`;
  readme += `| exit_reason | profit/adverse/timeout/stoploss |\n`;
  readme += `| spread_t0 | Spread bij entry |\n`;
  readme += `| binance_delta | Binance prijs vs strike |\n\n`;

  readme += `#### daily_pnl\n`;
  readme += `Dagelijkse PnL samenvatting.\n\n`;
  readme += `| Column | Description |\n`;
  readme += `|--------|-------------|\n`;
  readme += `| date | Datum |\n`;
  readme += `| realized_pnl | Gerealiseerde winst/verlies |\n`;
  readme += `| unrealized_pnl | Ongerealiseerde winst/verlies |\n`;
  readme += `| volume_traded | Totaal verhandeld volume |\n\n`;

  readme += `## Notes\n\n`;
  readme += `- Alle timestamps zijn in UTC\n`;
  readme += `- Prijzen zijn in cents (0.50 = $0.50)\n`;
  readme += `- PnL is in USD\n`;
  readme += `- Server-side export via Edge Function\n`;

  return readme;
}

async function fetchTableData(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  tableName: string,
  pageSize: number = 1000,
  maxRows: number = 50_000_000
): Promise<{ data: unknown[][]; error: string | null; totalRows: number }> {
  const allPages: unknown[][] = [];
  let page = 0;
  const maxPages = Math.ceil(maxRows / pageSize);
  let hasMore = true;
  let totalRows = 0;

  while (hasMore && page < maxPages) {
    try {
      const { data, error } = await supabase
        .from(tableName)
        .select("*")
        .range(page * pageSize, (page + 1) * pageSize - 1);

      if (error) {
        const errMsg = error.message || error.details || error.hint || JSON.stringify(error);
        return { data: allPages, error: errMsg, totalRows };
      }

      if (data && data.length > 0) {
        allPages.push(data);
        totalRows += data.length;
        hasMore = data.length === pageSize;
        page++;
      } else {
        hasMore = false;
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return { data: allPages, error: errMsg, totalRows };
    }
  }

  return { data: allPages, error: null, totalRows };
}

Deno.serve(async (req) => {
  // Handle CORS preflight
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

    // Use service role for direct DB access (no RLS overhead)
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

    console.log(`[database-export] Starting export of ${tables.length} tables`);

    const zip = new JSZip();
    const manifest: Record<string, { rows: number; description: string; category: string; pages?: number; error?: string }> = {};
    const errors: string[] = [];

    // Fetch tables in parallel (batches of 5 for memory safety)
    const batchSize = 5;
    for (let i = 0; i < tables.length; i += batchSize) {
      const batch = tables.slice(i, i + batchSize);
      
      const results = await Promise.all(
        batch.map(async (tableName) => {
          const startTime = Date.now();
          console.log(`[database-export] Fetching ${tableName}...`);
          
          const meta = tableMeta[tableName] || { category: "misc", description: "" };
          const result = await fetchTableData(supabase, tableName);
          
          const duration = Date.now() - startTime;
          console.log(`[database-export] ${tableName}: ${result.totalRows} rows in ${duration}ms${result.error ? ` (error: ${result.error})` : ""}`);
          
          return { tableName, meta, result };
        })
      );

      // Add to ZIP
      for (const { tableName, meta, result } of results) {
        const folderName = (meta.category || "misc").replace(/[^a-zA-Z0-9]/g, "_");
        const basePath = `${folderName}/${tableName}`;

        // Write each page as a separate JSON file
        for (let pageIdx = 0; pageIdx < result.data.length; pageIdx++) {
          const fileName = `${basePath}/page-${String(pageIdx).padStart(5, "0")}.json`;
          zip.file(fileName, JSON.stringify(result.data[pageIdx]));
        }

        if (result.error) {
          errors.push(tableName);
          manifest[tableName] = {
            rows: result.totalRows,
            description: meta.description,
            category: meta.category,
            pages: result.data.length,
            error: result.error,
          };
        } else {
          manifest[tableName] = {
            rows: result.totalRows,
            description: meta.description,
            category: meta.category,
            pages: result.data.length,
          };
        }
      }
    }

    // Add manifest and README
    zip.file(
      "_MANIFEST.json",
      JSON.stringify(
        {
          exported_at: new Date().toISOString(),
          export_method: "edge-function",
          total_tables: tables.length,
          successful: tables.length - errors.length,
          failed: errors,
          tables: manifest,
        },
        null,
        2
      )
    );

    zip.file("README.md", generateReadme(manifest));

    console.log(`[database-export] Generating ZIP...`);
    const zipBlob = await zip.generateAsync({
      type: "arraybuffer",
      streamFiles: true,
      compression: "STORE", // No compression for speed
    }) as ArrayBuffer;

    const totalRows = Object.values(manifest).reduce((sum, t) => sum + t.rows, 0);
    console.log(`[database-export] Complete: ${tables.length} tables, ${totalRows} total rows, ${(zipBlob.byteLength / 1024 / 1024).toFixed(2)} MB`);

    return new Response(zipBlob, {
      headers: {
        ...corsHeaders,
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="polytracker-export-${new Date().toISOString().slice(0, 10)}.zip"`,
        "X-Export-Tables": String(tables.length),
        "X-Export-Rows": String(totalRows),
        "X-Export-Errors": String(errors.length),
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
