-- Drop restrictive policies and create permissive ones
DROP POLICY IF EXISTS "Public read access for trades" ON public.trades;
DROP POLICY IF EXISTS "Public read access for positions" ON public.positions;
DROP POLICY IF EXISTS "Public read access for trader_stats" ON public.trader_stats;

-- Create PERMISSIVE policies (default type)
CREATE POLICY "Allow public read for trades" 
ON public.trades 
FOR SELECT 
TO public
USING (true);

CREATE POLICY "Allow public read for positions" 
ON public.positions 
FOR SELECT 
TO public
USING (true);

CREATE POLICY "Allow public read for trader_stats" 
ON public.trader_stats 
FOR SELECT 
TO public
USING (true);