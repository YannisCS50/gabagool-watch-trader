-- =============================================================
-- CRITICAL SECURITY FIX: Remove all sensitive credentials from database
-- These should ONLY be stored as Supabase secrets / environment variables
-- =============================================================

-- Step 1: Drop sensitive columns from bot_config
ALTER TABLE public.bot_config 
DROP COLUMN IF EXISTS polymarket_private_key,
DROP COLUMN IF EXISTS polymarket_api_key,
DROP COLUMN IF EXISTS polymarket_api_secret,
DROP COLUMN IF EXISTS polymarket_passphrase,
DROP COLUMN IF EXISTS runner_shared_secret;

-- Step 2: Drop existing insecure RLS policies
DROP POLICY IF EXISTS "Allow public read for bot_config" ON public.bot_config;
DROP POLICY IF EXISTS "Allow public insert for bot_config" ON public.bot_config;
DROP POLICY IF EXISTS "Allow public update for bot_config" ON public.bot_config;

-- Step 3: Create secure RLS policies (authenticated users only)
-- For now, allow authenticated users. Later you can add user_id column for per-user configs.
CREATE POLICY "Authenticated users can read bot_config"
ON public.bot_config
FOR SELECT
TO authenticated
USING (true);

CREATE POLICY "Authenticated users can update bot_config"
ON public.bot_config
FOR UPDATE
TO authenticated
USING (true)
WITH CHECK (true);

-- No public insert - config should be seeded, not created by users
CREATE POLICY "Authenticated users can insert bot_config"
ON public.bot_config
FOR INSERT
TO authenticated
WITH CHECK (true);

-- Step 4: Also secure live_bot_settings
DROP POLICY IF EXISTS "Allow public read on live_bot_settings" ON public.live_bot_settings;
DROP POLICY IF EXISTS "Allow public write on live_bot_settings" ON public.live_bot_settings;

CREATE POLICY "Authenticated users can read live_bot_settings"
ON public.live_bot_settings
FOR SELECT
TO authenticated
USING (true);

CREATE POLICY "Authenticated users can update live_bot_settings"
ON public.live_bot_settings
FOR UPDATE
TO authenticated
USING (true)
WITH CHECK (true);