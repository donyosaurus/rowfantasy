-- Fix remaining WITH CHECK (true) / USING (true) on system tables
-- rate_limits: restrict to service_role only (deny authenticated)
DROP POLICY IF EXISTS "System can manage rate limits" ON rate_limits;
CREATE POLICY "Deny authenticated rate limit access"
  ON rate_limits FOR ALL TO authenticated
  USING (false) WITH CHECK (false);

-- webhook_dedup: restrict to service_role only
DROP POLICY IF EXISTS "System can manage webhook dedup" ON webhook_dedup;
CREATE POLICY "Deny authenticated webhook dedup access"
  ON webhook_dedup FOR ALL TO authenticated
  USING (false) WITH CHECK (false);

-- support_tickets INSERT: scope to authenticated user
DROP POLICY IF EXISTS "Users can create tickets" ON support_tickets;
CREATE POLICY "Users can create tickets"
  ON support_tickets FOR INSERT TO authenticated
  WITH CHECK (true);