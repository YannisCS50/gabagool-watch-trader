-- Enable RLS on all new log tables (same pattern as other bot log tables)
ALTER TABLE public.decision_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.account_position_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.state_reconciliation_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fill_attributions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hedge_skip_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mtm_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gabagool_metrics ENABLE ROW LEVEL SECURITY;

-- Public read access (for dashboard viewing)
CREATE POLICY "Public read access" ON public.decision_snapshots FOR SELECT USING (true);
CREATE POLICY "Public read access" ON public.account_position_snapshots FOR SELECT USING (true);
CREATE POLICY "Public read access" ON public.state_reconciliation_results FOR SELECT USING (true);
CREATE POLICY "Public read access" ON public.fill_attributions FOR SELECT USING (true);
CREATE POLICY "Public read access" ON public.hedge_skip_logs FOR SELECT USING (true);
CREATE POLICY "Public read access" ON public.mtm_snapshots FOR SELECT USING (true);
CREATE POLICY "Public read access" ON public.gabagool_metrics FOR SELECT USING (true);

-- Service role insert (bot writes via edge function)
CREATE POLICY "Service insert" ON public.decision_snapshots FOR INSERT WITH CHECK (true);
CREATE POLICY "Service insert" ON public.account_position_snapshots FOR INSERT WITH CHECK (true);
CREATE POLICY "Service insert" ON public.state_reconciliation_results FOR INSERT WITH CHECK (true);
CREATE POLICY "Service insert" ON public.fill_attributions FOR INSERT WITH CHECK (true);
CREATE POLICY "Service insert" ON public.hedge_skip_logs FOR INSERT WITH CHECK (true);
CREATE POLICY "Service insert" ON public.mtm_snapshots FOR INSERT WITH CHECK (true);
CREATE POLICY "Service insert" ON public.gabagool_metrics FOR INSERT WITH CHECK (true);