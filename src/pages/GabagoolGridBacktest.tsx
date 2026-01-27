import { useState } from "react";
import { MainNav } from "@/components/MainNav";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Loader2, TrendingUp, TrendingDown, Grid3X3, BarChart3, Target, DollarSign, Percent, AlertTriangle } from "lucide-react";
import { useGabagoolGridBacktest, type GridBacktestConfig } from "@/hooks/useGabagoolGridBacktest";

export default function GabagoolGridBacktest() {
  const [selectedMode, setSelectedMode] = useState<'safe' | 'gabagool'>('gabagool');
  
  const config: GridBacktestConfig = { mode: selectedMode };
  const { data, isLoading, error, refetch } = useGabagoolGridBacktest(config);

  const formatCurrency = (value: number) => `$${value.toFixed(2)}`;
  const formatPercent = (value: number) => `${(value * 100).toFixed(1)}%`;
  const formatCpp = (value: number) => `${(value * 100).toFixed(1)}¢`;

  return (
    <div className="min-h-screen bg-background">
      <MainNav />
      <div className="container mx-auto px-4 py-8">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-3xl font-bold flex items-center gap-2">
              <Grid3X3 className="h-8 w-8 text-primary" />
              Grid Market Making Backtest
            </h1>
            <p className="text-muted-foreground mt-1">
              Simuleer Gabagool's passieve limit order strategie op historische markets
            </p>
          </div>
        </div>

        {/* Mode Selection */}
        <div className="flex gap-4 mb-6">
          <Button
            variant={selectedMode === 'safe' ? 'default' : 'outline'}
            onClick={() => setSelectedMode('safe')}
            className="flex-1"
          >
            <Target className="h-4 w-4 mr-2" />
            Safe Mode (Huidig)
            <Badge variant="secondary" className="ml-2">0.30-0.70</Badge>
          </Button>
          <Button
            variant={selectedMode === 'gabagool' ? 'default' : 'outline'}
            onClick={() => setSelectedMode('gabagool')}
            className="flex-1"
          >
            <TrendingUp className="h-4 w-4 mr-2" />
            Gabagool Mode
            <Badge variant="secondary" className="ml-2">0.10-0.90</Badge>
          </Button>
        </div>

        {/* Config Summary */}
        <Card className="mb-6">
          <CardHeader className="pb-2">
            <CardTitle className="text-lg">Configuratie: {selectedMode.toUpperCase()}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4 text-sm">
              <div>
                <div className="text-muted-foreground">Grid Range</div>
                <div className="font-mono font-bold">
                  {selectedMode === 'safe' ? '0.30 - 0.70' : '0.10 - 0.90'}
                </div>
              </div>
              <div>
                <div className="text-muted-foreground">Grid Step</div>
                <div className="font-mono font-bold">
                  {selectedMode === 'safe' ? '5¢' : '1¢'}
                </div>
              </div>
              <div>
                <div className="text-muted-foreground">Core Size</div>
                <div className="font-mono font-bold">
                  {selectedMode === 'safe' ? '10' : '15'} shares
                </div>
              </div>
              <div>
                <div className="text-muted-foreground">Max Unpaired</div>
                <div className="font-mono font-bold">
                  {selectedMode === 'safe' ? '20' : '150'} shares
                </div>
              </div>
              <div>
                <div className="text-muted-foreground">Entry Delay</div>
                <div className="font-mono font-bold">
                  {selectedMode === 'safe' ? '5s' : '3s'}
                </div>
              </div>
              <div>
                <div className="text-muted-foreground">Stop Before</div>
                <div className="font-mono font-bold">
                  {selectedMode === 'safe' ? '3m' : '1m'}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Loading / Error States */}
        {isLoading && (
          <Card className="mb-6">
            <CardContent className="py-12 text-center">
              <Loader2 className="h-8 w-8 animate-spin mx-auto mb-4 text-primary" />
              <p className="text-muted-foreground">Simulatie wordt uitgevoerd...</p>
              <p className="text-sm text-muted-foreground mt-2">
                Dit kan 30-60 seconden duren bij veel markets
              </p>
            </CardContent>
          </Card>
        )}

        {error && (
          <Card className="mb-6 border-destructive">
            <CardContent className="py-8 text-center">
              <AlertTriangle className="h-8 w-8 text-destructive mx-auto mb-4" />
              <p className="text-destructive font-medium">Backtest fout</p>
              <p className="text-sm text-muted-foreground mt-2">{String(error)}</p>
              <Button onClick={() => refetch()} className="mt-4">
                Opnieuw proberen
              </Button>
            </CardContent>
          </Card>
        )}

        {/* Results */}
        {data && !isLoading && (
          <>
            {/* Summary Cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4 mb-6">
              <Card>
                <CardContent className="pt-4">
                  <div className="flex items-center gap-2">
                    <BarChart3 className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm text-muted-foreground">Markets</span>
                  </div>
                  <div className="text-2xl font-bold">{data.summary.traded_markets}</div>
                  <div className="text-xs text-muted-foreground">
                    van {data.summary.total_markets}
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardContent className="pt-4">
                  <div className="flex items-center gap-2">
                    <Target className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm text-muted-foreground">Win Rate</span>
                  </div>
                  <div className="text-2xl font-bold">
                    {formatPercent(data.summary.win_rate)}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {data.summary.profit_markets}W / {data.summary.loss_markets}L
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardContent className="pt-4">
                  <div className="flex items-center gap-2">
                    <DollarSign className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm text-muted-foreground">Total P&L</span>
                  </div>
                  <div className={`text-2xl font-bold ${data.summary.total_pnl >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                    {formatCurrency(data.summary.total_pnl)}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    op {formatCurrency(data.summary.total_cost)} invested
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardContent className="pt-4">
                  <div className="flex items-center gap-2">
                    <Percent className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm text-muted-foreground">ROI</span>
                  </div>
                  <div className={`text-2xl font-bold ${data.summary.roi_percent >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                    {data.summary.roi_percent.toFixed(2)}%
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardContent className="pt-4">
                  <div className="flex items-center gap-2">
                    <TrendingUp className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm text-muted-foreground">Avg CPP</span>
                  </div>
                  <div className="text-2xl font-bold font-mono">
                    {formatCpp(data.summary.avg_cpp)}
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardContent className="pt-4">
                  <div className="flex items-center gap-2">
                    <Grid3X3 className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm text-muted-foreground">Grid Levels</span>
                  </div>
                  <div className="text-2xl font-bold">{data.summary.grid_levels}</div>
                  <div className="text-xs text-muted-foreground">
                    {data.summary.grid_range}
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* Detailed Tabs */}
            <Tabs defaultValue="byAsset" className="space-y-4">
              <TabsList>
                <TabsTrigger value="byAsset">Per Asset</TabsTrigger>
                <TabsTrigger value="trades">Alle Trades</TabsTrigger>
                <TabsTrigger value="comparison">Vergelijking</TabsTrigger>
              </TabsList>

              <TabsContent value="byAsset">
                <Card>
                  <CardHeader>
                    <CardTitle>Resultaten per Asset</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Asset</TableHead>
                          <TableHead className="text-right">Markets</TableHead>
                          <TableHead className="text-right">Traded</TableHead>
                          <TableHead className="text-right">P&L</TableHead>
                          <TableHead className="text-right">Avg CPP</TableHead>
                          <TableHead className="text-right">Avg Shares</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {Object.entries(data.summary.by_asset).map(([asset, stats]) => (
                          <TableRow key={asset}>
                            <TableCell className="font-mono font-bold">{asset}</TableCell>
                            <TableCell className="text-right">{stats.markets}</TableCell>
                            <TableCell className="text-right">{stats.traded}</TableCell>
                            <TableCell className={`text-right font-bold ${stats.pnl >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                              {formatCurrency(stats.pnl)}
                            </TableCell>
                            <TableCell className="text-right font-mono">
                              {formatCpp(stats.avgCpp)}
                            </TableCell>
                            <TableCell className="text-right">
                              {(stats.avgShares / stats.traded || 0).toFixed(0)}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="trades">
                <Card>
                  <CardHeader>
                    <CardTitle>Recente Trades</CardTitle>
                    <CardDescription>Laatste 50 gesimuleerde markets</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="max-h-[500px] overflow-y-auto">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Market</TableHead>
                            <TableHead className="text-right">UP Qty</TableHead>
                            <TableHead className="text-right">DOWN Qty</TableHead>
                            <TableHead className="text-right">Paired</TableHead>
                            <TableHead className="text-right">CPP</TableHead>
                            <TableHead className="text-right">Outcome</TableHead>
                            <TableHead className="text-right">P&L</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {data.results.slice(0, 50).map((r, i) => (
                            <TableRow key={i}>
                              <TableCell className="font-mono text-xs max-w-[200px] truncate">
                                {r.marketSlug.slice(-30)}
                              </TableCell>
                              <TableCell className="text-right">{r.totalUpQty}</TableCell>
                              <TableCell className="text-right">{r.totalDownQty}</TableCell>
                              <TableCell className="text-right">{r.paired}</TableCell>
                              <TableCell className="text-right font-mono">
                                {r.combinedCost > 0 ? formatCpp(r.combinedCost) : '-'}
                              </TableCell>
                              <TableCell className="text-right">
                                <Badge variant={r.outcome === 'UP' ? 'default' : 'secondary'}>
                                  {r.outcome}
                                </Badge>
                              </TableCell>
                              <TableCell className={`text-right font-bold ${r.pnl >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                                {formatCurrency(r.pnl)}
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="comparison">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <Card className={selectedMode === 'safe' ? 'border-primary' : ''}>
                    <CardHeader>
                      <CardTitle className="flex items-center gap-2">
                        <Target className="h-5 w-5" />
                        Safe Mode (Huidig)
                      </CardTitle>
                      <CardDescription>Grid: 0.30 - 0.70, Max Unpaired: 20</CardDescription>
                    </CardHeader>
                    <CardContent>
                      <div className="space-y-2">
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Grid Levels</span>
                          <span className="font-bold">8 per kant</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Dekking</span>
                          <span className="font-bold">40%</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Momentum Filter</span>
                          <span className="font-bold text-green-500">Aan</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Fill Sync</span>
                          <span className="font-bold text-green-500">Aan</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Risico</span>
                          <Badge variant="outline">Laag</Badge>
                        </div>
                      </div>
                    </CardContent>
                  </Card>

                  <Card className={selectedMode === 'gabagool' ? 'border-primary' : ''}>
                    <CardHeader>
                      <CardTitle className="flex items-center gap-2">
                        <TrendingUp className="h-5 w-5" />
                        Gabagool Mode
                      </CardTitle>
                      <CardDescription>Grid: 0.10 - 0.90, Max Unpaired: 150</CardDescription>
                    </CardHeader>
                    <CardContent>
                      <div className="space-y-2">
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Grid Levels</span>
                          <span className="font-bold">80 per kant</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Dekking</span>
                          <span className="font-bold">80%</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Momentum Filter</span>
                          <span className="font-bold text-red-500">Uit</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Fill Sync</span>
                          <span className="font-bold text-red-500">Uit</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Risico</span>
                          <Badge variant="destructive">Hoog</Badge>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                </div>

                <Card className="mt-6">
                  <CardHeader>
                    <CardTitle>⚠️ Belangrijke Overwegingen</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="flex gap-3">
                      <AlertTriangle className="h-5 w-5 text-yellow-500 flex-shrink-0 mt-0.5" />
                      <div>
                        <div className="font-medium">Backtest ≠ Live Performance</div>
                        <div className="text-sm text-muted-foreground">
                          Deze simulatie neemt aan dat alle limit orders die onder de markt ask vallen ook daadwerkelijk gevuld worden.
                          In werkelijkheid concurreer je met andere market makers.
                        </div>
                      </div>
                    </div>
                    <div className="flex gap-3">
                      <AlertTriangle className="h-5 w-5 text-yellow-500 flex-shrink-0 mt-0.5" />
                      <div>
                        <div className="font-medium">Order Book Competition</div>
                        <div className="text-sm text-muted-foreground">
                          Gabagool is een grote player - hun orders worden sneller gevuld door betere queue position.
                          Kleinere traders kunnen langere wachttijden ervaren.
                        </div>
                      </div>
                    </div>
                    <div className="flex gap-3">
                      <AlertTriangle className="h-5 w-5 text-yellow-500 flex-shrink-0 mt-0.5" />
                      <div>
                        <div className="font-medium">Capital Requirements</div>
                        <div className="text-sm text-muted-foreground">
                          Het Gabagool-niveau grid (80 levels × 15 shares × beide kanten) vereist ~$1,200+ margin per market.
                          Zorg dat je voldoende kapitaal hebt.
                        </div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </TabsContent>
            </Tabs>
          </>
        )}
      </div>
    </div>
  );
}
