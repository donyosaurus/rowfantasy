CREATE OR REPLACE FUNCTION public.enter_contest_pool_atomic(
  _user_id uuid,
  _wallet_id uuid,
  _contest_template_id uuid,
  _tier_name text,
  _picks jsonb,
  _state_code text
)
RETURNS TABLE (
  allowed boolean,
  reason text,
  entry_id uuid,
  pool_id uuid,
  current_entries integer,
  max_entries integer,
  available_balance_cents bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
  -- STEP 1: Serialize concurrent entry attempts per user
  PERFORM pg_advisory_xact_lock(hashtext('contest_entry:' || _user_id::text));

  -- STEP 2: Self-exclusion check
  SELECT self_exclusion_until INTO _exclusion_until
  FROM responsible_gaming
  WHERE user_id = _user_id;

  IF _exclusion_until IS NOT NULL AND _exclusion_until > now() THEN
    RETURN QUERY SELECT false, 'self_excluded'::text, NULL::uuid, NULL::uuid, NULL::integer, NULL::integer, NULL::bigint;
    RETURN;
  END IF;

  -- STEP 3: Validate picks structure
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

  -- STEP 4: Validate template exists
  SELECT id INTO _template_check
  FROM contest_templates
  WHERE id = _contest_template_id;

  IF _template_check IS NULL THEN
    RETURN QUERY SELECT false, 'template_not_found'::text, NULL::uuid, NULL::uuid, NULL::integer, NULL::integer, NULL::bigint;
    RETURN;
  END IF;

  -- STEP 5: Lock and read the wallet
  SELECT id, available_balance INTO _wallet_id_check, _available_balance
  FROM wallets
  WHERE id = _wallet_id AND user_id = _user_id
  FOR UPDATE;

  IF _wallet_id_check IS NULL THEN
    RETURN QUERY SELECT false, 'wallet_not_found'::text, NULL::uuid, NULL::uuid, NULL::integer, NULL::integer, NULL::bigint;
    RETURN;
  END IF;

  -- STEP 6: Pool selection
  -- 6a: Find candidate pools (locked FOR UPDATE), preferring fuller then older
  FOR _candidate IN
    SELECT id, current_entries, max_entries, lock_time, allow_overflow, entry_fee_cents, created_at
    FROM contest_pools
    WHERE contest_template_id = _contest_template_id
      AND status = 'open'
      AND (_tier_name IS NULL OR tier_name = _tier_name)
    ORDER BY current_entries DESC, created_at ASC
    FOR UPDATE
  LOOP
    _matching_pool_exists := true;

    IF _candidate.allow_overflow AND _candidate.lock_time > now() THEN
      _has_overflow_candidate := true;
      _pool_for_clone := _candidate.id;
    END IF;

    -- Skip if locked by time
    IF _candidate.lock_time <= now() THEN
      CONTINUE;
    END IF;

    -- Skip if full
    IF _candidate.current_entries >= _candidate.max_entries THEN
      CONTINUE;
    END IF;

    -- H2H: skip if user already entered
    IF _candidate.max_entries = H2H_MAX_ENTRIES THEN
      IF EXISTS (
        SELECT 1 FROM contest_entries
        WHERE pool_id = _candidate.id AND user_id = _user_id
        LIMIT 1
      ) THEN
        CONTINUE;
      END IF;
    END IF;

    -- Found a usable candidate
    _target_pool_id := _candidate.id;
    _pool_fee_cents := _candidate.entry_fee_cents;
    EXIT;
  END LOOP;

  -- 6b: No usable candidate
  IF _target_pool_id IS NULL THEN
    IF NOT _matching_pool_exists THEN
      RETURN QUERY SELECT false, 'no_pool_for_tier'::text, NULL::uuid, NULL::uuid, NULL::integer, NULL::integer, NULL::bigint;
      RETURN;
    END IF;

    IF NOT _has_overflow_candidate THEN
      RETURN QUERY SELECT false, 'all_pools_full'::text, NULL::uuid, NULL::uuid, NULL::integer, NULL::integer, NULL::bigint;
      RETURN;
    END IF;

    -- Pick the most recently created overflow-eligible pool to clone from
    SELECT id INTO _pool_for_clone
    FROM contest_pools
    WHERE contest_template_id = _contest_template_id
      AND (_tier_name IS NULL OR tier_name = _tier_name)
      AND allow_overflow = true
      AND lock_time > now()
    ORDER BY created_at DESC
    LIMIT 1;

    IF _pool_for_clone IS NULL THEN
      RETURN QUERY SELECT false, 'all_pools_full'::text, NULL::uuid, NULL::uuid, NULL::integer, NULL::integer, NULL::bigint;
      RETURN;
    END IF;

    _new_pool_id := clone_contest_pool(_pool_for_clone);

    -- Lock the new pool row
    SELECT id, entry_fee_cents INTO _target_pool_id, _pool_fee_cents
    FROM contest_pools
    WHERE id = _new_pool_id
    FOR UPDATE;
  END IF;

  -- STEP 7: Validate fee and balance
  IF _pool_fee_cents IS NULL THEN
    RETURN QUERY SELECT false, 'invalid_pool_fee'::text, NULL::uuid, NULL::uuid, NULL::integer, NULL::integer, NULL::bigint;
    RETURN;
  END IF;

  IF _available_balance < _pool_fee_cents THEN
    RETURN QUERY SELECT false, 'insufficient_balance'::text, NULL::uuid, NULL::uuid, NULL::integer, NULL::integer, _available_balance;
    RETURN;
  END IF;

  -- STEP 8: Debit wallet via existing RPC
  SELECT * INTO _wallet_result
  FROM update_wallet_balance(
    _wallet_id := _wallet_id,
    _available_delta := -_pool_fee_cents,
    _pending_delta := 0
  );

  _available_balance := _wallet_result.available_balance;

  -- STEP 9: Insert transaction
  INSERT INTO transactions (user_id, wallet_id, type, amount, status, description)
  VALUES (
    _user_id,
    _wallet_id,
    'entry_fee',
    -_pool_fee_cents,
    'completed',
    'Contest entry fee for ' || COALESCE(_tier_name, 'untiered') || ' tier'
  )
  RETURNING id INTO _transaction_id;

  -- STEP 10: Insert ledger entry
  -- reference_id = pool_id to match existing convention across all ENTRY_FEE/REFUND rows
  INSERT INTO ledger_entries (user_id, transaction_type, amount, reference_id, description)
  VALUES (
    _user_id,
    'ENTRY_FEE',
    -_pool_fee_cents,
    _target_pool_id,
    'Contest entry fee debit'
  );

  -- STEP 11: Insert contest entry (entry_fee_cents from authoritative pool value)
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

  -- STEP 12: Atomic capacity-check increment
  UPDATE contest_pools
  SET current_entries = current_entries + 1
  WHERE id = _target_pool_id AND current_entries < max_entries
  RETURNING current_entries, max_entries INTO _post_increment_entries, _pool_max;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'pool_capacity_violated';
  END IF;

  -- STEP 13: Success
  RETURN QUERY SELECT
    true,
    'approved'::text,
    _entry_id,
    _target_pool_id,
    _post_increment_entries,
    _pool_max,
    _available_balance;
END;
$$;