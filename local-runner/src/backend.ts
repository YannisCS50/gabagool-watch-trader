import { config } from './config.js';

interface MarketToken {
  slug: string;
  asset: string;
  upTokenId: string;
  downTokenId: string;
  eventStartTime: string;
  eventEndTime: string;
  marketType: string;
}

interface Trade {
  market_slug: string;
  outcome: string;
  shares: number;
  total: number;
}

interface TradeInsert {
  market_slug: string;
  asset: string;
  outcome: string;
  shares: number;
  price: number;
  total: number;
  order_id?: string;
  status: string;
  reasoning: string;
  event_start_time: string;
  event_end_time: string;
  avg_fill_price: number;
}

interface HeartbeatData {
  runner_id: string;
  runner_type: string;
  last_heartbeat: string;
  status: string;
  markets_count: number;
  positions_count: number;
  trades_count: number;
  balance: number;
  version: string;
}

async function callProxy<T>(action: string, data?: Record<string, unknown>): Promise<T> {
  const response = await fetch(config.backend.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Runner-Secret': config.backend.secret,
    },
    body: JSON.stringify({ action, data }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Backend error ${response.status}: ${text}`);
  }

  return response.json();
}

export async function fetchMarkets(): Promise<{ success: boolean; markets?: MarketToken[] }> {
  try {
    const result = await callProxy<{ success: boolean; markets?: MarketToken[] }>('get-markets');
    return result;
  } catch (error) {
    console.error('❌ fetchMarkets error:', error);
    return { success: false };
  }
}

export async function fetchTrades(slugs: string[]): Promise<Trade[]> {
  if (slugs.length === 0) return [];
  
  try {
    const result = await callProxy<{ success: boolean; trades?: Trade[] }>('get-trades', { slugs });
    return result.trades || [];
  } catch (error) {
    console.error('❌ fetchTrades error:', error);
    return [];
  }
}

export async function saveTrade(trade: TradeInsert): Promise<boolean> {
  try {
    const result = await callProxy<{ success: boolean }>('save-trade', { trade });
    return result.success;
  } catch (error) {
    console.error('❌ saveTrade error:', error);
    return false;
  }
}

export async function sendHeartbeat(heartbeat: HeartbeatData): Promise<boolean> {
  try {
    const result = await callProxy<{ success: boolean }>('heartbeat', { heartbeat });
    return result.success;
  } catch (error) {
    console.error('❌ sendHeartbeat error:', error);
    return false;
  }
}

export async function sendOffline(runnerId: string): Promise<void> {
  try {
    await callProxy('offline', { runner_id: runnerId });
  } catch (error) {
    console.error('❌ sendOffline error:', error);
  }
}
