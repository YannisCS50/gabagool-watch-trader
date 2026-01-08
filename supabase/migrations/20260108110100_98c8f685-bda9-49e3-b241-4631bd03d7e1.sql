-- Add config_version to track when config changes
ALTER TABLE public.v26_config 
ADD COLUMN config_version INTEGER NOT NULL DEFAULT 1;