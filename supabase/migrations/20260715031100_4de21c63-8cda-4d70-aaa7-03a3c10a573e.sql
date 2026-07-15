-- 1. Public contest browsing
DROP POLICY IF EXISTS "Anyone can view contest pools" ON public.contest_pools;
CREATE POLICY "Anon can view open contest pools"
  ON public.contest_pools FOR SELECT
  TO anon
  USING (status IN ('open', 'locked'));
CREATE POLICY "Authenticated can view contest pools"
  ON public.contest_pools FOR SELECT
  TO authenticated
  USING (true);

DROP POLICY IF EXISTS "Authenticated users can view contest crews" ON public.contest_pool_crews;
CREATE POLICY "Anyone can view contest crews"
  ON public.contest_pool_crews FOR SELECT
  TO anon, authenticated
  USING (true);

-- 2. Real winner_ids column-level restriction
REVOKE SELECT ON public.contest_pools FROM anon, authenticated;
GRANT SELECT (
  id, contest_template_id, created_at, current_entries, entry_fee_cents, entry_tiers,
  lock_time, max_entries, payout_structure, prize_pool_cents, prize_structure, settled_at,
  status, tier_id, tier_name, allow_overflow, void_unfilled_on_settle
) ON public.contest_pools TO anon, authenticated;

-- 3. support_tickets column-guard trigger
CREATE OR REPLACE FUNCTION public.guard_support_ticket_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF current_user IN ('postgres', 'service_role', 'supabase_admin') THEN
    RETURN NEW;
  END IF;
  IF public.has_role(auth.uid(), 'admin') THEN
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.user_id, NEW.email, NEW.subject, NEW.topic, NEW.message, NEW.status,
      NEW.priority, NEW.assigned_to, NEW.metadata, NEW.created_at, NEW.last_reply_at,
      NEW.last_reply_by, NEW.admin_last_viewed_at)
     IS DISTINCT FROM
     (OLD.id, OLD.user_id, OLD.email, OLD.subject, OLD.topic, OLD.message, OLD.status,
      OLD.priority, OLD.assigned_to, OLD.metadata, OLD.created_at, OLD.last_reply_at,
      OLD.last_reply_by, OLD.admin_last_viewed_at) THEN
    RAISE EXCEPTION 'only user_last_viewed_at may be updated';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_support_ticket_update ON public.support_tickets;
CREATE TRIGGER guard_support_ticket_update
  BEFORE UPDATE ON public.support_tickets
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_support_ticket_update();

-- 4. Reload PostgREST schema cache
NOTIFY pgrst, 'reload schema';