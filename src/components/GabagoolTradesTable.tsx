import { useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { TrendingUp, TrendingDown, Zap, Shield, Target, ArrowUpDown, Search, ChevronLeft, ChevronRight, Info, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

interface Trade {
  id: string;
  market_slug: string;
  market: string;
  outcome: string;
  side: string;
  price: number;
  shares: number;
  total: number;
  timestamp: string;
}

interface TradeWithReasoning extends Trade {
  reasoning: string;
  reasoningType: 'OPENING' | 'DCA_CHEAP' | 'DCA_BALANCE' | 'HEDGE' | 'ARBITRAGE' | 'ACCUMULATE';
  tradeNumber: number;
  marketTradeNumber: number;
  runningUpShares: number;
  runningDownShares: number;
  runningUpCost: number;
  runningDownCost: number;
  currentCombinedEntry: number;
  timeSinceLastTrade: number | null;
  positionImbalance: number;
}

interface GabagoolTradesTableProps {
  trades: Trade[];
}

export function GabagoolTradesTable({ trades }: GabagoolTradesTableProps) {
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [searchTerm, setSearchTerm] = useState('');
  const [outcomeFilter, setOutcomeFilter] = useState<string>('all');
  const [reasoningFilter, setReasoningFilter] = useState<string>('all');
  const [sortField, setSortField] = useState<'timestamp' | 'total' | 'price'>('timestamp');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');

  // Calculate reasoning for each trade
  const tradesWithReasoning: TradeWithReasoning[] = useMemo(() => {
    if (trades.length === 0) return [];

    // Sort trades by market and timestamp to analyze sequences
    const sortedTrades = [...trades].sort((a, b) => {
      if (a.market_slug !== b.market_slug) return a.market_slug.localeCompare(b.market_slug);
      return new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
    });

    // Track state per market
    const marketState = new Map<string, {
      upShares: number;
      downShares: number;
      upCost: number;
      downCost: number;
      tradeCount: number;
      lastTradeTime: Date | null;
    }>();

    let globalTradeNumber = 0;

    return sortedTrades.map(trade => {
      globalTradeNumber++;
      
      // Get or initialize market state
      if (!marketState.has(trade.market_slug)) {
        marketState.set(trade.market_slug, {
          upShares: 0,
          downShares: 0,
          upCost: 0,
          downCost: 0,
          tradeCount: 0,
          lastTradeTime: null,
        });
      }
      
      const state = marketState.get(trade.market_slug)!;
      const tradeTime = new Date(trade.timestamp);
      const timeSinceLastTrade = state.lastTradeTime 
        ? (tradeTime.getTime() - state.lastTradeTime.getTime()) / 1000 
        : null;
      
      // Calculate current position BEFORE this trade
      const prevUpShares = state.upShares;
      const prevDownShares = state.downShares;
      const prevUpCost = state.upCost;
      const prevDownCost = state.downCost;
      const prevTradeCount = state.tradeCount;
      
      // Calculate imbalance before trade
      const totalShares = prevUpShares + prevDownShares;
      const positionImbalance = totalShares > 0 
        ? ((prevUpShares - prevDownShares) / totalShares) * 100 
        : 0;
      
      // Determine reasoning
      let reasoning: string;
      let reasoningType: TradeWithReasoning['reasoningType'];
      
      const isFirstTrade = prevTradeCount === 0;
      const isFirstOfOutcome = trade.outcome === 'Up' ? prevUpShares === 0 : prevDownShares === 0;
      const isCheapPrice = trade.price <= 0.20;
      const isExpensivePrice = trade.price >= 0.80;
      const needsBalance = Math.abs(positionImbalance) > 20;
      const oppositeOutcome = trade.outcome === 'Up' ? 'Down' : 'Up';
      const hasOppositePosition = trade.outcome === 'Up' ? prevDownShares > 0 : prevUpShares > 0;
      
      // Calculate potential combined entry
      const newUpShares = trade.outcome === 'Up' ? prevUpShares + trade.shares : prevUpShares;
      const newDownShares = trade.outcome === 'Down' ? prevDownShares + trade.shares : prevDownShares;
      const newUpCost = trade.outcome === 'Up' ? prevUpCost + trade.total : prevUpCost;
      const newDownCost = trade.outcome === 'Down' ? prevDownCost + trade.total : prevDownCost;
      
      const avgUpPrice = newUpShares > 0 ? newUpCost / newUpShares : 0;
      const avgDownPrice = newDownShares > 0 ? newDownCost / newDownShares : 0;
      const currentCombinedEntry = (newUpShares > 0 && newDownShares > 0) 
        ? avgUpPrice + avgDownPrice 
        : 0;
      
      const isArbitrageOpportunity = currentCombinedEntry > 0 && currentCombinedEntry < 0.98;
      
      if (isFirstTrade) {
        reasoning = `🚀 OPENING: Eerste trade in markt. Start positie op ${trade.outcome} @ ${(trade.price * 100).toFixed(0)}¢`;
        reasoningType = 'OPENING';
      } else if (isFirstOfOutcome && hasOppositePosition) {
        reasoning = `🛡️ HEDGE: Start hedge positie. Had al ${oppositeOutcome}, nu ${trade.outcome} @ ${(trade.price * 100).toFixed(0)}¢ voor dual-side dekking`;
        reasoningType = 'HEDGE';
      } else if (isCheapPrice) {
        reasoning = `💰 DCA_CHEAP: Goedkope entry @ ${(trade.price * 100).toFixed(0)}¢. Koop meer ${trade.outcome} shares voor gemiddeld lagere entry`;
        reasoningType = 'DCA_CHEAP';
      } else if (needsBalance && (
        (positionImbalance > 20 && trade.outcome === 'Down') || 
        (positionImbalance < -20 && trade.outcome === 'Up')
      )) {
        reasoning = `⚖️ DCA_BALANCE: Herbalanceer positie. Was ${positionImbalance > 0 ? 'Up-heavy' : 'Down-heavy'} (${Math.abs(positionImbalance).toFixed(0)}%), koop meer ${trade.outcome}`;
        reasoningType = 'DCA_BALANCE';
      } else if (isArbitrageOpportunity) {
        reasoning = `🎯 ARBITRAGE: Combined entry ${(currentCombinedEntry * 100).toFixed(1)}¢ < 98¢. Gegarandeerde winst bij settlement`;
        reasoningType = 'ARBITRAGE';
      } else {
        reasoning = `📈 ACCUMULATE: DCA verder in ${trade.outcome} @ ${(trade.price * 100).toFixed(0)}¢. Trade #${prevTradeCount + 1} in deze markt`;
        reasoningType = 'ACCUMULATE';
      }
      
      // Update state AFTER reasoning
      if (trade.outcome === 'Up') {
        state.upShares += trade.shares;
        state.upCost += trade.total;
      } else {
        state.downShares += trade.shares;
        state.downCost += trade.total;
      }
      state.tradeCount++;
      state.lastTradeTime = tradeTime;
      
      return {
        ...trade,
        reasoning,
        reasoningType,
        tradeNumber: globalTradeNumber,
        marketTradeNumber: state.tradeCount,
        runningUpShares: state.upShares,
        runningDownShares: state.downShares,
        runningUpCost: state.upCost,
        runningDownCost: state.downCost,
        currentCombinedEntry,
        timeSinceLastTrade,
        positionImbalance,
      };
    });
  }, [trades]);

  // Filter and sort trades
  const filteredTrades = useMemo(() => {
    let result = [...tradesWithReasoning];
    
    // Apply search filter
    if (searchTerm) {
      const term = searchTerm.toLowerCase();
      result = result.filter(t => 
        t.market_slug.toLowerCase().includes(term) ||
        t.market.toLowerCase().includes(term) ||
        t.reasoning.toLowerCase().includes(term)
      );
    }
    
    // Apply outcome filter
    if (outcomeFilter !== 'all') {
      result = result.filter(t => t.outcome === outcomeFilter);
    }
    
    // Apply reasoning filter
    if (reasoningFilter !== 'all') {
      result = result.filter(t => t.reasoningType === reasoningFilter);
    }
    
    // Apply sorting
    result.sort((a, b) => {
      let comparison = 0;
      switch (sortField) {
        case 'timestamp':
          comparison = new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
          break;
        case 'total':
          comparison = a.total - b.total;
          break;
        case 'price':
          comparison = a.price - b.price;
          break;
      }
      return sortDirection === 'asc' ? comparison : -comparison;
    });
    
    return result;
  }, [tradesWithReasoning, searchTerm, outcomeFilter, reasoningFilter, sortField, sortDirection]);

  // Pagination
  const totalPages = Math.ceil(filteredTrades.length / pageSize);
  const paginatedTrades = filteredTrades.slice(
    (currentPage - 1) * pageSize,
    currentPage * pageSize
  );

  // Reasoning type stats
  const reasoningStats = useMemo(() => {
    const stats = {
      OPENING: 0,
      DCA_CHEAP: 0,
      DCA_BALANCE: 0,
      HEDGE: 0,
      ARBITRAGE: 0,
      ACCUMULATE: 0,
    };
    tradesWithReasoning.forEach(t => {
      stats[t.reasoningType]++;
    });
    return stats;
  }, [tradesWithReasoning]);

  const toggleSort = (field: 'timestamp' | 'total' | 'price') => {
    if (sortField === field) {
      setSortDirection(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDirection('desc');
    }
  };

  const getReasoningBadge = (type: TradeWithReasoning['reasoningType']) => {
    switch (type) {
      case 'OPENING':
        return <Badge className="bg-blue-500/20 text-blue-400 border-blue-500/30">🚀 Opening</Badge>;
      case 'HEDGE':
        return <Badge className="bg-purple-500/20 text-purple-400 border-purple-500/30">🛡️ Hedge</Badge>;
      case 'DCA_CHEAP':
        return <Badge className="bg-green-500/20 text-green-400 border-green-500/30">💰 DCA Cheap</Badge>;
      case 'DCA_BALANCE':
        return <Badge className="bg-yellow-500/20 text-yellow-400 border-yellow-500/30">⚖️ Balance</Badge>;
      case 'ARBITRAGE':
        return <Badge className="bg-primary/20 text-primary border-primary/30">🎯 Arbitrage</Badge>;
      case 'ACCUMULATE':
        return <Badge variant="secondary">📈 Accumulate</Badge>;
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Info className="h-5 w-5" />
          Trade-by-Trade Reasoning Analyse
        </CardTitle>
        <CardDescription>
          Elke trade met de beredeneerde logica waarom deze werd uitgevoerd
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Reasoning Stats */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2">
          <div className="p-3 bg-blue-500/10 rounded-lg text-center">
            <div className="text-lg font-bold text-blue-400">{reasoningStats.OPENING}</div>
            <div className="text-xs text-muted-foreground">🚀 Opening</div>
          </div>
          <div className="p-3 bg-purple-500/10 rounded-lg text-center">
            <div className="text-lg font-bold text-purple-400">{reasoningStats.HEDGE}</div>
            <div className="text-xs text-muted-foreground">🛡️ Hedge</div>
          </div>
          <div className="p-3 bg-green-500/10 rounded-lg text-center">
            <div className="text-lg font-bold text-green-400">{reasoningStats.DCA_CHEAP}</div>
            <div className="text-xs text-muted-foreground">💰 DCA Cheap</div>
          </div>
          <div className="p-3 bg-yellow-500/10 rounded-lg text-center">
            <div className="text-lg font-bold text-yellow-400">{reasoningStats.DCA_BALANCE}</div>
            <div className="text-xs text-muted-foreground">⚖️ Balance</div>
          </div>
          <div className="p-3 bg-primary/10 rounded-lg text-center">
            <div className="text-lg font-bold text-primary">{reasoningStats.ARBITRAGE}</div>
            <div className="text-xs text-muted-foreground">🎯 Arbitrage</div>
          </div>
          <div className="p-3 bg-muted rounded-lg text-center">
            <div className="text-lg font-bold">{reasoningStats.ACCUMULATE}</div>
            <div className="text-xs text-muted-foreground">📈 Accumulate</div>
          </div>
        </div>

        {/* Filters */}
        <div className="flex flex-wrap gap-3">
          <div className="flex-1 min-w-[200px]">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Zoek op markt of reasoning..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-9"
              />
            </div>
          </div>
          <Select value={outcomeFilter} onValueChange={setOutcomeFilter}>
            <SelectTrigger className="w-[130px]">
              <SelectValue placeholder="Outcome" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Alle</SelectItem>
              <SelectItem value="Up">Up</SelectItem>
              <SelectItem value="Down">Down</SelectItem>
            </SelectContent>
          </Select>
          <Select value={reasoningFilter} onValueChange={setReasoningFilter}>
            <SelectTrigger className="w-[150px]">
              <SelectValue placeholder="Reasoning" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Alle Types</SelectItem>
              <SelectItem value="OPENING">Opening</SelectItem>
              <SelectItem value="HEDGE">Hedge</SelectItem>
              <SelectItem value="DCA_CHEAP">DCA Cheap</SelectItem>
              <SelectItem value="DCA_BALANCE">Balance</SelectItem>
              <SelectItem value="ARBITRAGE">Arbitrage</SelectItem>
              <SelectItem value="ACCUMULATE">Accumulate</SelectItem>
            </SelectContent>
          </Select>
          <Select value={pageSize.toString()} onValueChange={(v) => { setPageSize(Number(v)); setCurrentPage(1); }}>
            <SelectTrigger className="w-[100px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="25">25</SelectItem>
              <SelectItem value="50">50</SelectItem>
              <SelectItem value="100">100</SelectItem>
              <SelectItem value="250">250</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Table */}
        <div className="border rounded-lg overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[60px]">#</TableHead>
                <TableHead 
                  className="cursor-pointer hover:bg-muted/50 transition-colors"
                  onClick={() => toggleSort('timestamp')}
                >
                  <div className="flex items-center gap-1">
                    Tijd
                    <ArrowUpDown className="h-3 w-3" />
                  </div>
                </TableHead>
                <TableHead>Markt</TableHead>
                <TableHead>Outcome</TableHead>
                <TableHead 
                  className="cursor-pointer hover:bg-muted/50 transition-colors"
                  onClick={() => toggleSort('price')}
                >
                  <div className="flex items-center gap-1">
                    Prijs
                    <ArrowUpDown className="h-3 w-3" />
                  </div>
                </TableHead>
                <TableHead>Shares</TableHead>
                <TableHead 
                  className="cursor-pointer hover:bg-muted/50 transition-colors"
                  onClick={() => toggleSort('total')}
                >
                  <div className="flex items-center gap-1">
                    Total
                    <ArrowUpDown className="h-3 w-3" />
                  </div>
                </TableHead>
                <TableHead>Type</TableHead>
                <TableHead className="min-w-[300px]">Reasoning</TableHead>
                <TableHead>Positie Na Trade</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {paginatedTrades.map((trade) => (
                <TableRow key={trade.id} className="hover:bg-muted/30">
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {trade.marketTradeNumber}
                  </TableCell>
                  <TableCell className="text-xs font-mono">
                    {new Date(trade.timestamp).toLocaleTimeString('nl-NL', { 
                      hour: '2-digit', 
                      minute: '2-digit', 
                      second: '2-digit' 
                    })}
                    {trade.timeSinceLastTrade !== null && (
                      <span className="text-muted-foreground ml-1">
                        (+{trade.timeSinceLastTrade.toFixed(1)}s)
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="text-xs truncate max-w-[150px] block cursor-help">
                          {trade.market_slug.replace(/-/g, ' ').slice(0, 25)}...
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>
                        <p>{trade.market}</p>
                      </TooltipContent>
                    </Tooltip>
                  </TableCell>
                  <TableCell>
                    <Badge 
                      variant={trade.outcome === 'Up' ? 'default' : 'secondary'}
                      className={trade.outcome === 'Up' 
                        ? 'bg-green-500/20 text-green-400 border-green-500/30' 
                        : 'bg-red-500/20 text-red-400 border-red-500/30'
                      }
                    >
                      {trade.outcome === 'Up' ? <TrendingUp className="h-3 w-3 mr-1" /> : <TrendingDown className="h-3 w-3 mr-1" />}
                      {trade.outcome}
                    </Badge>
                  </TableCell>
                  <TableCell className="font-mono">
                    <span className={
                      trade.price <= 0.20 ? 'text-green-400' : 
                      trade.price >= 0.80 ? 'text-red-400' : ''
                    }>
                      {(trade.price * 100).toFixed(0)}¢
                    </span>
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {trade.shares.toFixed(2)}
                  </TableCell>
                  <TableCell className="font-mono">
                    ${trade.total.toFixed(2)}
                  </TableCell>
                  <TableCell>
                    {getReasoningBadge(trade.reasoningType)}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {trade.reasoning}
                  </TableCell>
                  <TableCell className="text-xs font-mono">
                    <div className="space-y-0.5">
                      <div className="flex items-center gap-2">
                        <span className="text-green-400">↑{trade.runningUpShares.toFixed(0)}</span>
                        <span className="text-red-400">↓{trade.runningDownShares.toFixed(0)}</span>
                      </div>
                      {trade.currentCombinedEntry > 0 && (
                        <div className={
                          trade.currentCombinedEntry < 0.98 ? 'text-green-400' : 
                          trade.currentCombinedEntry > 1.00 ? 'text-red-400' : 'text-yellow-400'
                        }>
                          Σ{(trade.currentCombinedEntry * 100).toFixed(1)}¢
                        </div>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        {/* Pagination */}
        <div className="flex items-center justify-between">
          <div className="text-sm text-muted-foreground">
            Toon {((currentPage - 1) * pageSize) + 1} - {Math.min(currentPage * pageSize, filteredTrades.length)} van {filteredTrades.length} trades
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
              disabled={currentPage === 1}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="text-sm">
              Pagina {currentPage} van {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
              disabled={currentPage === totalPages}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* Reasoning Legend */}
        <div className="p-4 bg-muted/50 rounded-lg">
          <h4 className="font-semibold mb-3">Reasoning Types Uitleg</h4>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 text-sm">
            <div className="flex items-start gap-2">
              <span className="text-blue-400">🚀</span>
              <div>
                <strong>OPENING</strong>
                <p className="text-muted-foreground text-xs">Eerste trade in een nieuwe markt. Start van de positie.</p>
              </div>
            </div>
            <div className="flex items-start gap-2">
              <span className="text-purple-400">🛡️</span>
              <div>
                <strong>HEDGE</strong>
                <p className="text-muted-foreground text-xs">Start van de tegengestelde kant. Dual-side positie begint.</p>
              </div>
            </div>
            <div className="flex items-start gap-2">
              <span className="text-green-400">💰</span>
              <div>
                <strong>DCA_CHEAP</strong>
                <p className="text-muted-foreground text-xs">Kopen bij lage prijs (≤20¢) voor goedkope shares.</p>
              </div>
            </div>
            <div className="flex items-start gap-2">
              <span className="text-yellow-400">⚖️</span>
              <div>
                <strong>DCA_BALANCE</strong>
                <p className="text-muted-foreground text-xs">Herbalanceren als Up/Down ratio &gt;20% scheef is.</p>
              </div>
            </div>
            <div className="flex items-start gap-2">
              <span className="text-primary">🎯</span>
              <div>
                <strong>ARBITRAGE</strong>
                <p className="text-muted-foreground text-xs">Combined entry &lt;98¢ bereikt = gegarandeerde winst.</p>
              </div>
            </div>
            <div className="flex items-start gap-2">
              <span>📈</span>
              <div>
                <strong>ACCUMULATE</strong>
                <p className="text-muted-foreground text-xs">Standaard DCA accumulatie zonder specifieke trigger.</p>
              </div>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
