-- Enable realtime for paper_trading_config table so the runner can hot-reload config changes
ALTER PUBLICATION supabase_realtime ADD TABLE public.paper_trading_config;