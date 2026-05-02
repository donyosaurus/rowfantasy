
-- ============================================================
-- CHANGE 1 + 2 + 4 + 5 + 6: Rewrite trigger function
-- ============================================================
CREATE OR REPLACE FUNCTION public.responsible_gaming_validate_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- CHANGE 1: Role-based bypass. current_user reflects the actual DB role
  -- and cannot be spoofed via SET LOCAL or set_config. SECURITY DEFINER
  -- functions owned by postgres run with current_user='postgres'.
  IF current_user IN ('postgres', 'service_role') THEN
    RETURN NEW;
  END IF;

  -- CHANGE 4: Reject past-dated self-exclusion (applies to INSERT and UPDATE).
  IF NEW.self_exclusion_until IS NOT NULL AND NEW.self_exclusion_until <= now() THEN
    RAISE EXCEPTION 'self_exclusion_until must be in the future (got: %)', NEW.self_exclusion_until
      USING ERRCODE = 'check_violation';
  END IF;

  -- Section A: Self-exclusion weakening (UPDATE only — needs OLD).
  IF TG_OP = 'UPDATE' THEN
    IF OLD.self_exclusion_until IS NOT NULL AND OLD.self_exclusion_until > now() THEN
      IF NEW.self_exclusion_until IS NULL THEN
        RAISE EXCEPTION 'cannot remove an active self-exclusion'
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW.self_exclusion_until < OLD.self_exclusion_until THEN
        RAISE EXCEPTION 'cannot shorten an active self-exclusion (current: %, attempted: %)',
          OLD.self_exclusion_until, NEW.self_exclusion_until
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;

    -- Section B: Block direct deposit-limit increases (must go through pending).
    IF OLD.deposit_limit_monthly_cents IS NOT NULL
       AND NEW.deposit_limit_monthly_cents IS NOT NULL
       AND NEW.deposit_limit_monthly_cents > OLD.deposit_limit_monthly_cents THEN
      RAISE EXCEPTION 'deposit limit increases must use pending_deposit_limit_monthly_cents with a 24h cooling-off period'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- Section C: Pending-limit validation (INSERT and UPDATE).
  IF NEW.pending_deposit_limit_monthly_cents IS NOT NULL THEN
    IF NEW.pending_limit_effective_at IS NULL THEN
      RAISE EXCEPTION 'pending_limit_effective_at must be set when pending_deposit_limit_monthly_cents is set'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.pending_limit_effective_at < now() + interval '24 hours' THEN
      RAISE EXCEPTION 'pending_limit_effective_at must be at least 24 hours in the future'
        USING ERRCODE = 'check_violation';
    END IF;

    -- CHANGE 5: Compare pending against NEW (post-update) limit, not OLD.
    IF NEW.deposit_limit_monthly_cents IS NOT NULL
       AND NEW.pending_deposit_limit_monthly_cents <= NEW.deposit_limit_monthly_cents THEN
      RAISE EXCEPTION 'pending limit must exceed the (post-update) deposit limit'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- CHANGE 6: Block clock-refresh attack during active cooling-off window.
  IF TG_OP = 'UPDATE'
     AND OLD.pending_limit_effective_at IS NOT NULL
     AND OLD.pending_limit_effective_at > now()
     AND (NEW.pending_deposit_limit_monthly_cents IS DISTINCT FROM OLD.pending_deposit_limit_monthly_cents
          OR NEW.pending_limit_effective_at IS DISTINCT FROM OLD.pending_limit_effective_at) THEN
    IF NEW.pending_deposit_limit_monthly_cents IS NULL AND NEW.pending_limit_effective_at IS NULL THEN
      NULL;  -- explicit cancellation allowed
    ELSE
      RAISE EXCEPTION 'pending limit cannot be modified during cooling-off period; cancel first or wait until %',
        OLD.pending_limit_effective_at
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- CHANGE 2: Extend trigger to INSERT OR UPDATE.
DROP TRIGGER IF EXISTS responsible_gaming_validate_update_trigger ON public.responsible_gaming;
DROP TRIGGER IF EXISTS responsible_gaming_validate_trigger ON public.responsible_gaming;
CREATE TRIGGER responsible_gaming_validate_trigger
  BEFORE INSERT OR UPDATE ON public.responsible_gaming
  FOR EACH ROW
  EXECUTE FUNCTION public.responsible_gaming_validate_update();

-- ============================================================
-- CHANGE 1 (cont): Drop + recreate apply_pending without GUC calls.
-- ============================================================
DROP FUNCTION IF EXISTS public.apply_pending_responsible_gaming_limit(uuid);

CREATE FUNCTION public.apply_pending_responsible_gaming_limit(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.responsible_gaming
  SET deposit_limit_monthly_cents = pending_deposit_limit_monthly_cents,
      pending_deposit_limit_monthly_cents = NULL,
      pending_limit_effective_at = NULL,
      updated_at = now()
  WHERE user_id = p_user_id
    AND pending_deposit_limit_monthly_cents IS NOT NULL
    AND pending_limit_effective_at IS NOT NULL
    AND pending_limit_effective_at <= now();
END;
$$;

REVOKE ALL ON FUNCTION public.apply_pending_responsible_gaming_limit(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_pending_responsible_gaming_limit(uuid) TO service_role;

-- Recreate check_deposit_limit caller reference (signature unchanged, but ensure it still resolves).
-- No-op if check_deposit_limit already calls apply_pending_responsible_gaming_limit(p_user_id).

-- ============================================================
-- CHANGE 2 (cont): Audit + harden INSERT RLS policy.
-- ============================================================
DO $$
DECLARE pol record;
BEGIN
  FOR pol IN
    SELECT policyname FROM pg_policies
    WHERE schemaname='public' AND tablename='responsible_gaming' AND cmd='INSERT'
  LOOP
    EXECUTE 'DROP POLICY IF EXISTS ' || quote_ident(pol.policyname) || ' ON public.responsible_gaming';
  END LOOP;
END $$;

CREATE POLICY "Users can insert their own responsible gaming settings"
  ON public.responsible_gaming
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

-- ============================================================
-- CHANGE 3: Block DELETE entirely (except service_role).
-- ============================================================
DO $$
DECLARE pol record;
BEGIN
  FOR pol IN
    SELECT policyname FROM pg_policies
    WHERE schemaname='public' AND tablename='responsible_gaming' AND cmd='DELETE'
  LOOP
    EXECUTE 'DROP POLICY IF EXISTS ' || quote_ident(pol.policyname) || ' ON public.responsible_gaming';
  END LOOP;
END $$;

REVOKE DELETE ON public.responsible_gaming FROM authenticated;
REVOKE DELETE ON public.responsible_gaming FROM anon;
REVOKE DELETE ON public.responsible_gaming FROM PUBLIC;
