-- Phase 3 prerequisite: per-user entry cap on contest_templates.
-- Adds max_entries_per_user (default 1) and gates enter_contest_pool_atomic.

ALTER TABLE public.contest_templates
ADD COLUMN IF NOT EXISTS max_entries_per_user integer NOT NULL DEFAULT 1 CHECK (max_entries_per_user >= 1);

-- Phase 2b micro-fix: reorder per_competitor duplicate check before global
-- distinct-competitor check so picks [A,A] on GC templates report duplicate_competitor.
-- Phase 2a: time-vs-reference scoring + GC (per_competitor) roster mode
-- (a) enter_contest_pool_atomic: template fetch first, per_competitor pick validation
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
  _min_picks integer;
  _max_picks integer;
  _unique_competitor_count integer;
  _invalid_pick_count integer;
  _scoring_config jsonb;
  _roster_mode text;
  _max_entries_per_user integer;
  _existing_entry_count integer;
BEGIN
  -- Defense-in-depth: every legitimate call comes from the service-role edge
  -- function where auth.uid() IS NULL. Any JWT-scoped caller is rejected —
  -- this also blocks self-entry if the EXECUTE grant ever regresses.
  IF auth.uid() IS NOT NULL THEN
    RAISE EXCEPTION 'unauthorized: direct call not permitted';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('contest_entry:' || _user_id::text));

  SELECT self_exclusion_until INTO _exclusion_until
  FROM responsible_gaming
  WHERE user_id = _user_id;

  IF _exclusion_until IS NOT NULL AND _exclusion_until > now() THEN
    RETURN QUERY SELECT false, 'self_excluded'::text, NULL::uuid, NULL::uuid, NULL::integer, NULL::integer, NULL::bigint;
    RETURN;
  END IF;

  SELECT id, min_picks, max_picks, scoring_config, roster_mode, max_entries_per_user INTO _template_check, _min_picks, _max_picks, _scoring_config, _roster_mode, _max_entries_per_user
  FROM contest_templates
  WHERE id = _contest_template_id;

  IF _template_check IS NULL THEN
    RETURN QUERY SELECT false, 'template_not_found'::text, NULL::uuid, NULL::uuid, NULL::integer, NULL::integer, NULL::bigint;
    RETURN;
  END IF;

  SELECT count(*) INTO _existing_entry_count
  FROM contest_entries ce
  WHERE ce.user_id = _user_id
    AND ce.contest_template_id = _contest_template_id
    AND ce.status IN ('active','scored','settled');

  IF _existing_entry_count >= COALESCE(_max_entries_per_user, 1) THEN
    RETURN QUERY SELECT false, 'entry_limit_reached'::text, NULL::uuid, NULL::uuid, NULL::integer, NULL::integer, NULL::bigint;
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

  IF _scoring_config IS NULL OR _roster_mode = 'per_race' THEN
    IF _unique_event_count < _total_event_count THEN
      RETURN QUERY SELECT false, 'duplicate_event'::text, NULL::uuid, NULL::uuid, NULL::integer, NULL::integer, NULL::bigint;
      RETURN;
    END IF;

    IF _unique_event_count < MIN_UNIQUE_EVENTS THEN
      RETURN QUERY SELECT false, 'insufficient_events'::text, NULL::uuid, NULL::uuid, NULL::integer, NULL::integer, NULL::bigint;
      RETURN;
    END IF;
  END IF;

  IF _total_event_count < GREATEST(COALESCE(_min_picks, 2), 2) THEN
    RETURN QUERY SELECT false, 'insufficient_picks'::text, NULL::uuid, NULL::uuid, NULL::integer, NULL::integer, NULL::bigint;
    RETURN;
  END IF;

  IF _total_event_count > COALESCE(_max_picks, 4) THEN
    RETURN QUERY SELECT false, 'too_many_picks'::text, NULL::uuid, NULL::uuid, NULL::integer, NULL::integer, NULL::bigint;
    RETURN;
  END IF;

  IF _scoring_config IS NOT NULL AND _roster_mode = 'per_competitor' THEN
    -- GC / per-competitor rosters: each competitor may be picked at most once and
    -- the template must carry at least 2 stages (preserves the paid >=2-race floor).
    IF jsonb_array_length(_picks) <> (
      SELECT count(DISTINCT elem->>'crewId') FROM jsonb_array_elements(_picks) elem
    ) THEN
      RETURN QUERY SELECT false, 'duplicate_competitor'::text, NULL::uuid, NULL::uuid, NULL::integer, NULL::integer, NULL::bigint;
      RETURN;
    END IF;
  END IF;

  SELECT count(DISTINCT elem->>'crewId') INTO _unique_competitor_count
  FROM jsonb_array_elements(_picks) AS elem;

  IF _unique_competitor_count < 2 THEN
    RETURN QUERY SELECT false, 'insufficient_competitors'::text, NULL::uuid, NULL::uuid, NULL::integer, NULL::integer, NULL::bigint;
    RETURN;
  END IF;

  IF _scoring_config IS NOT NULL AND _roster_mode = 'per_competitor' THEN
    IF (SELECT count(*) FROM contest_races WHERE template_id = _contest_template_id) < 2 THEN
      RETURN QUERY SELECT false, 'insufficient_events'::text, NULL::uuid, NULL::uuid, NULL::integer, NULL::integer, NULL::bigint;
      RETURN;
    END IF;
  ELSIF _scoring_config IS NOT NULL AND _roster_mode <> 'per_race' THEN
    RETURN QUERY SELECT false, 'roster_mode_unsupported'::text, NULL::uuid, NULL::uuid, NULL::integer, NULL::integer, NULL::bigint;
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

    -- Validate picks against the SOURCE pool before cloning: clone_contest_pool
    -- copies crews verbatim, so this is equivalent to validating the clone and
    -- avoids leaving an empty cloned pool behind on rejection.
    IF _scoring_config IS NULL THEN
      SELECT count(*) INTO _invalid_pick_count
      FROM jsonb_array_elements(_picks) AS elem
      WHERE NOT EXISTS (
        SELECT 1 FROM contest_pool_crews cpc
        WHERE cpc.contest_pool_id = _pool_for_clone
          AND cpc.crew_id = elem->>'crewId'
          AND cpc.event_id = elem->>'event_id'
      );
    ELSIF _roster_mode = 'per_competitor' THEN
      SELECT count(*) INTO _invalid_pick_count
      FROM jsonb_array_elements(_picks) AS elem
      WHERE NOT EXISTS (
        SELECT 1 FROM contest_competitors c
        WHERE c.template_id = _contest_template_id
          AND c.competitor_key = elem->>'crewId'
          AND NOT EXISTS (
            SELECT 1 FROM contest_races r
            WHERE r.template_id = _contest_template_id
              AND NOT EXISTS (
                SELECT 1 FROM contest_race_entries re
                WHERE re.race_id = r.id AND re.competitor_id = c.id)));
    ELSE
      SELECT count(*) INTO _invalid_pick_count
      FROM jsonb_array_elements(_picks) AS elem
      WHERE NOT EXISTS (
        SELECT 1 FROM contest_race_entries re
        JOIN contest_races r ON r.id = re.race_id
        JOIN contest_competitors c ON c.id = re.competitor_id
        WHERE r.template_id = _contest_template_id
          AND c.template_id = _contest_template_id
          AND r.race_key = elem->>'event_id'
          AND c.competitor_key = elem->>'crewId'
      );
    END IF;

    IF _invalid_pick_count > 0 THEN
      RETURN QUERY SELECT false, 'invalid_pick'::text, NULL::uuid, NULL::uuid, NULL::integer, NULL::integer, NULL::bigint;
      RETURN;
    END IF;

    _new_pool_id := clone_contest_pool(_pool_for_clone);

    SELECT cp.id, cp.entry_fee_cents INTO _target_pool_id, _pool_fee_cents
    FROM contest_pools cp
    WHERE cp.id = _new_pool_id
    FOR UPDATE;
  END IF;

  -- Every pick must exist in the target pool's crew list (legacy) or in the
  -- template's race entries (new engine). Runs BEFORE any wallet debit /
  -- transaction / ledger insert so a rejected entry moves no money.
  IF _scoring_config IS NULL THEN
    SELECT count(*) INTO _invalid_pick_count
    FROM jsonb_array_elements(_picks) AS elem
    WHERE NOT EXISTS (
      SELECT 1 FROM contest_pool_crews cpc
      WHERE cpc.contest_pool_id = _target_pool_id
        AND cpc.crew_id = elem->>'crewId'
        AND cpc.event_id = elem->>'event_id'
    );
  ELSIF _roster_mode = 'per_competitor' THEN
    SELECT count(*) INTO _invalid_pick_count
    FROM jsonb_array_elements(_picks) AS elem
    WHERE NOT EXISTS (
      SELECT 1 FROM contest_competitors c
      WHERE c.template_id = _contest_template_id
        AND c.competitor_key = elem->>'crewId'
        AND NOT EXISTS (
          SELECT 1 FROM contest_races r
          WHERE r.template_id = _contest_template_id
            AND NOT EXISTS (
              SELECT 1 FROM contest_race_entries re
              WHERE re.race_id = r.id AND re.competitor_id = c.id)));
  ELSE
    SELECT count(*) INTO _invalid_pick_count
    FROM jsonb_array_elements(_picks) AS elem
    WHERE NOT EXISTS (
      SELECT 1 FROM contest_race_entries re
      JOIN contest_races r ON r.id = re.race_id
      JOIN contest_competitors c ON c.id = re.competitor_id
      WHERE r.template_id = _contest_template_id
        AND c.template_id = _contest_template_id
        AND r.race_key = elem->>'event_id'
        AND c.competitor_key = elem->>'crewId'
    );
  END IF;

  IF _invalid_pick_count > 0 THEN
    RETURN QUERY SELECT false, 'invalid_pick'::text, NULL::uuid, NULL::uuid, NULL::integer, NULL::integer, NULL::bigint;
    RETURN;
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

NOTIFY pgrst, 'reload schema';