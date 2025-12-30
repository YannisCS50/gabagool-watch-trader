import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  ArrowLeft,
  Zap,
  Wallet,
  RefreshCw,
  Bot,
  AlertTriangle,
  BarChart3,
  Activity,
} from 'lucide-react';
import { LiveTradeDashboard } from '@/components/LiveTradeDashboard';
import { LivePnLDashboard } from '@/components/LivePnLDashboard';
import { RunnerActivityLog } from '@/components/RunnerActivityLog';
import { MarketTradesLog } from '@/components/MarketTradesLog';
import { PaperTradeDashboard } from '@/components/PaperTradeDashboard';
import { RunnerStatus } from '@/components/RunnerStatus';
import { OrderQueueStatus } from '@/components/OrderQueueStatus';
import { RunnerInstructions } from '@/components/RunnerInstructions';
import { BotPositionsCard } from '@/components/BotPositionsCard';
import { supabase } from '@/integrations/supabase/client';

interface WalletBalance {
  usdc: string;
  usdt: string;
  matic: string;
}

interface Portfolio {
  totalValue: number;
  cashBalance: number;
  positionsValue: number;
  unrealizedPnl: number;
  realizedPnl: number;
  totalPnl: number;
}

interface Position {
  title: string;
  slug: string;
  outcome: string;
  size: number;
  avgPrice: number;
  currentPrice: number;
  currentValue: number;
  initialValue: number;
  cashPnl: number;
  percentPnl: number;
  redeemable: boolean;
  endDate: string;
}

export default function LiveTrading() {
  const [walletBalance, setWalletBalance] = useState<WalletBalance | null>(null);
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [positions, setPositions] = useState<Position[]>([]);
  const [isLoadingWallet, setIsLoadingWallet] = useState(true);

  const fetchBalances = async () => {
    setIsLoadingWallet(true);
    try {
      // Settle any expired trades first
      await supabase.functions.invoke('settle-live-trades', { body: {} });
      
      // Fetch wallet balance
      const { data: walletData } = await supabase.functions.invoke('live-trade-bot', {
        body: { action: 'wallet-balance' }
      });
      
      if (walletData?.balances) {
        setWalletBalance(walletData.balances);
      }

      // Fetch portfolio with positions from Polymarket
      const { data: portfolioData } = await supabase.functions.invoke('live-trade-bot', {
        body: { action: 'portfolio' }
      });
      
      if (portfolioData?.portfolio) {
        setPortfolio(portfolioData.portfolio);
      }
      if (portfolioData?.positions) {
        setPositions(portfolioData.positions);
      }
    } catch (err) {
      console.error('Error fetching balances:', err);
    } finally {
      setIsLoadingWallet(false);
    }
  };

  useEffect(() => {
    fetchBalances();
  }, []);

  return (
    <div className="min-h-screen bg-background">
      <div className="container mx-auto px-4 py-6 max-w-7xl">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-4">
            <Link to="/">
              <Button variant="ghost" size="icon">
                <ArrowLeft className="w-5 h-5" />
              </Button>
            </Link>
            <div>
              <h1 className="text-2xl font-bold flex items-center gap-3">
                <Zap className="w-7 h-7 text-red-500" />
                Live Trading
                <Badge variant="destructive">REAL $</Badge>
              </h1>
              <p className="text-muted-foreground text-sm">
                Live trading dashboard met echte posities
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Link to="/wallet">
              <Button variant="outline" size="sm">
                <Wallet className="w-4 h-4 mr-2" />
                Wallet
              </Button>
            </Link>
            <Button variant="outline" size="sm" onClick={fetchBalances} disabled={isLoadingWallet}>
              <RefreshCw className={`w-4 h-4 mr-2 ${isLoadingWallet ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
          </div>
        </div>

        {/* Portfolio Cards */}
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-8">
          <Card className="border-emerald-500/20 bg-gradient-to-br from-emerald-500/5 to-transparent">
            <CardContent className="p-4">
              <div className="text-sm text-muted-foreground mb-1">Portfolio Value</div>
              <div className="text-2xl font-bold font-mono text-emerald-500">
                ${portfolio ? portfolio.totalValue.toFixed(2) : '...'}
              </div>
              <div className="text-xs text-muted-foreground">Cash + Positions</div>
            </CardContent>
          </Card>

          <Card className="border-amber-500/20">
            <CardContent className="p-4">
              <div className="text-sm text-muted-foreground mb-1">Cash Balance</div>
              <div className="text-2xl font-bold font-mono">
                ${portfolio ? portfolio.cashBalance.toFixed(2) : '...'}
              </div>
              <div className="text-xs text-muted-foreground">Available USDC</div>
            </CardContent>
          </Card>
          
          <Card>
            <CardContent className="p-4">
              <div className="text-sm text-muted-foreground mb-1">Positions Value</div>
              <div className="text-2xl font-bold font-mono">
                ${portfolio ? portfolio.positionsValue.toFixed(2) : '...'}
              </div>
              <div className="text-xs text-muted-foreground">{positions.length} open positions</div>
            </CardContent>
          </Card>
          
          <Card className={portfolio && portfolio.totalPnl >= 0 ? "border-emerald-500/20" : "border-red-500/20"}>
            <CardContent className="p-4">
              <div className="text-sm text-muted-foreground mb-1">Total P/L</div>
              <div className={`text-2xl font-bold font-mono ${portfolio && portfolio.totalPnl >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
                {portfolio ? `${portfolio.totalPnl >= 0 ? '+' : ''}$${portfolio.totalPnl.toFixed(2)}` : '...'}
              </div>
              <div className="text-xs text-muted-foreground">Unrealized + Realized</div>
            </CardContent>
          </Card>
          
          <Card>
            <CardContent className="p-4">
              <div className="text-sm text-muted-foreground mb-1">Wallet USDC</div>
              <div className="text-2xl font-bold font-mono">
                ${walletBalance ? parseFloat(walletBalance.usdc).toFixed(2) : '...'}
              </div>
              <div className="text-xs text-muted-foreground">Ready to deposit</div>
            </CardContent>
          </Card>
        </div>

        {/* Runner Status & Instructions */}
        <div className="grid gap-4 md:grid-cols-2 mb-8">
          <RunnerStatus />
          <RunnerInstructions />
        </div>

        {/* Bot Positions from Polymarket Sync */}
        <div className="mb-8">
          <BotPositionsCard />
        </div>

        {/* Main Tabs */}
        <Tabs defaultValue="pnl" className="mb-8">
          <TabsList className="mb-4">
            <TabsTrigger value="pnl" className="flex items-center gap-2">
              <BarChart3 className="w-4 h-4" />
              P/L Dashboard
            </TabsTrigger>
            <TabsTrigger value="activity" className="flex items-center gap-2">
              <Activity className="w-4 h-4" />
              Activity & Orders
            </TabsTrigger>
          </TabsList>

          <TabsContent value="pnl" className="space-y-6">
            {/* P/L Dashboard */}
            <LivePnLDashboard />
          </TabsContent>

          <TabsContent value="activity" className="space-y-6">
            {/* Order Queue */}
            <OrderQueueStatus />

            {/* Market Trades Log - Categorized per bet */}
            <MarketTradesLog />

            {/* Runner Activity Log */}
            <RunnerActivityLog />

            {/* Live Trading Dashboard */}
            <LiveTradeDashboard />
          </TabsContent>
        </Tabs>

        {/* Paper Trading Comparison */}
        <Card className="mb-8">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Bot className="w-5 h-5 text-primary" />
              Paper Trading (ter vergelijking)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <PaperTradeDashboard compact />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
