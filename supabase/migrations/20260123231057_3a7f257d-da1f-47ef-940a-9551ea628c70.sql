-- Create v35_fills table for tracking V35 market maker fills
CREATE TABLE public.v35_fills (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  market_slug TEXT NOT NULL,
  asset TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('UP', 'DOWN')),
  price NUMERIC NOT NULL,
  size NUMERIC NOT NULL,
  order_id TEXT,
  fill_type TEXT DEFAULT 'maker',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.v35_fills ENABLE ROW LEVEL SECURITY;

-- Allow public read access (for dashboard)
CREATE POLICY "Public read access for v35_fills"
ON public.v35_fills
FOR SELECT
USING (true);

-- Allow insert from edge functions (anon key)
CREATE POLICY "Allow insert for v35_fills"
ON public.v35_fills
FOR INSERT
WITH CHECK (true);

-- Create index for efficient queries
CREATE INDEX idx_v35_fills_market_slug ON public.v35_fills(market_slug);
CREATE INDEX idx_v35_fills_created_at ON public.v35_fills(created_at DESC);

-- Enable realtime for live dashboard updates
ALTER PUBLICATION supabase_realtime ADD TABLE public.v35_fills;