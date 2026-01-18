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
import { useGabagoolBacktest, BacktestConfig, BacktestTrade } from "@/hooks/useGabagoolBacktest";
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
  Settings2
} from "lucide-react";

export default function GabagoolBacktest() {
  const [config, setConfig] = useState<BacktestConfig>({
    shares_per_side: 5,
    max_entry_price: 0.50,
    max_cpp: 0.97,
    min_delay_second_leg_ms: 2000,
    max_wait_second_leg_ms: 45000,
  });

  const { data, isLoading, error } = useGabagoolBacktest(config);

  const formatCurrency = (value: number) => `$${value.toFixed(2)}`;
  const formatPercent = (value: number) => `${(value * 100).toFixed(1)}%`;
  const formatCpp = (value: number) => `${(value * 100).toFixed(1)}¢`;

  return (
    <div className="min-h-screen bg-background">
      <MainNav />
      <div className="container mx-auto px-4 py-8">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-3xl font-bold flex items-center gap-2">
              <BarChart3 className="h-8 w-8 text-primary" />
              Gabagool Strategy Backtest
            </h1>
            <p className="text-muted-foreground mt-1">
              Simuleer de hedge-strategie op historische data
            </p>
          </div>
        </div>

        {/* Configuration Panel */}
        <Card className="mb-6">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Settings2 className="h-5 w-5" />
              Backtest Configuratie
            </CardTitle>
            <CardDescription>
              Pas de parameters aan en bekijk de resultaten
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-6">
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
                  Cost: ~{formatCurrency(config.shares_per_side * 0.5 * 2)}
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
                  max={100}
                  step={1}
                />
              </div>

              <div className="space-y-2">
                <Label>Min Delay: {(config.min_delay_second_leg_ms / 1000).toFixed(1)}s</Label>
                <Slider
                  value={[config.min_delay_second_leg_ms / 1000]}
                  onValueChange={([v]) => setConfig(c => ({ ...c, min_delay_second_leg_ms: v * 1000 }))}
                  min={0}
                  max={10}
                  step={0.5}
                />
              </div>

              <div className="space-y-2">
                <Label>Max Wait: {(config.max_wait_second_leg_ms / 1000).toFixed(0)}s</Label>
                <Slider
                  value={[config.max_wait_second_leg_ms / 1000]}
                  onValueChange={([v]) => setConfig(c => ({ ...c, max_wait_second_leg_ms: v * 1000 }))}
                  min={10}
                  max={120}
                  step={5}
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {isLoading && (
          <div className="flex items-center justify-center py-12">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
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
            {/* Summary Cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4 mb-6">
              <Card>
                <CardContent className="pt-4">
                  <div className="text-2xl font-bold">{data.summary.total_markets}</div>
                  <p className="text-sm text-muted-foreground">Total Markets</p>
                </CardContent>
              </Card>

              <Card className="border-green-500/30 bg-green-500/5">
                <CardContent className="pt-4">
                  <div className="text-2xl font-bold text-green-600">{data.summary.paired_markets}</div>
                  <p className="text-sm text-muted-foreground">Paired</p>
                </CardContent>
              </Card>

              <Card className="border-yellow-500/30 bg-yellow-500/5">
                <CardContent className="pt-4">
                  <div className="text-2xl font-bold text-yellow-600">{data.summary.partial_markets}</div>
                  <p className="text-sm text-muted-foreground">Partial (CPP &gt; {formatCpp(config.max_cpp)})</p>
                </CardContent>
              </Card>

              <Card className="border-red-500/30 bg-red-500/5">
                <CardContent className="pt-4">
                  <div className="text-2xl font-bold text-red-600">{data.summary.single_sided_markets}</div>
                  <p className="text-sm text-muted-foreground">Single-Sided</p>
                </CardContent>
              </Card>

              <Card>
                <CardContent className="pt-4">
                  <div className="text-2xl font-bold">{formatPercent(data.summary.pair_rate)}</div>
                  <p className="text-sm text-muted-foreground">Pair Rate</p>
                  <Progress value={data.summary.pair_rate * 100} className="mt-2 h-2" />
                </CardContent>
              </Card>

              <Card className={data.summary.total_pnl_paired >= 0 ? "border-green-500/30 bg-green-500/5" : "border-red-500/30 bg-red-500/5"}>
                <CardContent className="pt-4">
                  <div className={`text-2xl font-bold ${data.summary.total_pnl_paired >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                    {formatCurrency(data.summary.total_pnl_paired)}
                  </div>
                  <p className="text-sm text-muted-foreground">Est. PnL (Paired)</p>
                </CardContent>
              </Card>
            </div>

            {/* Key Metrics */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-lg flex items-center gap-2">
                    <Target className="h-5 w-5 text-primary" />
                    Avg CPP (Paired)
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-3xl font-bold">
                    {data.summary.avg_cpp > 0 ? formatCpp(data.summary.avg_cpp) : 'N/A'}
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Target: {formatCpp(config.max_cpp)} → {formatCurrency((1 - config.max_cpp) * config.shares_per_side)} profit per bet
                  </p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-lg flex items-center gap-2">
                    <Clock className="h-5 w-5 text-primary" />
                    Avg Delay
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-3xl font-bold">
                    {data.summary.avg_delay_ms > 0 ? `${(data.summary.avg_delay_ms / 1000).toFixed(1)}s` : 'N/A'}
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Tussen eerste en tweede leg
                  </p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-lg flex items-center gap-2">
                    <DollarSign className="h-5 w-5 text-primary" />
                    Capital Required
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-3xl font-bold">
                    {formatCurrency(config.shares_per_side * config.max_entry_price * 2)}
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Per markt ({config.shares_per_side} shares × 2 sides × {formatCpp(config.max_entry_price)})
                  </p>
                </CardContent>
              </Card>
            </div>

            {/* Asset Breakdown */}
            <Card className="mb-6">
              <CardHeader>
                <CardTitle>Per Asset Performance</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  {Object.entries(data.summary.by_asset).map(([asset, stats]) => (
                    <Card key={asset} className="bg-muted/30">
                      <CardContent className="pt-4">
                        <div className="flex items-center justify-between mb-2">
                          <Badge variant="outline" className="text-lg font-bold">{asset}</Badge>
                          <span className={stats.pnl >= 0 ? 'text-green-600 font-bold' : 'text-red-600 font-bold'}>
                            {formatCurrency(stats.pnl)}
                          </span>
                        </div>
                        <div className="space-y-1 text-sm">
                          <div className="flex justify-between">
                            <span className="text-muted-foreground">Markets:</span>
                            <span>{stats.markets}</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-muted-foreground">Paired:</span>
                            <span>{stats.paired} ({formatPercent(stats.pair_rate)})</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-muted-foreground">Avg CPP:</span>
                            <span>{stats.avg_cpp > 0 ? formatCpp(stats.avg_cpp) : 'N/A'}</span>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </CardContent>
            </Card>

            {/* Projections */}
            <Alert className="mb-6 border-primary/50 bg-primary/5">
              <TrendingUp className="h-5 w-5" />
              <AlertTitle>Winstprojectie (bij deze config)</AlertTitle>
              <AlertDescription className="mt-2">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                  <div>
                    <span className="text-muted-foreground">Per paired trade:</span>
                    <div className="font-bold">{formatCurrency((1 - data.summary.avg_cpp) * config.shares_per_side)}</div>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Bij {formatPercent(data.summary.pair_rate)} pair rate:</span>
                    <div className="font-bold">{formatCurrency((1 - data.summary.avg_cpp) * config.shares_per_side * data.summary.pair_rate)}/markt</div>
                  </div>
                  <div>
                    <span className="text-muted-foreground">4 markten/uur:</span>
                    <div className="font-bold">{formatCurrency((1 - data.summary.avg_cpp) * config.shares_per_side * data.summary.pair_rate * 4)}/uur</div>
                  </div>
                  <div>
                    <span className="text-muted-foreground">24 uur:</span>
                    <div className="font-bold">{formatCurrency((1 - data.summary.avg_cpp) * config.shares_per_side * data.summary.pair_rate * 4 * 24)}/dag</div>
                  </div>
                </div>
              </AlertDescription>
            </Alert>

            {/* Trade Details */}
            <Card>
              <CardHeader>
                <CardTitle>Backtest Trades ({data.trades.length})</CardTitle>
              </CardHeader>
              <CardContent>
                <Tabs defaultValue="paired">
                  <TabsList>
                    <TabsTrigger value="paired" className="flex items-center gap-1">
                      <CheckCircle2 className="h-4 w-4 text-green-500" />
                      Paired ({data.summary.paired_markets})
                    </TabsTrigger>
                    <TabsTrigger value="partial" className="flex items-center gap-1">
                      <AlertTriangle className="h-4 w-4 text-yellow-500" />
                      Partial ({data.summary.partial_markets})
                    </TabsTrigger>
                    <TabsTrigger value="single" className="flex items-center gap-1">
                      <XCircle className="h-4 w-4 text-red-500" />
                      Single-Sided ({data.summary.single_sided_markets})
                    </TabsTrigger>
                  </TabsList>

                  {['paired', 'partial', 'single'].map(tab => (
                    <TabsContent key={tab} value={tab}>
                      <ScrollArea className="h-[400px]">
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>Market</TableHead>
                              <TableHead>Asset</TableHead>
                              <TableHead>1st Side</TableHead>
                              <TableHead>1st Price</TableHead>
                              <TableHead>2nd Side</TableHead>
                              <TableHead>2nd Price</TableHead>
                              <TableHead>Delay</TableHead>
                              <TableHead>CPP</TableHead>
                              <TableHead>Cost</TableHead>
                              <TableHead>Est. PnL</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {data.trades
                              .filter(t => 
                                tab === 'paired' ? t.status === 'paired' :
                                tab === 'partial' ? t.status === 'partial' :
                                t.status === 'single-sided'
                              )
                              .slice(0, 100)
                              .map((trade, i) => (
                                <TableRow key={i}>
                                  <TableCell className="font-mono text-xs">
                                    {trade.market_id.split('-').slice(-1)[0]}
                                  </TableCell>
                                  <TableCell>
                                    <Badge variant="outline">{trade.asset}</Badge>
                                  </TableCell>
                                  <TableCell>
                                    <Badge variant={trade.first_side === 'UP' ? 'default' : 'secondary'}>
                                      {trade.first_side === 'UP' ? <TrendingUp className="h-3 w-3 mr-1" /> : <TrendingDown className="h-3 w-3 mr-1" />}
                                      {trade.first_side}
                                    </Badge>
                                  </TableCell>
                                  <TableCell>{formatCpp(trade.first_price)}</TableCell>
                                  <TableCell>
                                    {trade.second_side ? (
                                      <Badge variant={trade.second_side === 'UP' ? 'default' : 'secondary'}>
                                        {trade.second_side === 'UP' ? <TrendingUp className="h-3 w-3 mr-1" /> : <TrendingDown className="h-3 w-3 mr-1" />}
                                        {trade.second_side}
                                      </Badge>
                                    ) : '-'}
                                  </TableCell>
                                  <TableCell>{trade.second_price ? formatCpp(trade.second_price) : '-'}</TableCell>
                                  <TableCell>{trade.delay_ms ? `${(trade.delay_ms / 1000).toFixed(1)}s` : '-'}</TableCell>
                                  <TableCell className={trade.cpp && trade.cpp <= config.max_cpp ? 'text-green-600 font-bold' : 'text-yellow-600'}>
                                    {trade.cpp ? formatCpp(trade.cpp) : '-'}
                                  </TableCell>
                                  <TableCell>{formatCurrency(trade.total_cost)}</TableCell>
                                  <TableCell className={trade.pnl_if_paired >= 0 ? 'text-green-600 font-bold' : 'text-red-600'}>
                                    {formatCurrency(trade.pnl_if_paired)}
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
