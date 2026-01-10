-- Create deposits table for tracking real deposits
CREATE TABLE public.deposits (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  wallet TEXT NOT NULL DEFAULT '0x2930f79c7B87a5E6349DFE7e7628EBcbb4bF666',
  amount_usd NUMERIC NOT NULL,
  deposited_at TIMESTAMP WITH TIME ZONE NOT NULL,
  source TEXT DEFAULT 'manual',
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS (but allow public read for simplicity since this is a single-user app)
ALTER TABLE public.deposits ENABLE ROW LEVEL SECURITY;

-- Allow anyone to read deposits (single user app)
CREATE POLICY "Allow public read on deposits" 
ON public.deposits 
FOR SELECT 
USING (true);

-- Allow anyone to insert deposits (single user app)
CREATE POLICY "Allow public insert on deposits" 
ON public.deposits 
FOR INSERT 
WITH CHECK (true);

-- Insert the user's deposits
INSERT INTO public.deposits (amount_usd, deposited_at, notes) VALUES
  (1000.00, NOW() - INTERVAL '1 day', 'Deposit 1'),
  (500.00, NOW() - INTERVAL '4 days', 'Deposit 2'),
  (499.00, NOW() - INTERVAL '5 days', 'Deposit 3'),
  (1016.00, NOW() - INTERVAL '6 days', 'Deposit 4'),
  (949.00, NOW() - INTERVAL '6 days', 'Deposit 5'),
  (917.00, NOW() - INTERVAL '12 days', 'Deposit 6'),
  (998.00, NOW() - INTERVAL '12 days', 'Deposit 7'),
  (122.00, NOW() - INTERVAL '12 days', 'Deposit 8');