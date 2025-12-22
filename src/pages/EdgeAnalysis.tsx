import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useTrades } from "@/hooks/useTrades";
import { ArrowLeft, Clock, Target, TrendingUp, Zap } from "lucide-react";
import { useEffect, useMemo } from "react";
import { Link } from "react-router-dom";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

type EdgeType = "arbitrage" | "neutral" | "risk";

type EdgePoint = {
  market: string;
  outcomeA: string;
  outcomeB: string;
  priceA: number;
  priceB: number;
  combined: number;
  edge: number;
  edgeType: EdgeType;
  timestamp: Date;
};

const EDGE_META = {
  arbitrage: { label: "Arbitrage (Edge < 1)", color: "hsl(var(--chart-1))" },
  neutral: { label: "Neutral (Edge ≈ 1)", color: "hsl(var(--muted-foreground))" },
  risk: { label: "Risk (Edge > 1)", color: "hsl(var(--chart-2))" },
} as const;

function upsertMetaTag(name: string, content: string) {
  const selector = `meta[name="${name}"]`;
  let el = document.head.querySelector(selector) as HTMLMetaElement | null;
  if (!el) {
    el = document.createElement("meta");
    el.setAttribute("name", name);
    document.head.appendChild(el);
  }
  el.setAttribute("content", content);
}

function upsertCanonical(href: string) {
  let el = document.head.querySelector('link[rel="canonical"]') as HTMLLinkElement | null;
  if (!el) {
    el = document.createElement("link");
    el.setAttribute("rel", "canonical");
    document.head.appendChild(el);
  }
  el.setAttribute("href", href);
}

