-- =====================================================================
-- Phase 3a fix batch 3
-- FIX 1 (critical): submit_survivor_round_picks must lock pool -> entry -> round
-- FIX 2 (medium): hoist the survivor dual-signal mismatch test in
--                 admin_create_contest_v2 above the generic checks
-- FIX 3 (low): verification only, no change (live def already uses 'warning')
-- =====================================================================

-- ---------------------------------------------------------------------
-- FIX 1
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.submit_survivor_round_picks(_user_id uuid, _entry_id uuid, _round_no integer, _picks jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _exclusion_until timestamptz;
  _pool record;
  _entry record;
  _template_id uuid;
  _primitive text;
  _min_picks integer;
  _max_picks integer;
  _round record;
  _pick_count integer;
  _bad integer;
  _distinct_events integer;
  _distinct_crews integer;
BEGIN
  -- Service-role only: the edge function passes the verified user id.
  IF auth.uid() IS NOT NULL THEN
    RAISE EXCEPTION 'unauthorized: direct call not permitted';
  END IF;

  SELECT self_exclusion_until INTO _exclusion_until
  FROM responsible_gaming
  WHERE user_id = _user_id;

  IF _exclusion_until IS NOT NULL AND _exclusion_until > now() THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'self_excluded');
  END IF;

  -- Pick-shape gate FIRST so no jsonb function can throw on malformed input.
  IF _picks IS NULL OR jsonb_typeof(_picks) <> 'array' OR jsonb_array_length(_picks) = 0 THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'invalid_pick');
  END IF;

  -- FIX 1 (batch 3): the previous combined SELECT used FOR UPDATE OF ce, which
  -- locked ONLY the entry row; score_survivor_round_atomic locks all pools of
  -- the template first, then the round, then updates entries. That produced a
  -- cycle (submit holds ENTRY waits ROUND / score holds ROUND waits ENTRY).
  -- Take the POOL lock first so both functions share the prefix
  -- pool -> entry -> round and can never deadlock.
  SELECT cp.id, cp.status
  INTO _pool
  FROM contest_pools cp
  JOIN contest_entries ce ON ce.pool_id = cp.id
  WHERE ce.id = _entry_id AND ce.user_id = _user_id
  FOR UPDATE OF cp;

  IF _pool.id IS NULL THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'entry_not_found');
  END IF;

  SELECT ce.id, ce.status, ce.contest_template_id
  INTO _entry
  FROM contest_entries ce
  WHERE ce.id = _entry_id AND ce.user_id = _user_id
  FOR UPDATE OF ce;

  IF _entry.id IS NULL THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'entry_not_found');
  END IF;

  IF _entry.status <> 'active' OR _pool.status NOT IN ('open','locked') THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'entry_not_active');
  END IF;

  _template_id := _entry.contest_template_id;

  SELECT scoring_config->>'primitive', min_picks, max_picks
  INTO _primitive, _min_picks, _max_picks
  FROM contest_templates
  WHERE id = _template_id;

  IF _primitive IS DISTINCT FROM 'survivor' THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'not_survivor');
  END IF;

  IF _round_no IS NULL OR _round_no < 2 THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'round_one_fixed');
  END IF;

  -- FIX 1(a): lock the round row (lock order: pools -> entry -> round; the
  -- pool and entry are already locked above) and evaluate status/lock_at on the
  -- post-lock values so a concurrent lock/score cannot be raced.
  SELECT * INTO _round
  FROM contest_rounds
  WHERE template_id = _template_id AND round_no = _round_no
  FOR UPDATE;

  IF _round.id IS NULL THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'round_not_found');
  END IF;

  IF _round.status <> 'scheduled' OR _round.lock_at <= now() THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'round_locked');
  END IF;

  -- Alive: advanced in every already-scored round.
  IF EXISTS (
    SELECT 1 FROM contest_rounds r0
    WHERE r0.template_id = _template_id
      AND r0.status = 'scored'
      AND NOT EXISTS (
        SELECT 1 FROM contest_entry_rounds er0
        WHERE er0.entry_id = _entry_id
          AND er0.round_no = r0.round_no
          AND er0.advanced = true)
  ) THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'eliminated');
  END IF;

  SELECT count(*) INTO _bad
  FROM jsonb_array_elements(_picks) e
  WHERE jsonb_typeof(e) <> 'object'
     OR COALESCE(btrim(e->>'crewId'), '') = ''
     OR COALESCE(btrim(e->>'event_id'), '') = '';

  IF _bad > 0 THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'invalid_pick');
  END IF;

  _pick_count := jsonb_array_length(_picks);

  IF _pick_count < GREATEST(COALESCE(_min_picks, 2), 2) THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'insufficient_picks');
  END IF;

  IF _pick_count > COALESCE(_max_picks, 4) THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'too_many_picks');
  END IF;

  SELECT count(DISTINCT e->>'event_id'), count(DISTINCT e->>'crewId')
  INTO _distinct_events, _distinct_crews
  FROM jsonb_array_elements(_picks) e;

  IF _distinct_events < _pick_count THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'duplicate_event');
  END IF;

  IF _distinct_events < 2 THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'insufficient_events');
  END IF;

  IF _distinct_crews < 2 THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'insufficient_competitors');
  END IF;

  SELECT count(*) INTO _bad
  FROM jsonb_array_elements(_picks) e
  WHERE NOT EXISTS (
    SELECT 1
    FROM contest_race_entries re
    JOIN contest_races r ON r.id = re.race_id
    JOIN contest_competitors c ON c.id = re.competitor_id
    WHERE r.template_id = _template_id
      AND c.template_id = _template_id
      AND r.round_no = _round_no
      AND r.race_key = e->>'event_id'
      AND c.competitor_key = e->>'crewId'
  );

  IF _bad > 0 THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'invalid_pick');
  END IF;

  INSERT INTO contest_entry_rounds (entry_id, template_id, round_no, picks)
  VALUES (_entry_id, _template_id, _round_no, _picks)
  ON CONFLICT (entry_id, round_no) DO UPDATE
    SET picks = EXCLUDED.picks,
        updated_at = now();

  RETURN jsonb_build_object('allowed', true, 'reason', 'approved', 'round_no', _round_no);
