import { useState, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useUploadReconcile } from "@/hooks/useReconcileReports";
import { Upload, FileText, FileArchive, Loader2 } from "lucide-react";
import { toast } from "sonner";

interface ReconcileUploadFormProps {
  onUploadSuccess?: (reportId: string) => void;
}

export function ReconcileUploadForm({ onUploadSuccess }: ReconcileUploadFormProps) {
  const [csvFile, setCsvFile] = useState<File | null>(null);
  const [zipFile, setZipFile] = useState<File | null>(null);
  const csvInputRef = useRef<HTMLInputElement>(null);
  const zipInputRef = useRef<HTMLInputElement>(null);

  const uploadMutation = useUploadReconcile();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!csvFile) {
      toast.error("Upload een Polymarket CSV bestand");
      return;
    }

    try {
      const result = await uploadMutation.mutateAsync({ csvFile, zipFile: zipFile || undefined });
      toast.success(`Reconciliation gestart! Coverage: ${result.summary?.overallCoveragePct?.toFixed(1)}%`);
      setCsvFile(null);
      setZipFile(null);
      if (csvInputRef.current) csvInputRef.current.value = "";
      if (zipInputRef.current) zipInputRef.current.value = "";
      if (result.reportId) {
        onUploadSuccess?.(result.reportId);
      }
    } catch (error) {
      toast.error(`Upload mislukt: ${error instanceof Error ? error.message : "Onbekende fout"}`);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Upload className="h-5 w-5" />
          Nieuwe Reconciliation
        </CardTitle>
        <CardDescription>
          Upload je Polymarket CSV transactie export en optioneel de bot logs ZIP
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="csv" className="flex items-center gap-2">
              <FileText className="h-4 w-4" />
              Polymarket CSV (verplicht)
            </Label>
            <Input
              id="csv"
              type="file"
              accept=".csv"
              ref={csvInputRef}
              onChange={(e) => setCsvFile(e.target.files?.[0] || null)}
              className="cursor-pointer"
            />
            {csvFile && (
              <p className="text-sm text-muted-foreground">
                Geselecteerd: {csvFile.name} ({(csvFile.size / 1024).toFixed(1)} KB)
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="zip" className="flex items-center gap-2">
              <FileArchive className="h-4 w-4" />
              Bot Export ZIP (optioneel)
            </Label>
            <Input
              id="zip"
              type="file"
              accept=".zip"
              ref={zipInputRef}
              onChange={(e) => setZipFile(e.target.files?.[0] || null)}
              className="cursor-pointer"
            />
            {zipFile && (
              <p className="text-sm text-muted-foreground">
                Geselecteerd: {zipFile.name} ({(zipFile.size / 1024).toFixed(1)} KB)
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              Als je geen ZIP uploadt, worden fills uit de database gehaald
            </p>
          </div>

          <Button type="submit" disabled={!csvFile || uploadMutation.isPending} className="w-full">
            {uploadMutation.isPending ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Verwerken...
              </>
            ) : (
              <>
                <Upload className="mr-2 h-4 w-4" />
                Start Reconciliation
              </>
            )}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
