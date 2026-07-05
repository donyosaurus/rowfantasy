
-- 1. enter_contest_pool_atomic: service-role only + defense-in-depth guard
CREATE OR REPLACE FUNCTION public.enter_contest_pool_atomic(_user_id uuid, _wallet_id uuid, _contest_template_id uuid, _tier_name text, _picks jsonb, _state_code text)
 RETURNS TABLE(allowed boolean, reason text, entry_id uuid, pool_id uuid, current_entries integer, max_entries integer, available_balance_cents bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  MIN_UNIQUE_EVENTS CONSTANT integer := 2;
  H2H_MAX_ENTRIES CONSTANT integer := 2;

  _exclusion_until timestamptz;
  _event_ids text[];
  _unique_event_count integer;
  _total_event_count integer;
  _template_check uuid;
  _wallet_id_check uuid;
  _available_balance bigint;
  _candidate record;
  _target_pool_id uuid;
  _pool_fee_cents bigint;
  _pool_for_clone uuid;
  _has_overflow_candidate boolean := false;
  _matching_pool_exists boolean := false;
  _new_pool_id uuid;
  _wallet_result record;
  _transaction_id uuid;
  _entry_id uuid;
  _post_increment_entries integer;
  _pool_max integer;
BEGIN
  -- Defense-in-depth: if invoked with an active JWT (auth.uid() not null),
  -- the _user_id must match. Legitimate service-role edge calls have auth.uid() = NULL.
  IF auth.uid() IS NOT NULL AND _user_id <> auth.uid() THEN
    RAISE EXCEPTION 'unauthorized: user mismatch';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('contest_entry:' || _user_id::text));

  SELECT self_exclusion_until INTO _exclusion_until
  FROM responsible_gaming
  WHERE user_id = _user_id;

  IF _exclusion_until IS NOT NULL AND _exclusion_until > now() THEN
    RETURN QUERY SELECT false, 'self_excluded'::text, NULL::uuid, NULL::uuid, NULL::integer, NULL::integer, NULL::bigint;
    RETURN;
  END IF;

  SELECT array_agg(elem->>'event_id'), count(*)
  INTO _event_ids, _total_event_count
  FROM jsonb_array_elements(_picks) AS elem;

  IF _event_ids IS NULL THEN
    RETURN QUERY SELECT false, 'insufficient_events'::text, NULL::uuid, NULL::uuid, NULL::integer, NULL::integer, NULL::bigint;
    RETURN;
  END IF;

  SELECT count(DISTINCT e) INTO _unique_event_count
  FROM unnest(_event_ids) AS e;

  IF _unique_event_count < _total_event_count THEN
    RETURN QUERY SELECT false, 'duplicate_event'::text, NULL::uuid, NULL::uuid, NULL::integer, NULL::integer, NULL::bigint;
    RETURN;
  END IF;

  IF _unique_event_count < MIN_UNIQUE_EVENTS THEN
    RETURN QUERY SELECT false, 'insufficient_events'::text, NULL::uuid, NULL::uuid, NULL::integer, NULL::integer, NULL::bigint;
    RETURN;
  END IF;

  SELECT id INTO _template_check
  FROM contest_templates
  WHERE id = _contest_template_id;

  IF _template_check IS NULL THEN
    RETURN QUERY SELECT false, 'template_not_found'::text, NULL::uuid, NULL::uuid, NULL::integer, NULL::integer, NULL::bigint;
    RETURN;
  END IF;

  SELECT w.id, w.available_balance INTO _wallet_id_check, _available_balance
  FROM wallets w
  WHERE w.id = _wallet_id AND w.user_id = _user_id
  FOR UPDATE;

  IF _wallet_id_check IS NULL THEN
    RETURN QUERY SELECT false, 'wallet_not_found'::text, NULL::uuid, NULL::uuid, NULL::integer, NULL::integer, NULL::bigint;
    RETURN;
  END IF;

  FOR _candidate IN
    SELECT cp.id, cp.current_entries, cp.max_entries, cp.lock_time, cp.allow_overflow, cp.entry_fee_cents, cp.created_at
    FROM contest_pools cp
    WHERE cp.contest_template_id = _contest_template_id
      AND cp.status = 'open'
      AND (_tier_name IS NULL OR cp.tier_name = _tier_name)
    ORDER BY cp.current_entries DESC, cp.created_at ASC
    FOR UPDATE
  LOOP
    _matching_pool_exists := true;

    IF _candidate.allow_overflow AND _candidate.lock_time > now() THEN
      _has_overflow_candidate := true;
      _pool_for_clone := _candidate.id;
    END IF;

    IF _candidate.lock_time <= now() THEN
      CONTINUE;
    END IF;

    IF _candidate.current_entries >= _candidate.max_entries THEN
      CONTINUE;
    END IF;

    IF _candidate.max_entries = H2H_MAX_ENTRIES THEN
      IF EXISTS (
        SELECT 1 FROM contest_entries ce
        WHERE ce.pool_id = _candidate.id AND ce.user_id = _user_id
        LIMIT 1
      ) THEN
        CONTINUE;
      END IF;
    END IF;

    _target_pool_id := _candidate.id;
    _pool_fee_cents := _candidate.entry_fee_cents;
    EXIT;
  END LOOP;

  IF _target_pool_id IS NULL THEN
    IF NOT _matching_pool_exists THEN
      RETURN QUERY SELECT false, 'no_pool_for_tier'::text, NULL::uuid, NULL::uuid, NULL::integer, NULL::integer, NULL::bigint;
      RETURN;
    END IF;

    IF NOT _has_overflow_candidate THEN
      RETURN QUERY SELECT false, 'all_pools_full'::text, NULL::uuid, NULL::uuid, NULL::integer, NULL::integer, NULL::bigint;
      RETURN;
    END IF;

    SELECT cp.id INTO _pool_for_clone
    FROM contest_pools cp
    WHERE cp.contest_template_id = _contest_template_id
      AND (_tier_name IS NULL OR cp.tier_name = _tier_name)
      AND cp.allow_overflow = true
      AND cp.lock_time > now()
      AND cp.status = 'open'
    ORDER BY cp.created_at DESC
    LIMIT 1;

    IF _pool_for_clone IS NULL THEN
      RETURN QUERY SELECT false, 'all_pools_full'::text, NULL::uuid, NULL::uuid, NULL::integer, NULL::integer, NULL::bigint;
      RETURN;
    END IF;

    _new_pool_id := clone_contest_pool(_pool_for_clone);

    SELECT cp.id, cp.entry_fee_cents INTO _target_pool_id, _pool_fee_cents
    FROM contest_pools cp
    WHERE cp.id = _new_pool_id
    FOR UPDATE;
  END IF;

  IF _pool_fee_cents IS NULL OR _pool_fee_cents < 0 THEN
    RETURN QUERY SELECT false, 'invalid_pool_fee'::text, NULL::uuid, NULL::uuid, NULL::integer, NULL::integer, NULL::bigint;
    RETURN;
  END IF;

  IF _pool_fee_cents > 0 THEN
    IF _available_balance < _pool_fee_cents THEN
      RETURN QUERY SELECT false, 'insufficient_balance'::text, NULL::uuid, NULL::uuid, NULL::integer, NULL::integer, _available_balance;
      RETURN;
    END IF;

    SELECT * INTO _wallet_result
    FROM update_wallet_balance(
      _wallet_id := _wallet_id,
      _available_delta := -_pool_fee_cents,
      _pending_delta := 0
    );

    _available_balance := _wallet_result.available_balance;

    INSERT INTO transactions (user_id, wallet_id, type, amount, status, description)
    VALUES (
      _user_id,
      _wallet_id,
      'entry_fee',
      _pool_fee_cents,
      'completed',
      'Contest entry fee for ' || COALESCE(_tier_name, 'untiered') || ' tier'
    )
    RETURNING id INTO _transaction_id;

    INSERT INTO ledger_entries (user_id, transaction_type, amount, reference_id, description)
    VALUES (
      _user_id,
      'ENTRY_FEE',
      -_pool_fee_cents,
      _transaction_id,
      'Contest entry fee debit'
    );
  END IF;

  INSERT INTO contest_entries (user_id, pool_id, contest_template_id, picks, entry_fee_cents, state_code, tier_name, status)
  VALUES (
    _user_id,
    _target_pool_id,
    _contest_template_id,
    _picks,
    _pool_fee_cents,
    _state_code,
    _tier_name,
    'active'
  )
  RETURNING id INTO _entry_id;

  UPDATE public.contest_pools cp
  SET current_entries = cp.current_entries + 1
  WHERE cp.id = _target_pool_id AND cp.current_entries < cp.max_entries
  RETURNING cp.current_entries, cp.max_entries INTO _post_increment_entries, _pool_max;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'pool_capacity_violated';
  END IF;

  RETURN QUERY SELECT
    true,
    'approved'::text,
    _entry_id,
    _target_pool_id,
    _post_increment_entries,
    _pool_max,
    _available_balance;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.enter_contest_pool_atomic(uuid, uuid, uuid, text, jsonb, text)
  FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.enter_contest_pool_atomic(uuid, uuid, uuid, text, jsonb, text)
  TO service_role;

