import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Wallet as WalletIcon, RefreshCw, ArrowLeftRight, ArrowDown, BarChart3, Copy, Check, ExternalLink, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

interface WalletBalances {
  matic: number;
  usdc: number;
  usdt: number;
  usdcAllowanceToExchange: number;
}

interface WalletData {
  success: boolean;
  walletAddress: string;
  balances: WalletBalances;
  hasGasForTx: boolean;
  canDeposit: boolean;
  canSwapUsdtToUsdc: boolean;
  error?: string;
}

interface PolymarketBalance {
  success: boolean;
  balance: number;
  walletAddress: string;
  error?: string;
}

const Wallet = () => {
  const [walletData, setWalletData] = useState<WalletData | null>(null);
  const [polymarketBalance, setPolymarketBalance] = useState<PolymarketBalance | null>(null);
  const [isLoading, setIsLoading] = useState(true); // Start loading immediately
  const [isSwapping, setIsSwapping] = useState(false);
  const [isDepositing, setIsDepositing] = useState(false);
  const [swapAmount, setSwapAmount] = useState('');
  const [depositAmount, setDepositAmount] = useState('');
  const [copied, setCopied] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const fetchWalletBalance = async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      const { data, error } = await supabase.functions.invoke('live-trade-bot', {
        body: { action: 'wallet-balance' },
      });

      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      setWalletData(data);

      // Also fetch Polymarket balance
      const { data: polyData, error: polyError } = await supabase.functions.invoke('live-trade-bot', {
        body: { action: 'balance' },
      });

      if (!polyError && polyData?.success) {
        setPolymarketBalance(polyData);
      }
    } catch (error) {
      console.error('Error fetching wallet balance:', error);
      setLoadError(error instanceof Error ? error.message : 'Failed to load wallet');
    } finally {
      setIsLoading(false);
    }
  };

  // Auto-load on mount
  useEffect(() => {
    fetchWalletBalance();
  }, []);

  const handleSwap = async () => {
    const amount = parseFloat(swapAmount);
    if (!amount || amount <= 0) {
      toast.error('Enter a valid amount');
      return;
    }

    setIsSwapping(true);
    try {
      const { data, error } = await supabase.functions.invoke('live-trade-bot', {
        body: { action: 'swap', amount, fromToken: 'USDT' },
      });

      if (error) throw error;

      if (data.success) {
        toast.success(`Swapped ${amount} USDT to USDC`, {
          description: `TX: ${data.swapTxHash?.slice(0, 10)}...`,
        });
        setSwapAmount('');
        fetchWalletBalance();
      } else {
        toast.error(data.error || 'Swap failed');
      }
    } catch (error) {
      console.error('Swap error:', error);
      toast.error('Swap failed');
    } finally {
      setIsSwapping(false);
    }
  };

  const handleDeposit = async () => {
    const amount = parseFloat(depositAmount);
    if (!amount || amount <= 0) {
      toast.error('Enter a valid amount');
      return;
    }

    setIsDepositing(true);
    try {
      const { data, error } = await supabase.functions.invoke('live-trade-bot', {
        body: { action: 'deposit', amount },
      });

      if (error) throw error;

      if (data.success) {
        toast.success(`Deposited ${amount} USDC to Polymarket`, {
          description: `TX: ${data.depositTxHash?.slice(0, 10)}...`,
        });
        setDepositAmount('');
        fetchWalletBalance();
      } else {
        toast.error(data.error || 'Deposit failed');
      }
    } catch (error) {
      console.error('Deposit error:', error);
      toast.error('Deposit failed');
    } finally {
      setIsDepositing(false);
    }
  };

  const copyAddress = () => {
    if (walletData?.walletAddress) {
      navigator.clipboard.writeText(walletData.walletAddress);
      setCopied(true);
      toast.success('Address copied');
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border/50 bg-card/50 backdrop-blur-xl sticky top-0 z-50">
        <div className="container mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Link to="/" className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-primary to-emerald-400 flex items-center justify-center">
                  <BarChart3 className="w-4 h-4 text-primary-foreground" />
                </div>
                <span className="font-semibold text-lg">PolyTracker</span>
              </Link>
              <Badge variant="outline" className="font-mono text-xs">
                <WalletIcon className="w-3 h-3 mr-1" />
                Wallet
              </Badge>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={fetchWalletBalance}
              disabled={isLoading}
            >
              <RefreshCw className={`w-4 h-4 mr-2 ${isLoading ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-8">
        <div className="max-w-4xl mx-auto space-y-6">
          {/* Wallet Address Card */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <WalletIcon className="w-5 h-5" />
                Trading Wallet
              </CardTitle>
              <CardDescription>
                Send USDT or USDC (Polygon network) to this address to fund your trading
              </CardDescription>
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <div className="flex items-center gap-3 p-3 bg-muted rounded-lg">
                  <RefreshCw className="w-4 h-4 animate-spin text-muted-foreground" />
                  <span className="text-muted-foreground">Loading wallet data...</span>
                </div>
              ) : loadError ? (
                <div className="space-y-3">
                  <div className="flex items-center gap-2 p-3 bg-destructive/10 text-destructive rounded-lg text-sm">
                    <AlertCircle className="w-4 h-4 flex-shrink-0" />
                    <span>{loadError}</span>
                  </div>
                  <Button onClick={fetchWalletBalance} variant="outline" size="sm">
                    <RefreshCw className="w-4 h-4 mr-2" />
                    Try Again
                  </Button>
                </div>
              ) : walletData ? (
                <div className="space-y-4">
                  <div className="flex items-center gap-2 p-3 bg-muted rounded-lg font-mono text-sm">
                    <span className="flex-1 truncate">{walletData.walletAddress}</span>
                    <Button variant="ghost" size="icon" onClick={copyAddress}>
                      {copied ? <Check className="w-4 h-4 text-success" /> : <Copy className="w-4 h-4" />}
                    </Button>
                    <Button variant="ghost" size="icon" asChild>
                      <a
                        href={`https://polygonscan.com/address/${walletData.walletAddress}`}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        <ExternalLink className="w-4 h-4" />
                      </a>
                    </Button>
                  </div>
                  
                  {!walletData.hasGasForTx && (
                    <div className="flex items-center gap-2 p-3 bg-destructive/10 text-destructive rounded-lg text-sm">
                      <AlertCircle className="w-4 h-4 flex-shrink-0" />
                      <span>Need MATIC for gas. Send at least 0.01 MATIC to this address.</span>
                    </div>
                  )}
                </div>
              ) : (
                <Button onClick={fetchWalletBalance} disabled={isLoading}>
                  Load Wallet
                </Button>
              )}
            </CardContent>
          </Card>

          {/* Balances Grid */}
          {walletData && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <Card>
                <CardContent className="pt-6">
                  <div className="text-center">
                    <div className="text-2xl font-bold font-mono">
                      {walletData.balances.matic.toFixed(4)}
                    </div>
                    <div className="text-sm text-muted-foreground">MATIC (Gas)</div>
                    <Badge variant={walletData.hasGasForTx ? 'default' : 'destructive'} className="mt-2">
                      {walletData.hasGasForTx ? 'OK' : 'Low'}
                    </Badge>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardContent className="pt-6">
                  <div className="text-center">
                    <div className="text-2xl font-bold font-mono text-amber-400">
                      ${walletData.balances.usdt.toFixed(2)}
                    </div>
                    <div className="text-sm text-muted-foreground">USDT</div>
                    {walletData.balances.usdt > 0 && (
                      <Badge variant="outline" className="mt-2 text-amber-400 border-amber-400/30">
                        Swap to USDC
                      </Badge>
                    )}
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardContent className="pt-6">
                  <div className="text-center">
                    <div className="text-2xl font-bold font-mono text-blue-400">
                      ${walletData.balances.usdc.toFixed(2)}
                    </div>
                    <div className="text-sm text-muted-foreground">USDC (Wallet)</div>
                    {walletData.canDeposit && (
                      <Badge variant="outline" className="mt-2 text-blue-400 border-blue-400/30">
                        Ready to Deposit
                      </Badge>
                    )}
                  </div>
                </CardContent>
              </Card>

              <Card className="bg-gradient-to-br from-emerald-500/10 to-emerald-500/5 border-emerald-500/20">
                <CardContent className="pt-6">
                  <div className="text-center">
                    <div className="text-2xl font-bold font-mono text-emerald-400">
                      ${polymarketBalance?.balance?.toFixed(2) ?? '—'}
                    </div>
                    <div className="text-sm text-muted-foreground">Polymarket</div>
                    <Badge variant="default" className="mt-2 bg-emerald-500/20 text-emerald-400">
                      Trading Balance
                    </Badge>
                  </div>
                </CardContent>
              </Card>
            </div>
          )}

          {/* Actions */}
          {walletData && (
            <div className="grid md:grid-cols-2 gap-6">
              {/* Swap USDT → USDC */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-lg">
                    <ArrowLeftRight className="w-5 h-5 text-amber-400" />
                    Swap USDT → USDC
                  </CardTitle>
                  <CardDescription>
                    Convert USDT to USDC via Uniswap V3
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <Label>Amount (USDT)</Label>
                    <div className="flex gap-2">
                      <Input
                        type="number"
                        placeholder="0.00"
                        value={swapAmount}
                        onChange={(e) => setSwapAmount(e.target.value)}
                        className="font-mono"
                      />
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setSwapAmount(walletData.balances.usdt.toString())}
                        disabled={walletData.balances.usdt === 0}
                      >
                        Max
                      </Button>
                    </div>
                  </div>
                  <Button
                    className="w-full"
                    onClick={handleSwap}
                    disabled={isSwapping || !walletData.canSwapUsdtToUsdc || !swapAmount}
                  >
                    {isSwapping ? (
                      <>
                        <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                        Swapping...
                      </>
                    ) : (
                      <>
                        <ArrowLeftRight className="w-4 h-4 mr-2" />
                        Swap to USDC
                      </>
                    )}
                  </Button>
                </CardContent>
              </Card>

              {/* Deposit USDC → Polymarket */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-lg">
                    <ArrowDown className="w-5 h-5 text-emerald-400" />
                    Deposit to Polymarket
                  </CardTitle>
                  <CardDescription>
                    Move USDC from wallet to Polymarket trading balance
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <Label>Amount (USDC)</Label>
                    <div className="flex gap-2">
                      <Input
                        type="number"
                        placeholder="0.00"
                        value={depositAmount}
                        onChange={(e) => setDepositAmount(e.target.value)}
                        className="font-mono"
                      />
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setDepositAmount(walletData.balances.usdc.toString())}
                        disabled={walletData.balances.usdc === 0}
                      >
                        Max
                      </Button>
                    </div>
                  </div>
                  <Button
                    className="w-full bg-emerald-600 hover:bg-emerald-700"
                    onClick={handleDeposit}
                    disabled={isDepositing || !walletData.canDeposit || !depositAmount}
                  >
                    {isDepositing ? (
                      <>
                        <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                        Depositing...
                      </>
                    ) : (
                      <>
                        <ArrowDown className="w-4 h-4 mr-2" />
                        Deposit to Polymarket
                      </>
                    )}
                  </Button>
                </CardContent>
              </Card>
            </div>
          )}

          {/* Instructions */}
          <Card className="border-dashed">
            <CardHeader>
              <CardTitle className="text-lg">How to Fund Your Wallet</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm text-muted-foreground">
              <div className="flex gap-3">
                <Badge variant="outline" className="h-6 w-6 rounded-full flex items-center justify-center p-0">1</Badge>
                <span>Send <strong>USDT or USDC</strong> to the wallet address above on <strong>Polygon network</strong></span>
              </div>
              <div className="flex gap-3">
                <Badge variant="outline" className="h-6 w-6 rounded-full flex items-center justify-center p-0">2</Badge>
                <span>Send a small amount of <strong>MATIC</strong> (~0.01) for gas fees</span>
              </div>
              <div className="flex gap-3">
                <Badge variant="outline" className="h-6 w-6 rounded-full flex items-center justify-center p-0">3</Badge>
                <span>If you sent USDT, use the <strong>Swap</strong> button to convert to USDC</span>
              </div>
              <div className="flex gap-3">
                <Badge variant="outline" className="h-6 w-6 rounded-full flex items-center justify-center p-0">4</Badge>
                <span>Use <strong>Deposit</strong> to move USDC to your Polymarket trading balance</span>
              </div>
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  );
};

export default Wallet;
