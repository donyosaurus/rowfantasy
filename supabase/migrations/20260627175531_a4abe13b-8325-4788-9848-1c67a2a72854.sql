
-- 1. payment_sessions: service-role-only inserts
DROP POLICY IF EXISTS "System can insert payment sessions" ON public.payment_sessions;
CREATE POLICY "Deny authenticated insert on payment_sessions"
  ON public.payment_sessions
  FOR INSERT
  TO authenticated
  WITH CHECK (false);

-- 2. match_queue: drop user write policies (dead table; admin-manage + user select remain)
DROP POLICY IF EXISTS "Users can insert into queue" ON public.match_queue;
DROP POLICY IF EXISTS "Users can cancel own pending entries" ON public.match_queue;
