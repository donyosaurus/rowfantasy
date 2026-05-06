-- Pre-flight eligibility check for deposits.
-- Read-only mirror of process_deposit_atomic's pre-checks. Used by edge functions
-- to validate a deposit BEFORE charging the payment provider, eliminating ghost
-- charges on rejected deposits (Aeropay-readiness invariant).
--
-- SECURITY DEFINER + EXECUTE locked to service_role: trust boundary is the
-- edge function, which authenticates the user and passes _user_id explicitly.
-- Idempotency_key is intentionally NOT checked here (caller has not generated one yet).

CREATE OR REPLACE FUNCTION public.check_deposit_eligibility(
  _user_id uuid,
  _wallet_id uuid,
  _amount_cents bigint,
  _state_code text
)
RETURNS TABLE(allowed boolean, reason text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _wallet_check uuid;
  _settings RECORD;
  _monthly_deposits bigint;
BEGIN
  -- Defensive: only callable by service_role (and postgres). session_user is
  -- invariant across SECURITY DEFINER hops; current_user would always be the
  -- function owner here.
  IF session_user NOT IN ('postgres', 'service_role') THEN
    RAISE EXCEPTION 'unauthorized: check_deposit_eligibility may only be called by service_role';
  END IF;

  -- 1. Per-transaction range: $5 min, $500 max (cents)
  IF _amount_cents < 500 OR _amount_cents > 50000 THEN
    RETURN QUERY SELECT false, 'per_transaction_limit'::text;
    RETURN;
  END IF;

  -- 2. Wallet exists and belongs to user
  SELECT id INTO _wallet_check
  FROM wallets
  WHERE id = _wallet_id AND user_id = _user_id;

  IF _wallet_check IS NULL THEN
    RETURN QUERY SELECT false, 'wallet_not_found'::text;
    RETURN;
  END IF;

  -- 3. Apply any expired pending RG limit so subsequent reads see the new value.
  -- This is a write to responsible_gaming when a pending limit has matured;
  -- it represents user-intent already committed at staging time, so it is
  -- correct to apply it during eligibility (mirrors check_deposit_limit).
  PERFORM apply_pending_responsible_gaming_limit(_user_id);

  -- 4. Self-exclusion + monthly limit
  SELECT * INTO _settings
  FROM responsible_gaming
  WHERE user_id = _user_id;

  IF FOUND THEN
    IF _settings.self_exclusion_until IS NOT NULL
       AND _settings.self_exclusion_until > now() THEN
      RETURN QUERY SELECT false, 'self_excluded'::text;
      RETURN;
    END IF;

    IF _settings.deposit_limit_monthly_cents IS NOT NULL THEN
      SELECT COALESCE(SUM(amount), 0) INTO _monthly_deposits
      FROM ledger_entries
      WHERE user_id = _user_id
        AND transaction_type = 'DEPOSIT'
        AND created_at >= now() - interval '30 days';

      IF (_monthly_deposits + _amount_cents) > _settings.deposit_limit_monthly_cents THEN
        RETURN QUERY SELECT false, 'monthly_deposit_limit'::text;
        RETURN;
      END IF;
    END IF;
  END IF;

  -- 5. State-eligibility hook (placeholder, no-op today; geofencing wired separately)
  -- Intentionally a no-op so future state-rules table can be added here without
  -- changing the call sites.
  PERFORM 1 WHERE _state_code IS NOT NULL;

  RETURN QUERY SELECT true, 'approved'::text;
END;
$function$;

-- Lock down EXECUTE: only service_role may call (edge functions use service role)
REVOKE ALL ON FUNCTION public.check_deposit_eligibility(uuid, uuid, bigint, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_deposit_eligibility(uuid, uuid, bigint, text) TO service_role;