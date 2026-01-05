import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const EXTRACTION_PROMPT = `POLYMARKET UI EXTRACTION (ROBUST + STRATEGY-AWARE)

You will be given screenshots of the Polymarket web interface for crypto "Up or Down" markets with 15-minute expiries.
Your task is to extract trading data accurately and defensively, producing structured JSON that is SAFE for quantitative analysis.

====================
GLOBAL CONTEXT
====================
- Market type: Crypto "Up or Down"
- Assets: BTC, ETH, SOL, XRP
- Two outcomes per market: Up, Down
- Prices are in CENTS per share (0–100)
- One share pays $1 if correct, $0 if incorrect
- Screenshots may be partially unreadable or cropped

You MUST prefer correctness and explicit nulls over guessing.

====================
OUTPUT STRUCTURE
====================
Return ONE JSON object with this top-level structure:

{
  "extraction_timestamp": "ISO8601",
  "markets": [ ... ],
  "extraction_warnings": [ ... ]
}

====================
PER-MARKET EXTRACTION
====================
For each distinct market shown, extract the following.

--------------------
1) Market Metadata
--------------------
{
  "asset": "BTC | ETH | SOL | XRP | null",
  "start_time": "ISO8601 | human-readable | null",
  "end_time": "ISO8601 | human-readable | null",
  "current_price": number | null,
  "time_remaining_seconds": number | null
}

Rules:
- If time is shown as "10:25 mins", convert to seconds if possible
- If unclear, set null and add a warning

--------------------
2) Positions
--------------------
For EACH outcome shown (Up and/or Down):

{
  "outcome": "Up | Down",
  "shares": number | null,
  "avg_price_cents": number | null,
  "total_cost_usd": number | null,
  "current_value_usd": number | null,
  "reported_pnl_usd": number | null,
  "reported_pnl_pct": number | null
}

CRITICAL RULES:
- DO NOT recompute cost or PnL yet
- Extract exactly what the UI shows
- If a value is not clearly visible, use null

--------------------
3) Open Orders
--------------------
For EACH open order row:

{
  "side": "Buy | Sell",
  "outcome": "Up | Down",
  "price_cents": number | null,
  "shares": number | null,
  "total_usd": number | null,
  "filled_shares": number | null,
  "expiration": string | null,
  "parse_complete": boolean
}

Rules:
- If price OR shares is missing, set them to null
- Set parse_complete = false if any key numeric field is missing
- NEVER set price or shares to 0 unless explicitly shown as 0

--------------------
4) Trade History (if visible)
--------------------
For each history entry:

{
  "action": "Bought | Sold",
  "outcome": "Up | Down",
  "shares": number | null,
  "price_cents": number | null,
  "total_usd": number | null,
  "time_ago": string | null
}

====================
DERIVED METRICS (CALCULATE CAREFULLY)
====================
Compute derived metrics ONLY if inputs are sufficient.
If inputs are insufficient, set derived value to null.

--------------------
5) Derived Inventory Metrics
--------------------
{
  "net_up_shares": number | null,
  "net_down_shares": number | null,
  "inventory_skew_pct": number | null
}

Rules:
- inventory_skew_pct = (up - down) / (up + down)
- Only compute if both shares are known and sum > 0

--------------------
6) Pair Metrics
--------------------
{
  "paired_shares": number | null,
  "implied_pair_cost_cents": number | null
}

Rules:
- paired_shares = min(up_shares, down_shares)
- implied_pair_cost_cents = avg_up_price + avg_down_price
- Only compute if both avg prices are known

--------------------
7) Trade State Classification (MANDATORY)
--------------------
Classify EACH market into EXACTLY ONE state:

{
  "trade_state":
    "fully_paired" |
    "partial_pair_unbalanced" |
    "one_sided_waiting" |
    "forced_hedge" |
    "flat_no_position" |
    "unknown"
}

Definitions:
- fully_paired: up_shares == down_shares > 0
- partial_pair_unbalanced: up_shares > 0 AND down_shares > 0 AND up_shares != down_shares
- one_sided_waiting: exactly one side has shares > 0 AND no opposing fills
- forced_hedge: both sides exist AND implied_pair_cost_cents > 100
- flat_no_position: no shares on either side
- unknown: insufficient data

--------------------
8) Data Quality Flags (MANDATORY)
--------------------
{
  "data_quality": {
    "cost_consistent": boolean | null,
    "pnl_consistent": boolean | null,
    "orders_parse_complete": boolean
  }
}

Rules:
- cost_consistent: compare shares * avg_price vs total_cost (±5%)
- pnl_consistent: compare current_value - total_cost vs reported_pnl (±5%)
- If inputs missing, set consistency flag to null
- orders_parse_complete = true ONLY if all open orders have parse_complete = true

====================
WARNINGS
====================
Add human-readable warnings when:
- OCR ambiguity exists
- Numbers are inconsistent
- Trade_state = unknown
- Orders are incomplete

====================
FINAL RULES
====================
- NEVER guess missing numbers
- NEVER invent prices or shares
- Prefer null + warning over false precision
- Output VALID JSON only
- NO explanations outside JSON`;

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { image_base64, image_url } = await req.json();

    if (!image_base64 && !image_url) {
      console.error("Missing image data");
      throw new Error("Either image_base64 or image_url is required");
    }

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) {
      console.error("LOVABLE_API_KEY not configured");
      throw new Error("LOVABLE_API_KEY not configured");
    }

    // Build image content based on input type
    const imageContent = image_base64
      ? {
          type: "image_url",
          image_url: {
            url: `data:image/png;base64,${image_base64}`,
          },
        }
      : {
          type: "image_url",
          image_url: {
            url: image_url,
          },
        };

    console.log("Calling AI Gateway for extraction...");

    const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-pro",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: EXTRACTION_PROMPT },
              imageContent,
            ],
          },
        ],
        max_tokens: 8192,
        temperature: 0.1,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("AI Gateway error:", response.status, errorText);
      
      if (response.status === 429) {
        return new Response(
          JSON.stringify({ success: false, error: "Rate limit exceeded. Please try again later." }),
          { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      if (response.status === 402) {
        return new Response(
          JSON.stringify({ success: false, error: "Payment required. Please add credits to your workspace." }),
          { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      
      throw new Error(`AI Gateway error: ${response.status}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;

    if (!content) {
      console.error("No content in AI response");
      throw new Error("No content in AI response");
    }

    console.log("AI response received, parsing JSON...");

    // Parse the JSON response
    let extractedData;
    try {
      // Remove any markdown code blocks if present
      const cleanContent = content
        .replace(/```json\n?/g, "")
        .replace(/```\n?/g, "")
        .trim();
      extractedData = JSON.parse(cleanContent);
    } catch (parseError) {
      console.error("Failed to parse AI response:", content);
      const errorMsg = parseError instanceof Error ? parseError.message : "Unknown parse error";
      throw new Error(`Failed to parse extraction result: ${errorMsg}`);
    }

    console.log("Extraction successful:", {
      markets: extractedData.markets?.length || 0,
      warnings: extractedData.extraction_warnings?.length || 0
    });

    return new Response(
      JSON.stringify({
        success: true,
        data: extractedData,
        raw_response: content,
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    console.error("Extraction error:", error);
    const errorMsg = error instanceof Error ? error.message : "Unknown error";
    return new Response(
      JSON.stringify({
        success: false,
        error: errorMsg,
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
