import React, { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { 
  Activity, 
  RefreshCw, 
  CheckCircle, 
  XCircle, 
  AlertTriangle,
  Clock,
  TrendingUp,
  TrendingDown,
  ChevronDown,
  ChevronRight,
  Target,
  Layers,
  ArrowRightLeft,
  DollarSign,
  Zap
} from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { format } from 'date-fns';
import { useCurrentWallet } from '@/hooks/useCurrentWallet';

interface Trade {
  id: string;
  market_slug: string;
  asset: string;
  outcome: string;
  price: number;
  shares: number;
  total: number;
  reasoning: string | null;
  status: string | null;
  order_id: string | null;
  created_at: string;
  event_start_time?: string;
  event_end_time?: string;
}

interface MarketGroup {
  market_slug: string;
  asset: string;
  trades: Trade[];
  totalInvested: number;
  upShares: number;
  downShares: number;
  upCost: number;
  downCost: number;
  isHedged: boolean;
  potentialPayout: number;
  lockedProfit: number;
  eventEndTime?: string;
}

type TradeType = 'Opening' | 'Hedge' | 'Accumulate' | 'Pre-hedge' | 'Unknown';

function parseTradeType(reasoning: string | null): TradeType {
  if (!reasoning) return 'Unknown';
  const lower = reasoning.toLowerCase();
  if (lower.includes('opening')) return 'Opening';
  if (lower.includes('hedge')) return 'Hedge';
  if (lower.includes('pre-hedge')) return 'Pre-hedge';
  if (lower.includes('accumulate')) return 'Accumulate';
  return 'Unknown';
}

function getTradeTypeIcon(type: TradeType) {
  switch (type) {
    case 'Opening':
      return <Target className="w-4 h-4 text-blue-500" />;
    case 'Hedge':
      return <ArrowRightLeft className="w-4 h-4 text-emerald-500" />;
    case 'Pre-hedge':
      return <Zap className="w-4 h-4 text-amber-500" />;
    case 'Accumulate':
      return <Layers className="w-4 h-4 text-purple-500" />;
    default:
      return <Activity className="w-4 h-4 text-muted-foreground" />;
  }
}

function getTradeTypeBadge(type: TradeType) {
  switch (type) {
    case 'Opening':
      return <Badge variant="outline" className="bg-blue-500/10 text-blue-500 border-blue-500/20 text-xs">OPEN</Badge>;
    case 'Hedge':
      return <Badge variant="outline" className="bg-emerald-500/10 text-emerald-500 border-emerald-500/20 text-xs">HEDGE</Badge>;
    case 'Pre-hedge':
      return <Badge variant="outline" className="bg-amber-500/10 text-amber-500 border-amber-500/20 text-xs">PRE-HEDGE</Badge>;
    case 'Accumulate':
      return <Badge variant="outline" className="bg-purple-500/10 text-purple-500 border-purple-500/20 text-xs">ACCUM</Badge>;
    default:
      return <Badge variant="secondary" className="text-xs">OTHER</Badge>;
  }
}

export function MarketTradesLog() {
  const [trades, setTrades] = useState<Trade[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [expandedMarkets, setExpandedMarkets] = useState<Set<string>>(new Set());
  const { walletAddress, isLoading: walletLoading } = useCurrentWallet();

  const fetchTrades = async () => {
    if (walletLoading) return;
    
    try {
      let query = supabase
        .from('live_trades')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(100);

      // Filter by wallet if available
      if (walletAddress) {
        query = query.or(`wallet_address.eq.${walletAddress},wallet_address.is.null`);
      }

      const { data, error } = await query;

      if (error) throw error;
      setTrades(data || []);
    } catch (err) {
      console.error('Error fetching trades:', err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (!walletLoading) {
      fetchTrades();
    }
    
    if (autoRefresh && !walletLoading) {
      const interval = setInterval(fetchTrades, 5000);
      return () => clearInterval(interval);
    }
  }, [autoRefresh, walletAddress, walletLoading]);

  // Subscribe to realtime updates
  useEffect(() => {
    const channel = supabase
      .channel('market-trades-log')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'live_trades' }, () => fetchTrades())
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  // Group trades by market
  const marketGroups: MarketGroup[] = React.useMemo(() => {
    const groups = new Map<string, MarketGroup>();
    
    trades.forEach(trade => {
      if (!groups.has(trade.market_slug)) {
        groups.set(trade.market_slug, {
          market_slug: trade.market_slug,
          asset: trade.asset,
          trades: [],
          totalInvested: 0,
          upShares: 0,
          downShares: 0,
          upCost: 0,
          downCost: 0,
          isHedged: false,
          potentialPayout: 0,
          lockedProfit: 0,
          eventEndTime: trade.event_end_time || undefined
        });
      }
      
      const group = groups.get(trade.market_slug)!;
      group.trades.push(trade);
      group.totalInvested += trade.total;
      
      if (trade.outcome === 'UP') {
        group.upShares += trade.shares;
        group.upCost += trade.total;
      } else {
        group.downShares += trade.shares;
        group.downCost += trade.total;
      }
    });
    
    // Calculate hedged status and potential profit
    groups.forEach(group => {
      group.isHedged = group.upShares > 0 && group.downShares > 0;
      const minShares = Math.min(group.upShares, group.downShares);
      group.potentialPayout = minShares; // Each share pays $1 if correct
      group.lockedProfit = group.potentialPayout - (group.upCost + group.downCost);
      
      // Sort trades by time (newest first)
      group.trades.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    });
    
    return Array.from(groups.values()).sort((a, b) => 
      new Date(b.trades[0]?.created_at || 0).getTime() - new Date(a.trades[0]?.created_at || 0).getTime()
    );
  }, [trades]);

  const toggleMarket = (slug: string) => {
    setExpandedMarkets(prev => {
      const next = new Set(prev);
      if (next.has(slug)) {
        next.delete(slug);
      } else {
        next.add(slug);
      }
      return next;
    });
  };

  // Expand all markets by default when first loaded
  useEffect(() => {
    if (marketGroups.length > 0 && expandedMarkets.size === 0) {
      setExpandedMarkets(new Set(marketGroups.slice(0, 3).map(g => g.market_slug)));
    }
  }, [marketGroups.length]);

  const totalTrades = trades.length;
  const filledTrades = trades.filter(t => t.status === 'filled').length;
  const hedgedMarkets = marketGroups.filter(g => g.isHedged).length;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <Layers className="w-5 h-5 text-primary" />
            Trade Log per Market
          </CardTitle>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="text-emerald-500">
              {filledTrades}/{totalTrades} filled
            </Badge>
            <Badge variant="outline" className="text-purple-500">
              {hedgedMarkets} hedged
            </Badge>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setAutoRefresh(!autoRefresh)}
              className={autoRefresh ? 'text-emerald-500' : ''}
            >
              <RefreshCw className={`w-4 h-4 ${autoRefresh ? 'animate-spin' : ''}`} />
            </Button>
            <Button variant="ghost" size="sm" onClick={fetchTrades} disabled={isLoading}>
              <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue="by-market">
          <TabsList className="mb-4">
            <TabsTrigger value="by-market">Per Market ({marketGroups.length})</TabsTrigger>
            <TabsTrigger value="all-trades">All Trades ({trades.length})</TabsTrigger>
          </TabsList>
          
          <TabsContent value="by-market">
            <ScrollArea className="h-[500px] pr-4">
              {marketGroups.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
                  <Activity className="w-8 h-8 mb-2 opacity-50" />
                  <p>No trades yet</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {marketGroups.map((group) => (
                    <Collapsible
                      key={group.market_slug}
                      open={expandedMarkets.has(group.market_slug)}
                      onOpenChange={() => toggleMarket(group.market_slug)}
                    >
                      <div className={`rounded-lg border ${
                        group.isHedged 
                          ? 'border-emerald-500/30 bg-emerald-500/5' 
                          : 'border-amber-500/30 bg-amber-500/5'
                      }`}>
                        <CollapsibleTrigger asChild>
                          <button className="w-full p-3 flex items-center justify-between hover:bg-muted/30 transition-colors rounded-lg">
                            <div className="flex items-center gap-3">
                              {expandedMarkets.has(group.market_slug) ? (
                                <ChevronDown className="w-4 h-4" />
                              ) : (
                                <ChevronRight className="w-4 h-4" />
                              )}
                              <div className="text-left">
                                <div className="flex items-center gap-2">
                                  <span className="font-bold">{group.asset}</span>
                                  <Badge variant="outline" className="text-xs">
                                    {group.trades.length} trades
                                  </Badge>
                                  {group.isHedged ? (
                                    <Badge className="bg-emerald-500/20 text-emerald-500 border-emerald-500/30 text-xs">
                                      HEDGED
                                    </Badge>
                                  ) : (
                                    <Badge variant="outline" className="bg-amber-500/10 text-amber-500 border-amber-500/20 text-xs">
                                      OPEN
                                    </Badge>
                                  )}
                                </div>
                                <p className="text-xs text-muted-foreground font-mono mt-0.5">
                                  {group.market_slug}
                                </p>
                              </div>
                            </div>
                            <div className="flex items-center gap-4 text-sm">
                              <div className="text-right">
                                <div className="flex items-center gap-2">
                                  <TrendingUp className="w-3 h-3 text-emerald-500" />
                                  <span className="font-mono">{group.upShares}</span>
                                </div>
                                <div className="flex items-center gap-2">
                                  <TrendingDown className="w-3 h-3 text-red-500" />
                                  <span className="font-mono">{group.downShares}</span>
                                </div>
                              </div>
                              <div className="text-right min-w-[80px]">
                                <div className="font-mono">${group.totalInvested.toFixed(2)}</div>
                                {group.isHedged && (
                                  <div className={`text-xs font-mono ${group.lockedProfit >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
                                    {group.lockedProfit >= 0 ? '+' : ''}{group.lockedProfit.toFixed(2)}
                                  </div>
                                )}
                              </div>
                            </div>
                          </button>
                        </CollapsibleTrigger>
                        
                        <CollapsibleContent>
                          <div className="border-t border-border/50 px-3 pb-3">
                            <div className="mt-3 space-y-2">
                              {group.trades.map((trade) => {
                                const tradeType = parseTradeType(trade.reasoning);
                                const isSuccess = trade.status === 'filled' && trade.order_id;
                                
                                return (
                                  <div
                                    key={trade.id}
                                    className={`p-2 rounded-md border ${
                                      isSuccess
                                        ? 'border-emerald-500/20 bg-emerald-500/5'
                                        : 'border-red-500/20 bg-red-500/5'
                                    }`}
                                  >
                                    <div className="flex items-start justify-between gap-2">
                                      <div className="flex items-start gap-2 flex-1">
                                        {getTradeTypeIcon(tradeType)}
                                        <div className="flex-1 min-w-0">
                                          <div className="flex items-center gap-2 flex-wrap">
                                            {getTradeTypeBadge(tradeType)}
                                            <Badge variant={trade.outcome === 'UP' ? 'default' : 'secondary'} className="text-xs">
                                              {trade.outcome}
                                            </Badge>
                                            <span className="text-sm font-mono">
                                              @ ${Number(trade.price).toFixed(2)}
                                            </span>
                                            {isSuccess ? (
                                              <CheckCircle className="w-3.5 h-3.5 text-emerald-500" />
                                            ) : (
                                              <XCircle className="w-3.5 h-3.5 text-red-500" />
                                            )}
                                          </div>
                                          
                                          {/* Trade Reasoning - The Logic */}
                                          {trade.reasoning && (
                                            <div className="mt-1.5 p-2 rounded bg-background/50 border border-border/50">
                                              <div className="text-xs text-muted-foreground mb-1 flex items-center gap-1">
                                                <Target className="w-3 h-3" />
                                                Trade Logic:
                                              </div>
                                              <p className="text-sm font-medium text-foreground">
                                                {trade.reasoning}
                                              </p>
                                            </div>
                                          )}
                                          
                                          <div className="flex items-center gap-3 mt-1.5 text-xs text-muted-foreground">
                                            <span className="font-mono">{trade.shares} shares</span>
                                            <span className="font-mono">${Number(trade.total).toFixed(2)}</span>
                                            {trade.order_id && (
                                              <span className="font-mono truncate max-w-[120px]">
                                                {trade.order_id.substring(0, 12)}...
                                              </span>
                                            )}
                                          </div>
                                        </div>
                                      </div>
                                      <div className="text-xs text-muted-foreground whitespace-nowrap flex items-center gap-1">
                                        <Clock className="w-3 h-3" />
                                        {format(new Date(trade.created_at), 'HH:mm:ss')}
                                      </div>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        </CollapsibleContent>
                      </div>
                    </Collapsible>
                  ))}
                </div>
              )}
            </ScrollArea>
          </TabsContent>
          
          <TabsContent value="all-trades">
            <ScrollArea className="h-[500px] pr-4">
              {trades.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
                  <Activity className="w-8 h-8 mb-2 opacity-50" />
                  <p>No trades yet</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {trades.map((trade) => {
                    const tradeType = parseTradeType(trade.reasoning);
                    const isSuccess = trade.status === 'filled' && trade.order_id;
                    
                    return (
                      <div
                        key={trade.id}
                        className={`p-3 rounded-lg border ${
                          isSuccess
                            ? 'border-emerald-500/20 bg-emerald-500/5'
                            : 'border-red-500/20 bg-red-500/5'
                        }`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex items-start gap-2 flex-1">
                            {getTradeTypeIcon(tradeType)}
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="font-bold">{trade.asset}</span>
                                {getTradeTypeBadge(tradeType)}
                                <Badge variant={trade.outcome === 'UP' ? 'default' : 'secondary'} className="text-xs">
                                  {trade.outcome}
                                </Badge>
                                <span className="text-sm font-mono">
                                  @ ${Number(trade.price).toFixed(2)}
                                </span>
                                {isSuccess ? (
                                  <CheckCircle className="w-3.5 h-3.5 text-emerald-500" />
                                ) : (
                                  <XCircle className="w-3.5 h-3.5 text-red-500" />
                                )}
                              </div>
                              
                              {/* Trade Reasoning */}
                              {trade.reasoning && (
                                <div className="mt-1.5 p-2 rounded bg-background/50 border border-border/50">
                                  <p className="text-sm">{trade.reasoning}</p>
                                </div>
                              )}
                              
                              <div className="flex items-center gap-3 mt-1.5 text-xs text-muted-foreground">
                                <span className="font-mono">{trade.shares} shares</span>
                                <span className="font-mono">${Number(trade.total).toFixed(2)}</span>
                                <span className="font-mono truncate max-w-[200px]">{trade.market_slug}</span>
                              </div>
                            </div>
                          </div>
                          <div className="text-xs text-muted-foreground whitespace-nowrap flex items-center gap-1">
                            <Clock className="w-3 h-3" />
                            {format(new Date(trade.created_at), 'HH:mm:ss')}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </ScrollArea>
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}
