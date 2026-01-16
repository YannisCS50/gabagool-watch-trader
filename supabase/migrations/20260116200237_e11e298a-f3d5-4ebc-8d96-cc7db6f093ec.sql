-- Add source column to track where each signal came from
ALTER TABLE public.signal_quality_analysis 
ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'unknown';

-- Add index for source filtering
CREATE INDEX IF NOT EXISTS idx_signal_quality_source ON public.signal_quality_analysis(source);

-- Add comment
COMMENT ON COLUMN public.signal_quality_analysis.source IS 'Source table: v29_signals (legacy) or v29_signals_response (new format)';