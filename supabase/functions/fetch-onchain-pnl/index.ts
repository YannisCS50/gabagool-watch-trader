// ============================================================
// Fetch On-Chain P&L - Get actual USDC transfers from Polygonscan
// This calculates real P&L from on-chain token transfers
// ============================================================

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// USDC on Polygon
const USDC_CONTRACT = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const POLYGONSCAN_API = 'https://api.polygonscan.com/api';

interface TokenTransfer {
  blockNumber: string;
  timeStamp: string;
  hash: string;
  from: string;
  to: string;
  value: string;
  tokenName: string;
  tokenSymbol: string;
  tokenDecimal: string;
}

interface PnLResult {
  wallet: string;
  totalUsdcIn: number;
  totalUsdcOut: number;
  netPnL: number;
  transactionCount: number;
  firstTxDate: string | null;
  lastTxDate: string | null;
  polymarketInteractions: number;
}

// Known Polymarket contracts on Polygon
const POLYMARKET_CONTRACTS = new Set([
  '0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e', // CTF Exchange
  '0x4d97dcd97ec945f40cf65f87097ace5ea0476045', // Neg Risk CTF Exchange
  '0x9c0a4f1f7b7c00c5fcd67ecf4f4c9d2b0c8e9b8a', // Another exchange
  '0x7afe30cb3e53dba6801aa0ea647a0ecea7cbe18d', // Conditional Tokens
].map(a => a.toLowerCase()));

async function fetchAllTokenTransfers(
  wallet: string, 
  apiKey: string
): Promise<TokenTransfer[]> {
  const allTransfers: TokenTransfer[] = [];
  let page = 1;
  const pageSize = 10000;
  
  console.log(`[onchain-pnl] Fetching USDC transfers for ${wallet}...`);
  
  while (true) {
    const url = new URL(POLYGONSCAN_API);
    url.searchParams.set('module', 'account');
    url.searchParams.set('action', 'tokentx');
    url.searchParams.set('contractaddress', USDC_CONTRACT);
    url.searchParams.set('address', wallet);
    url.searchParams.set('page', String(page));
    url.searchParams.set('offset', String(pageSize));
    url.searchParams.set('sort', 'asc');
    url.searchParams.set('apikey', apiKey);
    
    const response = await fetch(url.toString());
    const data = await response.json();
    
    if (data.status !== '1' || !data.result || data.result.length === 0) {
      if (data.message === 'No transactions found') {
        console.log(`[onchain-pnl] No more transactions at page ${page}`);
      } else if (data.status !== '1') {
        console.error(`[onchain-pnl] API error:`, data.message);
      }
      break;
    }
    
    allTransfers.push(...data.result);
    console.log(`[onchain-pnl] Page ${page}: ${data.result.length} transfers (total: ${allTransfers.length})`);
    
    if (data.result.length < pageSize) break;
    page++;
    
    // Rate limit: 5 calls/sec for free tier
    await new Promise(r => setTimeout(r, 250));
  }
  
  return allTransfers;
}

function computePnL(transfers: TokenTransfer[], wallet: string): PnLResult {
  const walletLower = wallet.toLowerCase();
  let totalUsdcIn = 0;
  let totalUsdcOut = 0;
  let polymarketInteractions = 0;
  let firstTs: number | null = null;
  let lastTs: number | null = null;
  
  for (const tx of transfers) {
    const value = Number(tx.value) / 1e6; // USDC has 6 decimals
    const ts = Number(tx.timeStamp);
    const fromLower = tx.from.toLowerCase();
    const toLower = tx.to.toLowerCase();
    
    // Track timestamps
    if (!firstTs || ts < firstTs) firstTs = ts;
    if (!lastTs || ts > lastTs) lastTs = ts;
    
    // Check if Polymarket related
    const isPolymarket = POLYMARKET_CONTRACTS.has(fromLower) || POLYMARKET_CONTRACTS.has(toLower);
    if (isPolymarket) polymarketInteractions++;
    
    // USDC coming INTO wallet
    if (toLower === walletLower) {
      totalUsdcIn += value;
    }
    
    // USDC going OUT of wallet
    if (fromLower === walletLower) {
      totalUsdcOut += value;
    }
  }
  
  return {
    wallet,
    totalUsdcIn,
    totalUsdcOut,
    netPnL: totalUsdcIn - totalUsdcOut,
    transactionCount: transfers.length,
    firstTxDate: firstTs ? new Date(firstTs * 1000).toISOString() : null,
    lastTxDate: lastTs ? new Date(lastTs * 1000).toISOString() : null,
    polymarketInteractions,
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const apiKey = Deno.env.get('POLYGONSCAN_API_KEY');
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'POLYGONSCAN_API_KEY not configured' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  try {
    // Get wallet from request or use default from bot_config
    let wallet: string;
    
    const url = new URL(req.url);
    const queryWallet = url.searchParams.get('wallet');
    
    if (queryWallet) {
      wallet = queryWallet;
    } else {
      // Fetch from Supabase
      const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2');
      const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
      const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
      const supabase = createClient(supabaseUrl, supabaseKey);
      
      const { data: config } = await supabase
        .from('bot_config')
        .select('polymarket_address')
        .limit(1)
        .single();
      
      if (!config?.polymarket_address) {
        return new Response(JSON.stringify({ error: 'No wallet configured' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      wallet = config.polymarket_address;
    }

    console.log(`[onchain-pnl] Analyzing wallet: ${wallet}`);
    
    // Fetch all USDC transfers
    const transfers = await fetchAllTokenTransfers(wallet, apiKey);
    console.log(`[onchain-pnl] Found ${transfers.length} total USDC transfers`);
    
    // Compute P&L
    const pnl = computePnL(transfers, wallet);
    console.log(`[onchain-pnl] Result:`, JSON.stringify(pnl));

    return new Response(JSON.stringify({
      ...pnl,
      message: `Analyzed ${transfers.length} on-chain USDC transfers`,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (err) {
    console.error('[onchain-pnl] Error:', err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
