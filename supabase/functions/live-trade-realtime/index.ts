import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ============================================================================
// LIVE TRADING BOT - Real-time WebSocket Worker
// Continuously monitors markets and executes trades when enabled
// ============================================================================

const POLYMARKET_CLOB_HOST = 'https://clob.polymarket.com';
const GAMMA_API = 'https://gamma-api.polymarket.com';

interface MarketData {
  slug: string;
  asset: string;
  upTokenId: string;
  downTokenId: string;
  eventStartTime: string;
  eventEndTime: string;
}

interface TokenPrice {
  tokenId: string;
  bid: number;
  ask: number;
  mid: number;
}

// Strategy config (20x smaller than paper trading)
const STRATEGY = {
  opening: { shares: 5, maxPrice: 0.55 },
  hedge: { shares: 5, maxCombined: 0.97 },
  accumulate: { minShares: 1, maxShares: 3, maxCombined: 0.99, maxPositionPerSide: 25 },
  minSecondsRemaining: 60,
  minPrice: 0.02,
  maxPrice: 0.98,
};

Deno.serve(async (req) => {
  const { headers } = req;
  const upgradeHeader = headers.get("upgrade") || "";

  if (upgradeHeader.toLowerCase() !== "websocket") {
    return new Response("Live Trade Bot WebSocket - Expected WebSocket connection", { 
      status: 200,
      headers: { 'Content-Type': 'text/plain' }
    });
  }

  const { socket, response } = Deno.upgradeWebSocket(req);
  
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, supabaseKey);

  let isRunning = true;
  let isEnabled = false;
  let markets: MarketData[] = [];
  let prices: Map<string, TokenPrice> = new Map();
  let positions: Map<string, { upShares: number; downShares: number }> = new Map();

  const log = (msg: string) => {
    console.log(`[LiveBot] ${msg}`);
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'log', message: msg, timestamp: Date.now() }));
    }
  };

  const sendStatus = () => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({
        type: 'status',
        isEnabled,
        marketsCount: markets.length,
        positionsCount: positions.size,
        timestamp: Date.now(),
      }));
    }
  };

  // Check if bot is enabled in database
  const checkEnabled = async (): Promise<boolean> => {
    try {
      const { data } = await supabase
        .from('live_bot_settings')
        .select('is_enabled')
        .eq('id', '00000000-0000-0000-0000-000000000001')
        .single();
      return data?.is_enabled ?? false;
    } catch {
      return false;
    }
  };

  // Fetch active markets
  const fetchMarkets = async (): Promise<MarketData[]> => {
    try {
      const now = new Date();
      const response = await fetch(`${GAMMA_API}/markets?closed=false&active=true&limit=50`);
      if (!response.ok) return [];
      
      const data = await response.json();
      const cryptoMarkets: MarketData[] = [];

      for (const market of data) {
        // Only crypto price markets
        if (!market.enableOrderBook) continue;
        const slug = market.slug || market.conditionId;
        if (!slug) continue;

        // Check if it's a crypto price market
        const question = (market.question || '').toLowerCase();
        const assets = ['btc', 'eth', 'sol', 'xrp'];
        let asset = '';
        for (const a of assets) {
          if (question.includes(a) || slug.toLowerCase().includes(a)) {
            asset = a.toUpperCase();
            break;
          }
        }
        if (!asset) continue;

        // Get token IDs
        const outcomes = market.outcomes || [];
        if (outcomes.length < 2) continue;
        
        const upTokenId = market.clobTokenIds?.[0] || '';
        const downTokenId = market.clobTokenIds?.[1] || '';
        if (!upTokenId || !downTokenId) continue;

        const endTime = new Date(market.endDate || market.endDateIso);
        if (endTime <= now) continue;

        cryptoMarkets.push({
          slug,
          asset,
          upTokenId,
          downTokenId,
          eventStartTime: market.startDate || market.startDateIso || '',
          eventEndTime: market.endDate || market.endDateIso || '',
        });
      }

      return cryptoMarkets;
    } catch (err) {
      log(`Error fetching markets: ${err}`);
      return [];
    }
  };

  // Fetch CLOB prices
  const fetchPrices = async (tokenIds: string[]): Promise<Map<string, TokenPrice>> => {
    const priceMap = new Map<string, TokenPrice>();
    if (tokenIds.length === 0) return priceMap;

    try {
      const booksUrl = `${POLYMARKET_CLOB_HOST}/books?token_ids=${tokenIds.join(',')}`;
      const response = await fetch(booksUrl);
      if (!response.ok) return priceMap;

      const books = await response.json();
      for (const book of books) {
        const tokenId = book.asset_id;
        const bids = book.bids || [];
        const asks = book.asks || [];
        
        const bestBid = bids.length > 0 ? parseFloat(bids[0].price) : 0;
        const bestAsk = asks.length > 0 ? parseFloat(asks[0].price) : 1;
        
        priceMap.set(tokenId, {
          tokenId,
          bid: bestBid,
          ask: bestAsk,
          mid: (bestBid + bestAsk) / 2,
        });
      }
    } catch (err) {
      log(`Error fetching prices: ${err}`);
    }

    return priceMap;
  };

  // Load current positions from database
  const loadPositions = async () => {
    try {
      const { data: trades } = await supabase
        .from('live_trades')
        .select('market_slug, outcome, shares')
        .order('created_at', { ascending: false });

      const { data: results } = await supabase
        .from('live_trade_results')
        .select('market_slug, settled_at')
        .not('settled_at', 'is', null);

      const settledSlugs = new Set(results?.map(r => r.market_slug) || []);
      positions.clear();

      for (const trade of trades || []) {
        if (settledSlugs.has(trade.market_slug)) continue;

        if (!positions.has(trade.market_slug)) {
          positions.set(trade.market_slug, { upShares: 0, downShares: 0 });
        }
        const pos = positions.get(trade.market_slug)!;
        if (trade.outcome === 'UP') {
          pos.upShares += trade.shares;
        } else {
          pos.downShares += trade.shares;
        }
      }
    } catch (err) {
      log(`Error loading positions: ${err}`);
    }
  };

  // Execute trade via live-trade-bot function
  const executeTrade = async (
    market: MarketData,
    outcome: 'UP' | 'DOWN',
    price: number,
    shares: number,
    reasoning: string
  ): Promise<boolean> => {
    try {
      const tokenId = outcome === 'UP' ? market.upTokenId : market.downTokenId;
      
      log(`📊 Executing: ${outcome} ${shares} @ ${price.toFixed(2)} on ${market.slug}`);
      
      // Call live-trade-bot to place order
      const { data, error } = await supabase.functions.invoke('live-trade-bot', {
        body: {
          action: 'order',
          tokenId,
          side: 'BUY',
          price,
          size: shares,
          orderType: 'GTC',
          marketSlug: market.slug,
        },
      });

      if (error || !data?.success) {
        log(`❌ Order failed: ${error?.message || data?.error || 'Unknown error'}`);
        return false;
      }

      // Record trade in database
      await supabase.from('live_trades').insert({
        market_slug: market.slug,
        asset: market.asset,
        outcome,
        shares,
        price,
        total: shares * price,
        order_id: data.orderId,
        status: 'filled',
        reasoning,
        event_start_time: market.eventStartTime,
        event_end_time: market.eventEndTime,
      });

      // Update local positions
      if (!positions.has(market.slug)) {
        positions.set(market.slug, { upShares: 0, downShares: 0 });
      }
      const pos = positions.get(market.slug)!;
      if (outcome === 'UP') {
        pos.upShares += shares;
      } else {
        pos.downShares += shares;
      }

      log(`✅ Trade executed: ${outcome} ${shares} shares`);
      
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
          type: 'trade',
          market: market.slug,
          outcome,
          shares,
          price,
          orderId: data.orderId,
          timestamp: Date.now(),
        }));
      }

      return true;
    } catch (err) {
      log(`❌ Trade error: ${err}`);
      return false;
    }
  };

  // Analyze and trade
  const analyzeAndTrade = async () => {
    if (!isEnabled || markets.length === 0) return;

    const now = Date.now();

    for (const market of markets) {
      const endTime = new Date(market.eventEndTime).getTime();
      const remainingSeconds = (endTime - now) / 1000;

      if (remainingSeconds < STRATEGY.minSecondsRemaining) continue;

      const upPrice = prices.get(market.upTokenId);
      const downPrice = prices.get(market.downTokenId);

      if (!upPrice || !downPrice) continue;

      const pos = positions.get(market.slug) || { upShares: 0, downShares: 0 };
      const combinedPrice = upPrice.ask + downPrice.ask;

      // Opening trade: buy if price is low and we have no position
      if (pos.upShares === 0 && pos.downShares === 0) {
        if (upPrice.ask <= STRATEGY.opening.maxPrice && upPrice.ask >= STRATEGY.minPrice) {
          await executeTrade(market, 'UP', upPrice.ask, STRATEGY.opening.shares, 
            `Opening: UP @ ${upPrice.ask.toFixed(2)} (combined: ${combinedPrice.toFixed(2)})`);
        } else if (downPrice.ask <= STRATEGY.opening.maxPrice && downPrice.ask >= STRATEGY.minPrice) {
          await executeTrade(market, 'DOWN', downPrice.ask, STRATEGY.opening.shares,
            `Opening: DOWN @ ${downPrice.ask.toFixed(2)} (combined: ${combinedPrice.toFixed(2)})`);
        }
        continue;
      }

      // Hedge: buy opposite side if combined < threshold
      if (combinedPrice <= STRATEGY.hedge.maxCombined) {
        if (pos.upShares > 0 && pos.downShares === 0 && downPrice.ask >= STRATEGY.minPrice) {
          await executeTrade(market, 'DOWN', downPrice.ask, STRATEGY.hedge.shares,
            `Hedge: DOWN @ ${downPrice.ask.toFixed(2)} (combined: ${combinedPrice.toFixed(2)})`);
        } else if (pos.downShares > 0 && pos.upShares === 0 && upPrice.ask >= STRATEGY.minPrice) {
          await executeTrade(market, 'UP', upPrice.ask, STRATEGY.hedge.shares,
            `Hedge: UP @ ${upPrice.ask.toFixed(2)} (combined: ${combinedPrice.toFixed(2)})`);
        }
      }

      // Accumulate: add to positions if combined is still good
      if (combinedPrice <= STRATEGY.accumulate.maxCombined) {
        const accShares = Math.max(STRATEGY.accumulate.minShares, 
          Math.min(STRATEGY.accumulate.maxShares, Math.floor((1 - combinedPrice) * 10)));

        if (pos.upShares < STRATEGY.accumulate.maxPositionPerSide && upPrice.ask >= STRATEGY.minPrice && upPrice.ask <= STRATEGY.maxPrice) {
          await executeTrade(market, 'UP', upPrice.ask, accShares,
            `Accumulate: UP @ ${upPrice.ask.toFixed(2)} (shares: ${pos.upShares + accShares})`);
        }
        if (pos.downShares < STRATEGY.accumulate.maxPositionPerSide && downPrice.ask >= STRATEGY.minPrice && downPrice.ask <= STRATEGY.maxPrice) {
          await executeTrade(market, 'DOWN', downPrice.ask, accShares,
            `Accumulate: DOWN @ ${downPrice.ask.toFixed(2)} (shares: ${pos.downShares + accShares})`);
        }
      }
    }
  };

  // Check for expired markets and redeem on-chain
  const checkAndRedeem = async () => {
    const now = new Date();

    for (const [slug, pos] of positions.entries()) {
      const market = markets.find(m => m.slug === slug);
      if (!market) continue;

      const endTime = new Date(market.eventEndTime);
      if (endTime > now) continue;

      // Market has expired - check for settlement
      log(`🔄 Market expired: ${slug}, checking for redemption...`);

      try {
        // Fetch market result from Gamma API
        const resultResponse = await fetch(`${GAMMA_API}/markets/${slug}`);
        if (!resultResponse.ok) continue;

        const marketData = await resultResponse.json();
        const result = marketData.outcome?.toUpperCase();
        const conditionId = marketData.conditionId;

        if (!result || (result !== 'UP' && result !== 'DOWN' && result !== 'YES' && result !== 'NO')) {
          log(`Market ${slug} not yet resolved`);
          continue;
        }

        if (!conditionId) {
          log(`Market ${slug} has no conditionId, skipping on-chain redeem`);
          continue;
        }

        const winningOutcome = result === 'YES' ? 'UP' : result === 'NO' ? 'DOWN' : result;
        const winningShares = winningOutcome === 'UP' ? pos.upShares : pos.downShares;
        
        // Try to redeem on-chain via live-trade-bot
        log(`💰 Attempting on-chain redemption for ${slug} (condition: ${conditionId.slice(0, 20)}...)`);
        
        const { data: redeemResult, error: redeemError } = await supabase.functions.invoke('live-trade-bot', {
          body: {
            action: 'redeem',
            conditionId,
          },
        });

        let redeemedAmount = 0;
        let redeemSuccess = false;
        let redeemTxHash = null;

        if (redeemError) {
          log(`⚠️ Redeem invoke error: ${redeemError.message}`);
        } else if (redeemResult?.success) {
          redeemSuccess = true;
          redeemedAmount = redeemResult.redeemedAmount || 0;
          redeemTxHash = redeemResult.txHash;
          log(`✅ On-chain redeem successful: ${redeemedAmount} USDC (tx: ${redeemTxHash?.slice(0, 20)}...)`);
        } else {
          log(`⚠️ Redeem failed: ${redeemResult?.error || 'Unknown error'}`);
        }

        // Calculate P&L
        const payout = redeemSuccess ? redeemedAmount : winningShares; // Fallback to estimated if on-chain failed
        const totalInvested = (pos.upShares + pos.downShares) * 0.5; // Approximate
        const profitLoss = payout - totalInvested;

        // Record result in database
        await supabase.from('live_trade_results').upsert({
          market_slug: slug,
          asset: market.asset,
          result: winningOutcome,
          up_shares: pos.upShares,
          down_shares: pos.downShares,
          total_invested: totalInvested,
          payout,
          profit_loss: profitLoss,
          profit_loss_percent: totalInvested > 0 ? (profitLoss / totalInvested) * 100 : 0,
          event_end_time: market.eventEndTime,
          settled_at: new Date().toISOString(),
        }, { onConflict: 'market_slug' });

        log(`✅ Settled ${slug}: ${winningOutcome} won, payout: $${payout.toFixed(2)}, P/L: $${profitLoss.toFixed(2)}${redeemSuccess ? ' (on-chain)' : ' (estimated)'}`);
        
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({
            type: 'redemption',
            market: slug,
            result: winningOutcome,
            payout,
            profitLoss,
            redeemSuccess,
            redeemTxHash,
            timestamp: Date.now(),
          }));
        }

        positions.delete(slug);
      } catch (err) {
        log(`Error checking redemption for ${slug}: ${err}`);
      }
    }
  };

  // Main loop
  const runLoop = async () => {
    log('🚀 Live trading bot started');
    
    while (isRunning) {
      try {
        // Check if enabled
        const wasEnabled = isEnabled;
        isEnabled = await checkEnabled();
        
        if (isEnabled !== wasEnabled) {
          log(isEnabled ? '✅ Bot ENABLED' : '⏸️ Bot DISABLED');
          sendStatus();
        }

        if (isEnabled) {
          // Refresh markets every 5 loops
          markets = await fetchMarkets();
          log(`📈 Monitoring ${markets.length} markets`);

          // Get all token IDs
          const tokenIds: string[] = [];
          for (const m of markets) {
            tokenIds.push(m.upTokenId, m.downTokenId);
          }

          // Fetch prices
          prices = await fetchPrices(tokenIds);

          // Load positions
          await loadPositions();

          // Analyze and trade
          await analyzeAndTrade();

          // Check for redemptions
          await checkAndRedeem();

          sendStatus();
        }

        // Wait before next iteration (10 seconds when enabled, 30 when disabled)
        await new Promise(resolve => setTimeout(resolve, isEnabled ? 10000 : 30000));
      } catch (err) {
        log(`Loop error: ${err}`);
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }

    log('🛑 Live trading bot stopped');
  };

  socket.onopen = () => {
    log('WebSocket connected');
    runLoop();
  };

  socket.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      
      if (data.type === 'ping') {
        socket.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
      } else if (data.type === 'status') {
        sendStatus();
      }
    } catch {
      // Ignore parse errors
    }
  };

  socket.onerror = (error) => {
    log(`WebSocket error: ${error}`);
  };

  socket.onclose = () => {
    log('WebSocket closed');
    isRunning = false;
  };

  return response;
});
