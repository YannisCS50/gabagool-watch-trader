import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const EXTRACTION_PROMPT = `You are a Polymarket trading data extractor. Analyze the screenshot and extract ALL visible trading data.

CONTEXT:
- Market type: Crypto "Up or Down" (15 minutes)
- Each market has two outcomes: Up and Down
- Prices are in cents per share (0–100)
- One share pays $1 if correct, $0 if incorrect

EXTRACT AND RETURN THIS EXACT JSON STRUCTURE:

{
  "markets": [
    {
      "asset": "XRP | ETH | BTC | SOL",
      "start_time": "ISO8601 or human-readable string",
      "end_time": "ISO8601 or human-readable string", 
      "current_price": number or null,
      "time_remaining_seconds": number or null,
      "positions": [
        {
          "outcome": "Up | Down",
          "shares": number,
          "avg_price_cents": number,
          "total_cost_usd": number,
          "current_value_usd": number,
          "pnl_usd": number,
          "pnl_pct": number
        }
      ],
      "open_orders": [
        {
          "side": "Buy | Sell",
          "outcome": "Up | Down",
          "price_cents": number,
          "shares": number,
          "total_usd": number,
          "filled_shares": number,
          "expiration": "string or null"
        }
      ],
      "derived_metrics": {
        "net_up_shares": number,
        "net_down_shares": number,
        "inventory_skew_pct": number,
        "implied_pair_cost": number,
        "is_fully_paired": boolean,
        "is_one_sided": boolean
      }
    }
  ],
  "extraction_notes": "any relevant notes about what was visible/not visible"
}

RULES:
- Use ONLY information visible in the screenshot
- Do NOT make assumptions
- If data is missing, use null
- Output ONLY valid JSON, no markdown, no explanations
- Extract ALL markets visible in the screenshot`;

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { image_base64, image_url } = await req.json();

    if (!image_base64 && !image_url) {
      throw new Error("Either image_base64 or image_url is required");
    }

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) {
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
        max_tokens: 4096,
        temperature: 0.1,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("AI Gateway error:", errorText);
      throw new Error(`AI Gateway error: ${response.status}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;

    if (!content) {
      throw new Error("No content in AI response");
    }

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
