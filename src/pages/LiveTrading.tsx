import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  ArrowLeft,
  Zap,
  Wallet,
  RefreshCw,
  Bot,
  AlertTriangle,
} from 'lucide-react';
import { LiveTradeDashboard } from '@/components/LiveTradeDashboard';
import { PaperTradeDashboard } from '@/components/PaperTradeDashboard';
import { supabase } from '@/integrations/supabase/client';

interface WalletBalance {
  usdc: string;
  usdt: string;
  matic: string;
}

const ZERO = 0;

export default function LiveTrading() {
  const [walletBalance, setWalletBalance] = useState<WalletBalance | null>(null);
  const [polymarketBalance, setPolymarketBalance] = useState<number | null>(null);
  const [isLoadingWallet, setIsLoadingWallet] = useState(true);

  const fetchBalances = async () => {
    setIsLoadingWallet(true);
    try {
      // Fetch wallet balance
      const { data: walletData } = await supabase.functions.invoke('live-trade-bot', {
        body: { action: 'wallet-balance' }
      });
      
      if (walletData?.balances) {
        setWalletBalance(walletData.balances);
      }

      // Fetch Polymarket balance
      const { data: pmData } = await supabase.functions.invoke('live-trade-bot', {
        body: { action: 'balance' }
      });
      
      if (typeof pmData?.balance === 'number') {
        setPolymarketBalance(pmData.balance);
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

        {/* Balance Cards */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          <Card className="border-red-500/20">
            <CardContent className="p-4">
              <div className="text-sm text-muted-foreground mb-1">Trading Balance</div>
              <div className="text-2xl font-bold font-mono">
                ${polymarketBalance !== null ? polymarketBalance.toFixed(2) : '...'}
              </div>
              <div className="text-xs text-muted-foreground">Polymarket USDC</div>
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
          
          <Card>
            <CardContent className="p-4">
              <div className="text-sm text-muted-foreground mb-1">Wallet USDT</div>
              <div className="text-2xl font-bold font-mono">
                ${walletBalance ? parseFloat(walletBalance.usdt).toFixed(2) : '...'}
              </div>
              <div className="text-xs text-muted-foreground">Needs swap</div>
            </CardContent>
          </Card>
          
          <Card>
            <CardContent className="p-4">
              <div className="text-sm text-muted-foreground mb-1">MATIC</div>
              <div className="text-2xl font-bold font-mono">
                {walletBalance ? parseFloat(walletBalance.matic).toFixed(4) : '...'}
              </div>
              <div className="text-xs text-muted-foreground">For gas fees</div>
            </CardContent>
          </Card>
        </div>

        {/* Warning */}
        <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-4 mb-8 flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-yellow-500 flex-shrink-0 mt-0.5" />
          <div className="text-sm">
            <span className="font-semibold text-yellow-500">Let op:</span>{' '}
            <span className="text-muted-foreground">
              De live bot is momenteel niet automatisch actief. Trades moeten handmatig getriggerd worden via de API.
              Ga naar <Link to="/wallet" className="text-primary underline">Wallet</Link> om je balances te beheren.
            </span>
          </div>
        </div>

        {/* Live Trading Dashboard */}
        <div className="mb-8">
          <LiveTradeDashboard />
        </div>

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
