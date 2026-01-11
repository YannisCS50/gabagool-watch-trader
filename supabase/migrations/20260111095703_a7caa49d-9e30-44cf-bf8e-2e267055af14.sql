-- V27 Config table - adjustable thresholds (if not exists)
CREATE TABLE IF NOT EXISTS public.v27_config (
  id TEXT PRIMARY KEY DEFAULT 'default',
  enabled BOOLEAN DEFAULT true,
  shadow_mode BOOLEAN DEFAULT true,
  assets TEXT[] DEFAULT ARRAY['BTC', 'ETH', 'SOL', 'XRP'],
  
  -- Per-asset thresholds (JSONB for flexibility)
  asset_thresholds JSONB DEFAULT '{
    "BTC": {"min": 45, "max": 70, "current": 55},
    "ETH": {"min": 0.18, "max": 0.30, "current": 0.22},
    "SOL": {"min": 0.08, "max": 0.15, "current": 0.10},
    "XRP": {"min": 0.003, "max": 0.008, "current": 0.005}
  }'::jsonb,
  
  -- Timing
  causality_min_ms INTEGER DEFAULT 200,
  causality_max_ms INTEGER DEFAULT 3000,
  
  -- Correction
  correction_threshold_pct NUMERIC DEFAULT 0.03,
  
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_by TEXT
);

-- Insert default config if not exists
INSERT INTO public.v27_config (id) VALUES ('default') ON CONFLICT (id) DO NOTHING;

-- Enable RLS
ALTER TABLE public.v27_config ENABLE ROW LEVEL SECURITY;

-- Allow public read/write for bot operations
CREATE POLICY "Allow all for v27_config" ON public.v27_config FOR ALL USING (true) WITH CHECK (true);

-- Trigger for config updated_at
DROP TRIGGER IF EXISTS update_v27_config_updated_at ON public.v27_config;
CREATE TRIGGER update_v27_config_updated_at
BEFORE UPDATE ON public.v27_config
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();