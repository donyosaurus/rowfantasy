-- CHANGE 1: Add cooling-off columns
ALTER TABLE public.responsible_gaming
  ADD COLUMN pending_deposit_limit_monthly_cents bigint NULL,
  ADD COLUMN pending_limit_effective_at timestamptz NULL;

COMMENT ON COLUMN public.responsible_gaming.pending_deposit_limit_monthly_cents IS
  'Staged deposit limit increase. Becomes the effective limit on or after pending_limit_effective_at.';
COMMENT ON COLUMN public.responsible_gaming.pending_limit_effective_at IS
  '24-hour cooling-off timestamp after which a pending limit increase becomes effective.';

-- CHANGE 2: Tighten UPDATE RLS with WITH CHECK (preserving original policy name)
DROP POLICY IF EXISTS "Users can update their own responsible gaming settings" ON public.responsible_gaming;
CREATE POLICY "Users can update their own responsible gaming settings"
  ON public.responsible_gaming
  FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- CHANGE 3: Validation trigger enforcing monotonic restriction-tightening
CREATE OR REPLACE FUNCTION public.responsible_gaming_validate_update()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  -- Bypass guard for internal apply_pending function
  IF current_setting('rg.bypass_trigger', true) = 'true' THEN
    RETURN NEW;
  END IF;

  -- A. Self-exclusion: cannot be weakened while active
  IF OLD.self_exclusion_until IS NOT NULL AND OLD.self_exclusion_until > now() THEN
    IF NEW.self_exclusion_until IS NULL THEN
      RAISE EXCEPTION 'self_exclusion_until cannot be removed while active'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.self_exclusion_until < OLD.self_exclusion_until THEN
      RAISE EXCEPTION 'self_exclusion_until cannot be reduced while active (current: %, attempted: %)',
        OLD.self_exclusion_until, NEW.self_exclusion_until
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- B. Deposit limit: direct increases not allowed
  IF NEW.deposit_limit_monthly_cents IS DISTINCT FROM OLD.deposit_limit_monthly_cents THEN
    IF OLD.deposit_limit_monthly_cents IS NOT NULL AND
       (NEW.deposit_limit_monthly_cents IS NULL OR NEW.deposit_limit_monthly_cents > OLD.deposit_limit_monthly_cents)
    THEN
      RAISE EXCEPTION 'direct deposit limit increase not allowed; use pending_deposit_limit_monthly_cents with 24-hour cooling-off'
        USING ERRCODE = 'check_violation';
    END IF;
    -- Going from NULL (unrestricted) to a value is a tightening; allow.
  END IF;

  -- C. Pending limit must have valid effective_at and exceed current limit
  IF NEW.pending_deposit_limit_monthly_cents IS NOT NULL THEN
    IF NEW.pending_limit_effective_at IS NULL THEN
      RAISE EXCEPTION 'pending_limit_effective_at required when pending_deposit_limit_monthly_cents is set'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.pending_limit_effective_at < (now() + interval '24 hours' - interval '1 minute') THEN
      RAISE EXCEPTION 'pending_limit_effective_at must be at least 24 hours from now'
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.deposit_limit_monthly_cents IS NOT NULL AND
       NEW.pending_deposit_limit_monthly_cents <= OLD.deposit_limit_monthly_cents
    THEN
      RAISE EXCEPTION 'pending limit must exceed current limit; use direct decrease for tightening'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS responsible_gaming_validate_update_trigger ON public.responsible_gaming;
CREATE TRIGGER responsible_gaming_validate_update_trigger
  BEFORE UPDATE ON public.responsible_gaming
  FOR EACH ROW
  EXECUTE FUNCTION public.responsible_gaming_validate_update();

-- CHANGE 4: Helper to apply expired pending limit
CREATE OR REPLACE FUNCTION public.apply_pending_responsible_gaming_limit(_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Bypass validation trigger for this internal transition
  PERFORM set_config('rg.bypass_trigger', 'true', true);

  UPDATE public.responsible_gaming
  SET deposit_limit_monthly_cents = pending_deposit_limit_monthly_cents,
      pending_deposit_limit_monthly_cents = NULL,
      pending_limit_effective_at = NULL,
      updated_at = now()
  WHERE user_id = _user_id
    AND pending_limit_effective_at IS NOT NULL
    AND pending_limit_effective_at <= now()
    AND pending_deposit_limit_monthly_cents IS NOT NULL;

  PERFORM set_config('rg.bypass_trigger', 'false', true);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.apply_pending_responsible_gaming_limit(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.apply_pending_responsible_gaming_limit(uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.apply_pending_responsible_gaming_limit(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.apply_pending_responsible_gaming_limit(uuid) TO service_role;

-- CHANGE 5: Update check_deposit_limit to apply pending first
CREATE OR REPLACE FUNCTION public.check_deposit_limit(p_user_id uuid, p_amount bigint)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_settings RECORD;
  v_monthly_deposits BIGINT;
BEGIN
  -- Apply any expired pending limit before reading
  PERFORM apply_pending_responsible_gaming_limit(p_user_id);

  -- Get responsible gaming settings
  SELECT * INTO v_settings
  FROM responsible_gaming
  WHERE user_id = p_user_id;

  -- If no settings exist, allow the deposit
  IF NOT FOUND THEN
    RETURN true;
  END IF;

  -- Check self-exclusion
  IF v_settings.self_exclusion_until IS NOT NULL AND v_settings.self_exclusion_until > now() THEN
    RAISE EXCEPTION 'Account is self-excluded until %', v_settings.self_exclusion_until::date;
  END IF;

  -- Check deposit limit if set
  IF v_settings.deposit_limit_monthly_cents IS NOT NULL THEN
    SELECT COALESCE(SUM(amount), 0) INTO v_monthly_deposits
    FROM ledger_entries
    WHERE user_id = p_user_id
      AND transaction_type = 'DEPOSIT'
      AND created_at >= now() - interval '30 days';

    IF (v_monthly_deposits + p_amount) > v_settings.deposit_limit_monthly_cents THEN
      RAISE EXCEPTION 'Deposit exceeds monthly limit. Current: $%, Limit: $%, Requested: $%',
        (v_monthly_deposits / 100.0)::numeric(10,2),
        (v_settings.deposit_limit_monthly_cents / 100.0)::numeric(10,2),
        (p_amount / 100.0)::numeric(10,2);
    END IF;
  END IF;

  RETURN true;
END;
$function$;