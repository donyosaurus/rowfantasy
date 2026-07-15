-- PART 1: Fix profiles sensitive-column guard (SECURITY INVOKER + current_user bypass)
CREATE OR REPLACE FUNCTION public.profiles_prevent_sensitive_self_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  -- Service contexts: service_role PostgREST, and SECURITY DEFINER functions owned by
  -- postgres (e.g. soft_delete_user_account) whose nested UPDATEs run as their owner.
  -- NOTE: this makes the guard an anti-direct-PATCH control only — ANY postgres-owned
  -- DEFINER RPC that updates profiles bypasses it; such RPCs must enforce their own checks.
  IF current_user IN ('postgres', 'service_role', 'supabase_admin') THEN
    RETURN NEW;
  END IF;

  IF auth.uid() IS NOT NULL AND public.has_role(auth.uid(), 'admin'::app_role) THEN
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

-- PART 2: Retarget six stale TO-public admin policies to TO authenticated
DROP POLICY IF EXISTS "Admins can manage state regulations" ON public.state_regulation_rules;
CREATE POLICY "Admins can manage state regulations" ON public.state_regulation_rules
  FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role));

DROP POLICY IF EXISTS "Admins can view licenses" ON public.license_registry;
CREATE POLICY "Admins can view licenses" ON public.license_registry
  FOR SELECT TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role));

DROP POLICY IF EXISTS "Admins can manage licenses" ON public.license_registry;
CREATE POLICY "Admins can manage licenses" ON public.license_registry
  FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role));

DROP POLICY IF EXISTS "Admins can manage CMS pages" ON public.cms_pages;
CREATE POLICY "Admins can manage CMS pages" ON public.cms_pages
  FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role));

DROP POLICY IF EXISTS "Admins can view all consents" ON public.user_consents;
CREATE POLICY "Admins can view all consents" ON public.user_consents
  FOR SELECT TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role));

DROP POLICY IF EXISTS "Admins can manage all privacy requests" ON public.privacy_requests;
CREATE POLICY "Admins can manage all privacy requests" ON public.privacy_requests
  FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role));

-- PART 3: Remove PUBLIC/anon EXECUTE on DEFINER oracle helpers
REVOKE EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.user_in_pool(uuid, uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.user_in_pool(uuid, uuid) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.get_usernames(uuid[]) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.get_usernames(uuid[]) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';