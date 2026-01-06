import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface CsvTransaction {
  timestamp: string;
  marketId: string;
  asset: string;
  outcome: "UP" | "DOWN";
  side: "BUY" | "SELL";
  shares: number;
  price: number;
  total: number;
  rawRow: Record<string, string>;
}

interface BotFill {
  timestamp: string;
  ts: number;
  marketId: string;
  asset: string;
  outcome: "UP" | "DOWN";
  side: string;
  shares: number;
  price: number;
  orderId?: string;
}

interface CoverageResult {
  marketId: string;
  outcome: "UP" | "DOWN";
  csvTotalBuys: number;
  csvTotalSells: number;
  botReportedBuys: number;
  botReportedSells: number;
  coveragePct: number;
  status: "FULLY_COVERED" | "PARTIALLY_COVERED" | "NOT_COVERED";
  unexplainedTransactions: CsvTransaction[];
}

interface ReconcileReport {
  summary: {
    totalCsvTransactions: number;
    totalBotFills: number;
    fullyCoveredCount: number;
    partiallyCoveredCount: number;
    notCoveredCount: number;
    unexplainedCount: number;
    overallCoveragePct: number;
  };
  coverageByMarket: CoverageResult[];
  unmatchedBotFills: BotFill[];
  processingTimeMs: number;
}

