import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export interface ReconcileReport {
  id: string;
  created_at: string;
  csv_filename: string | null;
  zip_filename: string | null;
  total_csv_transactions: number;
  total_bot_fills: number;
  fully_covered_count: number;
  partially_covered_count: number;
  not_covered_count: number;
  unexplained_count: number;
  coverage_pct: number;
  status: string;
  error_message: string | null;
  report_data: ReconcileReportData | null;
  processed_at: string | null;
  processing_time_ms: number | null;
}

export interface CoverageResult {
  marketId: string;
  outcome: "UP" | "DOWN";
  csvTotalBuys: number;
  csvTotalSells: number;
  botReportedBuys: number;
  botReportedSells: number;
  coveragePct: number;
  status: "FULLY_COVERED" | "PARTIALLY_COVERED" | "NOT_COVERED";
  unexplainedTransactions: unknown[];
}

export interface ReconcileReportData {
  summary: {
    totalCsvTransactions: number;
    totalBotFills: number;
    fullyCoveredCount: number;
    partiallyCoveredCount: number;
    notCoveredCount: number;
    unexplainedCount: number;
    overallCoveragePct: number;
  };
  coverageByMarket: CoverageResult[];
  unmatchedBotFills: unknown[];
  processingTimeMs: number;
}

export function useReconcileReports() {
  return useQuery({
    queryKey: ["reconcile-reports"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("reconcile_reports")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(50);

      if (error) throw error;
      return (data || []).map((row) => ({
        ...row,
        report_data: row.report_data as unknown as ReconcileReportData | null,
      })) as ReconcileReport[];
    },
    refetchInterval: 5000, // Poll for updates
  });
}

export function useReconcileReport(id: string | null) {
  return useQuery({
    queryKey: ["reconcile-report", id],
    queryFn: async () => {
      if (!id) return null;
      const { data, error } = await supabase
        .from("reconcile_reports")
        .select("*")
        .eq("id", id)
        .single();

      if (error) throw error;
      return {
        ...data,
        report_data: data.report_data as unknown as ReconcileReportData | null,
      } as ReconcileReport;
    },
    enabled: !!id,
    refetchInterval: (query) => 
      query.state.data?.status === "processing" ? 2000 : false,
  });
}

export function useUploadReconcile() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ csvFile, zipFile }: { csvFile: File; zipFile?: File }) => {
      const formData = new FormData();
      formData.append("csv", csvFile);
      if (zipFile) {
        formData.append("zip", zipFile);
      }

      const { data: { session } } = await supabase.auth.getSession();
      
      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/reconcile-fills`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${session?.access_token || import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
          },
          body: formData,
        }
      );

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Upload failed");
      }

      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["reconcile-reports"] });
    },
  });
}
