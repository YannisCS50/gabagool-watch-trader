-- Add missing fields for "minimaal compleet" logging

-- 1. Add total_payout_usd to settlement_logs (realized payout from winning side)
ALTER TABLE public.settlement_logs 
ADD COLUMN IF NOT EXISTS total_payout_usd numeric;

-- 3. Add unpaired_notional_usd and paired_delay_sec to inventory_snapshots
ALTER TABLE public.inventory_snapshots 
ADD COLUMN IF NOT EXISTS unpaired_notional_usd numeric,
ADD COLUMN IF NOT EXISTS paired_delay_sec numeric;

-- 3. Also add paired_shares for clarity (can be computed but explicit is better)
ALTER TABLE public.inventory_snapshots 
ADD COLUMN IF NOT EXISTS paired_shares numeric;