
ALTER TABLE public.contest_pools
  ADD COLUMN IF NOT EXISTS void_unfilled_on_settle boolean NOT NULL DEFAULT false;

INSERT INTO public.feature_flags (key, value)
VALUES ('ipbase_enabled', '{"enabled": false}'::jsonb)
ON CONFLICT (key) DO NOTHING;
