-- Drop old settlement function
DROP FUNCTION IF EXISTS public.settle_pool_payouts(uuid);
DROP FUNCTION IF EXISTS public.settle_pool_payouts(uuid, uuid);
DROP FUNCTION IF EXISTS public.settle_pool_payouts CASCADE;

-- New atomic settlement function
CREATE OR REPLACE FUNCTION public.settle_contest_pool_atomic(
  _pool_id uuid,
  _admin_user_id uuid
)
RETURNS TABLE (
  allowed boolean,
  reason text,
  was_already_settled boolean,
  pool_id uuid,
  total_payout_cents bigint,
  winners_count integer,
  is_tie_refund boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _pool contest_pools%ROWTYPE;
  _is_tie_refund boolean := false;
  _total_payout_cents bigint := 0;
  _winners_count integer := 0;
  _transaction_id uuid;
  _wallet_id uuid;
  _rank1_count integer;
  _active_count integer;
  _rec record;
BEGIN
  -- STEP 1: Lock pool row to serialize concurrent settlement attempts
  SELECT * INTO _pool FROM contest_pools WHERE id = _pool_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'pool_not_found'::text, false, NULL::uuid, 0::bigint, 0, false;
    RETURN;
  END IF;

  -- STEP 2: Idempotency — already settled means we're done
  IF _pool.status = 'settled' THEN
    RETURN QUERY SELECT true, 'approved'::text, true, _pool_id, 0::bigint, 0, false;
    RETURN;
  END IF;

  -- STEP 3: Status precondition — pool must be scored
  IF _pool.status <> 'scoring_completed' THEN
    RETURN QUERY SELECT false, 'wrong_pool_status'::text, false, _pool_id, 0::bigint, 0, false;
    RETURN;
  END IF;

  -- STEP 4: Determine settlement mode (H2H tie-refund detection)
  -- An H2H tie-refund pool has every active entry tied at rank=1 and the
  -- count of rank=1 entries equals max_entries (e.g., 2-of-2 tied in H2H).
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
     AND (_pool.winner_ids IS NULL OR _pool.winner_ids = ARRAY[]::uuid[])
  THEN
    _is_tie_refund := true;
  END IF;

  -- STEP 5A: H2H tie-refund branch — refund each player their entry fee
  IF _is_tie_refund THEN
    FOR _rec IN
      SELECT cs.id AS score_id, cs.entry_id, cs.user_id, ce.entry_fee_cents
      FROM contest_scores cs
      JOIN contest_entries ce ON ce.id = cs.entry_id
      WHERE cs.pool_id = _pool_id AND ce.status = 'active'
      ORDER BY cs.user_id ASC
    LOOP
      -- Resolve wallet
      SELECT id INTO _wallet_id FROM wallets WHERE user_id = _rec.user_id;
      IF _wallet_id IS NULL THEN
        RAISE EXCEPTION 'Wallet not found for user % during tie refund', _rec.user_id;
      END IF;

      -- a. Insert transaction (positive amount; direction in type)
      INSERT INTO transactions (
        user_id, wallet_id, type, amount, status, description, reference_type, reference_id
      ) VALUES (
        _rec.user_id, _wallet_id, 'refund', _rec.entry_fee_cents, 'completed',
        'H2H tie refund', 'contest_pool', _pool_id::text
      ) RETURNING id INTO _transaction_id;

      -- b. Credit wallet (refund is NOT lifetime winnings)
      PERFORM update_wallet_balance(
        _wallet_id,
        _rec.entry_fee_cents,  -- _available_delta
        0,                      -- _pending_delta
        0                       -- _lifetime_deposits_delta (no winnings delta on refund)
      );

      -- c. Ledger entry (signed amount; refund credits user => positive)
      INSERT INTO ledger_entries (
        user_id, transaction_type, amount, reference_id, description
      ) VALUES (
        _rec.user_id, 'REFUND', _rec.entry_fee_cents, _transaction_id, 'H2H tie refund'
      );

      -- d. Mark score row payout
      UPDATE contest_scores SET payout_cents = _rec.entry_fee_cents, is_winner = false
      WHERE id = _rec.score_id;

      -- e. Mark entry settled
      UPDATE contest_entries SET payout_cents = _rec.entry_fee_cents, status = 'settled'
      WHERE id = _rec.entry_id;

      -- f. Accumulate
      _total_payout_cents := _total_payout_cents + _rec.entry_fee_cents;
      _winners_count := _winners_count + 1;
    END LOOP;

  ELSE
    -- STEP 5B: Standard payout branch
    IF _pool.payout_structure IS NULL OR _pool.payout_structure = '{}'::jsonb THEN
      RETURN QUERY SELECT false, 'no_payout_structure'::text, false, _pool_id, 0::bigint, 0, false;
      RETURN;
    END IF;

    -- Compute per-player payouts using sum-and-split rule for tied ranks.
    -- For a tie group at rank R with N tied players:
    --   sum   = sum of payout_structure[R..R+N-1] (missing slots count as 0)
    --   base  = floor(sum / N)
    --   extra = sum - base*N  (remainder cents)
    --   First `extra` players (ORDER BY user_id) get base+1; others get base.
    FOR _rec IN
      WITH ranked_players AS (
        SELECT
          cs.id AS score_id,
          cs.entry_id,
          cs.user_id,
          cs.rank,
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
        -- Resolve wallet
        SELECT id INTO _wallet_id FROM wallets WHERE user_id = _rec.user_id;
        IF _wallet_id IS NULL THEN
          RAISE EXCEPTION 'Wallet not found for user % during payout', _rec.user_id;
        END IF;

        -- a. Insert transaction (positive amount)
        INSERT INTO transactions (
          user_id, wallet_id, type, amount, status, description, reference_type, reference_id
        ) VALUES (
          _rec.user_id, _wallet_id, 'payout', _rec.payout_cents, 'completed',
          'Contest pool payout', 'contest_pool', _pool_id::text
        ) RETURNING id INTO _transaction_id;

        -- b. Credit wallet AND increment lifetime winnings
        -- update_wallet_balance signature: (_wallet_id, _available_delta, _pending_delta, _lifetime_deposits_delta, _lifetime_withdrawals_delta, _lifetime_winnings_delta)
        -- Use positional args for available + winnings.
        PERFORM update_wallet_balance(
          _wallet_id,
          _rec.payout_cents,  -- _available_delta
          0,                   -- _pending_delta
          0,                   -- _lifetime_deposits_delta
          0,                   -- _lifetime_withdrawals_delta
          _rec.payout_cents   -- _lifetime_winnings_delta
        );

        -- c. Ledger entry
        INSERT INTO ledger_entries (
          user_id, transaction_type, amount, reference_id, description
        ) VALUES (
          _rec.user_id, 'PRIZE_PAYOUT', _rec.payout_cents, _transaction_id, 'Contest pool payout'
        );

        -- d. Mark score row
        UPDATE contest_scores
        SET payout_cents = _rec.payout_cents, is_winner = true
        WHERE id = _rec.score_id;

        -- e. Mark entry settled
        UPDATE contest_entries
        SET payout_cents = _rec.payout_cents, status = 'settled'
        WHERE id = _rec.entry_id;

        -- f. Accumulate
        _total_payout_cents := _total_payout_cents + _rec.payout_cents;
        _winners_count := _winners_count + 1;
      ELSE
        -- Zero-payout score row: still record the zero and we'll settle entry below.
        UPDATE contest_scores
        SET payout_cents = 0, is_winner = false
        WHERE id = _rec.score_id;
      END IF;
    END LOOP;

    -- STEP 5C: Mark any remaining 'active' entries (non-winners) as settled
    UPDATE contest_entries
    SET payout_cents = COALESCE(payout_cents, 0), status = 'settled'
    WHERE pool_id = _pool_id AND status = 'active';
  END IF;

  -- STEP 6: Sanity check — total paid must not exceed prize pool
  -- (Skip for tie refunds, which return entry fees, not prize pool funds.)
  IF NOT _is_tie_refund AND _total_payout_cents > _pool.prize_pool_cents THEN
    RAISE EXCEPTION 'Payout exceeds prize pool: % > %', _total_payout_cents, _pool.prize_pool_cents;
  END IF;

  -- STEP 7: Finalize pool
  UPDATE contest_pools
  SET status = 'settled',
      settled_at = now(),
      winner_ids = COALESCE(
        (SELECT array_agg(user_id) FROM contest_scores WHERE pool_id = _pool_id AND payout_cents > 0),
        ARRAY[]::uuid[]
      )
  WHERE id = _pool_id;

  -- STEP 8: Success
  RETURN QUERY SELECT
    true,
    'approved'::text,
    false,
    _pool_id,
    _total_payout_cents,
    _winners_count,
    _is_tie_refund;
END;
$$;