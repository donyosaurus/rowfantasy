-- Drop dead admin_void_contest wrapper. Zero edge-function callers, zero
-- pg_proc.prosrc references in other functions, zero pg_trigger references.
-- Live void path: void_contest_pool_atomic (called from admin-contest-void).
DROP FUNCTION IF EXISTS public.admin_void_contest(uuid);