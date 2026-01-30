import { useState } from "react";
import { MainNav } from "@/components/MainNav";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Slider } from "@/components/ui/slider";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useGabagoolHistoricalBacktest, HistoricalBacktestConfig } from "@/hooks/useGabagoolHistoricalBacktest";
import { 
  TrendingUp, 
  TrendingDown, 
  DollarSign, 
  Target, 
  Clock, 
  BarChart3,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Settings2,
  Trophy,
  Percent,
  Activity,
  Zap
} from "lucide-react";

export default function GabagoolBacktest() {
  const [config, setConfig] = useState<HistoricalBacktestConfig>({
    shares_per_side: 5,
    max_entry_price: 0.50,
    max_cpp: 0.97,
    min_delay_second_leg_ms: 2000,
    max_wait_second_leg_ms: 45000,
    entry_after_market_start_ms: 15000, // Gabagool starts 15-30s after market open
  });

  const { data, isLoading, error } = useGabagoolHistoricalBacktest(config);

  const formatCurrency = (value: number) => `$${value.toFixed(2)}`;
  const formatPercent = (value: number) => `${(value * 100).toFixed(1)}%`;
  const formatCpp = (value: number) => `${(value * 100).toFixed(1)}¢`;
  const formatTime = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

  return (
    <div className="min-h-screen bg-background">
      <MainNav />
      <div className="container mx-auto px-4 py-8">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-3xl font-bold flex items-center gap-2">
              <BarChart3 className="h-8 w-8 text-primary" />
              Gabagool Historical Backtest
            </h1>
            <p className="text-muted-foreground mt-1">
              Simuleer de hedge-strategie op {data?.summary.total_markets || '...'} echte afgesloten markten
            </p>
          </div>
          {data && (
            <Badge 
              variant={data.summary.total_pnl >= 0 ? "default" : "destructive"}
              className="text-lg px-4 py-2"
            >
              {data.summary.total_pnl >= 0 ? '+' : ''}{formatCurrency(data.summary.total_pnl)} Total PnL
            </Badge>
          )}
        </div>

        {/* Configuration Panel */}
        <Card className="mb-6">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Settings2 className="h-5 w-5" />
              Backtest Configuratie
            </CardTitle>
            <CardDescription>
              Pas de parameters aan en bekijk de resultaten op echte marktdata
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-6 gap-6">
              <div className="space-y-2">
                <Label>Shares per Side: {config.shares_per_side}</Label>
                <Slider
                  value={[config.shares_per_side]}
                  onValueChange={([v]) => setConfig(c => ({ ...c, shares_per_side: v }))}
                  min={1}
                  max={25}
                  step={1}
                />
                <p className="text-xs text-muted-foreground">
                  Max cost: ~{formatCurrency(config.shares_per_side * config.max_entry_price * 2)}
                </p>
              </div>

              <div className="space-y-2">
                <Label>Max Entry Price: {formatCpp(config.max_entry_price)}</Label>
                <Slider
                  value={[config.max_entry_price * 100]}
                  onValueChange={([v]) => setConfig(c => ({ ...c, max_entry_price: v / 100 }))}
                  min={35}
                  max={55}
                  step={1}
                />
              </div>

              <div className="space-y-2">
                <Label>Max CPP: {formatCpp(config.max_cpp)}</Label>
                <Slider
                  value={[config.max_cpp * 100]}
                  onValueChange={([v]) => setConfig(c => ({ ...c, max_cpp: v / 100 }))}
                  min={90}
                  max={102}
                  step={1}
                />
              </div>

              <div className="space-y-2">
                <Label>Entry After Start: {formatTime(config.entry_after_market_start_ms)}</Label>
                <Slider
                  value={[config.entry_after_market_start_ms / 1000]}
                  onValueChange={([v]) => setConfig(c => ({ ...c, entry_after_market_start_ms: v * 1000 }))}
                  min={0}
                  max={60}
                  step={5}
                />
              </div>

              <div className="space-y-2">
                <Label>Min Delay 2nd Leg: {formatTime(config.min_delay_second_leg_ms)}</Label>
                <Slider
                  value={[config.min_delay_second_leg_ms / 1000]}
                  onValueChange={([v]) => setConfig(c => ({ ...c, min_delay_second_leg_ms: v * 1000 }))}
                  min={0}
                  max={30}
                  step={1}
                />
              </div>

              <div className="space-y-2">
                <Label>Max Wait 2nd Leg: {formatTime(config.max_wait_second_leg_ms)}</Label>
                <Slider
                  value={[config.max_wait_second_leg_ms / 1000]}
                  onValueChange={([v]) => setConfig(c => ({ ...c, max_wait_second_leg_ms: v * 1000 }))}
                  min={10}
                  max={300}
                  step={10}
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {isLoading && (
          <div className="flex flex-col items-center justify-center py-12 gap-4">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary"></div>
            <p className="text-muted-foreground">Backtesting op echte marktdata...</p>
          </div>
        )}

        {error && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Error</AlertTitle>
            <AlertDescription>{String(error)}</AlertDescription>
          </Alert>
        )}

        {data && (
          <>
            {/* Key Performance Metrics */}
            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-4 mb-6">
              <Card>
                <CardContent className="pt-4">
                  <div className="text-2xl font-bold">{data.summary.total_markets}</div>
                  <p className="text-xs text-muted-foreground">Markets</p>
                </CardContent>
              </Card>

              <Card>
                <CardContent className="pt-4">
                  <div className="text-2xl font-bold">{data.summary.traded_markets}</div>
                  <p className="text-xs text-muted-foreground">Traded</p>
                </CardContent>
              </Card>

              <Card className="border-green-500/30 bg-green-500/5">
                <CardContent className="pt-4">
                  <div className="text-2xl font-bold text-green-600">{data.summary.paired_markets}</div>
                  <p className="text-xs text-muted-foreground">Paired</p>
                </CardContent>
              </Card>

              <Card className="border-yellow-500/30 bg-yellow-500/5">
                <CardContent className="pt-4">
                  <div className="text-2xl font-bold text-yellow-600">{data.summary.single_sided_markets}</div>
                  <p className="text-xs text-muted-foreground">Single-Sided</p>
                </CardContent>
              </Card>

              <Card>
                <CardContent className="pt-4">
                  <div className="text-2xl font-bold">{formatPercent(data.summary.win_rate)}</div>
                  <p className="text-xs text-muted-foreground">Win Rate</p>
                </CardContent>
              </Card>

              <Card>
                <CardContent className="pt-4">
                  <div className="text-2xl font-bold">{data.summary.avg_cpp > 0 ? formatCpp(data.summary.avg_cpp) : 'N/A'}</div>
                  <p className="text-xs text-muted-foreground">Avg CPP</p>
                </CardContent>
              </Card>

              <Card className={data.summary.roi_percent >= 0 ? "border-green-500/30 bg-green-500/5" : "border-red-500/30 bg-red-500/5"}>
                <CardContent className="pt-4">
                  <div className={`text-2xl font-bold ${data.summary.roi_percent >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                    {data.summary.roi_percent >= 0 ? '+' : ''}{data.summary.roi_percent.toFixed(1)}%
                  </div>
                  <p className="text-xs text-muted-foreground">ROI</p>
                </CardContent>
              </Card>

              <Card className={data.summary.total_pnl >= 0 ? "border-green-500/30 bg-green-500/5" : "border-red-500/30 bg-red-500/5"}>
                <CardContent className="pt-4">
                  <div className={`text-2xl font-bold ${data.summary.total_pnl >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                    {formatCurrency(data.summary.total_pnl)}
                  </div>
                  <p className="text-xs text-muted-foreground">Total PnL</p>
                </CardContent>
              </Card>
            </div>

            {/* Detailed Stats */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-lg flex items-center gap-2">
                    <Trophy className="h-5 w-5 text-primary" />
                    Win/Loss Breakdown
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    <div className="flex justify-between items-center">
                      <span className="flex items-center gap-2">
                        <CheckCircle2 className="h-4 w-4 text-green-500" />
                        Paired Wins
                      </span>
                      <Badge variant="outline" className="bg-green-500/10 text-green-600">{data.summary.paired_wins}</Badge>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="flex items-center gap-2">
                        <XCircle className="h-4 w-4 text-red-500" />
                        Paired Losses
                      </span>
                      <Badge variant="outline" className="bg-red-500/10 text-red-600">{data.summary.paired_losses}</Badge>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="flex items-center gap-2">
                        <TrendingUp className="h-4 w-4 text-green-500" />
                        Single Wins
                      </span>
                      <Badge variant="outline" className="bg-green-500/10 text-green-600">{data.summary.single_wins}</Badge>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="flex items-center gap-2">
                        <TrendingDown className="h-4 w-4 text-red-500" />
                        Single Losses
                      </span>
                      <Badge variant="outline" className="bg-red-500/10 text-red-600">{data.summary.single_losses}</Badge>
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-lg flex items-center gap-2">
                    <DollarSign className="h-5 w-5 text-primary" />
                    Financial Summary
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    <div className="flex justify-between items-center">
                      <span className="text-muted-foreground">Total Cost</span>
                      <span className="font-bold">{formatCurrency(data.summary.total_cost)}</span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-muted-foreground">Total Payout</span>
                      <span className="font-bold">{formatCurrency(data.summary.total_payout)}</span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-muted-foreground">Net PnL</span>
                      <span className={`font-bold ${data.summary.total_pnl >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                        {formatCurrency(data.summary.total_pnl)}
                      </span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-muted-foreground">Avg PnL/Trade</span>
                      <span className={`font-bold ${data.summary.avg_pnl_per_trade >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                        {formatCurrency(data.summary.avg_pnl_per_trade)}
                      </span>
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-lg flex items-center gap-2">
                    <Zap className="h-5 w-5 text-primary" />
                    Projected Returns
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    <div className="flex justify-between items-center">
                      <span className="text-muted-foreground">Per Trade</span>
                      <span className="font-bold">{formatCurrency(data.summary.avg_pnl_per_trade)}</span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-muted-foreground">Per Hour (4 trades)</span>
                      <span className="font-bold">{formatCurrency(data.summary.avg_pnl_per_trade * 4)}</span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-muted-foreground">Per Day (96 trades)</span>
                      <span className="font-bold text-primary">{formatCurrency(data.summary.avg_pnl_per_trade * 96)}</span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-muted-foreground">Per Month</span>
                      <span className="font-bold text-primary">{formatCurrency(data.summary.avg_pnl_per_trade * 96 * 30)}</span>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* Asset Breakdown */}
            <Card className="mb-6">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Activity className="h-5 w-5" />
                  Per Asset Performance
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  {Object.entries(data.summary.by_asset).map(([asset, stats]) => (
                    <Card key={asset} className="bg-muted/30">
                      <CardContent className="pt-4">
                        <div className="flex items-center justify-between mb-3">
                          <Badge variant="outline" className="text-lg font-bold">{asset}</Badge>
                          <span className={`font-bold ${stats.pnl >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                            {stats.pnl >= 0 ? '+' : ''}{formatCurrency(stats.pnl)}
                          </span>
                        </div>
                        <div className="space-y-1 text-sm">
                          <div className="flex justify-between">
                            <span className="text-muted-foreground">Markets:</span>
                            <span>{stats.traded}/{stats.markets}</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-muted-foreground">Win/Loss:</span>
                            <span className="text-green-600">{stats.wins}</span>
                            <span>/</span>
                            <span className="text-red-600">{stats.losses}</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-muted-foreground">Avg CPP:</span>
                            <span>{stats.avg_cpp > 0 ? formatCpp(stats.avg_cpp) : 'N/A'}</span>
                          </div>
                        </div>
                        <Progress 
                          value={stats.traded > 0 ? (stats.wins / stats.traded) * 100 : 0} 
                          className="mt-2 h-2" 
                        />
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </CardContent>
            </Card>

            {/* Trade Details */}
            <Card>
              <CardHeader>
                <CardTitle>Trade Details ({data.trades.length})</CardTitle>
              </CardHeader>
              <CardContent>
                <Tabs defaultValue="all">
                  <TabsList>
                    <TabsTrigger value="all">All ({data.summary.traded_markets})</TabsTrigger>
                    <TabsTrigger value="paired-win" className="text-green-600">
                      Paired Wins ({data.summary.paired_wins})
                    </TabsTrigger>
                    <TabsTrigger value="paired-loss" className="text-red-600">
                      Paired Losses ({data.summary.paired_losses})
                    </TabsTrigger>
                    <TabsTrigger value="single">
                      Single-Sided ({data.summary.single_sided_markets})
                    </TabsTrigger>
                    <TabsTrigger value="skipped" className="text-muted-foreground">
                      Skipped ({data.summary.skipped_markets})
                    </TabsTrigger>
                  </TabsList>

                  {['all', 'paired-win', 'paired-loss', 'single', 'skipped'].map(tab => (
                    <TabsContent key={tab} value={tab}>
                      <ScrollArea className="h-[500px]">
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>Market</TableHead>
                              <TableHead>Asset</TableHead>
                              <TableHead>1st Side</TableHead>
                              <TableHead>1st Price</TableHead>
                              <TableHead>2nd Price</TableHead>
                              <TableHead>Delay</TableHead>
                              <TableHead>CPP</TableHead>
                              <TableHead>Outcome</TableHead>
                              <TableHead>Cost</TableHead>
                              <TableHead>Payout</TableHead>
                              <TableHead>PnL</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {data.trades
                              .filter(t => {
                                if (tab === 'all') return t.status !== 'skipped';
                                if (tab === 'paired-win') return t.status === 'paired-win';
                                if (tab === 'paired-loss') return t.status === 'paired-loss';
                                if (tab === 'single') return t.status.startsWith('single');
                                if (tab === 'skipped') return t.status === 'skipped';
                                return true;
                              })
                              .slice(0, 200)
                              .map((trade, i) => (
                                <TableRow key={i} className={trade.pnl > 0 ? 'bg-green-500/5' : trade.pnl < 0 ? 'bg-red-500/5' : ''}>
                                  <TableCell className="font-mono text-xs">
                                    {trade.market_slug.split('-').slice(-1)[0]}
                                  </TableCell>
                                  <TableCell>
                                    <Badge variant="outline">{trade.asset}</Badge>
                                  </TableCell>
                                  <TableCell>
                                    {trade.status !== 'skipped' ? (
                                      <Badge variant={trade.first_side === 'UP' ? 'default' : 'secondary'}>
                                        {trade.first_side === 'UP' ? <TrendingUp className="h-3 w-3 mr-1" /> : <TrendingDown className="h-3 w-3 mr-1" />}
                                        {trade.first_side}
                                      </Badge>
                                    ) : '-'}
                                  </TableCell>
                                  <TableCell>{trade.first_price > 0 ? formatCpp(trade.first_price) : '-'}</TableCell>
                                  <TableCell>{trade.second_price ? formatCpp(trade.second_price) : '-'}</TableCell>
                                  <TableCell>{trade.delay_ms ? formatTime(trade.delay_ms) : '-'}</TableCell>
                                  <TableCell className={trade.cpp && trade.cpp <= config.max_cpp ? 'text-green-600 font-bold' : trade.cpp ? 'text-yellow-600' : ''}>
                                    {trade.cpp ? formatCpp(trade.cpp) : '-'}
                                  </TableCell>
                                  <TableCell>
                                    {trade.status !== 'skipped' ? (
                                      <Badge variant={trade.outcome === 'UP' ? 'default' : 'secondary'}>
                                        {trade.outcome}
                                      </Badge>
                                    ) : (
                                      <span className="text-xs text-muted-foreground">{trade.skip_reason}</span>
                                    )}
                                  </TableCell>
                                  <TableCell>{trade.total_cost > 0 ? formatCurrency(trade.total_cost) : '-'}</TableCell>
                                  <TableCell>{trade.payout > 0 ? formatCurrency(trade.payout) : '-'}</TableCell>
                                  <TableCell className={`font-bold ${trade.pnl > 0 ? 'text-green-600' : trade.pnl < 0 ? 'text-red-600' : ''}`}>
                                    {trade.status !== 'skipped' ? formatCurrency(trade.pnl) : '-'}
                                  </TableCell>
                                </TableRow>
                              ))}
                          </TableBody>
                        </Table>
                      </ScrollArea>
                    </TabsContent>
                  ))}
                </Tabs>
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </div>
  );
}
