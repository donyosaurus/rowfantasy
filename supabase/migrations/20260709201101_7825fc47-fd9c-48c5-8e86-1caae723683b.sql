
-- ============================================================
-- 1) Profiles: block user tampering with sensitive columns
-- Column-level GRANTs already restrict UPDATE to safe columns,
-- but add a trigger as defense-in-depth AND to satisfy explicit
-- WITH CHECK expectations. Service role and admins bypass.
-- ============================================================
CREATE OR REPLACE FUNCTION public.profiles_prevent_sensitive_self_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Bypass for service_role and admins (server-side / admin flows).
  IF current_setting('request.jwt.claim.role', true) = 'service_role'
     OR (auth.uid() IS NOT NULL AND public.has_role(auth.uid(), 'admin'::app_role)) THEN
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.kyc_status IS DISTINCT FROM OLD.kyc_status
     OR NEW.is_employee IS DISTINCT FROM OLD.is_employee
     OR NEW.is_active IS DISTINCT FROM OLD.is_active
     OR NEW.deposit_limit_monthly IS DISTINCT FROM OLD.deposit_limit_monthly
     OR NEW.self_exclusion_type IS DISTINCT FROM OLD.self_exclusion_type
     OR NEW.self_exclusion_until IS DISTINCT FROM OLD.self_exclusion_until
     OR NEW.email IS DISTINCT FROM OLD.email
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'Not permitted to modify restricted profile fields'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS profiles_prevent_sensitive_self_update_trg ON public.profiles;
CREATE TRIGGER profiles_prevent_sensitive_self_update_trg
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.profiles_prevent_sensitive_self_update();

-- Add explicit WITH CHECK to make the row-scope intent unambiguous.
DROP POLICY IF EXISTS "Users can update their own profile" ON public.profiles;
CREATE POLICY "Users can update their own profile"
  ON public.profiles FOR UPDATE
  TO authenticated
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

-- ============================================================
-- 2) Revoke public EXECUTE on internal SECURITY DEFINER functions
-- Trigger functions and server-only helpers shouldn't be callable
-- via PostgREST. User-facing functions are intentionally left alone.
-- ============================================================
REVOKE EXECUTE ON FUNCTION public.update_updated_at_column() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.responsible_gaming_audit() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.support_ticket_after_reply() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.auto_lock_expired_contests() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.cleanup_old_rate_limits() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.cleanup_old_webhooks() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.email_queue_dispatch() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.email_queue_wake() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.enqueue_email(text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.delete_email(text, bigint) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.read_email_batch(text, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.move_to_dlq(text, text, bigint, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.consume_step_up_token(uuid, text, text) FROM PUBLIC, anon, authenticated;
