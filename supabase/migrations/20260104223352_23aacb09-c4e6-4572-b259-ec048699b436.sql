-- Create claim_logs table for tracking all claim attempts and successes
CREATE TABLE public.claim_logs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  
  -- Market identification
  market_id TEXT,
  condition_id TEXT NOT NULL,
  market_title TEXT,
  outcome TEXT,
  
  -- Claim details
  shares_redeemed NUMERIC NOT NULL DEFAULT 0,
  usdc_received NUMERIC NOT NULL DEFAULT 0,
  
  -- Transaction details
  tx_hash TEXT,
  gas_used NUMERIC,
  gas_price_gwei NUMERIC,
  
  -- Wallet info
  wallet_address TEXT NOT NULL,
  wallet_type TEXT DEFAULT 'EOA', -- EOA or PROXY
  
  -- Status tracking
  status TEXT NOT NULL DEFAULT 'pending', -- pending, confirmed, failed
  error_message TEXT,
  retry_count INTEGER DEFAULT 0,
  
  -- Timestamps
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  confirmed_at TIMESTAMP WITH TIME ZONE,
  
  -- Block info
  block_number BIGINT
);

-- Create index for efficient lookups
CREATE INDEX idx_claim_logs_condition_id ON public.claim_logs(condition_id);
CREATE INDEX idx_claim_logs_status ON public.claim_logs(status);
CREATE INDEX idx_claim_logs_wallet ON public.claim_logs(wallet_address);
CREATE INDEX idx_claim_logs_created_at ON public.claim_logs(created_at DESC);

-- Enable RLS (but allow all operations for now since this is bot-internal)
ALTER TABLE public.claim_logs ENABLE ROW LEVEL SECURITY;

-- Policy to allow all operations (bot runs with service role)
CREATE POLICY "Allow all operations on claim_logs" 
ON public.claim_logs 
FOR ALL 
USING (true) 
WITH CHECK (true);

-- Add claim tracking columns to live_trade_results if not exists
ALTER TABLE public.live_trade_results 
ADD COLUMN IF NOT EXISTS claim_status TEXT DEFAULT 'pending',
ADD COLUMN IF NOT EXISTS claim_tx_hash TEXT,
ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS claim_usdc NUMERIC;