-- 2. admin_override_responsible_gaming: drop the broken session_user guard.
CREATE OR REPLACE FUNCTION public.admin_override_responsible_gaming(_admin_user_id uuid, _target_user_id uuid, _action text, _new_limit_cents bigint, _reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _admin_check int;
BEGIN
  -- Confirm caller is an admin AND the auth.users row exists (orphan-admin guard).
  SELECT 1 INTO _admin_check
  FROM public.user_roles ur
  JOIN auth.users u ON u.id = ur.user_id
  WHERE ur.user_id = _admin_user_id AND ur.role = 'admin';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unauthorized: caller is not an admin';
  END IF;

  IF _reason IS NULL OR length(trim(_reason)) < 10 THEN
    RAISE EXCEPTION 'invalid: reason required (min 10 chars)';
  END IF;

  CASE _action
    WHEN 'lift_self_exclusion' THEN
      UPDATE public.responsible_gaming
      SET self_exclusion_until = NULL,
          updated_at = now()
      WHERE user_id = _target_user_id;

    WHEN 'reset_pending' THEN
      UPDATE public.responsible_gaming
      SET pending_deposit_limit_monthly_cents = NULL,
          pending_limit_effective_at = NULL,
          updated_at = now()
      WHERE user_id = _target_user_id;

    WHEN 'set_limit_immediately' THEN
      IF _new_limit_cents IS NULL OR _new_limit_cents <= 0 THEN
        RAISE EXCEPTION 'invalid: _new_limit_cents required and positive';
      END IF;
      UPDATE public.responsible_gaming
      SET deposit_limit_monthly_cents = _new_limit_cents,
          pending_deposit_limit_monthly_cents = NULL,
          pending_limit_effective_at = NULL,
          updated_at = now()
      WHERE user_id = _target_user_id;

    ELSE
      RAISE EXCEPTION 'invalid: unknown action %', _action;
  END CASE;

  INSERT INTO public.compliance_audit_logs (user_id, event_type, description, severity, metadata)
  VALUES (
    _target_user_id,
    'rg_admin_override',
    format('Admin override: %s', _action),
    'warning',
    jsonb_build_object(
      'admin_user_id', _admin_user_id,
      'action', _action,
      'new_limit_cents', _new_limit_cents,
      'reason', _reason,
      'session_user', session_user
    )
  );

  RETURN jsonb_build_object('success', true, 'action', _action);
END;
$function$;

-- 3. responsible_gaming_validate_update: block clearing the deposit limit directly.
CREATE OR REPLACE FUNCTION public.responsible_gaming_validate_update()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF current_user IN ('postgres', 'service_role') THEN
    RETURN NEW;
  END IF;

  IF NEW.self_exclusion_until IS NOT NULL AND NEW.self_exclusion_until <= now() THEN
    RAISE EXCEPTION 'self_exclusion_until must be in the future (got: %)', NEW.self_exclusion_until
      USING ERRCODE = 'check_violation';
  END IF;

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

    -- Block clearing the deposit limit directly (NOT NULL -> NULL).
    -- Mirrors the self-exclusion protection above; clearing must go through
    -- the pending-limit cooling-off flow.
    IF OLD.deposit_limit_monthly_cents IS NOT NULL
       AND NEW.deposit_limit_monthly_cents IS NULL THEN
      RAISE EXCEPTION 'deposit limit cannot be cleared directly; use the pending-limit cooling-off flow'
        USING ERRCODE = 'check_violation';
    END IF;

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

  IF NEW.pending_deposit_limit_monthly_cents IS NOT NULL THEN
    IF NEW.pending_limit_effective_at IS NULL THEN
      RAISE EXCEPTION 'pending_limit_effective_at must be set when pending_deposit_limit_monthly_cents is set'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.pending_limit_effective_at < now() + interval '24 hours' THEN
      RAISE EXCEPTION 'pending_limit_effective_at must be at least 24 hours in the future'
        USING ERRCODE = 'check_violation';
    END IF;

    IF NEW.deposit_limit_monthly_cents IS NOT NULL
       AND NEW.pending_deposit_limit_monthly_cents <= NEW.deposit_limit_monthly_cents THEN
      RAISE EXCEPTION 'pending limit must exceed the (post-update) deposit limit'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD.pending_limit_effective_at IS NOT NULL
     AND OLD.pending_limit_effective_at > now()
     AND (NEW.pending_deposit_limit_monthly_cents IS DISTINCT FROM OLD.pending_deposit_limit_monthly_cents
          OR NEW.pending_limit_effective_at IS DISTINCT FROM OLD.pending_limit_effective_at) THEN
    IF NEW.pending_deposit_limit_monthly_cents IS NULL AND NEW.pending_limit_effective_at IS NULL THEN
      NULL;
    ELSE
      RAISE EXCEPTION 'pending limit cannot be modified during cooling-off period; cancel first or wait until %',
        OLD.pending_limit_effective_at
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

NOTIFY pgrst, 'reload schema';
