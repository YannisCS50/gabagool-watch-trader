/// <reference lib="webworker" />

import JSZip from "jszip";
import { createClient } from "@supabase/supabase-js";

type TableMeta = { category: string; description: string };

type StartMessage = {
  type: "start";
  tables: string[];
  tableMeta: Record<string, TableMeta>;
  fileName: string;
  accessToken: string | null;
};

type WorkerMessage =
  | { type: "table-start"; tableName: string; tableIndex: number; totalTables: number }
  | { type: "table-progress"; tableName: string; rows: number; page: number }
  | { type: "table-done"; tableName: string; rows: number; pages: number; tableIndex: number; totalTables: number }
  | { type: "done"; blob: Blob; fileName: string; errors: string[] }
  | { type: "error"; message: string; tableName?: string };

const ctx: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;

function generateReadme(manifest: Record<string, { rows: number; description: string; category: string }>) {
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
  readme += `- Sommige tabellen hebben overlappende data (bijv. v29_signals en v29_signals_response)\n`;

  return readme;
}

ctx.onmessage = async (event: MessageEvent<StartMessage>) => {
  const msg = event.data;
  if (msg?.type !== "start") return;

  try {
    const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
    const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;
    if (!url || !key) {
      const out: WorkerMessage = { type: "error", message: "Backend configuratie ontbreekt (URL/key)." };
      ctx.postMessage(out);
      return;
    }

    const supabase = createClient(url, key, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      global: msg.accessToken
        ? {
            headers: {
              Authorization: `Bearer ${msg.accessToken}`,
            },
          }
        : undefined,
    });

    const zip = new JSZip();
    const manifest: Record<string, { rows: number; description: string; category: string; pages?: number; error?: string }> = {};
    const errors: string[] = [];

    // Safety: keep it high enough to be "effectively all" for typical tables, but still prevents infinite loops.
    const MAX_ROWS_PER_TABLE = 50_000_000;
    const pageSize = 1000;
    const maxPages = Math.ceil(MAX_ROWS_PER_TABLE / pageSize);

    for (let i = 0; i < msg.tables.length; i++) {
      const tableName = msg.tables[i];
      ctx.postMessage({ type: "table-start", tableName, tableIndex: i, totalTables: msg.tables.length } satisfies WorkerMessage);

      const meta = msg.tableMeta[tableName];
      const folderName = (meta?.category || "misc").replace(/[^a-zA-Z0-9]/g, "_");
      const basePath = `${folderName}/${tableName}`;

      let totalRows = 0;
      let page = 0;
      let hasMore = true;

      try {
        while (hasMore && page < maxPages) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const { data, error } = await (supabase as any)
            .from(tableName)
            .select("*")
            .range(page * pageSize, (page + 1) * pageSize - 1);

          if (error) throw error;

          if (data && data.length > 0) {
            const fileName = `${basePath}/page-${String(page).padStart(5, "0")}.json`;
            zip.file(fileName, JSON.stringify(data));

            totalRows += data.length;
            hasMore = data.length === pageSize;
            page++;

            if (page % 50 === 0) {
              ctx.postMessage({ type: "table-progress", tableName, rows: totalRows, page } satisfies WorkerMessage);
            }
          } else {
            hasMore = false;
          }
        }

        if (page >= maxPages) {
          // Mark as warning in manifest; still return what we have.
          manifest[tableName] = {
            rows: totalRows,
            description: meta?.description || "",
            category: meta?.category || "misc",
            pages: page,
            error: `Hit safety limit of ${MAX_ROWS_PER_TABLE.toLocaleString()} rows`,
          };
          errors.push(tableName);
        } else {
          manifest[tableName] = {
            rows: totalRows,
            description: meta?.description || "",
            category: meta?.category || "misc",
            pages: page,
          };
        }

        ctx.postMessage(
          { type: "table-done", tableName, rows: totalRows, pages: page, tableIndex: i, totalTables: msg.tables.length } satisfies WorkerMessage,
        );
      } catch (err) {
        errors.push(tableName);
        manifest[tableName] = {
          rows: 0,
          description: meta?.description || "",
          category: meta?.category || "misc",
          error: err instanceof Error ? err.message : String(err),
        };
        ctx.postMessage({ type: "error", message: err instanceof Error ? err.message : String(err), tableName } satisfies WorkerMessage);
      }
    }

    zip.file(
      "_MANIFEST.json",
      JSON.stringify(
        {
          exported_at: new Date().toISOString(),
          total_tables: msg.tables.length,
          successful: msg.tables.length - errors.length,
          failed: errors,
          tables: manifest,
        },
        null,
        2,
      ),
    );

    zip.file("README.md", generateReadme(manifest));

    const blob = await zip.generateAsync({
      type: "blob",
      streamFiles: true,
      compression: "STORE",
    });

    ctx.postMessage({ type: "done", blob, fileName: msg.fileName, errors } satisfies WorkerMessage);
  } catch (err) {
    ctx.postMessage({ type: "error", message: err instanceof Error ? err.message : String(err) } satisfies WorkerMessage);
  }
};