END;
$function$;

REVOKE ALL ON FUNCTION public.submit_survivor_round_picks(uuid, uuid, integer, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.submit_survivor_round_picks(uuid, uuid, integer, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.submit_survivor_round_picks(uuid, uuid, integer, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.submit_survivor_round_picks(uuid, uuid, integer, jsonb) TO service_role;

-- ---------------------------------------------------------------------
-- FIX 2
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_create_contest_v2(p_name text, p_sport text, p_gender_category text, p_lock_time timestamp with time zone, p_races jsonb, p_competitors jsonb, p_race_entries jsonb, p_entry_fee_cents bigint, p_max_entries integer, p_payout_structure jsonb DEFAULT NULL::jsonb, p_entry_tiers jsonb DEFAULT NULL::jsonb, p_allow_overflow boolean DEFAULT false, p_void_unfilled_on_settle boolean DEFAULT false, p_card_banner_url text DEFAULT NULL::text, p_draft_banner_url text DEFAULT NULL::text, p_contest_group_id uuid DEFAULT NULL::uuid, p_primitive text DEFAULT 'placement'::text, p_roster_mode text DEFAULT 'per_race'::text, p_scoring_config jsonb DEFAULT NULL::jsonb, p_min_picks integer DEFAULT 2, p_max_picks integer DEFAULT 4, _admin_user_id uuid DEFAULT NULL::uuid, p_rounds jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_template_id uuid;
  v_pool_id uuid;
  v_first_pool_id uuid;
  v_pools_created integer := 0;
  v_total_payout bigint := 0;
  v_tier jsonb;
  v_tier_id text;
  v_tier_fee bigint;
  v_tier_payout jsonb;
  v_tier_name text;
  v_tier_total bigint;
  v_race_count integer;
  v_competitor_count integer;
  v_entry_count integer;
  v_bad integer;
  v_multi_race integer;
  v_has_paid boolean;
  v_crews_added integer := 0;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM user_roles ur
    JOIN auth.users u ON u.id = ur.user_id
    WHERE ur.user_id = _admin_user_id AND ur.role = 'admin'
  ) THEN
    RAISE EXCEPTION 'unauthorized: caller is not an admin';
  END IF;

  IF p_name IS NULL OR btrim(p_name) = '' THEN
    RAISE EXCEPTION 'name is required';
  END IF;

  v_race_count := COALESCE(jsonb_array_length(p_races), 0);
  v_competitor_count := COALESCE(jsonb_array_length(p_competitors), 0);
  v_entry_count := COALESCE(jsonb_array_length(p_race_entries), 0);

  IF v_race_count < 1 THEN RAISE EXCEPTION 'at least 1 race is required'; END IF;
  IF v_competitor_count < 2 THEN RAISE EXCEPTION 'at least 2 competitors are required'; END IF;
  IF v_entry_count < 1 THEN RAISE EXCEPTION 'at least 1 race entry is required'; END IF;

  SELECT count(*) INTO v_bad
  FROM jsonb_array_elements(p_race_entries) e
  WHERE NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_races) r WHERE r->>'race_key' = e->>'race_key'
  ) OR NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_competitors) c WHERE c->>'competitor_key' = e->>'competitor_key'
  );
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'race_entries reference unknown race_key or competitor_key (% bad rows)', v_bad;
  END IF;

  SELECT count(*) INTO v_bad
  FROM jsonb_array_elements(p_races) r
  WHERE NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_race_entries) e WHERE e->>'race_key' = r->>'race_key'
  );
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'every race must have at least 1 entry (% empty races)', v_bad;
  END IF;

  -- FIX 2 (batch 3): the dual-signal mismatch test is hoisted here, ahead of
  -- the generic min/max-picks checks and all tier JSON processing, so a call
  -- whose two survivor signals disagree always reports the mismatch instead of
  -- a generic or jsonb error. Fires only when at least one signal is survivor,
  -- so the non-survivor path is byte-identical to before.
  IF COALESCE(p_primitive, 'placement') = 'survivor'
     OR p_scoring_config->>'primitive' = 'survivor' THEN
    IF COALESCE(p_primitive, 'placement') <> 'survivor'
       OR p_scoring_config->>'primitive' IS DISTINCT FROM 'survivor' THEN
      RAISE EXCEPTION 'scoring_config primitive mismatch';
    END IF;
  END IF;

  -- FIX 3 (batch 1): survivor fixed-pick-count check precedes the generic
  -- min/max checks so p_min_picks NULL/1 or p_max_picks < p_min_picks reports
  -- the survivor message. Non-survivor calls fall through unchanged.
  IF COALESCE(p_primitive, 'placement') = 'survivor'
     AND (p_min_picks IS NULL OR p_max_picks IS NULL OR p_min_picks <> p_max_picks OR p_min_picks < 2) THEN
    RAISE EXCEPTION 'survivor requires a fixed pick count';
  END IF;

  IF p_min_picks IS NULL OR p_min_picks < 2 THEN RAISE EXCEPTION 'p_min_picks must be >= 2'; END IF;
  IF p_max_picks IS NULL OR p_max_picks < p_min_picks THEN RAISE EXCEPTION 'p_max_picks must be >= p_min_picks'; END IF;
  IF COALESCE(p_roster_mode, 'per_race') = 'per_competitor' THEN
    IF p_max_picks > v_competitor_count THEN RAISE EXCEPTION 'p_max_picks exceeds competitor count'; END IF;
  ELSE
    IF p_min_picks > v_race_count THEN RAISE EXCEPTION 'p_min_picks (%) exceeds race count (%)', p_min_picks, v_race_count; END IF;
  END IF;
  IF p_entry_fee_cents IS NULL OR p_entry_fee_cents < 0 THEN RAISE EXCEPTION 'p_entry_fee_cents must be >= 0'; END IF;

  -- FIX 4 (batch 1): survivor tier rejection precedes any generic tier JSON
  -- processing so a scalar/object p_entry_tiers reports the survivor message
  -- instead of a jsonb type error. Non-survivor ordering is unchanged.
  IF COALESCE(p_primitive, 'placement') = 'survivor' AND p_entry_tiers IS NOT NULL THEN
    RAISE EXCEPTION 'survivor does not support entry tiers';
  END IF;

  IF p_entry_tiers IS NOT NULL AND jsonb_array_length(p_entry_tiers) > 0 THEN
    SELECT count(*) INTO v_bad
    FROM jsonb_array_elements(p_entry_tiers) t
    WHERE t->>'entry_fee_cents' IS NULL OR (t->>'entry_fee_cents')::bigint < 0;
    IF v_bad > 0 THEN RAISE EXCEPTION 'every tier requires entry_fee_cents >= 0'; END IF;
  END IF;

  v_has_paid := p_entry_fee_cents > 0;
  IF NOT v_has_paid AND p_entry_tiers IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_entry_tiers) t WHERE (t->>'entry_fee_cents')::bigint > 0
    ) INTO v_has_paid;
  END IF;
  IF v_has_paid AND v_race_count < 2 THEN
    RAISE EXCEPTION 'paid contests require at least 2 races';
  END IF;

  SELECT count(*) INTO v_multi_race FROM (
    SELECT e->>'competitor_key' AS ck
    FROM jsonb_array_elements(p_race_entries) e
    GROUP BY 1 HAVING count(DISTINCT e->>'race_key') > 1
  ) z;
  IF v_multi_race > 0 AND p_scoring_config IS NULL THEN
    RAISE EXCEPTION 'multi-race competitors require scoring_config (new engine path)';
  END IF;


  -- ===== survivor validation (all checks precede every INSERT) =====
  -- FIX 2: the gate keys on BOTH p_primitive and scoring_config->>'primitive'
  -- so a call that claims one but not the other can never skip validation.
  -- (batch 3: the mismatch test itself now runs earlier, above.)
  IF COALESCE(p_primitive, 'placement') = 'survivor'
     OR p_scoring_config->>'primitive' = 'survivor' THEN

    IF COALESCE(p_roster_mode, 'per_race') <> 'per_race' THEN
      RAISE EXCEPTION 'survivor requires per_race roster';
    END IF;

    -- FIX 3: prize_pool_cents is fixed at create time and settle only checks
    -- total_payout <= prize_pool_cents, so an underfilled survivor pool would
    -- pay advertised prizes out of house funds. Force the void-on-settle path.
    IF COALESCE(p_void_unfilled_on_settle, false) IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'survivor contests require void_unfilled_on_settle';
    END IF;

    -- FIX 6: an empty or all-zero points_table scores everyone 0, so the
    -- advance threshold is 0, nobody is ever eliminated and the pot splits.
    IF p_scoring_config->'points_table' IS NULL
       OR jsonb_typeof(p_scoring_config->'points_table') <> 'object'
       OR NOT EXISTS (
         SELECT 1 FROM jsonb_each_text(p_scoring_config->'points_table') kv
         WHERE kv.key = '1' AND kv.value ~ '^[0-9]+$' AND kv.value::numeric > 0)
    THEN
      RAISE EXCEPTION 'survivor requires a points_table with a positive value for place 1';
    END IF;

    IF p_rounds IS NULL OR jsonb_typeof(p_rounds) <> 'array' OR jsonb_array_length(p_rounds) < 2 THEN
      RAISE EXCEPTION 'invalid rounds';
    END IF;

    IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_rounds) e WHERE jsonb_typeof(e) <> 'object') THEN
      RAISE EXCEPTION 'invalid rounds';
    END IF;

    -- Shape first (no casts), so malformed input can never raise a cast error.
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_rounds) e
      WHERE jsonb_typeof(e->'round_no') <> 'number'
         OR jsonb_typeof(e->'advance_count') <> 'number'
         OR jsonb_typeof(e->'lock_at') <> 'string'
         OR (e->>'round_no') !~ '^[0-9]+$'
         OR (e->>'advance_count') !~ '^[0-9]+$'
    ) THEN
      RAISE EXCEPTION 'invalid rounds';
    END IF;

    -- FIX 2 (batch 1): bound the magnitude while the values are still known to
    -- be digit-only, so every later ::int cast is safe (numeric casts of
    -- digit-only strings cannot overflow). Kept as its own block rather than
    -- another OR arm above because SQL does not guarantee OR short-circuiting,
    -- so a cast beside the regex guard could still raise on non-numeric input.
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_rounds) e
      WHERE (e->>'round_no')::numeric NOT BETWEEN 1 AND 2147483647
         OR (e->>'advance_count')::numeric NOT BETWEEN 1 AND 2147483647
    ) THEN
      RAISE EXCEPTION 'invalid rounds';
    END IF;

    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_rounds) e
      WHERE (e->>'round_no')::int < 1 OR (e->>'advance_count')::int < 1
    ) THEN
      RAISE EXCEPTION 'invalid rounds';
    END IF;

    -- FIX 8(c): narrowed from WHEN others, which swallowed unrelated errors
    -- (e.g. statement_timeout) and reported them as 'invalid rounds'.
    BEGIN
      PERFORM (e->>'lock_at')::timestamptz FROM jsonb_array_elements(p_rounds) e;
    EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
      RAISE EXCEPTION 'invalid rounds';
    END;

    IF (SELECT count(DISTINCT (e->>'round_no')::int) FROM jsonb_array_elements(p_rounds) e) <> jsonb_array_length(p_rounds)
       OR (SELECT min((e->>'round_no')::int) FROM jsonb_array_elements(p_rounds) e) <> 1
       OR (SELECT max((e->>'round_no')::int) FROM jsonb_array_elements(p_rounds) e) <> jsonb_array_length(p_rounds)
    THEN
      RAISE EXCEPTION 'invalid rounds';
    END IF;

    IF EXISTS (
      SELECT 1 FROM (
        SELECT (e->>'lock_at')::timestamptz AS la,
               lag((e->>'lock_at')::timestamptz) OVER (ORDER BY (e->>'round_no')::int) AS prev
        FROM jsonb_array_elements(p_rounds) e
      ) z
      WHERE z.prev IS NOT NULL AND z.la <= z.prev
    ) THEN
      RAISE EXCEPTION 'invalid rounds';
    END IF;

    -- FIX 5: the ladder must actually narrow to a single survivor, otherwise
    -- an H2H pool can have both entries advance every round and tie-refund.
    -- Placed after the shape/bounds checks so malformed input still reports
    -- 'invalid rounds'.
    IF (SELECT (e->>'advance_count')::int FROM jsonb_array_elements(p_rounds) e
        WHERE (e->>'round_no')::int = jsonb_array_length(p_rounds)) <> 1 THEN
      RAISE EXCEPTION 'the final survivor round must advance exactly 1';
    END IF;

    IF EXISTS (
      SELECT 1 FROM (
        SELECT (e->>'advance_count')::int AS ac,
               lag((e->>'advance_count')::int) OVER (ORDER BY (e->>'round_no')::int) AS prev
        FROM jsonb_array_elements(p_rounds) e
      ) z WHERE z.prev IS NOT NULL AND z.ac >= z.prev
    ) THEN
      RAISE EXCEPTION 'survivor advance_count must strictly decrease';
    END IF;

    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_races) r
      WHERE jsonb_typeof(r->'round_no') <> 'number'
         OR (r->>'round_no') !~ '^[0-9]+$'
    ) THEN
      RAISE EXCEPTION 'every survivor race needs a round_no';
    END IF;

    -- FIX 2 (batch 1, races): bound the magnitude before the first ::int cast.
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_races) r
      WHERE (r->>'round_no')::numeric NOT BETWEEN 1 AND 2147483647
    ) THEN
      RAISE EXCEPTION 'every survivor race needs a round_no';
    END IF;

    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_races) r
      WHERE NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(p_rounds) e
        WHERE (e->>'round_no')::int = (r->>'round_no')::int)
    ) THEN
      RAISE EXCEPTION 'every survivor race needs a round_no';
    END IF;

    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_rounds) e
      WHERE (
        SELECT count(*) FROM jsonb_array_elements(p_races) r
        WHERE (r->>'round_no')::int = (e->>'round_no')::int
      ) < p_min_picks
    ) THEN
      RAISE EXCEPTION 'each survivor round needs at least min_picks races';
    END IF;

    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_rounds) e
      WHERE (
        SELECT count(DISTINCT en->>'competitor_key')
        FROM jsonb_array_elements(p_race_entries) en
        WHERE EXISTS (
          SELECT 1 FROM jsonb_array_elements(p_races) r
          WHERE r->>'race_key' = en->>'race_key'
            AND (r->>'round_no')::int = (e->>'round_no')::int)
      ) < 2
    ) THEN
      RAISE EXCEPTION 'each survivor round needs at least 2 distinct competitors';
    END IF;

    IF p_lock_time IS DISTINCT FROM (
      SELECT (e->>'lock_at')::timestamptz FROM jsonb_array_elements(p_rounds) e
      WHERE (e->>'round_no')::int = 1
    ) THEN
      RAISE EXCEPTION 'survivor lock_time must equal round 1 lock_at';
    END IF;
  ELSIF p_rounds IS NOT NULL THEN
    RAISE EXCEPTION 'rounds are only supported for survivor contests';
  END IF;

  INSERT INTO public.contest_templates (
    regatta_name, name, sport, primitive, roster_mode, scoring_config,
    gender_category, lock_time, status, crews, divisions, entry_tiers,
    min_picks, max_picks, card_banner_url, draft_banner_url, contest_group_id
  ) VALUES (
    p_name, p_name, COALESCE(p_sport, 'rowing'), COALESCE(p_primitive, 'placement'),
    COALESCE(p_roster_mode, 'per_race'), p_scoring_config,
    p_gender_category, p_lock_time, 'open', '[]'::jsonb, '[]'::jsonb,
    COALESCE(p_entry_tiers, '[]'::jsonb), p_min_picks, p_max_picks,
    p_card_banner_url, p_draft_banner_url, p_contest_group_id
  )
  RETURNING id INTO v_template_id;

  INSERT INTO public.contest_races (template_id, race_key, name, race_order, event_class, division, round, distance, scheduled_at)
  SELECT v_template_id,
         r->>'race_key',
         COALESCE(r->>'name', r->>'race_key'),
         COALESCE((r->>'race_order')::int, (ord - 1)::int),
         r->>'event_class', r->>'division', r->>'round', r->>'distance',
         CASE WHEN r->>'scheduled_at' IS NULL THEN NULL ELSE (r->>'scheduled_at')::timestamptz END
  FROM jsonb_array_elements(p_races) WITH ORDINALITY AS a(r, ord);

  -- FIX 2: the rounds / round_no insert block uses the same widened gate.
  IF COALESCE(p_primitive, 'placement') = 'survivor'
     OR p_scoring_config->>'primitive' = 'survivor' THEN
    INSERT INTO public.contest_rounds (template_id, round_no, lock_at, advance_count)
    SELECT v_template_id,
           (e->>'round_no')::int,
           (e->>'lock_at')::timestamptz,
           (e->>'advance_count')::int
    FROM jsonb_array_elements(p_rounds) e;

    UPDATE public.contest_races cr
    SET round_no = (r->>'round_no')::int
    FROM jsonb_array_elements(p_races) r
    WHERE cr.template_id = v_template_id AND cr.race_key = r->>'race_key';
  END IF;

  INSERT INTO public.contest_competitors (template_id, competitor_key, name, logo_url, competitor_type)
  SELECT v_template_id,
         c->>'competitor_key',
         COALESCE(c->>'name', c->>'competitor_key'),
         c->>'logo_url',
         COALESCE(c->>'competitor_type', 'crew')
  FROM jsonb_array_elements(p_competitors) c;

  INSERT INTO public.contest_race_entries (race_id, competitor_id, seed_time_ms)
  SELECT rr.id, cc.id, CASE WHEN e->>'seed_time_ms' IS NULL THEN NULL ELSE (e->>'seed_time_ms')::bigint END
  FROM jsonb_array_elements(p_race_entries) e
  JOIN public.contest_races rr ON rr.template_id = v_template_id AND rr.race_key = e->>'race_key'
  JOIN public.contest_competitors cc ON cc.template_id = v_template_id AND cc.competitor_key = e->>'competitor_key'
  ON CONFLICT DO NOTHING;

  IF p_entry_tiers IS NOT NULL AND jsonb_array_length(p_entry_tiers) > 0 THEN
    FOR v_tier IN SELECT * FROM jsonb_array_elements(p_entry_tiers)
    LOOP
      v_tier_name := v_tier->>'name';
      v_tier_fee := (v_tier->>'entry_fee_cents')::bigint;
      v_tier_payout := v_tier->'payout_structure';
      v_tier_id := 'tier_' || v_tier_fee::text;

      SELECT COALESCE(SUM((value)::bigint), 0) INTO v_tier_total
      FROM jsonb_each_text(v_tier_payout);

      INSERT INTO public.contest_pools (
        contest_template_id, tier_id, tier_name, entry_fee_cents, prize_pool_cents, max_entries, lock_time, status, payout_structure, allow_overflow, entry_tiers, void_unfilled_on_settle
      ) VALUES (
        v_template_id, v_tier_id, v_tier_name, v_tier_fee, v_tier_total, p_max_entries, p_lock_time, 'open', v_tier_payout, p_allow_overflow, NULL, p_void_unfilled_on_settle
      )
      RETURNING id INTO v_pool_id;

      IF v_first_pool_id IS NULL THEN v_first_pool_id := v_pool_id; END IF;
      v_pools_created := v_pools_created + 1;

      IF v_multi_race = 0 THEN
        INSERT INTO public.contest_pool_crews (contest_pool_id, crew_id, crew_name, event_id, logo_url)
        SELECT v_pool_id, cc.competitor_key, cc.name, rr.race_key, cc.logo_url
        FROM public.contest_race_entries re
        JOIN public.contest_races rr ON rr.id = re.race_id
        JOIN public.contest_competitors cc ON cc.id = re.competitor_id
        WHERE rr.template_id = v_template_id;
        GET DIAGNOSTICS v_crews_added = ROW_COUNT;
      END IF;
    END LOOP;
  ELSE
    IF p_payout_structure IS NOT NULL THEN
      SELECT COALESCE(SUM((value)::bigint), 0) INTO v_total_payout
      FROM jsonb_each_text(p_payout_structure);
    END IF;

    v_tier_id := 'tier_' || p_entry_fee_cents::text;

    INSERT INTO public.contest_pools (
      contest_template_id, tier_id, entry_fee_cents, prize_pool_cents, max_entries, lock_time, status, payout_structure, allow_overflow, entry_tiers, void_unfilled_on_settle
    ) VALUES (
      v_template_id, v_tier_id, p_entry_fee_cents, v_total_payout, p_max_entries, p_lock_time, 'open', p_payout_structure, p_allow_overflow, NULL, p_void_unfilled_on_settle
    )
    RETURNING id INTO v_pool_id;

    v_first_pool_id := v_pool_id;
    v_pools_created := 1;

    IF v_multi_race = 0 THEN
      INSERT INTO public.contest_pool_crews (contest_pool_id, crew_id, crew_name, event_id, logo_url)
      SELECT v_pool_id, cc.competitor_key, cc.name, rr.race_key, cc.logo_url
      FROM public.contest_race_entries re
      JOIN public.contest_races rr ON rr.id = re.race_id
      JOIN public.contest_competitors cc ON cc.id = re.competitor_id
      WHERE rr.template_id = v_template_id;
      GET DIAGNOSTICS v_crews_added = ROW_COUNT;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'contest_template_id', v_template_id,
    'contest_pool_id', v_first_pool_id,
    'crews_added', v_crews_added,
    'pools_created', v_pools_created,
    'total_payout_cents', v_total_payout,
    'races_created', v_race_count,
    'competitors_created', v_competitor_count,
    'entries_created', v_entry_count
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.admin_create_contest_v2(text, text, text, timestamptz, jsonb, jsonb, jsonb, bigint, integer, jsonb, jsonb, boolean, boolean, text, text, uuid, text, text, jsonb, integer, integer, uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_create_contest_v2(text, text, text, timestamptz, jsonb, jsonb, jsonb, bigint, integer, jsonb, jsonb, boolean, boolean, text, text, uuid, text, text, jsonb, integer, integer, uuid, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.admin_create_contest_v2(text, text, text, timestamptz, jsonb, jsonb, jsonb, bigint, integer, jsonb, jsonb, boolean, boolean, text, text, uuid, text, text, jsonb, integer, integer, uuid, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.admin_create_contest_v2(text, text, text, timestamptz, jsonb, jsonb, jsonb, bigint, integer, jsonb, jsonb, boolean, boolean, text, text, uuid, text, text, jsonb, integer, integer, uuid, jsonb) TO service_role;

NOTIFY pgrst, 'reload schema';