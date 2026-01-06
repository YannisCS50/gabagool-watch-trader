import { useState } from "react";
import { useReconcileReports, useReconcileReport, CoverageResult } from "@/hooks/useReconcileReports";
import { ReconcileUploadForm } from "./ReconcileUploadForm";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Progress } from "@/components/ui/progress";
import { 
  CheckCircle2, 
  AlertCircle, 
  XCircle, 
  Loader2, 
  Clock,
  TrendingUp,
  TrendingDown,
  FileSearch,
  Filter
} from "lucide-react";
import { format } from "date-fns";

function StatusBadge({ status }: { status: string }) {
  switch (status) {
    case "completed":
      return <Badge variant="default" className="bg-green-500">Voltooid</Badge>;
    case "processing":
      return <Badge variant="secondary" className="animate-pulse">Verwerken...</Badge>;
    case "failed":
      return <Badge variant="destructive">Mislukt</Badge>;
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

function CoverageBadge({ status }: { status: string }) {
  switch (status) {
    case "FULLY_COVERED":
      return <Badge className="bg-green-500"><CheckCircle2 className="h-3 w-3 mr-1" />Volledig</Badge>;
    case "PARTIALLY_COVERED":
      return <Badge variant="secondary" className="bg-yellow-500 text-black"><AlertCircle className="h-3 w-3 mr-1" />Gedeeltelijk</Badge>;
    case "NOT_COVERED":
      return <Badge variant="destructive"><XCircle className="h-3 w-3 mr-1" />Niet gedekt</Badge>;
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

function ReportDetail({ reportId }: { reportId: string }) {
  const { data: report, isLoading } = useReconcileReport(reportId);
  const [assetFilter, setAssetFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState("");

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-8">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!report) {
    return <div className="text-muted-foreground p-4">Report niet gevonden</div>;
  }

  const reportData = report.report_data;
  const coverageByMarket = reportData?.coverageByMarket || [];

  // Extract unique assets
  const assets = [...new Set(coverageByMarket.map((c) => {
    const match = c.marketId.match(/^(btc|eth|sol|xrp)/i);
    return match ? match[1].toUpperCase() : "OTHER";
  }))];

  // Filter coverage results
  const filteredCoverage = coverageByMarket.filter((c) => {
    const asset = c.marketId.match(/^(btc|eth|sol|xrp)/i)?.[1]?.toUpperCase() || "OTHER";
    if (assetFilter !== "all" && asset !== assetFilter) return false;
    if (statusFilter !== "all" && c.status !== statusFilter) return false;
    if (searchQuery && !c.marketId.toLowerCase().includes(searchQuery.toLowerCase())) return false;
    return true;
  });

  return (
    <div className="space-y-6">
      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-6">
            <div className="text-2xl font-bold">{report.coverage_pct?.toFixed(1)}%</div>
            <p className="text-xs text-muted-foreground">Overall Coverage</p>
            <Progress value={report.coverage_pct || 0} className="mt-2" />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-2xl font-bold text-green-500">{report.fully_covered_count}</div>
            <p className="text-xs text-muted-foreground">Volledig gedekt</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-2xl font-bold text-yellow-500">{report.partially_covered_count}</div>
            <p className="text-xs text-muted-foreground">Gedeeltelijk</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-2xl font-bold text-red-500">{report.not_covered_count}</div>
            <p className="text-xs text-muted-foreground">Niet gedekt</p>
          </CardContent>
        </Card>
      </div>

      {/* Stats Row */}
      <div className="grid grid-cols-3 md:grid-cols-6 gap-4 text-sm">
        <div className="text-center">
          <div className="font-semibold">{report.total_csv_transactions}</div>
          <div className="text-muted-foreground">CSV Txs</div>
        </div>
        <div className="text-center">
          <div className="font-semibold">{report.total_bot_fills}</div>
          <div className="text-muted-foreground">Bot Fills</div>
        </div>
        <div className="text-center">
          <div className="font-semibold">{report.unexplained_count}</div>
          <div className="text-muted-foreground">Unexplained</div>
        </div>
        <div className="text-center">
          <div className="font-semibold">{report.processing_time_ms}ms</div>
          <div className="text-muted-foreground">Processing</div>
        </div>
        <div className="text-center col-span-2">
          <div className="font-semibold">{report.csv_filename}</div>
          <div className="text-muted-foreground">Bron</div>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-4 items-center">
        <div className="flex items-center gap-2">
          <Filter className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm text-muted-foreground">Filters:</span>
        </div>
        <Select value={assetFilter} onValueChange={setAssetFilter}>
          <SelectTrigger className="w-[120px]">
            <SelectValue placeholder="Asset" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Alle assets</SelectItem>
            {assets.map((asset) => (
              <SelectItem key={asset} value={asset}>{asset}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-[150px]">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Alle statussen</SelectItem>
            <SelectItem value="FULLY_COVERED">Volledig</SelectItem>
            <SelectItem value="PARTIALLY_COVERED">Gedeeltelijk</SelectItem>
            <SelectItem value="NOT_COVERED">Niet gedekt</SelectItem>
          </SelectContent>
        </Select>
        <Input 
          placeholder="Zoek market..." 
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="max-w-[200px]"
        />
        <span className="text-sm text-muted-foreground ml-auto">
          {filteredCoverage.length} van {coverageByMarket.length} markets
        </span>
      </div>

      {/* Coverage Table */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileSearch className="h-5 w-5" />
            Coverage per Market
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Market ID</TableHead>
                  <TableHead>Outcome</TableHead>
                  <TableHead className="text-right">CSV Buys</TableHead>
                  <TableHead className="text-right">CSV Sells</TableHead>
                  <TableHead className="text-right">Bot Buys</TableHead>
                  <TableHead className="text-right">Bot Sells</TableHead>
                  <TableHead className="text-right">Coverage</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredCoverage.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center text-muted-foreground py-8">
                      Geen resultaten gevonden
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredCoverage.map((coverage, idx) => (
                    <TableRow key={`${coverage.marketId}-${coverage.outcome}-${idx}`}>
                      <TableCell className="font-mono text-xs max-w-[200px] truncate">
                        {coverage.marketId}
                      </TableCell>
                      <TableCell>
                        {coverage.outcome === "UP" ? (
                          <Badge variant="outline" className="text-green-500">
                            <TrendingUp className="h-3 w-3 mr-1" />UP
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="text-red-500">
                            <TrendingDown className="h-3 w-3 mr-1" />DOWN
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-right">{coverage.csvTotalBuys}</TableCell>
                      <TableCell className="text-right">{coverage.csvTotalSells}</TableCell>
                      <TableCell className="text-right">{coverage.botReportedBuys}</TableCell>
                      <TableCell className="text-right">{coverage.botReportedSells}</TableCell>
                      <TableCell className="text-right font-semibold">
                        {coverage.coveragePct.toFixed(1)}%
                      </TableCell>
                      <TableCell>
                        <CoverageBadge status={coverage.status} />
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export function ReconcileDashboard() {
  const { data: reports, isLoading } = useReconcileReports();
  const [selectedReportId, setSelectedReportId] = useState<string | null>(null);

  return (
    <div className="space-y-6">
      <Tabs defaultValue="reports" className="space-y-4">
        <TabsList>
          <TabsTrigger value="reports">Reports</TabsTrigger>
          <TabsTrigger value="upload">Nieuwe Upload</TabsTrigger>
        </TabsList>

        <TabsContent value="upload" className="space-y-4">
          <div className="max-w-xl">
            <ReconcileUploadForm 
              onUploadSuccess={(id) => {
                setSelectedReportId(id);
              }} 
            />
          </div>
        </TabsContent>

        <TabsContent value="reports" className="space-y-4">
          {/* Report List */}
          <Card>
            <CardHeader>
              <CardTitle>Reconciliation Reports</CardTitle>
              <CardDescription>
                Selecteer een report om de details te bekijken
              </CardDescription>
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <div className="flex items-center justify-center p-8">
                  <Loader2 className="h-6 w-6 animate-spin" />
                </div>
              ) : reports?.length === 0 ? (
                <div className="text-center text-muted-foreground py-8">
                  Nog geen reports. Upload een CSV om te beginnen.
                </div>
              ) : (
                <div className="space-y-2">
                  {reports?.map((report) => (
                    <Button
                      key={report.id}
                      variant={selectedReportId === report.id ? "default" : "outline"}
                      className="w-full justify-start h-auto py-3"
                      onClick={() => setSelectedReportId(report.id)}
                    >
                      <div className="flex items-center gap-4 w-full">
                        <div className="flex items-center gap-2">
                          <Clock className="h-4 w-4 text-muted-foreground" />
                          <span className="text-sm">
                            {format(new Date(report.created_at), "dd MMM HH:mm")}
                          </span>
                        </div>
                        <div className="flex-1 text-left truncate">
                          {report.csv_filename || "Onbekend"}
                        </div>
                        <StatusBadge status={report.status} />
                        {report.status === "completed" && (
                          <span className="font-semibold">
                            {report.coverage_pct?.toFixed(1)}%
                          </span>
                        )}
                      </div>
                    </Button>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Selected Report Detail */}
          {selectedReportId && (
            <ReportDetail reportId={selectedReportId} />
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