// Parse Polymarket CSV (handles various formats)
function parseCsv(csvContent: string): CsvTransaction[] {
  const lines = csvContent.trim().split("\n");
  if (lines.length < 2) return [];

  const headers = lines[0].split(",").map((h) => h.trim().toLowerCase().replace(/"/g, ""));
  const transactions: CsvTransaction[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = parseCsvLine(lines[i]);
    if (values.length < headers.length) continue;

    const row: Record<string, string> = {};
    headers.forEach((h, idx) => {
      row[h] = values[idx]?.replace(/"/g, "").trim() || "";
    });

    // Try to extract transaction data
    const tx = extractTransaction(row);
    if (tx) transactions.push(tx);
  }

  return transactions;
}

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;

  for (const char of line) {
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      result.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  result.push(current);
  return result;
}

function extractTransaction(row: Record<string, string>): CsvTransaction | null {
  // Try different column name patterns
  const timestamp = row["timestamp"] || row["time"] || row["date"] || row["created_at"] || "";
  const market = row["market"] || row["market_id"] || row["marketid"] || row["slug"] || "";
  const outcome = row["outcome"] || row["side_name"] || "";
  const side = row["side"] || row["type"] || row["action"] || "";
  const shares = parseFloat(row["shares"] || row["amount"] || row["quantity"] || "0");
  const price = parseFloat(row["price"] || row["avg_price"] || "0");
  const total = parseFloat(row["total"] || row["cost"] || "0") || shares * price;

  if (!market || shares <= 0) return null;

  // Normalize outcome to UP/DOWN
  let normalizedOutcome: "UP" | "DOWN" = "UP";
  const outcomeLower = outcome.toLowerCase();
  if (outcomeLower.includes("down") || outcomeLower.includes("no") || outcomeLower === "down") {
    normalizedOutcome = "DOWN";
  } else if (outcomeLower.includes("up") || outcomeLower.includes("yes") || outcomeLower === "up") {
    normalizedOutcome = "UP";
  }

  // Normalize side to BUY/SELL
  let normalizedSide: "BUY" | "SELL" = "BUY";
  const sideLower = side.toLowerCase();
  if (sideLower.includes("sell") || sideLower === "sell") {
    normalizedSide = "SELL";
  }

  // Extract asset from market name
  let asset = "UNKNOWN";
  const marketLower = market.toLowerCase();
  if (marketLower.includes("btc") || marketLower.includes("bitcoin")) asset = "BTC";
  else if (marketLower.includes("eth") || marketLower.includes("ethereum")) asset = "ETH";
  else if (marketLower.includes("sol") || marketLower.includes("solana")) asset = "SOL";
  else if (marketLower.includes("xrp") || marketLower.includes("ripple")) asset = "XRP";

  // Normalize market ID
  const marketId = normalizeMarketId(market, timestamp, asset);

  return {
    timestamp,
    marketId,
    asset,
    outcome: normalizedOutcome,
    side: normalizedSide,
    shares: Math.round(shares),
    price,
    total,
    rawRow: row,
  };
}

function normalizeMarketId(market: string, timestamp: string, asset: string): string {
  // Try to extract epoch from market name or timestamp
  const epochMatch = market.match(/(\d{10,13})/);
  if (epochMatch) {
    const epoch = epochMatch[1].length === 13 
      ? Math.floor(parseInt(epochMatch[1]) / 1000) 
      : parseInt(epochMatch[1]);
    // Round to 15-minute boundary
    const rounded = Math.floor(epoch / 900) * 900;
    return `${asset.toLowerCase()}-updown-15m-${rounded}`;
  }

  // Try to use timestamp
  if (timestamp) {
    try {
      const date = new Date(timestamp);
      const epoch = Math.floor(date.getTime() / 1000);
      const rounded = Math.floor(epoch / 900) * 900;
      return `${asset.toLowerCase()}-updown-15m-${rounded}`;
    } catch {
      // ignore
    }
  }

  // Fallback: use market as-is
  return market.toLowerCase().replace(/\s+/g, "-");
}

// Parse bot fill logs from ZIP
async function parseBotFills(zipArrayBuffer: ArrayBuffer): Promise<BotFill[]> {
  const fills: BotFill[] = [];
  
  try {
    // Simple ZIP parsing - look for fill_logs.json or similar files
    const textDecoder = new TextDecoder();
    const content = textDecoder.decode(zipArrayBuffer);
    
    // Try to find JSON content in the ZIP
    // This is a simplified approach - real ZIP parsing would need a library
    const jsonMatches = content.match(/\[\s*\{[^[\]]*"fill"[^[\]]*\}\s*\]/g) ||
                        content.match(/\[\s*\{[^[\]]*"ts"[^[\]]*"market"[^[\]]*\}\s*\]/g);
    
    if (jsonMatches) {
      for (const match of jsonMatches) {
        try {
          const parsed = JSON.parse(match);
          if (Array.isArray(parsed)) {
            for (const item of parsed) {
              const fill = extractBotFill(item);
              if (fill) fills.push(fill);
            }
          }
        } catch {
          // ignore parse errors
        }
      }
    }

    // Also try to find fill_logs entries in text format
    const logLines = content.split("\n");
    for (const line of logLines) {
      if (line.includes("FILL") || line.includes("fill_qty")) {
        try {
          const jsonStart = line.indexOf("{");
          const jsonEnd = line.lastIndexOf("}");
          if (jsonStart !== -1 && jsonEnd !== -1) {
            const json = JSON.parse(line.substring(jsonStart, jsonEnd + 1));
            const fill = extractBotFill(json);
            if (fill) fills.push(fill);
          }
        } catch {
          // ignore
        }
      }
    }
  } catch (error) {
    console.error("[reconcile-fills] Error parsing ZIP:", error);
  }

  return fills;
}

function extractBotFill(item: Record<string, unknown>): BotFill | null {
  const ts = item.ts as number || item.timestamp as number || 0;
  const marketId = (item.market_id || item.marketId || item.market || "") as string;
  const asset = (item.asset || "") as string;
  const side = (item.side || "") as string;
  const shares = parseFloat(String(item.fill_qty || item.shares || item.quantity || 0));
  const price = parseFloat(String(item.fill_price || item.price || 0));
  const intent = (item.intent || "") as string;

  if (!marketId || shares <= 0) return null;

  // Determine outcome from intent or side
  let outcome: "UP" | "DOWN" = "UP";
  const intentLower = intent.toLowerCase();
  const sideLower = side.toLowerCase();
  
  if (intentLower.includes("down") || sideLower.includes("down")) {
    outcome = "DOWN";
  } else if (intentLower.includes("up") || sideLower.includes("up")) {
    outcome = "UP";
  }

  return {
    timestamp: ts ? new Date(ts).toISOString() : "",
    ts,
    marketId: normalizeMarketId(marketId, "", asset.toUpperCase()),
    asset: asset.toUpperCase(),
    outcome,
    side,
    shares: Math.round(shares),
    price,
    orderId: item.order_id as string | undefined,
  };
}

// Main reconciliation logic
function reconcile(csvTransactions: CsvTransaction[], botFills: BotFill[]): ReconcileReport {
  const startTime = Date.now();

  // Group CSV transactions by marketId + outcome
  const csvByMarket = new Map<string, CsvTransaction[]>();
  for (const tx of csvTransactions) {
    const key = `${tx.marketId}:${tx.outcome}`;
    if (!csvByMarket.has(key)) csvByMarket.set(key, []);
    csvByMarket.get(key)!.push(tx);
  }

  // Group bot fills by marketId + outcome
  const botByMarket = new Map<string, BotFill[]>();
  for (const fill of botFills) {
    const key = `${fill.marketId}:${fill.outcome}`;
    if (!botByMarket.has(key)) botByMarket.set(key, []);
    botByMarket.get(key)!.push(fill);
  }

  // Get all unique market+outcome combinations
  const allKeys = new Set([...csvByMarket.keys(), ...botByMarket.keys()]);
  
  const coverageResults: CoverageResult[] = [];
  const unmatchedBotFills: BotFill[] = [];
  let fullyCoveredCount = 0;
  let partiallyCoveredCount = 0;
  let notCoveredCount = 0;
  let totalUnexplained = 0;

  for (const key of allKeys) {
    const [marketId, outcome] = key.split(":");
    const csvTxs = csvByMarket.get(key) || [];
    const botFillsForMarket = botByMarket.get(key) || [];

    // Calculate totals
    const csvBuys = csvTxs.filter((tx) => tx.side === "BUY").reduce((sum, tx) => sum + tx.shares, 0);
    const csvSells = csvTxs.filter((tx) => tx.side === "SELL").reduce((sum, tx) => sum + tx.shares, 0);
    const botBuys = botFillsForMarket.filter((f) => f.side.toLowerCase().includes("buy")).reduce((sum, f) => sum + f.shares, 0);
    const botSells = botFillsForMarket.filter((f) => f.side.toLowerCase().includes("sell")).reduce((sum, f) => sum + f.shares, 0);

    const csvTotal = csvBuys + csvSells;
    const botTotal = botBuys + botSells;

    // Calculate coverage
    let coveragePct = 0;
    let status: "FULLY_COVERED" | "PARTIALLY_COVERED" | "NOT_COVERED" = "NOT_COVERED";

    if (csvTotal > 0) {
      coveragePct = Math.min(100, (botTotal / csvTotal) * 100);
      if (coveragePct >= 95) {
        status = "FULLY_COVERED";
        fullyCoveredCount++;
      } else if (coveragePct > 0) {
        status = "PARTIALLY_COVERED";
        partiallyCoveredCount++;
      } else {
        notCoveredCount++;
      }
    } else if (botTotal > 0) {
      // Bot has fills but no CSV transactions - these are unmatched
      unmatchedBotFills.push(...botFillsForMarket);
      continue;
    }

    // Find unexplained transactions (in CSV but not matched by bot)
    const unexplained = csvTxs.filter((tx) => {
      // Check if there's a bot fill within 60s
      return !botFillsForMarket.some((fill) => {
        if (!tx.timestamp || !fill.timestamp) return false;
        const txTime = new Date(tx.timestamp).getTime();
        const fillTime = new Date(fill.timestamp).getTime();
        return Math.abs(txTime - fillTime) < 60000 && tx.shares === fill.shares;
      });
    });

    totalUnexplained += unexplained.length;

    coverageResults.push({
      marketId,
      outcome: outcome as "UP" | "DOWN",
      csvTotalBuys: csvBuys,
      csvTotalSells: csvSells,
      botReportedBuys: botBuys,
      botReportedSells: botSells,
      coveragePct: Math.round(coveragePct * 100) / 100,
      status,
      unexplainedTransactions: unexplained,
    });
  }

  // Calculate overall coverage
  const totalCsvShares = csvTransactions.reduce((sum, tx) => sum + tx.shares, 0);
  const totalBotShares = botFills.reduce((sum, f) => sum + f.shares, 0);
  const overallCoveragePct = totalCsvShares > 0 
    ? Math.round((totalBotShares / totalCsvShares) * 10000) / 100 
    : 0;

  return {
    summary: {
      totalCsvTransactions: csvTransactions.length,
      totalBotFills: botFills.length,
      fullyCoveredCount,
      partiallyCoveredCount,
      notCoveredCount,
      unexplainedCount: totalUnexplained,
      overallCoveragePct,
    },
    coverageByMarket: coverageResults.sort((a, b) => a.coveragePct - b.coveragePct),
    unmatchedBotFills,
    processingTimeMs: Date.now() - startTime,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    const formData = await req.formData();
    const csvFile = formData.get("csv") as File | null;
    const zipFile = formData.get("zip") as File | null;

    if (!csvFile) {
      return new Response(
        JSON.stringify({ error: "CSV file is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`[reconcile-fills] Processing CSV: ${csvFile.name}, ZIP: ${zipFile?.name || "none"}`);

    // Create pending report
    const { data: report, error: insertError } = await supabase
      .from("reconcile_reports")
      .insert({
        csv_filename: csvFile.name,
        zip_filename: zipFile?.name || null,
        status: "processing",
      })
      .select()
      .single();

    if (insertError || !report) {
      console.error("[reconcile-fills] Insert error:", insertError);
      throw new Error("Failed to create report record");
    }

    const reportId = report.id;

    try {
      // Upload files to storage
      const csvBuffer = await csvFile.arrayBuffer();
      const csvPath = `${reportId}/csv/${csvFile.name}`;
      await supabase.storage.from("reconcile-files").upload(csvPath, csvBuffer, {
        contentType: "text/csv",
      });

      let zipPath: string | null = null;
      let zipBuffer: ArrayBuffer | null = null;
      if (zipFile) {
        zipBuffer = await zipFile.arrayBuffer();
        zipPath = `${reportId}/zip/${zipFile.name}`;
        await supabase.storage.from("reconcile-files").upload(zipPath, zipBuffer, {
          contentType: "application/zip",
        });
      }

      // Parse files
      const csvContent = new TextDecoder().decode(csvBuffer);
      const csvTransactions = parseCsv(csvContent);
      console.log(`[reconcile-fills] Parsed ${csvTransactions.length} CSV transactions`);

      let botFills: BotFill[] = [];
      if (zipBuffer) {
        botFills = await parseBotFills(zipBuffer);
        console.log(`[reconcile-fills] Parsed ${botFills.length} bot fills from ZIP`);
      }

      // If no ZIP provided, try to get fills from database
      if (botFills.length === 0) {
        console.log("[reconcile-fills] No ZIP fills, querying fill_logs from database...");
        const { data: dbFills } = await supabase
          .from("fill_logs")
          .select("*")
          .order("ts", { ascending: false })
          .limit(5000);

        if (dbFills) {
          botFills = dbFills.map((f) => ({
            timestamp: f.iso || new Date(f.ts).toISOString(),
            ts: f.ts,
            marketId: f.market_id,
            asset: f.asset,
            outcome: f.side?.toUpperCase().includes("UP") ? "UP" as const : "DOWN" as const,
            side: f.side,
            shares: f.fill_qty,
            price: f.fill_price,
            orderId: f.order_id || undefined,
          }));
          console.log(`[reconcile-fills] Got ${botFills.length} fills from database`);
        }
      }

      // Run reconciliation
      const reconcileResult = reconcile(csvTransactions, botFills);
      console.log(`[reconcile-fills] Reconciliation complete in ${reconcileResult.processingTimeMs}ms`);

      // Update report with results
      const { error: updateError } = await supabase
        .from("reconcile_reports")
        .update({
          csv_storage_path: csvPath,
          zip_storage_path: zipPath,
          total_csv_transactions: reconcileResult.summary.totalCsvTransactions,
          total_bot_fills: reconcileResult.summary.totalBotFills,
          fully_covered_count: reconcileResult.summary.fullyCoveredCount,
          partially_covered_count: reconcileResult.summary.partiallyCoveredCount,
          not_covered_count: reconcileResult.summary.notCoveredCount,
          unexplained_count: reconcileResult.summary.unexplainedCount,
          coverage_pct: reconcileResult.summary.overallCoveragePct,
          status: "completed",
          report_data: reconcileResult as unknown as Record<string, unknown>,
          processed_at: new Date().toISOString(),
          processing_time_ms: reconcileResult.processingTimeMs,
        })
        .eq("id", reportId);

      if (updateError) {
        console.error("[reconcile-fills] Update error:", updateError);
      }

      return new Response(
        JSON.stringify({
          success: true,
          reportId,
          summary: reconcileResult.summary,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );

    } catch (processingError) {
      console.error("[reconcile-fills] Processing error:", processingError);
      
      await supabase
        .from("reconcile_reports")
        .update({
          status: "failed",
          error_message: String(processingError),
        })
        .eq("id", reportId);

      throw processingError;
    }

  } catch (error) {
    console.error("[reconcile-fills] Error:", error);
    return new Response(
      JSON.stringify({ error: String(error) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
