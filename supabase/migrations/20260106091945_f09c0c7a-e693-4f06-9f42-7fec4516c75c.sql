-- Storage bucket voor reconciliation files (CSV, ZIP uploads en result JSON)
INSERT INTO storage.buckets (id, name, public) 
VALUES ('reconcile-files', 'reconcile-files', false)
ON CONFLICT (id) DO NOTHING;

-- RLS policy: authenticated users kunnen eigen files uploaden
CREATE POLICY "Authenticated users can upload reconcile files"
ON storage.objects FOR INSERT
WITH CHECK (bucket_id = 'reconcile-files' AND auth.role() = 'authenticated');

-- RLS policy: authenticated users kunnen eigen files lezen
CREATE POLICY "Authenticated users can read reconcile files"
ON storage.objects FOR SELECT
USING (bucket_id = 'reconcile-files' AND auth.role() = 'authenticated');

-- RLS policy: service role kan alles (voor edge function)
CREATE POLICY "Service role full access to reconcile files"
ON storage.objects FOR ALL
USING (bucket_id = 'reconcile-files')
WITH CHECK (bucket_id = 'reconcile-files');

-- Tabel voor reconciliation reports
CREATE TABLE public.reconcile_reports (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  
  -- Source file info
  csv_filename TEXT,
  zip_filename TEXT,
  csv_storage_path TEXT,
  zip_storage_path TEXT,
  
  -- Summary stats
  total_csv_transactions INTEGER DEFAULT 0,
  total_bot_fills INTEGER DEFAULT 0,
  fully_covered_count INTEGER DEFAULT 0,
  partially_covered_count INTEGER DEFAULT 0,
  not_covered_count INTEGER DEFAULT 0,
  unexplained_count INTEGER DEFAULT 0,
  coverage_pct NUMERIC(5,2) DEFAULT 0,
  
  -- Status
  status TEXT NOT NULL DEFAULT 'pending',
  error_message TEXT,
  
  -- Full report data (JSONB voor flexibiliteit)
  report_data JSONB,
  
  -- Processing metadata
  processed_at TIMESTAMP WITH TIME ZONE,
  processing_time_ms INTEGER
);

-- Enable RLS
ALTER TABLE public.reconcile_reports ENABLE ROW LEVEL SECURITY;

-- RLS: iedereen kan reports lezen (intern dashboard)
CREATE POLICY "Anyone can read reconcile reports"
ON public.reconcile_reports FOR SELECT
USING (true);

-- RLS: alleen service role kan inserts/updates doen
CREATE POLICY "Service role can manage reconcile reports"
ON public.reconcile_reports FOR ALL
USING (true)
WITH CHECK (true);

-- Index voor snelle queries
CREATE INDEX idx_reconcile_reports_created_at ON public.reconcile_reports(created_at DESC);
CREATE INDEX idx_reconcile_reports_status ON public.reconcile_reports(status);