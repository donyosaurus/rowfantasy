-- Phase 1b (a): enter_contest_pool_atomic — new-path pick validation branch
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

  SELECT id, min_picks, max_picks, scoring_config, roster_mode INTO _template_check, _min_picks, _max_picks, _scoring_config, _roster_mode
  FROM contest_templates
  WHERE id = _contest_template_id;

  IF _template_check IS NULL THEN
    RETURN QUERY SELECT false, 'template_not_found'::text, NULL::uuid, NULL::uuid, NULL::integer, NULL::integer, NULL::bigint;
    RETURN;
  END IF;

  IF _total_event_count < GREATEST(COALESCE(_min_picks, 2), 2) THEN
    RETURN QUERY SELECT false, 'insufficient_picks'::text, NULL::uuid, NULL::uuid, NULL::integer, NULL::integer, NULL::bigint;
    RETURN;
  END IF;

  IF _total_event_count > COALESCE(_max_picks, 4) THEN
    RETURN QUERY SELECT false, 'too_many_picks'::text, NULL::uuid, NULL::uuid, NULL::integer, NULL::integer, NULL::bigint;
    RETURN;
  END IF;

  SELECT count(DISTINCT elem->>'crewId') INTO _unique_competitor_count
  FROM jsonb_array_elements(_picks) AS elem;

  IF _unique_competitor_count < 2 THEN
    RETURN QUERY SELECT false, 'insufficient_competitors'::text, NULL::uuid, NULL::uuid, NULL::integer, NULL::integer, NULL::bigint;
    RETURN;
  END IF;

  IF _scoring_config IS NOT NULL AND _roster_mode <> 'per_race' THEN
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