export default function EdgeAnalysis() {
  const { trades, isLoading } = useTrades("gabagool22");

  useEffect(() => {
    document.title = "Edge analysis Gabagool22 | Trading dashboard";
    upsertMetaTag(
      "description",
      "Edge analyse van Gabagool22: hoe vaak arbitrage vs risk trades voorkomen en wanneer hij start."
    );
    upsertCanonical(`${window.location.origin}/edge-analysis`);
  }, []);

  const analysis = useMemo(() => {
    if (!trades.length) return null;

    // Group trades by market (fallback to market string when slug is empty)
    const marketGroups = new Map<string, typeof trades>();
    for (const trade of trades) {
      const key = (trade.marketSlug && trade.marketSlug.trim()) || trade.market;
      const group = marketGroups.get(key);
      if (group) group.push(trade);
      else marketGroups.set(key, [trade]);
    }

    const edgeData: EdgePoint[] = [];

    marketGroups.forEach((marketTrades) => {
      // Market name to display (prefer the verbose market title)
      const marketName = marketTrades[0]?.market ?? "";

      // Sort trades by timestamp ascending to find the FIRST trades (entry strategy)
      const sortedTrades = [...marketTrades].sort(
        (a, b) => a.timestamp.getTime() - b.timestamp.getTime()
      );

      // Group by outcome label (these are often "Up" / "Down", not "Yes" / "No")
      const outcomeGroups = new Map<string, typeof sortedTrades>();
      for (const t of sortedTrades) {
        const key = String(t.outcome);
        const group = outcomeGroups.get(key);
        if (group) group.push(t);
        else outcomeGroups.set(key, [t]);
      }

      const outcomes = Array.from(outcomeGroups.entries())
        .map(([outcome, list]) => ({ outcome, list, count: list.length }))
        .sort((a, b) => b.count - a.count);

      // We only support binary markets here (2 outcomes)
      if (outcomes.length < 2) return;

      const [a, b] = outcomes;

      // Get the FIRST trade for each outcome (entry price)
      const firstTradeA = a.list[0];
      const firstTradeB = b.list[0];

      const entryPriceA = firstTradeA.price;
      const entryPriceB = firstTradeB.price;
      const combined = entryPriceA + entryPriceB;
      const edge = 1 - combined;

      // Use the earliest entry timestamp
      const entryTs = new Date(
        Math.min(firstTradeA.timestamp.getTime(), firstTradeB.timestamp.getTime())
      );

      edgeData.push({
        market: marketName,
        outcomeA: a.outcome,
        outcomeB: b.outcome,
        priceA: entryPriceA,
        priceB: entryPriceB,
        combined,
        edge,
        edgeType: combined < 0.98 ? "arbitrage" : combined > 1.02 ? "risk" : "neutral",
        timestamp: entryTs,
      });
    });

    if (!edgeData.length) return null;

    const counts = {
      arbitrage: edgeData.filter((e) => e.edgeType === "arbitrage").length,
      neutral: edgeData.filter((e) => e.edgeType === "neutral").length,
      risk: edgeData.filter((e) => e.edgeType === "risk").length,
    };

    const total = edgeData.length || 1;

    const pieData = (Object.keys(counts) as EdgeType[])
      .map((k) => ({
        key: k,
        name: EDGE_META[k].label,
        value: counts[k],
        color: EDGE_META[k].color,
      }))
      .filter((d) => d.value > 0);

    const buckets = [
      { range: "<90%", min: 0, max: 0.9, count: 0 },
      { range: "90-95%", min: 0.9, max: 0.95, count: 0 },
      { range: "95-98%", min: 0.95, max: 0.98, count: 0 },
      { range: "98-100%", min: 0.98, max: 1.0, count: 0 },
      { range: "100-102%", min: 1.0, max: 1.02, count: 0 },
      { range: "102-105%", min: 1.02, max: 1.05, count: 0 },
      { range: ">105%", min: 1.05, max: 2.0, count: 0 },
    ];

    for (const e of edgeData) {
      const bucket = buckets.find((b) => e.combined >= b.min && e.combined < b.max);
      if (bucket) bucket.count++;
    }

    // Hourly activity (based on edgeData points, not raw trades)
    const hourlyActivity = Array.from({ length: 24 }, (_, i) => ({
      hour: i,
      marketPairs: 0,
      avgCombined: 0,
      combinedSum: 0,
    }));

    for (const e of edgeData) {
      const hour = e.timestamp.getUTCHours();
      hourlyActivity[hour].marketPairs++;
      hourlyActivity[hour].combinedSum += e.combined;
    }

    for (const h of hourlyActivity) {
      h.avgCombined = h.marketPairs ? h.combinedSum / h.marketPairs : 0;
    }

    const topArbitrage = [...edgeData]
      .filter((e) => e.edgeType === "arbitrage")
      .sort((a, b) => a.combined - b.combined)
      .slice(0, 10);

    const avgArbEdge = edgeData
      .filter((e) => e.edgeType === "arbitrage")
      .reduce((sum, e) => sum + (1 - e.combined), 0);

    const avgArbEdgePct = (avgArbEdge / (counts.arbitrage || 1)) * 100;

    const bestCombined = Math.min(...edgeData.map((e) => e.combined));
    const bestEdgePct = (1 - bestCombined) * 100;

    return {
      pieData,
      buckets,
      hourlyActivity,
      topArbitrage,
      stats: {
        totalMarkets: edgeData.length,
        arbitragePercent: ((counts.arbitrage / total) * 100).toFixed(1),
        riskPercent: ((counts.risk / total) * 100).toFixed(1),
        avgArbitrageEdge: avgArbEdgePct.toFixed(2),
        bestEdge: bestEdgePct.toFixed(2),
      },
    };
  }, [trades]);

  if (isLoading) {
    return (
      <main className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-muted-foreground">Loading trade data…</div>
      </main>
    );
  }

  if (!analysis) {
    return (
      <main className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-muted-foreground">
          Geen 2-outcome markten gevonden om edge te berekenen (verwacht bijv. Up/Down of Yes/No).
        </div>
      </main>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="container mx-auto px-4 py-8 max-w-7xl">
        <Link to="/">
          <Button variant="ghost" size="sm" className="mb-4">
            <ArrowLeft className="w-4 h-4 mr-2" />
            Back to Dashboard
          </Button>
        </Link>
        <h1 className="text-3xl font-bold text-foreground mb-2">Edge analysis: Gabagool22</h1>
        <p className="text-muted-foreground">Analyse van trading edge berekening en strategiepatronen</p>
      </header>

      <main className="container mx-auto px-4 pb-10 max-w-7xl">
        {/* Edge Formula */}
        <section aria-labelledby="edge-formula" className="mb-8">
          <Card className="border-primary/20 bg-card/50">
            <CardHeader>
              <CardTitle id="edge-formula" className="flex items-center gap-2">
                <Zap className="w-5 h-5 text-primary" />
                Edge formule
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="bg-muted/50 rounded-lg p-6 font-mono text-center mb-4">
                <div className="text-2xl mb-2">
                  <span className="text-primary">Edge</span> = 1 - (
                  <span className="text-chart-1">Price(outcome A)</span> + <span className="text-chart-2">Price(outcome B)</span>
                  )
                </div>
                <div className="text-sm text-muted-foreground mt-4">
                  Als A = 0.45 en B = 0.33 → Combined = 0.78 → <span className="text-primary font-bold">Edge = 22%</span>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
                <div className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded-full bg-chart-1" />
                  <span>
                    <strong>Edge &lt; 1:</strong> Arbitrage mogelijk (risicovrije winst)
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded-full bg-muted-foreground" />
                  <span>
                    <strong>Edge ≈ 1:</strong> Neutrale markt (geen edge)
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded-full bg-chart-2" />
                  <span>
                    <strong>Edge &gt; 1:</strong> Risico/Directional bet
                  </span>
                </div>
              </div>
            </CardContent>
          </Card>
        </section>

        {/* Stats */}
        <section aria-label="Samenvatting" className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
          <Card className="bg-card/50">
            <CardContent className="pt-6">
              <div className="flex items-center gap-2 text-muted-foreground text-sm mb-1">
                <Target className="w-4 h-4" />
                Arbitrage
              </div>
              <div className="text-2xl font-bold text-chart-1">{analysis.stats.arbitragePercent}%</div>
            </CardContent>
          </Card>

          <Card className="bg-card/50">
            <CardContent className="pt-6">
              <div className="flex items-center gap-2 text-muted-foreground text-sm mb-1">
                <TrendingUp className="w-4 h-4" />
                Risk
              </div>
              <div className="text-2xl font-bold text-chart-2">{analysis.stats.riskPercent}%</div>
            </CardContent>
          </Card>

          <Card className="bg-card/50">
            <CardContent className="pt-6">
              <div className="flex items-center gap-2 text-muted-foreground text-sm mb-1">
                <Zap className="w-4 h-4" />
                Gem. arbitrage edge
              </div>
              <div className="text-2xl font-bold text-primary">{analysis.stats.avgArbitrageEdge}%</div>
            </CardContent>
          </Card>

          <Card className="bg-card/50">
            <CardContent className="pt-6">
              <div className="flex items-center gap-2 text-muted-foreground text-sm mb-1">
                <Clock className="w-4 h-4" />
                Beste edge
              </div>
              <div className="text-2xl font-bold text-chart-3">{analysis.stats.bestEdge}%</div>
            </CardContent>
          </Card>
        </section>

        {/* Charts */}
        <section aria-label="Grafieken" className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
          <Card className="bg-card/50">
            <CardHeader>
              <CardTitle>Trade type verdeling</CardTitle>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={300}>
                <PieChart>
                  <Pie
                    data={analysis.pieData}
                    cx="50%"
                    cy="50%"
                    innerRadius={60}
                    outerRadius={100}
                    dataKey="value"
                    label={({ name, percent }) => `${name}: ${(percent * 100).toFixed(0)}%`}
                  >
                    {analysis.pieData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip
                    contentStyle={{
                      backgroundColor: "hsl(var(--popover))",
                      border: "1px solid hsl(var(--border))",
                      color: "hsl(var(--popover-foreground))",
                    }}
                  />
                </PieChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          <Card className="bg-card/50">
            <CardHeader>
              <CardTitle>Edge distribution (combined price)</CardTitle>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={analysis.buckets}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="range" tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 12 }} />
                  <YAxis tick={{ fill: "hsl(var(--muted-foreground))" }} />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: "hsl(var(--popover))",
                      border: "1px solid hsl(var(--border))",
                      color: "hsl(var(--popover-foreground))",
                    }}
                  />
                  <Bar dataKey="count" fill="hsl(var(--chart-5))" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        </section>

        {/* Hourly */}
        <section aria-label="Activiteit" className="mb-8">
          <Card className="bg-card/50">
            <CardHeader>
              <CardTitle>Trading activiteit per uur (UTC)</CardTitle>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={300}>
                <LineChart data={analysis.hourlyActivity}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis
                    dataKey="hour"
                    tick={{ fill: "hsl(var(--muted-foreground))" }}
                    tickFormatter={(h) => `${h}:00`}
                  />
                  <YAxis tick={{ fill: "hsl(var(--muted-foreground))" }} />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: "hsl(var(--popover))",
                      border: "1px solid hsl(var(--border))",
                      color: "hsl(var(--popover-foreground))",
                    }}
                    labelFormatter={(h) => `${h}:00 UTC`}
                    formatter={(v: number, name: string) => {
                      if (name === "marketPairs") return [v, "Market pairs"];
                      return [v, name];
                    }}
                  />
                  <Line
                    type="monotone"
                    dataKey="marketPairs"
                    stroke="hsl(var(--chart-1))"
                    strokeWidth={2}
                    dot={{ fill: "hsl(var(--chart-1))" }}
                    name="Market pairs"
                  />
                </LineChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        </section>

        {/* Table */}
        <section aria-label="Voorbeelden">
          <Card className="bg-card/50">
            <CardHeader>
              <CardTitle>Top 10 arbitrage opportunities (gevonden)</CardTitle>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Market</TableHead>
                    <TableHead>Outcome A</TableHead>
                    <TableHead className="text-right">Price A</TableHead>
                    <TableHead>Outcome B</TableHead>
                    <TableHead className="text-right">Price B</TableHead>
                    <TableHead className="text-right">Combined</TableHead>
                    <TableHead className="text-right">Edge</TableHead>
                    <TableHead>Type</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {analysis.topArbitrage.map((row, i) => (
                    <TableRow key={i}>
                      <TableCell className="max-w-[320px] truncate font-medium">{row.market}</TableCell>
                      <TableCell>{row.outcomeA}</TableCell>
                      <TableCell className="text-right text-chart-1">{(row.priceA * 100).toFixed(1)}¢</TableCell>
                      <TableCell>{row.outcomeB}</TableCell>
                      <TableCell className="text-right text-chart-2">{(row.priceB * 100).toFixed(1)}¢</TableCell>
                      <TableCell className="text-right">{(row.combined * 100).toFixed(1)}%</TableCell>
                      <TableCell className="text-right font-bold text-primary">{((1 - row.combined) * 100).toFixed(1)}%</TableCell>
                      <TableCell>
                        <Badge variant="outline" className="bg-chart-1/10 text-chart-1 border-chart-1/20">
                          Arbitrage
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </section>

        {/* Insights */}
        <section aria-label="Conclusies" className="mt-8">
          <Card className="border-primary/20 bg-gradient-to-br from-primary/5 to-transparent">
            <CardHeader>
              <CardTitle>Key insights</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-start gap-3">
                <div className="w-2 h-2 rounded-full bg-chart-1 mt-2" />
                <p>
                  <strong>{analysis.stats.arbitragePercent}%</strong> van de markt-paren zijn <em>arbitrage</em>
                  (combined &lt; 98%).
                </p>
              </div>
              <div className="flex items-start gap-3">
                <div className="w-2 h-2 rounded-full bg-chart-3 mt-2" />
                <p>
                  De <strong>beste edge</strong> was <strong>{analysis.stats.bestEdge}%</strong>.
                </p>
              </div>
              <div className="flex items-start gap-3">
                <div className="w-2 h-2 rounded-full bg-chart-2 mt-2" />
                <p>
                  <strong>{analysis.stats.riskPercent}%</strong> zijn <em>risk/directional</em> situaties (combined &gt; 102%),
                  dus hij start niet alleen bij edge &lt; 1.
                </p>
              </div>
              <div className="flex items-start gap-3">
                <div className="w-2 h-2 rounded-full bg-primary mt-2" />
                <p>
                  <strong>Conclusie:</strong> hij combineert systematische arbitrage met selectieve directional trades.
                </p>
              </div>
            </CardContent>
          </Card>
        </section>
      </main>
    </div>
  );
}
