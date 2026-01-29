-- Add new PnL calculation columns to v35_expiry_snapshots
ALTER TABLE public.v35_expiry_snapshots 
ADD COLUMN IF NOT EXISTS total_cost numeric,
ADD COLUMN IF NOT EXISTS predicted_winning_side text,
ADD COLUMN IF NOT EXISTS predicted_final_value numeric,
ADD COLUMN IF NOT EXISTS predicted_pnl numeric;

-- Add comment explaining the correct formula
COMMENT ON COLUMN public.v35_expiry_snapshots.total_cost IS 'Total cost paid: (upQty × avgUpPrice) + (downQty × avgDownPrice)';
COMMENT ON COLUMN public.v35_expiry_snapshots.predicted_winning_side IS 'UP or DOWN based on 99¢ bid price at expiry';
COMMENT ON COLUMN public.v35_expiry_snapshots.predicted_final_value IS 'Winning shares × $1.00 (loser = $0)';
COMMENT ON COLUMN public.v35_expiry_snapshots.predicted_pnl IS 'finalValue - totalCost (the CORRECT PnL formula)';