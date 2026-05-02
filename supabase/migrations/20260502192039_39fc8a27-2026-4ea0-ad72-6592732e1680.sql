CREATE OR REPLACE FUNCTION public.responsible_gaming_validate_update()
RETURNS trigger
LANGUAGE plpgsql
-- SECURITY INVOKER (default) — do NOT add SECURITY DEFINER.
SET search_path TO 'public'
AS $function$
BEGIN
  -- Role-based bypass. With SECURITY INVOKER, current_user reflects the
  -- actual session role (e.g. 'authenticated', 'service_role', 'postgres').
  IF current_user IN ('postgres', 'service_role') THEN
    RETURN NEW;
  END IF;

  -- Reject past-dated self-exclusion (applies to INSERT and UPDATE).
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

    -- CHANGE 2: Block combined decrease + stage-pending in the same UPDATE.
    -- Prevents a regulatory clock-restart attack where a user briefly decreases
    -- to stage a much-higher pending against the lower temporary limit.
    IF NEW.deposit_limit_monthly_cents IS NOT NULL
       AND OLD.deposit_limit_monthly_cents IS NOT NULL
       AND NEW.deposit_limit_monthly_cents < OLD.deposit_limit_monthly_cents
       AND NEW.pending_deposit_limit_monthly_cents IS NOT NULL
       AND (OLD.pending_deposit_limit_monthly_cents IS NULL
            OR NEW.pending_deposit_limit_monthly_cents IS DISTINCT FROM OLD.pending_deposit_limit_monthly_cents)
    THEN
      RAISE EXCEPTION 'cannot stage a pending limit change in the same operation as a direct decrease; perform decrease first, then stage pending separately'
        USING ERRCODE = 'check_violation';
    END IF;

    -- Block decrease while there's an active pending (regardless of whether pending is changing in this UPDATE).
    -- Codex finding #2 from final pass: prevents the two-step variant of the clock-restart attack.
    -- The user must either: cancel pending first, then decrease; or decrease and cancel atomically; or wait.
    IF TG_OP = 'UPDATE'
       AND NEW.deposit_limit_monthly_cents IS NOT NULL
       AND OLD.deposit_limit_monthly_cents IS NOT NULL
       AND NEW.deposit_limit_monthly_cents < OLD.deposit_limit_monthly_cents
       AND OLD.pending_deposit_limit_monthly_cents IS NOT NULL
       AND OLD.pending_limit_effective_at > now()
       AND NOT (NEW.pending_deposit_limit_monthly_cents IS NULL
                AND NEW.pending_limit_effective_at IS NULL)
    THEN
      RAISE EXCEPTION 'cannot decrease deposit limit while a pending increase is active; cancel the pending first or perform both atomically'
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

    -- Compare pending against NEW (post-update) limit, not OLD.
    IF NEW.deposit_limit_monthly_cents IS NOT NULL
       AND NEW.pending_deposit_limit_monthly_cents <= NEW.deposit_limit_monthly_cents THEN
      RAISE EXCEPTION 'pending limit must exceed the (post-update) deposit limit'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- Block clock-refresh attack during active cooling-off window.
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
$function$;

CREATE OR REPLACE FUNCTION public.apply_pending_responsible_gaming_limit(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _row record;
BEGIN
  -- Defensive guard: only postgres or service_role should reach this code.
  -- EXECUTE is restricted to service_role, but this provides a second layer
  -- against accidental future grant changes.
  IF current_user NOT IN ('postgres', 'service_role') THEN
    RAISE EXCEPTION 'unauthorized: apply_pending_responsible_gaming_limit may only be called by service_role';
  END IF;

  -- Lock the user's row first, then re-check pending state inside the lock
  SELECT * INTO _row
  FROM public.responsible_gaming
  WHERE user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN;  -- no row to update
  END IF;

  -- Only proceed if pending is set and elapsed
  IF _row.pending_deposit_limit_monthly_cents IS NULL
     OR _row.pending_limit_effective_at IS NULL
     OR _row.pending_limit_effective_at > now() THEN
    RETURN;
  END IF;

  UPDATE public.responsible_gaming
  SET deposit_limit_monthly_cents = pending_deposit_limit_monthly_cents,
      pending_deposit_limit_monthly_cents = NULL,
      pending_limit_effective_at = NULL,
      updated_at = now()
  WHERE user_id = p_user_id;
END;
$$;