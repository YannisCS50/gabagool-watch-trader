import { ArrowLeft, Book, Code, Database, Server, TrendingUp, Zap, Shield, RefreshCw, Calculator } from 'lucide-react';
import { Link } from 'react-router-dom';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';

const CodeBlock = ({ children, language = 'typescript' }: { children: string; language?: string }) => (
  <pre className="bg-background/80 border border-border/50 rounded-lg p-4 overflow-x-auto text-xs font-mono">
    <code>{children}</code>
  </pre>
);

const DevGuide = () => {
  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border/50 bg-card/50 backdrop-blur-xl sticky top-0 z-50">
        <div className="container mx-auto px-4 py-4">
          <div className="flex items-center gap-3">
            <Link to="/" className="flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors">
              <ArrowLeft className="w-4 h-4" />
            </Link>
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-500 to-purple-500 flex items-center justify-center">
              <Book className="w-4 h-4 text-primary-foreground" />
            </div>
            <span className="font-semibold text-lg">Developer Guide</span>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-8 max-w-4xl">
        {/* Intro */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold mb-4">Polymarket Trading Bot - Developer Guide</h1>
          <p className="text-muted-foreground text-lg">
            Een complete handleiding voor het bouwen van een Polymarket arbitrage trading bot met real-time data, 
            automatische analyse en position tracking.
          </p>
        </div>

        {/* Table of Contents */}
        <div className="glass rounded-lg p-6 mb-8">
          <h2 className="font-semibold mb-4">📚 Inhoudsopgave</h2>
          <ol className="space-y-2 text-sm">
            <li><a href="#architectuur" className="text-primary hover:underline">1. Architectuur Overzicht</a></li>
            <li><a href="#polymarket-api" className="text-primary hover:underline">2. Polymarket Data API</a></li>
            <li><a href="#database" className="text-primary hover:underline">3. Database Design (Supabase)</a></li>
            <li><a href="#edge-functions" className="text-primary hover:underline">4. Edge Functions & Scraping</a></li>
            <li><a href="#frontend" className="text-primary hover:underline">5. Frontend Implementatie</a></li>
            <li><a href="#arbitrage" className="text-primary hover:underline">6. Arbitrage Strategie</a></li>
            <li><a href="#dca" className="text-primary hover:underline">7. Dollar Cost Averaging (DCA)</a></li>
            <li><a href="#realtime" className="text-primary hover:underline">8. Real-time Updates</a></li>
            <li><a href="#deployment" className="text-primary hover:underline">9. Deployment & Monitoring</a></li>
          </ol>
        </div>

        {/* Chapters */}
        <div className="space-y-6">
          
          {/* Chapter 1: Architecture */}
          <section id="architectuur" className="glass rounded-lg overflow-hidden">
            <div className="p-6 border-b border-border/50 flex items-center gap-3">
              <Zap className="w-5 h-5 text-primary" />
              <h2 className="text-xl font-bold">1. Architectuur Overzicht</h2>
            </div>
            <div className="p-6">
              <Accordion type="multiple" className="space-y-2">
                <AccordionItem value="tech-stack">
                  <AccordionTrigger className="text-sm font-semibold">1.1 Technology Stack</AccordionTrigger>
                  <AccordionContent className="space-y-4">
                    <p className="text-muted-foreground">De bot is gebouwd met de volgende technologieën:</p>
                    <div className="grid grid-cols-2 gap-4 text-sm">
                      <div className="bg-card/50 rounded-lg p-4">
                        <h4 className="font-semibold mb-2">Frontend</h4>
                        <ul className="space-y-1 text-muted-foreground">
                          <li>• React 18 + TypeScript</li>
                          <li>• Vite (build tool)</li>
                          <li>• TailwindCSS (styling)</li>
                          <li>• Shadcn/UI (components)</li>
                          <li>• TanStack Query (data fetching)</li>
                          <li>• React Router (navigation)</li>
                        </ul>
                      </div>
                      <div className="bg-card/50 rounded-lg p-4">
                        <h4 className="font-semibold mb-2">Backend</h4>
                        <ul className="space-y-1 text-muted-foreground">
                          <li>• Supabase (database + auth)</li>
                          <li>• Deno Edge Functions</li>
                          <li>• PostgreSQL (data storage)</li>
                          <li>• Row Level Security (RLS)</li>
                        </ul>
                      </div>
                    </div>
                  </AccordionContent>
                </AccordionItem>

                <AccordionItem value="data-flow">
                  <AccordionTrigger className="text-sm font-semibold">1.2 Data Flow</AccordionTrigger>
                  <AccordionContent className="space-y-4">
                    <div className="bg-card/50 rounded-lg p-4 font-mono text-xs">
                      <pre>{`┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   Polymarket    │────▶│  Edge Function   │────▶│    Supabase     │
│    Data API     │     │  (scraper)       │     │    Database     │
└─────────────────┘     └──────────────────┘     └────────┬────────┘
                                                          │
                                                          ▼
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   React App     │◀────│  TanStack Query  │◀────│  Supabase SDK   │
│   (Frontend)    │     │  (caching)       │     │  (real-time)    │
└─────────────────┘     └──────────────────┘     └─────────────────┘`}</pre>
                    </div>
                    <ol className="space-y-2 text-sm text-muted-foreground">
                      <li><strong>1.</strong> Edge Function haalt data op van Polymarket Data API</li>
                      <li><strong>2.</strong> Data wordt verwerkt en opgeslagen in Supabase</li>
                      <li><strong>3.</strong> Frontend haalt data op via Supabase SDK</li>
                      <li><strong>4.</strong> TanStack Query cachet en refresht automatisch</li>
                    </ol>
                  </AccordionContent>
                </AccordionItem>
              </Accordion>
            </div>
          </section>

          {/* Chapter 2: Polymarket API */}
          <section id="polymarket-api" className="glass rounded-lg overflow-hidden">
            <div className="p-6 border-b border-border/50 flex items-center gap-3">
              <Server className="w-5 h-5 text-primary" />
              <h2 className="text-xl font-bold">2. Polymarket Data API</h2>
            </div>
            <div className="p-6">
              <Accordion type="multiple" className="space-y-2">
                <AccordionItem value="api-overview">
                  <AccordionTrigger className="text-sm font-semibold">2.1 API Endpoints</AccordionTrigger>
                  <AccordionContent className="space-y-4">
                    <p className="text-muted-foreground">Polymarket heeft twee APIs:</p>
                    <div className="space-y-3">
                      <div className="bg-destructive/10 border border-destructive/30 rounded-lg p-4">
                        <h4 className="font-semibold text-destructive mb-2">❌ CLOB API (vereist authenticatie)</h4>
                        <p className="text-sm text-muted-foreground">
                          <code>https://clob.polymarket.com</code> - Vereist L2 wallet signatures en API keys.
                          Te complex voor basic trade tracking.
                        </p>
                      </div>
                      <div className="bg-success/10 border border-success/30 rounded-lg p-4">
                        <h4 className="font-semibold text-success mb-2">✓ Data API (publiek)</h4>
                        <p className="text-sm text-muted-foreground">
                          <code>https://data-api.polymarket.com</code> - Geen authenticatie nodig.
                          Ideaal voor het ophalen van trades en posities.
                        </p>
                      </div>
                    </div>
                  </AccordionContent>
                </AccordionItem>

                <AccordionItem value="activity-endpoint">
                  <AccordionTrigger className="text-sm font-semibold">2.2 Activity Endpoint (Trades)</AccordionTrigger>
                  <AccordionContent className="space-y-4">
                    <p className="text-muted-foreground">Haal alle trades op voor een wallet address:</p>
                    <CodeBlock>{`// Activity endpoint - alle trades voor een wallet
const WALLET = '0x6031b6eed1c97e853c6e0f03ad3ce3529351f96d';
const url = \`https://data-api.polymarket.com/activity?user=\${WALLET}&limit=500\`;

const response = await fetch(url);
const activities = await response.json();

// Response structuur:
interface Activity {
  id: string;
  timestamp: string;           // ISO datetime
  type: 'TRADE' | 'REDEEM';    // Trade of uitbetaling
  market: string;              // Markt naam
  slug: string;                // Market slug (URL-friendly)
  outcome: string;             // 'Yes', 'No', 'Up', 'Down', etc.
  side: string;                // 'BUY' of 'SELL'
  size: string;                // Aantal shares (string!)
  price: string;               // Prijs per share (0-1)
  usdcSize: string;            // Totale waarde in USDC
}`}</CodeBlock>
                    <div className="bg-warning/10 border border-warning/30 rounded-lg p-4 text-sm">
                      <strong className="text-warning">⚠️ Paginatie:</strong>
                      <p className="text-muted-foreground mt-1">
                        De API retourneert max 500 items per request. Gebruik <code>offset</code> parameter voor meer:
                      </p>
                      <code className="text-xs">{`?user=${'{wallet}'}&limit=500&offset=500`}</code>
                    </div>
                  </AccordionContent>
                </AccordionItem>

                <AccordionItem value="positions-endpoint">
                  <AccordionTrigger className="text-sm font-semibold">2.3 Positions Endpoint</AccordionTrigger>
                  <AccordionContent className="space-y-4">
                    <p className="text-muted-foreground">Haal huidige open posities op:</p>
                    <CodeBlock>{`// Positions endpoint - huidige holdings
const url = \`https://data-api.polymarket.com/positions?user=\${WALLET}&sizeThreshold=0.01&limit=500\`;

const response = await fetch(url);
const positions = await response.json();

// Response structuur:
interface Position {
  market: string;              // Markt naam
  slug: string;                // Market slug
  outcome: string;             // Outcome naam
  size: string;                // Aantal shares
  avgPrice: string;            // Gemiddelde aankoopprijs
  curPrice: string;            // Huidige marktprijs
  pnl: string;                 // Profit/Loss in USDC
  pnlPercent: string;          // P/L percentage
}`}</CodeBlock>
                  </AccordionContent>
                </AccordionItem>

                <AccordionItem value="wallet-lookup">
                  <AccordionTrigger className="text-sm font-semibold">2.4 Username → Wallet Lookup</AccordionTrigger>
                  <AccordionContent className="space-y-4">
                    <p className="text-muted-foreground">
                      De Data API werkt met wallet addresses, niet usernames. Je hebt een mapping nodig:
                    </p>
                    <CodeBlock>{`// Hardcoded mapping (eenvoudig)
const WALLET_MAP: Record<string, string> = {
  'gabagool22': '0x6031b6eed1c97e853c6e0f03ad3ce3529351f96d',
  'andere_user': '0x...',
};

// Of: Scrape van profile page met Firecrawl
const profileUrl = \`https://polymarket.com/profile/\${username}\`;
// Parse de wallet address uit de HTML`}</CodeBlock>
                    <div className="bg-primary/10 border border-primary/30 rounded-lg p-4 text-sm">
                      <strong className="text-primary">💡 Tip:</strong>
                      <p className="text-muted-foreground mt-1">
                        Het wallet address is te vinden in de URL van de profielpagina of door de HTML te scrapen.
                      </p>
                    </div>
                  </AccordionContent>
                </AccordionItem>
              </Accordion>
            </div>
          </section>

          {/* Chapter 3: Database */}
          <section id="database" className="glass rounded-lg overflow-hidden">
            <div className="p-6 border-b border-border/50 flex items-center gap-3">
              <Database className="w-5 h-5 text-primary" />
              <h2 className="text-xl font-bold">3. Database Design (Supabase)</h2>
            </div>
            <div className="p-6">
              <Accordion type="multiple" className="space-y-2">
                <AccordionItem value="schema">
                  <AccordionTrigger className="text-sm font-semibold">3.1 Database Schema</AccordionTrigger>
                  <AccordionContent className="space-y-4">
                    <p className="text-muted-foreground">Drie hoofdtabellen voor trade tracking:</p>
                    <CodeBlock>{`-- Trades tabel: alle individuele trades
CREATE TABLE public.trades (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  trader_username TEXT NOT NULL DEFAULT 'gabagool22',
  external_id TEXT,                    -- Polymarket trade ID
  timestamp TIMESTAMPTZ NOT NULL,
  market TEXT NOT NULL,
  market_slug TEXT,
  outcome TEXT NOT NULL,               -- 'Yes', 'No', 'Up', 'Down'
  side TEXT NOT NULL,                  -- 'buy', 'sell'
  shares NUMERIC NOT NULL,
  price NUMERIC NOT NULL,              -- 0-1
  total NUMERIC NOT NULL,              -- shares * price
  status TEXT DEFAULT 'filled',
  created_at TIMESTAMPTZ DEFAULT now(),
  
  -- Voorkom duplicates
  UNIQUE(trader_username, external_id)
);

-- Positions tabel: huidige open posities
CREATE TABLE public.positions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  trader_username TEXT NOT NULL DEFAULT 'gabagool22',
  market TEXT NOT NULL,
  market_slug TEXT,
  outcome TEXT NOT NULL,
  shares NUMERIC NOT NULL,
  avg_price NUMERIC NOT NULL,
  current_price NUMERIC,
  pnl NUMERIC DEFAULT 0,
  pnl_percent NUMERIC DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  
  UNIQUE(trader_username, market, outcome)
);

-- Trader stats tabel: aggregated statistieken
CREATE TABLE public.trader_stats (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  trader_username TEXT NOT NULL UNIQUE DEFAULT 'gabagool22',
  total_trades INTEGER DEFAULT 0,
  total_volume NUMERIC DEFAULT 0,
  win_rate NUMERIC DEFAULT 0,
  avg_trade_size NUMERIC DEFAULT 0,
  active_since TIMESTAMPTZ,
  last_active TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT now()
);`}</CodeBlock>
                  </AccordionContent>
                </AccordionItem>

                <AccordionItem value="rls">
                  <AccordionTrigger className="text-sm font-semibold">3.2 Row Level Security (RLS)</AccordionTrigger>
                  <AccordionContent className="space-y-4">
                    <p className="text-muted-foreground">
                      Configureer RLS voor publieke lees-toegang (de scraper schrijft via service role):
                    </p>
                    <CodeBlock>{`-- Enable RLS
ALTER TABLE public.trades ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trader_stats ENABLE ROW LEVEL SECURITY;

-- Publieke lees-toegang
CREATE POLICY "Public read access for trades"
ON public.trades FOR SELECT
USING (true);

CREATE POLICY "Public read access for positions"
ON public.positions FOR SELECT
USING (true);

CREATE POLICY "Public read access for trader_stats"
ON public.trader_stats FOR SELECT
USING (true);

-- Schrijf-toegang alleen via service role (Edge Functions)`}</CodeBlock>
                    <div className="bg-warning/10 border border-warning/30 rounded-lg p-4 text-sm">
                      <strong className="text-warning">⚠️ Security:</strong>
                      <p className="text-muted-foreground mt-1">
                        In productie wil je mogelijk per-user RLS policies als je meerdere traders tracked.
                      </p>
                    </div>
                  </AccordionContent>
                </AccordionItem>

                <AccordionItem value="indexes">
                  <AccordionTrigger className="text-sm font-semibold">3.3 Indexes voor Performance</AccordionTrigger>
                  <AccordionContent className="space-y-4">
                    <CodeBlock>{`-- Indexes voor snelle queries
CREATE INDEX idx_trades_username ON trades(trader_username);
CREATE INDEX idx_trades_timestamp ON trades(timestamp DESC);
CREATE INDEX idx_trades_market ON trades(market);
CREATE INDEX idx_positions_username ON positions(trader_username);
CREATE INDEX idx_positions_market ON positions(market);`}</CodeBlock>
                  </AccordionContent>
                </AccordionItem>
              </Accordion>
            </div>
          </section>

          {/* Chapter 4: Edge Functions */}
          <section id="edge-functions" className="glass rounded-lg overflow-hidden">
            <div className="p-6 border-b border-border/50 flex items-center gap-3">
              <Code className="w-5 h-5 text-primary" />
              <h2 className="text-xl font-bold">4. Edge Functions & Scraping</h2>
            </div>
            <div className="p-6">
              <Accordion type="multiple" className="space-y-2">
                <AccordionItem value="scraper-function">
                  <AccordionTrigger className="text-sm font-semibold">4.1 Scraper Edge Function</AccordionTrigger>
                  <AccordionContent className="space-y-4">
                    <p className="text-muted-foreground">De kern van de bot - haalt data op en slaat op in Supabase:</p>
                    <CodeBlock>{`// supabase/functions/scrape-polymarket/index.ts
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Username → Wallet mapping
const WALLET_MAP: Record<string, string> = {
  'gabagool22': '0x6031b6eed1c97e853c6e0f03ad3ce3529351f96d',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { username = 'gabagool22' } = await req.json();
    const wallet = WALLET_MAP[username];
    
    if (!wallet) {
      throw new Error(\`Unknown username: \${username}\`);
    }

    // Supabase client met service role (voor schrijven)
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    // 1. Fetch activities met paginatie
    const activities = await fetchAllActivities(wallet);
    
    // 2. Filter & transform trades
    const trades = activities
      .filter(a => a.type === 'TRADE')
      .map(a => ({
        trader_username: username,
        external_id: a.id,
        timestamp: a.timestamp,
        market: a.market,
        market_slug: a.slug,
        outcome: a.outcome,
        side: a.side.toLowerCase(),
        shares: parseFloat(a.size),
        price: parseFloat(a.price),
        total: parseFloat(a.usdcSize),
        status: 'filled',
      }));

    // 3. Upsert trades (voorkom duplicates)
    const { error: tradesError } = await supabase
      .from('trades')
      .upsert(trades, { 
        onConflict: 'trader_username,external_id',
        ignoreDuplicates: true 
      });

    if (tradesError) throw tradesError;

    // 4. Fetch & store positions
    await fetchAndStorePositions(supabase, username, wallet);

    // 5. Update stats
    await updateTraderStats(supabase, username);

    return new Response(
      JSON.stringify({ 
        success: true, 
        tradesFound: trades.length 
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Scrape error:', error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});

async function fetchAllActivities(wallet: string) {
  const activities: any[] = [];
  let offset = 0;
  const limit = 500;

  while (true) {
    const url = \`https://data-api.polymarket.com/activity?user=\${wallet}&limit=\${limit}&offset=\${offset}\`;
    const response = await fetch(url);
    const data = await response.json();
    
    if (!data || data.length === 0) break;
    
    activities.push(...data);
    if (data.length < limit) break;
    
    offset += limit;
    // Rate limiting
    await new Promise(r => setTimeout(r, 100));
  }

  return activities;
}`}</CodeBlock>
                  </AccordionContent>
                </AccordionItem>

                <AccordionItem value="config-toml">
                  <AccordionTrigger className="text-sm font-semibold">4.2 Config.toml Configuratie</AccordionTrigger>
                  <AccordionContent className="space-y-4">
                    <CodeBlock>{`# supabase/config.toml
project_id = "your-project-id"

[functions.scrape-polymarket]
verify_jwt = false  # Publiek toegankelijk (of true voor auth)`}</CodeBlock>
                  </AccordionContent>
                </AccordionItem>

                <AccordionItem value="calling-function">
                  <AccordionTrigger className="text-sm font-semibold">4.3 Edge Function Aanroepen</AccordionTrigger>
                  <AccordionContent className="space-y-4">
                    <CodeBlock>{`// Vanuit React component
import { supabase } from '@/integrations/supabase/client';

const scrapeTrades = async (username: string) => {
  const { data, error } = await supabase.functions.invoke(
    'scrape-polymarket',
    { body: { username } }
  );

  if (error) throw error;
  return data;
};

// Met TanStack Query mutation
const scrapeMutation = useMutation({
  mutationFn: async () => {
    const response = await supabase.functions.invoke('scrape-polymarket', {
      body: { username: 'gabagool22' },
    });
    if (response.error) throw response.error;
    return response.data;
  },
  onSuccess: () => {
    // Refetch queries na succesvolle scrape
    queryClient.invalidateQueries({ queryKey: ['trades'] });
  },
});`}</CodeBlock>
                  </AccordionContent>
                </AccordionItem>
              </Accordion>
            </div>
          </section>

          {/* Chapter 5: Frontend */}
          <section id="frontend" className="glass rounded-lg overflow-hidden">
            <div className="p-6 border-b border-border/50 flex items-center gap-3">
              <Code className="w-5 h-5 text-primary" />
              <h2 className="text-xl font-bold">5. Frontend Implementatie</h2>
            </div>
            <div className="p-6">
              <Accordion type="multiple" className="space-y-2">
                <AccordionItem value="use-trades-hook">
                  <AccordionTrigger className="text-sm font-semibold">5.1 useTrades Hook</AccordionTrigger>
                  <AccordionContent className="space-y-4">
                    <p className="text-muted-foreground">Custom hook voor data fetching met TanStack Query:</p>
                    <CodeBlock>{`// src/hooks/useTrades.ts
import { useQuery, useMutation } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export function useTrades(username: string = 'gabagool22') {
  // Trades query met auto-refresh
  const tradesQuery = useQuery({
    queryKey: ['trades', username],
    refetchInterval: 30000, // Elke 30 seconden
    queryFn: async () => {
      // Paginatie voor >1000 trades
      let allTrades: any[] = [];
      let offset = 0;
      const pageSize = 1000;
      
      while (true) {
        const { data, error } = await supabase
          .from('trades')
          .select('*')
          .eq('trader_username', username)
          .order('timestamp', { ascending: false })
          .range(offset, offset + pageSize - 1);

        if (error) throw error;
        if (!data || data.length === 0) break;
        
        allTrades = [...allTrades, ...data];
        if (data.length < pageSize) break;
        offset += pageSize;
      }

      return allTrades.map(t => ({
        id: t.id,
        timestamp: new Date(t.timestamp),
        market: t.market,
        outcome: t.outcome,
        side: t.side,
        shares: Number(t.shares),
        price: Number(t.price),
        total: Number(t.total),
      }));
    },
  });

  // Scrape mutation
  const scrapeMutation = useMutation({
    mutationFn: async () => {
      const response = await supabase.functions.invoke('scrape-polymarket', {
        body: { username },
      });
      if (response.error) throw response.error;
      return response.data;
    },
    onSuccess: () => {
      tradesQuery.refetch();
    },
  });

  return {
    trades: tradesQuery.data || [],
    isLoading: tradesQuery.isLoading,
    scrape: scrapeMutation.mutate,
    isScraping: scrapeMutation.isPending,
  };
}`}</CodeBlock>
                  </AccordionContent>
                </AccordionItem>

                <AccordionItem value="types">
                  <AccordionTrigger className="text-sm font-semibold">5.2 TypeScript Types</AccordionTrigger>
                  <AccordionContent className="space-y-4">
                    <CodeBlock>{`// src/types/trade.ts
export interface Trade {
  id: string;
  timestamp: Date;
  market: string;
  marketSlug: string;
  outcome: 'Yes' | 'No' | string; // Kan ook 'Up', 'Down' zijn
  side: 'buy' | 'sell';
  shares: number;
  price: number;     // 0-1
  total: number;     // shares * price
  status: 'filled' | 'pending' | 'cancelled';
}

export interface MarketPosition {
  market: string;
  marketSlug: string;
  outcome: string;
  shares: number;
  avgPrice: number;
  currentPrice: number;
  pnl: number;
  pnlPercent: number;
}

export interface TraderStats {
  totalTrades: number;
  totalVolume: number;
  winRate: number;
  avgTradeSize: number;
  activeSince: Date;
  lastActive: Date;
}`}</CodeBlock>
                  </AccordionContent>
                </AccordionItem>
              </Accordion>
            </div>
          </section>

          {/* Chapter 6: Arbitrage */}
          <section id="arbitrage" className="glass rounded-lg overflow-hidden">
            <div className="p-6 border-b border-border/50 flex items-center gap-3">
              <TrendingUp className="w-5 h-5 text-primary" />
              <h2 className="text-xl font-bold">6. Arbitrage Strategie</h2>
            </div>
            <div className="p-6">
              <Accordion type="multiple" className="space-y-2">
                <AccordionItem value="arb-basics">
                  <AccordionTrigger className="text-sm font-semibold">6.1 Basis Concept</AccordionTrigger>
                  <AccordionContent className="space-y-4">
                    <div className="bg-card/50 rounded-lg p-4">
                      <p className="text-muted-foreground mb-4">
                        Bij prediction markets betaalt de winnende kant altijd <strong>$1.00</strong> uit per share.
                        Arbitrage is mogelijk als je beide kanten voor minder dan $1.00 kunt kopen.
                      </p>
                      <div className="grid grid-cols-3 gap-4 text-center text-sm">
                        <div className="bg-success/10 rounded-lg p-3">
                          <p className="font-mono font-bold text-success">YES + NO &lt; $1.00</p>
                          <p className="text-xs text-muted-foreground mt-1">Gegarandeerde winst</p>
                        </div>
                        <div className="bg-warning/10 rounded-lg p-3">
                          <p className="font-mono font-bold text-warning">YES + NO = $1.00</p>
                          <p className="text-xs text-muted-foreground mt-1">Breakeven</p>
                        </div>
                        <div className="bg-destructive/10 rounded-lg p-3">
                          <p className="font-mono font-bold text-destructive">YES + NO &gt; $1.00</p>
                          <p className="text-xs text-muted-foreground mt-1">Gegarandeerd verlies</p>
                        </div>
                      </div>
                    </div>
                  </AccordionContent>
                </AccordionItem>

                <AccordionItem value="arb-detection">
                  <AccordionTrigger className="text-sm font-semibold">6.2 Arbitrage Detectie Algoritme</AccordionTrigger>
                  <AccordionContent className="space-y-4">
                    <CodeBlock>{`// Analyseer trades per markt voor arbitrage opportunities
interface MarketAnalysis {
  market: string;
  outcomes: {
    outcome: string;
    avgPrice: number;
    totalShares: number;
  }[];
  combinedScore: number;  // YES avg + NO avg
  status: 'profitable' | 'breakeven' | 'loss' | 'exposed';
}

function analyzeMarketForArbitrage(trades: Trade[]): MarketAnalysis[] {
  // Groepeer per markt
  const marketMap = new Map<string, Trade[]>();
  trades.filter(t => t.side === 'buy').forEach(trade => {
    if (!marketMap.has(trade.market)) {
      marketMap.set(trade.market, []);
    }
    marketMap.get(trade.market)!.push(trade);
  });

  const results: MarketAnalysis[] = [];

  marketMap.forEach((marketTrades, marketName) => {
    // Groepeer per outcome
    const outcomeMap = new Map<string, Trade[]>();
    marketTrades.forEach(t => {
      if (!outcomeMap.has(t.outcome)) {
        outcomeMap.set(t.outcome, []);
      }
      outcomeMap.get(t.outcome)!.push(t);
    });

    // Bereken gemiddelde prijs per outcome
    const outcomes = Array.from(outcomeMap.entries()).map(([outcome, trades]) => {
      const totalCost = trades.reduce((sum, t) => sum + t.total, 0);
      const totalShares = trades.reduce((sum, t) => sum + t.shares, 0);
      return {
        outcome,
        avgPrice: totalCost / totalShares,
        totalShares,
      };
    });

    // Bereken combined score (alleen voor binary markets)
    let combinedScore = 0;
    let status: MarketAnalysis['status'] = 'exposed';
    
    if (outcomes.length === 2) {
      combinedScore = outcomes.reduce((sum, o) => sum + o.avgPrice, 0);
      
      if (combinedScore < 0.99) status = 'profitable';
      else if (combinedScore > 1.01) status = 'loss';
      else status = 'breakeven';
    }

    results.push({ market: marketName, outcomes, combinedScore, status });
  });

  return results;
}`}</CodeBlock>
                  </AccordionContent>
                </AccordionItem>

                <AccordionItem value="arb-timeline">
                  <AccordionTrigger className="text-sm font-semibold">6.3 Chronologische Timeline</AccordionTrigger>
                  <AccordionContent className="space-y-4">
                    <p className="text-muted-foreground">
                      Track de arbitrage score na elke trade om te zien hoe de positie evolueert:
                    </p>
                    <CodeBlock>{`interface TimelineEvent {
  timestamp: Date;
  outcome: string;
  trade: Trade;
  outcomeAvgPrice: number;      // Running avg voor dit outcome
  otherOutcomeAvgPrice: number; // Running avg voor andere kant
  arbitrageScore: number;       // Som van beide averages
  reason: string;               // Uitleg waarom deze trade
}

function buildTimeline(trades: Trade[]): TimelineEvent[] {
  const sorted = trades.sort((a, b) => 
    a.timestamp.getTime() - b.timestamp.getTime()
  );

  const timeline: TimelineEvent[] = [];
  const runningState: Record<string, { shares: number; cost: number }> = {};

  sorted.forEach(trade => {
    // Initialize if needed
    if (!runningState[trade.outcome]) {
      runningState[trade.outcome] = { shares: 0, cost: 0 };
    }

    const prevAvg = runningState[trade.outcome].shares > 0
      ? runningState[trade.outcome].cost / runningState[trade.outcome].shares
      : 0;

    // Update running state
    runningState[trade.outcome].shares += trade.shares;
    runningState[trade.outcome].cost += trade.total;

    const newAvg = runningState[trade.outcome].cost / 
                   runningState[trade.outcome].shares;

    // Find other outcome
    const otherOutcome = Object.keys(runningState)
      .find(o => o !== trade.outcome);
    const otherAvg = otherOutcome && runningState[otherOutcome].shares > 0
      ? runningState[otherOutcome].cost / runningState[otherOutcome].shares
      : 0;

    // Calculate score
    const arbScore = otherAvg > 0 ? newAvg + otherAvg : 0;

    // Determine reason
    let reason = '';
    if (prevAvg === 0) {
      reason = \`Eerste \${trade.outcome} positie\`;
    } else if (trade.price < prevAvg) {
      reason = \`Middelen: \${(prevAvg*100).toFixed(1)}¢ → \${(newAvg*100).toFixed(1)}¢\`;
    } else {
      reason = \`Bijkopen @ \${(trade.price*100).toFixed(1)}¢\`;
    }

    timeline.push({
      timestamp: trade.timestamp,
      outcome: trade.outcome,
      trade,
      outcomeAvgPrice: newAvg,
      otherOutcomeAvgPrice: otherAvg,
      arbitrageScore: arbScore,
      reason,
    });
  });

  return timeline;
}`}</CodeBlock>
                  </AccordionContent>
                </AccordionItem>
              </Accordion>
            </div>
          </section>

          {/* Chapter 7: DCA */}
          <section id="dca" className="glass rounded-lg overflow-hidden">
            <div className="p-6 border-b border-border/50 flex items-center gap-3">
              <Calculator className="w-5 h-5 text-primary" />
              <h2 className="text-xl font-bold">7. Dollar Cost Averaging (DCA)</h2>
            </div>
            <div className="p-6">
              <Accordion type="multiple" className="space-y-2">
                <AccordionItem value="dca-concept">
                  <AccordionTrigger className="text-sm font-semibold">7.1 Concept</AccordionTrigger>
                  <AccordionContent className="space-y-4">
                    <p className="text-muted-foreground">
                      DCA betekent bijkopen bij lagere prijzen om je gemiddelde entry te verlagen:
                    </p>
                    <div className="bg-card/50 rounded-lg p-4 font-mono text-sm">
                      <p className="text-muted-foreground mb-2">Voorbeeld:</p>
                      <p>• 1e buy: 100 shares @ 60¢ = $60.00</p>
                      <p>• 2e buy: 100 shares @ 40¢ = $40.00</p>
                      <p className="border-t border-border/50 mt-2 pt-2 text-success">
                        → Totaal: 200 shares @ 50¢ gemiddeld (was 60¢)
                      </p>
                    </div>
                  </AccordionContent>
                </AccordionItem>

                <AccordionItem value="dca-formula">
                  <AccordionTrigger className="text-sm font-semibold">7.2 Formule</AccordionTrigger>
                  <AccordionContent className="space-y-4">
                    <CodeBlock>{`// Bereken nieuwe gemiddelde prijs na bijkopen
function calculateNewAverage(
  currentShares: number,
  currentAvgPrice: number,
  newShares: number,
  newPrice: number
): number {
  const currentCost = currentShares * currentAvgPrice;
  const newCost = newShares * newPrice;
  const totalShares = currentShares + newShares;
  const totalCost = currentCost + newCost;
  
  return totalCost / totalShares;
}

// Voorbeeld:
const newAvg = calculateNewAverage(100, 0.60, 100, 0.40);
// Result: 0.50 (50¢)`}</CodeBlock>
                  </AccordionContent>
                </AccordionItem>

                <AccordionItem value="dca-target">
                  <AccordionTrigger className="text-sm font-semibold">7.3 Target Prijs Berekenen</AccordionTrigger>
                  <AccordionContent className="space-y-4">
                    <p className="text-muted-foreground">
                      Bereken hoeveel je moet bijkopen om een target gemiddelde te bereiken:
                    </p>
                    <CodeBlock>{`// Bereken hoeveel shares je moet kopen bij prijs X
// om gemiddelde te verlagen naar target Y
function calculateSharesNeeded(
  currentShares: number,
  currentAvgPrice: number,
  buyPrice: number,
  targetAvgPrice: number
): number {
  // Formule: (currentShares * currentAvg + newShares * buyPrice) / 
  //          (currentShares + newShares) = targetAvg
  
  // Oplossen voor newShares:
  const numerator = currentShares * (currentAvgPrice - targetAvgPrice);
  const denominator = targetAvgPrice - buyPrice;
  
  if (denominator <= 0) {
    throw new Error('Buy price must be lower than target average');
  }
  
  return numerator / denominator;
}

// Voorbeeld: Je hebt 100 shares @ 60¢, prijs is nu 35¢
// Hoeveel kopen om gemiddelde naar 45¢ te krijgen?
const needed = calculateSharesNeeded(100, 0.60, 0.35, 0.45);
// Result: 150 shares`}</CodeBlock>
                  </AccordionContent>
                </AccordionItem>
              </Accordion>
            </div>
          </section>

          {/* Chapter 8: Real-time */}
          <section id="realtime" className="glass rounded-lg overflow-hidden">
            <div className="p-6 border-b border-border/50 flex items-center gap-3">
              <RefreshCw className="w-5 h-5 text-primary" />
              <h2 className="text-xl font-bold">8. Real-time Updates</h2>
            </div>
            <div className="p-6">
              <Accordion type="multiple" className="space-y-2">
                <AccordionItem value="polling">
                  <AccordionTrigger className="text-sm font-semibold">8.1 Polling met TanStack Query</AccordionTrigger>
                  <AccordionContent className="space-y-4">
                    <CodeBlock>{`// Auto-refresh elke 30 seconden
const tradesQuery = useQuery({
  queryKey: ['trades', username],
  refetchInterval: 30000,  // 30 seconden
  refetchIntervalInBackground: true,  // Ook als tab niet actief
  queryFn: async () => {
    // ... fetch logic
  },
});`}</CodeBlock>
                  </AccordionContent>
                </AccordionItem>

                <AccordionItem value="supabase-realtime">
                  <AccordionTrigger className="text-sm font-semibold">8.2 Supabase Realtime (Geavanceerd)</AccordionTrigger>
                  <AccordionContent className="space-y-4">
                    <p className="text-muted-foreground">
                      Voor instant updates zonder polling, gebruik Supabase Realtime:
                    </p>
                    <CodeBlock>{`// Enable realtime op de tabel (SQL)
ALTER PUBLICATION supabase_realtime ADD TABLE public.trades;

// React hook voor realtime updates
function useRealtimeTrades(username: string) {
  const [trades, setTrades] = useState<Trade[]>([]);

  useEffect(() => {
    // Initial fetch
    fetchTrades().then(setTrades);

    // Subscribe to changes
    const channel = supabase
      .channel('trades-changes')
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'trades',
          filter: \`trader_username=eq.\${username}\`,
        },
        (payload) => {
          setTrades(prev => [payload.new as Trade, ...prev]);
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [username]);

  return trades;
}`}</CodeBlock>
                  </AccordionContent>
                </AccordionItem>
              </Accordion>
            </div>
          </section>

          {/* Chapter 9: Deployment */}
          <section id="deployment" className="glass rounded-lg overflow-hidden">
            <div className="p-6 border-b border-border/50 flex items-center gap-3">
              <Shield className="w-5 h-5 text-primary" />
              <h2 className="text-xl font-bold">9. Deployment & Monitoring</h2>
            </div>
            <div className="p-6">
              <Accordion type="multiple" className="space-y-2">
                <AccordionItem value="lovable-deploy">
                  <AccordionTrigger className="text-sm font-semibold">9.1 Lovable Deployment</AccordionTrigger>
                  <AccordionContent className="space-y-4">
                    <p className="text-muted-foreground">
                      Bij Lovable worden Edge Functions automatisch gedeployed wanneer je code pusht.
                      Frontend changes vereisen een expliciete "Update" via de Publish knop.
                    </p>
                    <div className="grid grid-cols-2 gap-4 text-sm">
                      <div className="bg-card/50 rounded-lg p-4">
                        <h4 className="font-semibold text-success mb-2">✓ Automatisch</h4>
                        <ul className="space-y-1 text-muted-foreground">
                          <li>• Edge Functions</li>
                          <li>• Database migraties</li>
                        </ul>
                      </div>
                      <div className="bg-card/50 rounded-lg p-4">
                        <h4 className="font-semibold text-warning mb-2">⚡ Handmatig</h4>
                        <ul className="space-y-1 text-muted-foreground">
                          <li>• Frontend (Publish → Update)</li>
                        </ul>
                      </div>
                    </div>
                  </AccordionContent>
                </AccordionItem>

                <AccordionItem value="monitoring">
                  <AccordionTrigger className="text-sm font-semibold">9.2 Logging & Monitoring</AccordionTrigger>
                  <AccordionContent className="space-y-4">
                    <CodeBlock>{`// Goede logging in Edge Functions
serve(async (req) => {
  console.info(\`[scrape-polymarket] Starting for \${username}\`);
  
  try {
    const activities = await fetchAllActivities(wallet);
    console.info(\`[scrape-polymarket] Fetched \${activities.length} activities\`);
    
    // ... processing
    
    console.info(\`[scrape-polymarket] Stored \${trades.length} trades\`);
    
  } catch (error) {
    console.error(\`[scrape-polymarket] Error:\`, error);
    // Logs zijn zichtbaar in Supabase Dashboard → Logs
  }
});`}</CodeBlock>
                  </AccordionContent>
                </AccordionItem>

                <AccordionItem value="cron">
                  <AccordionTrigger className="text-sm font-semibold">9.3 Scheduled Scraping (Cron)</AccordionTrigger>
                  <AccordionContent className="space-y-4">
                    <p className="text-muted-foreground">
                      Automatisch scrapen met pg_cron:
                    </p>
                    <CodeBlock>{`-- Enable extensions (eenmalig)
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Schedule scrape elke 5 minuten
SELECT cron.schedule(
  'scrape-polymarket-every-5-min',
  '*/5 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://your-project.supabase.co/functions/v1/scrape-polymarket',
    headers := '{"Content-Type": "application/json", "Authorization": "Bearer YOUR_ANON_KEY"}'::jsonb,
    body := '{"username": "gabagool22"}'::jsonb
  );
  $$
);

-- Bekijk scheduled jobs
SELECT * FROM cron.job;

-- Verwijder een job
SELECT cron.unschedule('scrape-polymarket-every-5-min');`}</CodeBlock>
                  </AccordionContent>
                </AccordionItem>
              </Accordion>
            </div>
          </section>

        </div>

        {/* Footer */}
        <div className="mt-12 text-center py-8 border-t border-border/50">
          <p className="text-sm text-muted-foreground">
            Vragen? Check de broncode of open een issue op GitHub.
          </p>
          <Link to="/" className="text-sm text-primary hover:underline mt-2 inline-block">
            ← Terug naar Dashboard
          </Link>
        </div>
      </main>
    </div>
  );
};

export default DevGuide;
