-- Create table for hourly P&L period snapshots
CREATE TABLE public.hourly_pnl_snapshots (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  period_start TIMESTAMP WITH TIME ZONE NOT NULL,
  period_end TIMESTAMP WITH TIME ZONE NOT NULL,
  total_pnl NUMERIC NOT NULL DEFAULT 0,
  total_invested NUMERIC NOT NULL DEFAULT 0,
  total_wins INTEGER NOT NULL DEFAULT 0,
  total_losses INTEGER NOT NULL DEFAULT 0,
  win_rate NUMERIC NOT NULL DEFAULT 0,
  up_outcomes INTEGER NOT NULL DEFAULT 0,
  down_outcomes INTEGER NOT NULL DEFAULT 0,
  up_outcome_pct NUMERIC NOT NULL DEFAULT 0,
  down_outcome_pct NUMERIC NOT NULL DEFAULT 0,
  total_trades INTEGER NOT NULL DEFAULT 0,
  avg_pnl_per_hour NUMERIC NOT NULL DEFAULT 0,
  profitable_hours INTEGER NOT NULL DEFAULT 0,
  losing_hours INTEGER NOT NULL DEFAULT 0,
  notes TEXT
);

-- Enable RLS
ALTER TABLE public.hourly_pnl_snapshots ENABLE ROW LEVEL SECURITY;

-- Allow public read/write (no auth required for this dashboard)
CREATE POLICY "Allow public read" ON public.hourly_pnl_snapshots FOR SELECT USING (true);
CREATE POLICY "Allow public insert" ON public.hourly_pnl_snapshots FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow public delete" ON public.hourly_pnl_snapshots FOR DELETE USING (true);