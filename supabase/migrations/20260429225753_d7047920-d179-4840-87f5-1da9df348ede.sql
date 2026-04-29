DROP FUNCTION IF EXISTS public.initiate_withdrawal_atomic(uuid, uuid, bigint, text);

CREATE FUNCTION public.initiate_withdrawal_atomic(
  _user_id uuid,
  _wallet_id uuid,
  _amount_cents bigint,
  _state_code text
)
RETURNS TABLE (
  allowed boolean,
  reason text,
  transaction_id uuid,
  today_total_cents bigint,
  available_balance_cents bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _wallet_id_check uuid;
  _available_balance bigint;
  _pending_count integer;
  _last_completed_at timestamptz;
  _today_start timestamptz;
  _today_total bigint;
  _recent_deposit_count integer;
  _new_transaction_id uuid;
BEGIN
  -- 1. Serialize concurrent requests for the same user
  PERFORM pg_advisory_xact_lock(hashtext(_user_id::text));

  -- 2. Per-transaction range: $5 min, $500 max
  IF _amount_cents > 50000 OR _amount_cents < 500 THEN
    RETURN QUERY SELECT false, 'per_transaction_limit'::text, NULL::uuid, 0::bigint, 0::bigint;
    RETURN;
  END IF;

  -- 3. Lock the wallet row
  SELECT id, available_balance
    INTO _wallet_id_check, _available_balance
  FROM wallets
  WHERE id = _wallet_id AND user_id = _user_id
  FOR UPDATE;

  IF _wallet_id_check IS NULL THEN
    RETURN QUERY SELECT false, 'wallet_not_found'::text, NULL::uuid, 0::bigint, 0::bigint;
    RETURN;
  END IF;

  -- 4. Available balance check
  IF _available_balance < _amount_cents THEN
    RETURN QUERY SELECT false, 'insufficient_balance'::text, NULL::uuid, 0::bigint, _available_balance;
    RETURN;
  END IF;

  -- 5. No pending withdrawals allowed
  SELECT COUNT(*) INTO _pending_count
  FROM transactions
  WHERE user_id = _user_id
    AND type = 'withdrawal'
    AND status = 'pending';

  IF _pending_count > 0 THEN
    RETURN QUERY SELECT false, 'pending_withdrawal_exists'::text, NULL::uuid, 0::bigint, _available_balance;
    RETURN;
  END IF;

  -- 6. 10-minute cooldown vs last COMPLETED withdrawal
  SELECT MAX(created_at) INTO _last_completed_at
  FROM transactions
  WHERE user_id = _user_id
    AND type = 'withdrawal'
    AND status = 'completed';

  IF _last_completed_at IS NOT NULL AND _last_completed_at > (now() - interval '10 minutes') THEN
    RETURN QUERY SELECT false, 'cooldown'::text, NULL::uuid, 0::bigint, _available_balance;
    RETURN;
  END IF;

  -- 7. Daily cap ($500) since UTC midnight, includes pending + completed
  _today_start := date_trunc('day', now() AT TIME ZONE 'UTC');

  SELECT COALESCE(SUM(ABS(amount)), 0)::bigint INTO _today_total
  FROM transactions
  WHERE user_id = _user_id
    AND type = 'withdrawal'
    AND status IN ('completed', 'pending')
    AND created_at >= _today_start;

  IF (_today_total + _amount_cents) > 50000 THEN
    RETURN QUERY SELECT false, 'daily_limit'::text, NULL::uuid, _today_total, _available_balance;
    RETURN;
  END IF;

  -- 8. 24-hour deposit hold
  SELECT COUNT(*) INTO _recent_deposit_count
  FROM transactions
  WHERE user_id = _user_id
    AND type = 'deposit'
    AND status = 'completed'
    AND created_at >= (now() - interval '24 hours');

  IF _recent_deposit_count > 0 THEN
    RETURN QUERY SELECT false, 'deposit_hold_24h'::text, NULL::uuid, _today_total, _available_balance;
    RETURN;
  END IF;

  -- 9. Insert pending withdrawal
  INSERT INTO transactions (user_id, wallet_id, type, amount, status, description)
  VALUES (_user_id, _wallet_id, 'withdrawal', -_amount_cents, 'pending', 'Withdrawal request')
  RETURNING id INTO _new_transaction_id;

  -- 10. Move funds from available to pending
  UPDATE wallets
  SET available_balance = available_balance - _amount_cents,
      pending_balance = pending_balance + _amount_cents,
      updated_at = now()
  WHERE id = _wallet_id;

  -- 11. Re-read updated available balance
  SELECT available_balance INTO _available_balance
  FROM wallets WHERE id = _wallet_id;

  -- 12. Success
  RETURN QUERY SELECT
    true,
    'approved'::text,
    _new_transaction_id,
    (_today_total + _amount_cents),
    _available_balance;
END;
$$;