-- Phase 1b (b): admin_update_race_results_v2 — verbatim time passthrough + result bounds
CREATE OR REPLACE FUNCTION public.admin_update_race_results_v2(p_template_id uuid, p_results jsonb, _admin_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_result jsonb;
  v_race_key text;
  v_competitor_key text;
  v_place integer;
  v_time_ms bigint;
  v_finish_time text;
  v_status text;
  v_race_id uuid;
  v_competitor_id uuid;
  v_pool_count integer;
  v_active_pools integer;
  v_frozen_pools integer;
  v_legacy boolean;
  v_upserted integer := 0;
  v_flipped integer := 0;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM user_roles ur
    JOIN auth.users u ON u.id = ur.user_id
    WHERE ur.user_id = _admin_user_id AND ur.role = 'admin'
  ) THEN
    RAISE EXCEPTION 'unauthorized: caller is not an admin';
  END IF;

  SELECT count(*) INTO v_pool_count FROM contest_pools WHERE contest_template_id = p_template_id;
  IF v_pool_count = 0 THEN
    RAISE EXCEPTION 'admin_update_race_results_v2: template % has no pools', p_template_id;
  END IF;

  SELECT count(*) INTO v_active_pools FROM (
    SELECT id FROM contest_pools
    WHERE contest_template_id = p_template_id
      AND status NOT IN ('settling','settled','voided','cancelled')
    FOR UPDATE
  ) locked;

  IF v_active_pools = 0 THEN
    RAISE EXCEPTION 'admin_update_race_results_v2: all pools of template % are frozen', p_template_id;
  END IF;

  v_frozen_pools := v_pool_count - v_active_pools;

  SELECT scoring_config IS NULL INTO v_legacy FROM contest_templates WHERE id = p_template_id;
  IF v_legacy IS NULL THEN
    RAISE EXCEPTION 'admin_update_race_results_v2: template % not found', p_template_id;
  END IF;

  FOR v_result IN SELECT * FROM jsonb_array_elements(p_results)
  LOOP
    v_race_key := v_result->>'race_key';
    v_competitor_key := v_result->>'competitor_key';
    v_place := CASE WHEN v_result->>'place' IS NULL THEN NULL ELSE (v_result->>'place')::int END;
    v_finish_time := v_result->>'finish_time';
    v_time_ms := CASE
      WHEN v_result->>'time_ms' IS NOT NULL THEN (v_result->>'time_ms')::bigint
      WHEN v_finish_time IS NOT NULL THEN public.parse_race_time_ms(v_finish_time)
      ELSE NULL END;
    v_status := COALESCE(
      v_result->>'status',
      CASE WHEN v_place IS NOT NULL OR v_time_ms IS NOT NULL THEN 'OK' ELSE 'PENDING' END
    );

    IF v_status = 'OK' AND v_place IS NULL THEN
      RAISE EXCEPTION 'OK results require a place';
    END IF;

    IF v_place IS NOT NULL AND (v_place < 1 OR v_place > 10000) THEN
      RAISE EXCEPTION 'place out of range: %', v_place;
    END IF;

    IF v_time_ms IS NOT NULL AND (v_time_ms < 0 OR v_time_ms > 1000000000) THEN
      RAISE EXCEPTION 'time_ms out of range: %', v_time_ms;
    END IF;

    IF v_legacy AND v_place IS NULL THEN
      RAISE EXCEPTION 'legacy templates require a finish place for every result, including DNS/DNF/DSQ';
    END IF;

    SELECT r.id, c.id INTO v_race_id, v_competitor_id
    FROM public.contest_races r
    JOIN public.contest_competitors c ON c.template_id = r.template_id
    WHERE r.template_id = p_template_id
      AND r.race_key = v_race_key
      AND c.competitor_key = v_competitor_key;

    IF v_race_id IS NULL OR v_competitor_id IS NULL
       OR NOT EXISTS (SELECT 1 FROM public.contest_race_entries re WHERE re.race_id = v_race_id AND re.competitor_id = v_competitor_id) THEN
      RAISE EXCEPTION 'race_key % / competitor_key % is not a race entry of template %', v_race_key, v_competitor_key, p_template_id;
    END IF;

    INSERT INTO public.contest_race_results (race_id, competitor_id, place, time_ms, status)
    VALUES (v_race_id, v_competitor_id, v_place, v_time_ms, v_status)
    ON CONFLICT (race_id, competitor_id) DO UPDATE
      SET place = EXCLUDED.place,
          time_ms = EXCLUDED.time_ms,
          status = EXCLUDED.status,
          updated_at = now();

    v_upserted := v_upserted + 1;

    UPDATE public.contest_pool_crews cpc
    SET manual_finish_order = v_place,
        manual_result_time = CASE
          WHEN v_finish_time IS NULL THEN CASE WHEN v_time_ms IS NULL THEN NULL ELSE public.format_race_time_ms(v_time_ms) END
          WHEN v_finish_time ~ '^\d+:\d+(\.\d+)?$' THEN v_finish_time
          ELSE COALESCE(public.format_race_time_ms(public.parse_race_time_ms(v_finish_time)), v_finish_time)
        END
    FROM public.contest_pools cp
    WHERE cp.id = cpc.contest_pool_id
      AND cp.contest_template_id = p_template_id
      AND cp.status NOT IN ('settling','settled','voided','cancelled')
      AND cpc.crew_id = v_competitor_key
      AND cpc.event_id = v_race_key;
  END LOOP;

  UPDATE public.contest_pools
  SET status = 'results_entered'
  WHERE contest_template_id = p_template_id
    AND status IN ('open','locked','scoring_completed');
  GET DIAGNOSTICS v_flipped = ROW_COUNT;

  RETURN jsonb_build_object(
    'success', true,
    'results_upserted', v_upserted,
    'pools_flipped', v_flipped,
    'pools_frozen_skipped', v_frozen_pools
  );
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.admin_update_race_results_v2(uuid, jsonb, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_update_race_results_v2(uuid, jsonb, uuid) TO service_role;

NOTIFY pgrst, 'reload schema';