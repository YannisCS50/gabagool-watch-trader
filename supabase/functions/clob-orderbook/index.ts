import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

type Level = { price: number; size: number };

function parseLevels(raw: any, depth: number): Level[] {
  if (!Array.isArray(raw)) return [];
  const out: Level[] = [];

  for (const lvl of raw) {
    // Polymarket book endpoint returns: { price: "0.52", size: "123" }
    if (lvl && typeof lvl === "object" && "price" in lvl && "size" in lvl) {
      const price = parseFloat(String((lvl as any).price));
      const size = parseFloat(String((lvl as any).size));
      if (!Number.isFinite(price) || !Number.isFinite(size)) continue;
      if (price <= 0 || size <= 0) continue;
      out.push({ price, size });
      if (out.length >= depth) break;
      continue;
    }

    // Defensive: [[price, size], ...]
    if (Array.isArray(lvl) && lvl.length >= 2) {
      const price = parseFloat(String(lvl[0]));
      const size = parseFloat(String(lvl[1]));
      if (!Number.isFinite(price) || !Number.isFinite(size)) continue;
      if (price <= 0 || size <= 0) continue;
      out.push({ price, size });
      if (out.length >= depth) break;
    }
  }

  return out;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const startedAt = Date.now();

  try {
    const body = await req.json().catch(() => ({}));
    const tokenId = String(body?.tokenId ?? "").trim();
    const depth = Math.max(1, Math.min(50, Number(body?.depth ?? 15)));

    if (!tokenId) {
      return new Response(
        JSON.stringify({ success: false, error: "tokenId is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const res = await fetch(`https://clob.polymarket.com/book?token_id=${encodeURIComponent(tokenId)}`, {
      headers: { Accept: "application/json" },
    });

    if (!res.ok) {
      return new Response(
        JSON.stringify({
          success: false,
          tokenId,
          status: res.status,
          durationMs: Date.now() - startedAt,
          bids: [],
          asks: [],
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const book = await res.json();

    const bids = parseLevels(book?.bids ?? [], depth);
    const asks = parseLevels(book?.asks ?? [], depth);

    return new Response(
      JSON.stringify({
        success: true,
        tokenId,
        depth,
        durationMs: Date.now() - startedAt,
        timestamp: new Date().toISOString(),
        bids,
        asks,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error) {
    return new Response(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
        durationMs: Date.now() - startedAt,
        bids: [],
        asks: [],
      }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
