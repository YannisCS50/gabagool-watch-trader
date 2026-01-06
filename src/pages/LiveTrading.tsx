import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  ArrowLeft,
  Zap,
  Wallet,
  RefreshCw,
  Bot,
  BarChart3,
  Activity,
  ChevronDown,
  Target,
} from 'lucide-react';
import { LiveTradeDashboard } from '@/components/LiveTradeDashboard';
import { LivePnLDashboard } from '@/components/LivePnLDashboard';
import { LiveHourlyPnL } from '@/components/LiveHourlyPnL';
import { LiveHourlyPnLChart } from '@/components/LiveHourlyPnLChart';
import { RunnerActivityLog } from '@/components/RunnerActivityLog';
import { MarketTradesLog } from '@/components/MarketTradesLog';
import { PaperTradeDashboard } from '@/components/PaperTradeDashboard';
import { RunnerStatus } from '@/components/RunnerStatus';
import { OrderQueueStatus } from '@/components/OrderQueueStatus';
import { RunnerInstructions } from '@/components/RunnerInstructions';
import { BotPositionsCard } from '@/components/BotPositionsCard';
import { LiveBotDataFeed } from '@/components/LiveBotDataFeed';
import { HedgeFeasibilityDashboard } from '@/components/HedgeFeasibilityDashboard';
import { RunnerConflictBanner } from '@/components/RunnerConflictBanner';
import { PositionCacheStatus } from '@/components/PositionCacheStatus';
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
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  const fetchBalances = async (silent = false) => {
    if (!silent) setIsLoadingWallet(true);
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
      setLastRefresh(new Date());
    } catch (err) {
      console.error('Error fetching balances:', err);
    } finally {
      if (!silent) setIsLoadingWallet(false);
    }
  };

  // Initial load
  useEffect(() => {
    fetchBalances();
  }, []);

  // Auto-refresh every 10 seconds for near-realtime updates
  useEffect(() => {
    const interval = setInterval(() => {
      fetchBalances(true); // silent refresh
    }, 10 * 1000);
    return () => clearInterval(interval);
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
          <div className="flex items-center gap-4">
            <PositionCacheStatus />
            {lastRefresh && (
              <span className="text-xs text-muted-foreground">
                Updated {lastRefresh.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
              </span>
            )}
            <Link to="/wallet">
              <Button variant="outline" size="sm">
                <Wallet className="w-4 h-4 mr-2" />
                Wallet
              </Button>
            </Link>
            <Button variant="outline" size="sm" onClick={() => fetchBalances(false)} disabled={isLoadingWallet}>
              <RefreshCw className={`w-4 h-4 mr-2 ${isLoadingWallet ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
          </div>
        </div>

        {/* v7.3.2: Runner Conflict Warning Banner */}
        <RunnerConflictBanner />

        {/* Runner Status & Instructions - Collapsible */}
        <Collapsible className="mb-8">
          <CollapsibleTrigger asChild>
            <Button variant="outline" className="w-full flex items-center justify-between mb-2">
              <span className="flex items-center gap-2">
                <Bot className="w-4 h-4" />
                Runner Status & Instructions
              </span>
              <ChevronDown className="w-4 h-4" />
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="grid gap-4 md:grid-cols-2">
              <RunnerStatus />
              <RunnerInstructions />
            </div>
          </CollapsibleContent>
        </Collapsible>

        {/* Live Bot Data Feed - Realtime orderbook + fills from runner */}
        <div className="mb-8">
          <LiveBotDataFeed />
        </div>

        {/* Bot Positions from Polymarket Sync */}
        <div className="mb-8">
          <BotPositionsCard
            portfolioPositions={positions}
            portfolioLoading={isLoadingWallet}
            onRefresh={fetchBalances}
          />
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
            <TabsTrigger value="feasibility" className="flex items-center gap-2">
              <Target className="w-4 h-4" />
              Hedge Analyse
            </TabsTrigger>
          </TabsList>

          <TabsContent value="pnl" className="space-y-6">
            {/* Hourly P/L Chart - Shows actual P/L per hour from settlements */}
            <LiveHourlyPnLChart defaultHours={24} />

            {/* Hourly Trading Activity */}
            <LiveHourlyPnL hoursToShow={24} />

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

          <TabsContent value="feasibility" className="space-y-6">
            <HedgeFeasibilityDashboard />
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
