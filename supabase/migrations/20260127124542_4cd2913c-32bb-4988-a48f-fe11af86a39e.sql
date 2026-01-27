-- Enforce idempotency at the database level
ALTER TABLE public.v35_fills
  ALTER COLUMN fill_ts SET NOT NULL,
  ALTER COLUMN fill_key SET NOT NULL;

-- One row per fill event (as identified by fill_key)
CREATE UNIQUE INDEX IF NOT EXISTS v35_fills_fill_key_key
  ON public.v35_fills (fill_key);

-- Helpful for time-window queries
CREATE INDEX IF NOT EXISTS idx_v35_fills_fill_ts
  ON public.v35_fills (fill_ts DESC);
