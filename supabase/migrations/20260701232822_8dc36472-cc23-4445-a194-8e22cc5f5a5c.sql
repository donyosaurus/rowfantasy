
CREATE OR REPLACE FUNCTION public.settle_contest_pool_atomic(_pool_id uuid, _admin_user_id uuid)
 RETURNS TABLE(allowed boolean, reason text, was_already_settled boolean, pool_id uuid, total_payout_cents bigint, winners_count integer, is_tie_refund boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _pool contest_pools%ROWTYPE;
  _is_tie_refund boolean := false;
  _total_payout_cents bigint := 0;
  _winners_count integer := 0;
  _transaction_id uuid;
  _wallet_id uuid;
  _rank1_count integer;
  _active_count integer;
  _entry_count_for_capacity integer;
  _rec record;
BEGIN
  -- STEP 0: admin authorization
  IF NOT EXISTS (
    SELECT 1 FROM user_roles ur
    JOIN auth.users u ON u.id = ur.user_id
    WHERE ur.user_id = _admin_user_id AND ur.role = 'admin'
  ) THEN
    RAISE EXCEPTION 'unauthorized: caller is not an admin';
  END IF;

  -- STEP 1: lock pool row
  SELECT * INTO _pool FROM contest_pools cp WHERE cp.id = _pool_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'pool_not_found'::text, false, NULL::uuid, 0::bigint, 0, false;
    RETURN;
  END IF;

  -- STEP 2: idempotency — already settled
  IF _pool.status = 'settled' THEN
    RETURN QUERY SELECT true, 'approved'::text, true, _pool_id, 0::bigint, 0, false;
    RETURN;
  END IF;

  -- STEP 2a: explicit refusal for voided pools (never settle a voided pool)
  IF _pool.status = 'voided' THEN
    RETURN QUERY SELECT false, 'pool_voided'::text, false, _pool_id, 0::bigint, 0, false;
    RETURN;
  END IF;

  -- STEP 2b: count active entries directly (do NOT trust current_entries) and,
  -- if the pool is flagged void_unfilled_on_settle and is not full, refuse so
  -- the caller routes to the void path instead.
  SELECT COUNT(*) INTO _entry_count_for_capacity
  FROM contest_entries ce
  WHERE ce.pool_id = _pool_id AND ce.status = 'active';

  IF COALESCE(_pool.void_unfilled_on_settle, false) = true
     AND _entry_count_for_capacity < _pool.max_entries THEN
    RETURN QUERY SELECT false, 'must_void_unfilled'::text, false, _pool_id, 0::bigint, 0, false;
    RETURN;
  END IF;

  -- STEP 3: precondition
  IF _pool.status <> 'scoring_completed' THEN
    RETURN QUERY SELECT false, 'wrong_pool_status'::text, false, _pool_id, 0::bigint, 0, false;
    RETURN;
  END IF;

  -- STEP 4: H2H tie-refund detection
  SELECT
    COUNT(*) FILTER (WHERE cs.rank = 1),
    COUNT(*)
  INTO _rank1_count, _active_count
  FROM contest_scores cs
  JOIN contest_entries ce ON ce.id = cs.entry_id
  WHERE cs.pool_id = _pool_id AND ce.status = 'active';

  IF _active_count > 0
     AND _rank1_count = _active_count
     AND _rank1_count = _pool.max_entries
     AND _pool.max_entries = 2
     AND _pool.winner_ids = ARRAY[]::uuid[]
  THEN
    _is_tie_refund := true;
  END IF;

  -- STEP 5A: tie refund branch
  IF _is_tie_refund THEN
    FOR _rec IN
      SELECT cs.id AS score_id, cs.entry_id, cs.user_id, ce.entry_fee_cents
      FROM contest_scores cs
      JOIN contest_entries ce ON ce.id = cs.entry_id
      WHERE cs.pool_id = _pool_id AND ce.status = 'active'
      ORDER BY cs.user_id ASC
    LOOP
      IF _rec.entry_fee_cents > 0 THEN
        SELECT w.id INTO _wallet_id FROM wallets w WHERE w.user_id = _rec.user_id;
        IF _wallet_id IS NULL THEN
          RAISE EXCEPTION 'Wallet not found for user % during tie refund', _rec.user_id;
        END IF;

        INSERT INTO transactions (
          user_id, wallet_id, type, amount, status, description, reference_type, reference_id
        ) VALUES (
          _rec.user_id, _wallet_id, 'refund', _rec.entry_fee_cents, 'completed',
          'H2H tie refund', 'contest_pool', _pool_id::text
        ) RETURNING id INTO _transaction_id;

        PERFORM update_wallet_balance(
          _wallet_id,
          _rec.entry_fee_cents,
          0::bigint,
          0::bigint,
          0::bigint,
          0::bigint
        );

        INSERT INTO ledger_entries (user_id, transaction_type, amount, reference_id, description)
        VALUES (_rec.user_id, 'REFUND', _rec.entry_fee_cents, _transaction_id, 'H2H tie refund');
      END IF;

      UPDATE contest_scores cs SET payout_cents = _rec.entry_fee_cents, is_winner = false
      WHERE cs.id = _rec.score_id;

      UPDATE contest_entries ce SET payout_cents = _rec.entry_fee_cents, status = 'settled'
      WHERE ce.id = _rec.entry_id;

      _total_payout_cents := _total_payout_cents + _rec.entry_fee_cents;
      _winners_count := _winners_count + 1;
    END LOOP;

  ELSE
    -- STEP 5B: standard payout branch
    IF _pool.payout_structure IS NULL OR _pool.payout_structure = '{}'::jsonb THEN
      RETURN QUERY SELECT false, 'no_payout_structure'::text, false, _pool_id, 0::bigint, 0, false;
      RETURN;
    END IF;

    FOR _rec IN
      WITH ranked_players AS (
        SELECT
          cs.id AS score_id,
          cs.entry_id,
          cs.user_id,
          cs.rank,
          ce.entry_fee_cents,
          ROW_NUMBER() OVER (PARTITION BY cs.rank ORDER BY cs.user_id ASC) AS tie_position,
          COUNT(*)    OVER (PARTITION BY cs.rank) AS tie_count
        FROM contest_scores cs
        JOIN contest_entries ce ON ce.id = cs.entry_id
        WHERE cs.pool_id = _pool_id AND ce.status = 'active'
      ),
      payout_calc AS (
        SELECT
          rp.*,
          (
            SELECT COALESCE(SUM(COALESCE((_pool.payout_structure ->> r::text)::bigint, 0)), 0)
            FROM generate_series(rp.rank, rp.rank + rp.tie_count - 1) AS r
          ) AS group_total_cents
        FROM ranked_players rp
      )
      SELECT
        pc.score_id,
        pc.entry_id,
        pc.user_id,
        pc.rank,
        pc.tie_count,
        pc.group_total_cents,
        pc.entry_fee_cents,
        (
          floor(pc.group_total_cents::numeric / pc.tie_count)::bigint
          + CASE
              WHEN pc.tie_position <=
                   (pc.group_total_cents - floor(pc.group_total_cents::numeric / pc.tie_count)::bigint * pc.tie_count)
              THEN 1 ELSE 0
            END
        ) AS payout_cents
      FROM payout_calc pc
      ORDER BY pc.rank ASC, pc.tie_position ASC
    LOOP
      IF _rec.payout_cents > 0 THEN
        SELECT w.id INTO _wallet_id FROM wallets w WHERE w.user_id = _rec.user_id;
        IF _wallet_id IS NULL THEN
          RAISE EXCEPTION 'Wallet not found for user % during payout', _rec.user_id;
        END IF;

        INSERT INTO transactions (
          user_id, wallet_id, type, amount, status, description, reference_type, reference_id
        ) VALUES (
          _rec.user_id, _wallet_id, 'payout', _rec.payout_cents, 'completed',
          'Contest pool payout', 'contest_pool', _pool_id::text
        ) RETURNING id INTO _transaction_id;

        PERFORM update_wallet_balance(
          _wallet_id,
          _rec.payout_cents,
          0::bigint,
          0::bigint,
          _rec.payout_cents,
          0::bigint
        );

        INSERT INTO ledger_entries (user_id, transaction_type, amount, reference_id, description)
        VALUES (_rec.user_id, 'PRIZE_PAYOUT', _rec.payout_cents, _transaction_id, 'Contest pool payout');

        UPDATE contest_scores cs
        SET payout_cents = _rec.payout_cents, is_winner = true
        WHERE cs.id = _rec.score_id;

        UPDATE contest_entries ce
        SET payout_cents = _rec.payout_cents, status = 'settled'
        WHERE ce.id = _rec.entry_id;

        _total_payout_cents := _total_payout_cents + _rec.payout_cents;
        _winners_count := _winners_count + 1;
      ELSE
        UPDATE contest_scores cs
        SET payout_cents = 0, is_winner = false
        WHERE cs.id = _rec.score_id;
      END IF;
    END LOOP;
  END IF;

  -- STEP 5C: verify all active entries have score rows
  IF EXISTS (
    SELECT 1
    FROM contest_entries ce
    WHERE ce.pool_id = _pool_id
      AND ce.status = 'active'
      AND NOT EXISTS (SELECT 1 FROM contest_scores cs WHERE cs.entry_id = ce.id)
  ) THEN
    RAISE EXCEPTION 'data integrity error: pool % has active entries without contest_scores rows', _pool_id;
  END IF;

  UPDATE contest_entries ce
  SET payout_cents = COALESCE(ce.payout_cents, 0), status = 'settled'
  WHERE ce.pool_id = _pool_id AND ce.status = 'active';

  -- STEP 6: sanity check
  IF NOT _is_tie_refund AND _total_payout_cents > _pool.prize_pool_cents THEN
    RAISE EXCEPTION 'Payout exceeds prize pool: % > %', _total_payout_cents, _pool.prize_pool_cents;
  END IF;

  -- STEP 7: finalize pool
  UPDATE contest_pools cp
  SET status = 'settled',
      settled_at = now(),
      winner_ids = CASE
        WHEN _is_tie_refund THEN ARRAY[]::uuid[]
        ELSE COALESCE(
          (SELECT array_agg(cs.user_id ORDER BY cs.rank ASC, cs.user_id ASC)
             FROM contest_scores cs
             WHERE cs.pool_id = _pool_id AND cs.payout_cents > 0),
          ARRAY[]::uuid[]
        )
      END
  WHERE cp.id = _pool_id;

  RETURN QUERY SELECT
    true,
    'approved'::text,
    false,
    _pool_id,
    _total_payout_cents,
    _winners_count,
    _is_tie_refund;
END;
$function$;

NOTIFY pgrst, 'reload schema';
