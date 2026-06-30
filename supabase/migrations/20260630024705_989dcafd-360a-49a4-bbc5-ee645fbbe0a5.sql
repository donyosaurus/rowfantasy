CREATE OR REPLACE FUNCTION public.void_contest_pool_atomic(_pool_id uuid, _admin_user_id uuid, _reason text DEFAULT NULL::text)
 RETURNS TABLE(allowed boolean, reason text, was_already_voided boolean, pool_id uuid, total_refunded_cents bigint, refunded_count integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _pool                 contest_pools%ROWTYPE;
  _rec                  RECORD;
  _wallet_id            uuid;
  _transaction_id       uuid;
  _total_refunded_cents bigint := 0;
  _refunded_count       integer := 0;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM user_roles ur
    JOIN auth.users u ON u.id = ur.user_id
    WHERE ur.user_id = _admin_user_id AND ur.role = 'admin'
  ) THEN
    RAISE EXCEPTION 'unauthorized: caller is not an admin';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('void_pool:' || _pool_id::text));

  SELECT * INTO _pool
  FROM contest_pools cp
  WHERE cp.id = _pool_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'pool_not_found'::text, false, _pool_id, 0::bigint, 0;
    RETURN;
  END IF;

  IF _pool.status = 'voided' THEN
    RETURN QUERY SELECT true, 'approved'::text, true, _pool_id, 0::bigint, 0;
    RETURN;
  END IF;

  IF _pool.status = 'settled' THEN
    RETURN QUERY SELECT false, 'cannot_void_settled'::text, false, _pool_id, 0::bigint, 0;
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM contest_entries ce
    WHERE ce.pool_id = _pool_id AND ce.status = 'settled'
  ) THEN
    RAISE EXCEPTION 'data integrity error: pool % has settled entries; cannot void', _pool_id;
  END IF;

  FOR _rec IN
    SELECT ce.id AS entry_id, ce.user_id, ce.entry_fee_cents
    FROM contest_entries ce
    WHERE ce.pool_id = _pool_id AND ce.status = 'active'
    ORDER BY ce.user_id ASC
    FOR UPDATE
  LOOP
    IF _rec.entry_fee_cents > 0 THEN
      SELECT w.id INTO _wallet_id FROM wallets w WHERE w.user_id = _rec.user_id;
      IF _wallet_id IS NULL THEN
        RAISE EXCEPTION 'Wallet not found for user % during void refund', _rec.user_id;
      END IF;

      INSERT INTO transactions (
        user_id, wallet_id, type, amount, status, description, reference_type, reference_id
      ) VALUES (
        _rec.user_id,
        _wallet_id,
        'refund',
        _rec.entry_fee_cents,
        'completed',
        COALESCE('Contest voided: ' || NULLIF(_reason, ''), 'Contest voided'),
        'contest_pool',
        _pool_id::text
      )
      RETURNING id INTO _transaction_id;

      PERFORM update_wallet_balance(
        _wallet_id,
        _rec.entry_fee_cents,
        0, 0, 0, 0
      );

      INSERT INTO ledger_entries (
        user_id, transaction_type, amount, reference_id, description
      ) VALUES (
        _rec.user_id,
        'REFUND',
        _rec.entry_fee_cents,
        _transaction_id,
        'Contest void refund'
      );
    END IF;

    UPDATE contest_entries ce
    SET status = 'voided',
        payout_cents = _rec.entry_fee_cents,
        updated_at = now()
    WHERE ce.id = _rec.entry_id;

    _total_refunded_cents := _total_refunded_cents + _rec.entry_fee_cents;
    _refunded_count := _refunded_count + 1;
  END LOOP;

  UPDATE contest_pools cp
  SET status = 'voided'
  WHERE cp.id = _pool_id;

  RETURN QUERY SELECT true, 'approved'::text, false, _pool_id, _total_refunded_cents, _refunded_count;
END;
$function$;

REVOKE ALL ON FUNCTION public.void_contest_pool_atomic(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.void_contest_pool_atomic(uuid, uuid, text) TO service_role;

NOTIFY pgrst, 'reload schema';