-- Remove broken session_user guards from SECURITY DEFINER RPCs.
-- Under PostgREST, session_user is always 'authenticator', so these guards
-- raised P0001 on every legitimate service_role call. EXECUTE grants are
-- re-asserted (service_role only) as the authorization boundary.

CREATE OR REPLACE FUNCTION public.admin_list_wallet_balances(_admin_user_id uuid)
 RETURNS TABLE(user_id uuid, available_balance_cents bigint, pending_balance_cents bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _admin_check int;
BEGIN
  -- Orphan-admin guard: admin must exist in auth.users AND have admin role.
  SELECT 1 INTO _admin_check
  FROM public.user_roles ur
  JOIN auth.users u ON u.id = ur.user_id
  WHERE ur.user_id = _admin_user_id AND ur.role = 'admin';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unauthorized: caller is not an admin';
  END IF;

  RETURN QUERY
    SELECT w.user_id, w.available_balance::bigint, w.pending_balance::bigint
    FROM public.wallets w;
END;
$function$;

CREATE OR REPLACE FUNCTION public.apply_pending_responsible_gaming_limit(p_user_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _row record;
BEGIN
  -- Lock the user's row first, then re-check pending state inside the lock
  SELECT * INTO _row
  FROM public.responsible_gaming
  WHERE user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN;
  END IF;

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
$function$;

CREATE OR REPLACE FUNCTION public.cancel_pending_withdrawal_atomic(_user_id uuid, _transaction_id uuid)
 RETURNS TABLE(allowed boolean, reason text, amount_cents bigint, available_balance_cents bigint, pending_balance_cents bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _tx record;
  _wallet record;
BEGIN
  -- STEP 1: Lock transaction row + verify ownership/state
  SELECT * INTO _tx
  FROM public.transactions
  WHERE id = _transaction_id
    AND user_id = _user_id
    AND type = 'withdrawal'
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'transaction_not_found'::text, NULL::bigint, NULL::bigint, NULL::bigint;
    RETURN;
  END IF;

  IF _tx.status <> 'pending' THEN
    RETURN QUERY SELECT false, 'not_pending'::text, NULL::bigint, NULL::bigint, NULL::bigint;
    RETURN;
  END IF;

  -- STEP 2: Lock wallet
  SELECT * INTO _wallet
  FROM public.wallets
  WHERE id = _tx.wallet_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'wallet_not_found'::text, NULL::bigint, NULL::bigint, NULL::bigint;
    RETURN;
  END IF;

  IF _wallet.pending_balance < _tx.amount THEN
    RETURN QUERY SELECT false, 'pending_balance_insufficient'::text,
      _tx.amount::bigint,
      _wallet.available_balance::bigint,
      _wallet.pending_balance::bigint;
    RETURN;
  END IF;

  UPDATE public.transactions
  SET status = 'failed',
      metadata = COALESCE(metadata, '{}'::jsonb)
                 || jsonb_build_object('cancelled_by_user', true, 'cancelled_at', now())
  WHERE id = _transaction_id;

  UPDATE public.wallets
  SET available_balance = available_balance + _tx.amount,
      pending_balance   = pending_balance   - _tx.amount,
      updated_at        = now()
  WHERE id = _tx.wallet_id;

  INSERT INTO public.ledger_entries (
    user_id, transaction_type, amount, reference_id, description
  )
  VALUES (
    _user_id,
    'WITHDRAWAL_CANCEL',
    _tx.amount,
    _transaction_id,
    'User cancelled pending withdrawal'
  );

  SELECT * INTO _wallet FROM public.wallets WHERE id = _tx.wallet_id;
  RETURN QUERY SELECT true, 'ok'::text,
    _tx.amount::bigint,
    _wallet.available_balance::bigint,
    _wallet.pending_balance::bigint;
END;
$function$;

CREATE OR REPLACE FUNCTION public.check_deposit_eligibility(_user_id uuid, _wallet_id uuid, _amount_cents bigint, _state_code text)
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

  PERFORM 1 WHERE _state_code IS NOT NULL;

  RETURN QUERY SELECT true, 'approved'::text;
END;
$function$;

-- Re-assert grants: service_role only.
REVOKE ALL ON FUNCTION public.admin_list_wallet_balances(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_list_wallet_balances(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.apply_pending_responsible_gaming_limit(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_pending_responsible_gaming_limit(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.cancel_pending_withdrawal_atomic(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_pending_withdrawal_atomic(uuid, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.check_deposit_eligibility(uuid, uuid, bigint, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_deposit_eligibility(uuid, uuid, bigint, text) TO service_role;
