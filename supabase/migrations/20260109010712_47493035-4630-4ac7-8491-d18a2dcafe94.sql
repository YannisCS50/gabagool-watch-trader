-- Allow fractional shares from Polymarket transaction history CSV.
-- v26_trades.notional is a generated column that depends on shares; it must be recreated.
-- There is also a dependent view (v26_stats) that must be recreated.

DROP VIEW IF EXISTS public.v26_stats;

ALTER TABLE public.v26_trades
  DROP COLUMN notional;

ALTER TABLE public.v26_trades
  ALTER COLUMN shares TYPE numeric USING shares::numeric;

ALTER TABLE public.v26_trades
  ALTER COLUMN filled_shares TYPE numeric USING filled_shares::numeric;

ALTER TABLE public.v26_trades
  ADD COLUMN notional numeric GENERATED ALWAYS AS (price * shares) STORED;

CREATE VIEW public.v26_stats AS
SELECT
  count(*) AS total_trades,
  count(*) FILTER (WHERE status = 'filled') AS filled_trades,
  count(*) FILTER (WHERE result IS NOT NULL) AS settled_trades,
  count(*) FILTER (WHERE result = 'DOWN') AS wins,
  count(*) FILTER (WHERE result = 'UP') AS losses,
  round(
    count(*) FILTER (WHERE result = 'DOWN')::numeric
    / NULLIF(count(*) FILTER (WHERE result IS NOT NULL), 0)::numeric
    * 100::numeric,
    1
  ) AS win_rate_pct,
  COALESCE(sum(pnl), 0::numeric) AS total_pnl,
  COALESCE(sum(notional) FILTER (WHERE status = 'filled'), 0::numeric) AS total_invested,
  max(created_at) AS last_trade_at
FROM public.v26_trades;