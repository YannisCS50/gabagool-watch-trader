import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { username = 'gabagool22' } = await req.json().catch(() => ({}));
    
    const FIRECRAWL_API_KEY = Deno.env.get('FIRECRAWL_API_KEY');
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

    if (!FIRECRAWL_API_KEY) {
      console.error('FIRECRAWL_API_KEY not configured');
      return new Response(
        JSON.stringify({ success: false, error: 'Firecrawl not configured' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      console.error('Supabase credentials not configured');
      return new Response(
        JSON.stringify({ success: false, error: 'Database not configured' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    console.log(`Scraping Polymarket activity for @${username}...`);

    // Scrape the user's activity page
    const activityUrl = `https://polymarket.com/@${username}?tab=activity`;
    
    const scrapeResponse = await fetch('https://api.firecrawl.dev/v1/scrape', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${FIRECRAWL_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url: activityUrl,
        formats: ['markdown', 'html'],
        onlyMainContent: true,
        waitFor: 3000,
      }),
    });

    const scrapeData = await scrapeResponse.json();

    if (!scrapeResponse.ok) {
      console.error('Firecrawl error:', scrapeData);
      return new Response(
        JSON.stringify({ success: false, error: 'Failed to scrape Polymarket' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const markdown = scrapeData.data?.markdown || scrapeData.markdown || '';
    console.log('Scraped content length:', markdown.length);

    // Parse the markdown to extract trade information
    // Polymarket activity format varies, so we'll extract what we can
    const trades = parsePolymarketActivity(markdown, username);
    console.log(`Parsed ${trades.length} trades from activity`);

    if (trades.length > 0) {
      // Insert trades into database (upsert to avoid duplicates)
      for (const trade of trades) {
        const { error } = await supabase
          .from('trades')
          .upsert(trade, { 
            onConflict: 'external_id',
            ignoreDuplicates: true 
          });
        
        if (error) {
          console.error('Error inserting trade:', error);
        }
      }

      // Update trader stats
      const { data: tradeCount } = await supabase
        .from('trades')
        .select('*', { count: 'exact' })
        .eq('trader_username', username);

      const totalTrades = tradeCount?.length || 0;
      const totalVolume = tradeCount?.reduce((sum, t) => sum + Number(t.total), 0) || 0;
      const avgTradeSize = totalTrades > 0 ? totalVolume / totalTrades : 0;

      await supabase
        .from('trader_stats')
        .upsert({
          trader_username: username,
          total_trades: totalTrades,
          total_volume: totalVolume,
          avg_trade_size: avgTradeSize,
          last_active: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }, { onConflict: 'trader_username' });
    }

    return new Response(
      JSON.stringify({ 
        success: true, 
        tradesFound: trades.length,
        rawContent: markdown.substring(0, 500) + '...'
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Error in scrape-polymarket:', error);
    return new Response(
      JSON.stringify({ success: false, error: error instanceof Error ? error.message : 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});

function parsePolymarketActivity(markdown: string, username: string): any[] {
  const trades: any[] = [];
  
  // Look for trade patterns in the content
  // Common patterns: "Bought X shares of Yes/No at $Y.YY"
  const tradePatterns = [
    /(?:Bought|Sold)\s+(\d+(?:,\d+)?)\s+shares?\s+of\s+(Yes|No)\s+(?:at|@)\s+\$?([\d.]+)/gi,
    /(Yes|No)\s+(\d+(?:,\d+)?)\s+shares?\s+(?:at|@)\s+\$?([\d.]+)/gi,
  ];

  // Extract market titles - look for text before trade info
  const lines = markdown.split('\n');
  let currentMarket = '';
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    
    // Skip empty lines
    if (!line) continue;
    
    // Check if this looks like a market title (longer text, not a number)
    if (line.length > 20 && !line.match(/^\d/) && line.includes('?')) {
      currentMarket = line.replace(/\[|\]|\(.*?\)/g, '').trim();
    }
    
    // Look for trade info
    for (const pattern of tradePatterns) {
      const matches = line.matchAll(pattern);
      for (const match of matches) {
        const isBought = match[0].toLowerCase().includes('bought');
        const shares = parseInt(match[1]?.replace(/,/g, '') || match[2]?.replace(/,/g, '') || '0');
        const outcome = match[2] || match[1] || 'Yes';
        const price = parseFloat(match[3] || '0.50');
        
        if (shares > 0) {
          trades.push({
            external_id: `${username}-${Date.now()}-${trades.length}`,
            trader_username: username,
            timestamp: new Date().toISOString(),
            market: currentMarket || 'Unknown Market',
            market_slug: currentMarket.toLowerCase().replace(/[^a-z0-9]+/g, '-').substring(0, 50),
            outcome: outcome,
            side: isBought ? 'buy' : 'sell',
            shares: shares,
            price: price,
            total: shares * price,
            status: 'filled',
          });
        }
      }
    }
  }
  
  return trades;
}
