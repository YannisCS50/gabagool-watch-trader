import React, { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Upload, Loader2, CheckCircle2, XCircle } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

interface CsvResultsUploaderProps {
  onImportComplete?: () => void;
}

interface ParsedRow {
  asset: string;
  market_slug: string;
  real_result: string;
  side: string;
  filled_shares: number;
  avg_fill_price: number;
  event_start_time: string;
  event_end_time: string;
  pnl: number | null;
}

// Parse European number format (e.g., "4.800.000.106.683.760" should be "0.48")
function parseEuropeanNumber(value: string): number | null {
  if (!value || value.trim() === '') return null;
  
  const cleaned = value.trim();
  
  // Check if it's a normal number (has at most one decimal separator)
  const dotCount = (cleaned.match(/\./g) || []).length;
  
  if (dotCount <= 1) {
    // Normal number format
    const num = parseFloat(cleaned);
    return isNaN(num) ? null : num;
  }
  
  // European format with thousands separators
  // "4.800.000.106.683.760" -> these are malformed, try to detect pattern
  // The pattern seems to be: real value has periods as thousands separators
  // E.g., "-14.399.999.999.999.900" should be "-14.4" or similar
  
  // Strategy: Take the first part before too many digits
  const parts = cleaned.split('.');
  if (parts.length >= 2) {
    // Try to reconstruct: first part is integer, second part is first decimals
    // But the data seems really corrupted, so let's use a heuristic
    const firstPart = parts[0];
    const isNegative = firstPart.startsWith('-');
    const absFirst = isNegative ? firstPart.slice(1) : firstPart;
    
    // If first part is small (1-2 digits), it's likely the integer part
    // and second part starts the decimals
    if (absFirst.length <= 2 && parts.length >= 2) {
      // Assume format like "15.600.000.000.000.000" = 15.6
      // or "-14.399.999.999.999.900" = -14.4
      const intPart = parseInt(firstPart);
      const decimalStart = parts[1].charAt(0); // First digit after first period
      const num = parseFloat(`${intPart}.${decimalStart}`);
      return isNaN(num) ? null : num;
    }
  }
  
  // Fallback: just try parsing directly
  const fallback = parseFloat(cleaned.replace(/\./g, ''));
  return isNaN(fallback) ? null : fallback;
}

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current);
  return result;
}

function parseCsv(content: string): ParsedRow[] {
  const lines = content.split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];
  
  const rows: ParsedRow[] = [];
  
  // Skip header
  for (let i = 1; i < lines.length; i++) {
    const values = parseCsvLine(lines[i]);
    if (values.length < 10) continue;
    
    const [asset, market_slug, , real_result, side, filled_shares, avg_fill_price, event_start_time, event_end_time, pnl] = values;
    
    if (!asset || !market_slug) continue;
    
    rows.push({
      asset: asset.trim(),
      market_slug: market_slug.trim(),
      real_result: real_result?.trim().toUpperCase() || '',
      side: side?.trim().toUpperCase() || '',
      filled_shares: parseFloat(filled_shares) || 0,
      avg_fill_price: parseEuropeanNumber(avg_fill_price) ?? 0,
      event_start_time: event_start_time?.trim() || '',
      event_end_time: event_end_time?.trim() || '',
      pnl: parseEuropeanNumber(pnl),
    });
  }
  
  return rows;
}

// Calculate correct PnL based on result
function calculatePnl(row: ParsedRow): number {
  const cost = row.filled_shares * row.avg_fill_price;
  const isWin = row.real_result === row.side;
  
  if (isWin) {
    // WIN: get $1 per share - cost
    return row.filled_shares - cost;
  } else {
    // LOSS: get $0 - cost
    return -cost;
  }
}

export function CsvResultsUploader({ onImportComplete }: CsvResultsUploaderProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [result, setResult] = useState<{ success: number; failed: number; skipped: number } | null>(null);

  const handleFileSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setIsUploading(true);
    setResult(null);

    try {
      const content = await file.text();
      const rows = parseCsv(content);
      
      if (rows.length === 0) {
        toast.error('Geen data gevonden in CSV');
        return;
      }

      let success = 0;
      let failed = 0;
      let skipped = 0;

      // Update database in batches
      for (const row of rows) {
        if (!row.market_slug || !row.real_result) {
          skipped++;
          continue;
        }

        // Calculate the correct PnL
        const correctPnl = calculatePnl(row);

        const { error } = await supabase
          .from('v26_trades')
          .update({
            result: row.real_result,
            pnl: correctPnl,
            filled_shares: row.filled_shares,
            avg_fill_price: row.avg_fill_price,
            status: 'filled',
          })
          .eq('market_slug', row.market_slug);

        if (error) {
          console.error(`Failed to update ${row.market_slug}:`, error);
          failed++;
        } else {
          success++;
        }
      }

      setResult({ success, failed, skipped });
      toast.success(`Geïmporteerd: ${success} trades, ${failed} gefaald, ${skipped} overgeslagen`);
      onImportComplete?.();
    } catch (err) {
      console.error('CSV import error:', err);
      toast.error('Fout bij importeren van CSV');
    } finally {
      setIsUploading(false);
      // Reset file input
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  return (
    <div className="flex items-center gap-2">
      <input
        ref={fileInputRef}
        type="file"
        accept=".csv"
        onChange={handleFileSelect}
        className="hidden"
      />
      <Button
        variant="outline"
        size="sm"
        onClick={() => fileInputRef.current?.click()}
        disabled={isUploading}
      >
        {isUploading ? (
          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
        ) : (
          <Upload className="h-4 w-4 mr-2" />
        )}
        Import CSV Results
      </Button>
      {result && (
        <div className="flex items-center gap-1 text-xs">
          <CheckCircle2 className="h-3 w-3 text-green-500" />
          <span className="text-green-500">{result.success}</span>
          {result.failed > 0 && (
            <>
              <XCircle className="h-3 w-3 text-red-500 ml-1" />
              <span className="text-red-500">{result.failed}</span>
            </>
          )}
        </div>
      )}
    </div>
  );
}
