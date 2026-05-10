-- Audit finding P0-S2 — REVOKE/scope ACLs on rate_limits and webhook_dedup
-- Forward-only migration; does not modify prior migration files.

-- 1. Revoke all access from end-user roles on rate_limits
REVOKE ALL ON public.rate_limits FROM PUBLIC;
REVOKE ALL ON public.rate_limits FROM anon;
REVOKE ALL ON public.rate_limits FROM authenticated;

-- 2. Revoke all access from end-user roles on webhook_dedup
REVOKE ALL ON public.webhook_dedup FROM PUBLIC;
REVOKE ALL ON public.webhook_dedup FROM anon;
REVOKE ALL ON public.webhook_dedup FROM authenticated;

-- 3. Re-affirm service_role grants (idempotent)
GRANT ALL ON public.rate_limits TO service_role;
GRANT ALL ON public.webhook_dedup TO service_role;

-- 4. Drop over-broad policies and re-create scoped to service_role
DROP POLICY IF EXISTS "System can manage rate limits" ON public.rate_limits;
CREATE POLICY "System can manage rate limits"
  ON public.rate_limits
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "System can manage webhook dedup" ON public.webhook_dedup;
CREATE POLICY "System can manage webhook dedup"
  ON public.webhook_dedup
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- 5. Confirm RLS remains enabled (idempotent, no FORCE)
ALTER TABLE public.rate_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.webhook_dedup ENABLE ROW LEVEL SECURITY;
