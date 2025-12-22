export interface Trade {
  id: string;
  timestamp: Date;
  market: string;
  marketSlug: string;
  outcome: 'Yes' | 'No';
  side: 'buy' | 'sell';
  shares: number;
  price: number;
  total: number;
  status: 'filled' | 'pending' | 'cancelled';
}

export interface TraderStats {
  totalTrades: number;
  totalVolume: number;
  winRate: number;
  avgTradeSize: number;
  activeSince: Date;
  lastActive: Date;
}

export interface MarketPosition {
  market: string;
  marketSlug: string;
  outcome: 'Yes' | 'No';
  shares: number;
  avgPrice: number;
  currentPrice: number;
  pnl: number;
  pnlPercent: number;
}
