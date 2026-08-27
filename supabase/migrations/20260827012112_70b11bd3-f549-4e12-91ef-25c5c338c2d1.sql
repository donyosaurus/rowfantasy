-- Phase 3a fix batch 2: second adversarial-review round on the survivor backend.
-- Eight fixes; each function is a CREATE OR REPLACE of its exact current body
-- with only the described change.

-- ---------- FIX 8(a): defense-in-depth grants on the survivor round tables ----------
REVOKE INSERT, UPDATE, DELETE ON public.contest_rounds, public.contest_entry_rounds FROM anon, authenticated;


-- ---------- FIXES 2, 3, 5, 6, 8(c): admin_create_contest_v2 (23 params, signature unchanged) ----------
CREATE OR REPLACE FUNCTION public.admin_create_contest_v2(
  p_name text,
  p_sport text,
  p_gender_category text,
  p_lock_time timestamptz,
  p_races jsonb,
  p_competitors jsonb,
  p_race_entries jsonb,
  p_entry_fee_cents bigint,
  p_max_entries integer,
  p_payout_structure jsonb DEFAULT NULL,
  p_entry_tiers jsonb DEFAULT NULL,
  p_allow_overflow boolean DEFAULT false,
  p_void_unfilled_on_settle boolean DEFAULT false,
  p_card_banner_url text DEFAULT NULL,
  p_draft_banner_url text DEFAULT NULL,
  p_contest_group_id uuid DEFAULT NULL,
  p_primitive text DEFAULT 'placement',
  p_roster_mode text DEFAULT 'per_race',
  p_scoring_config jsonb DEFAULT NULL,
  p_min_picks integer DEFAULT 2,
  p_max_picks integer DEFAULT 4,
  _admin_user_id uuid DEFAULT NULL,
  p_rounds jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
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
  IF COALESCE(p_primitive, 'placement') = 'survivor'
     OR p_scoring_config->>'primitive' = 'survivor' THEN

    -- FIX 2: reject any disagreement between the two survivor signals first.
    IF COALESCE(p_primitive, 'placement') <> 'survivor'
       OR p_scoring_config->>'primitive' IS DISTINCT FROM 'survivor' THEN
      RAISE EXCEPTION 'scoring_config primitive mismatch';
    END IF;

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
$fn$;

REVOKE EXECUTE ON FUNCTION public.admin_create_contest_v2(text, text, text, timestamptz, jsonb, jsonb, jsonb, bigint, integer, jsonb, jsonb, boolean, boolean, text, text, uuid, text, text, jsonb, integer, integer, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_create_contest_v2(text, text, text, timestamptz, jsonb, jsonb, jsonb, bigint, integer, jsonb, jsonb, boolean, boolean, text, text, uuid, text, text, jsonb, integer, integer, uuid, jsonb) TO service_role;


-- ---------- FIXES 1, 4, 7: score_survivor_round_atomic ----------
CREATE OR REPLACE FUNCTION public.score_survivor_round_atomic(
  p_template_id uuid,
  _admin_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_scoring_config jsonb;
  v_locked_pools integer;
  v_target integer;
  v_target_id uuid;
  v_advance_count integer;
  v_max_round integer;
  v_sched record;
  v_unscored_before integer;
  v_race_count integer;
  v_incomplete integer;
  v_unmatched integer;
  v_pool record;
  v_scored_count integer;
  v_threshold numeric;
  v_advancers integer;
  v_alive_count integer;
  v_pool_active integer;
  v_rank1_count integer;
  v_winner_ids uuid[];
  v_is_tie_refund boolean;
  v_finalize boolean;
  v_flip integer;
  v_pools_scored integer := 0;
  v_pools_finalized integer := 0;
  v_alive_by_pool jsonb := '{}'::jsonb;
  v_late boolean := false;
  v_late_rounds integer[];
  v_rows integer;
  v_lock_id uuid;
BEGIN
  -- 1. Admin gate
  IF NOT EXISTS (
    SELECT 1 FROM user_roles ur
    JOIN auth.users u ON u.id = ur.user_id
    WHERE ur.user_id = _admin_user_id AND ur.role = 'admin'
  ) THEN
    RAISE EXCEPTION 'unauthorized: caller is not an admin';
  END IF;

  -- 2. Template must be survivor
  SELECT scoring_config INTO v_scoring_config
  FROM contest_templates WHERE id = p_template_id;

  IF v_scoring_config IS NULL OR v_scoring_config->>'primitive' IS DISTINCT FROM 'survivor' THEN
    RAISE EXCEPTION 'not a survivor template';
  END IF;

  -- 3. Lock every pool of the template; bail out if none is live.
  SELECT count(*) FILTER (WHERE p.status = 'locked') INTO v_locked_pools
  FROM (
    SELECT cp.status FROM contest_pools cp
    WHERE cp.contest_template_id = p_template_id
    FOR UPDATE
  ) p;

  -- FIX 4: the target-round step already self-heals a stuck round lock, so do
  -- the same for pools instead of noop-ing forever when the auto-lock cron is
  -- inert or delayed. Runs under the FOR UPDATE lock taken just above.
  UPDATE contest_pools SET status = 'locked'
  WHERE contest_template_id = p_template_id AND status = 'open' AND lock_time <= now();

  -- FIX 4: a pool still open at scoring time would be skipped silently while
  -- the round flips to 'scored', wiping out every entry in it. Be loud.
  IF EXISTS (SELECT 1 FROM contest_pools
             WHERE contest_template_id = p_template_id AND status = 'open') THEN
    RAISE EXCEPTION 'template % has pools still open at scoring time', p_template_id;
  END IF;

  -- FIX 4: re-read the pool set after the self-heal UPDATE so the 'locked'
  -- loop below sees the newly locked pools.
  SELECT count(*) FILTER (WHERE cp.status = 'locked') INTO v_locked_pools
  FROM contest_pools cp
  WHERE cp.contest_template_id = p_template_id;

  IF v_locked_pools = 0 THEN
    RETURN jsonb_build_object('noop', true, 'reason', 'no_active_pools');
  END IF;

  -- 4. Target round
  SELECT cr.id, cr.round_no, cr.advance_count
  INTO v_target_id, v_target, v_advance_count
  FROM contest_rounds cr
  WHERE cr.template_id = p_template_id AND cr.status = 'locked'
  ORDER BY cr.round_no
  LIMIT 1;

  IF v_target IS NULL THEN
    SELECT cr.id, cr.round_no, cr.advance_count, cr.lock_at
    INTO v_sched
    FROM contest_rounds cr
    WHERE cr.template_id = p_template_id AND cr.status = 'scheduled'
    ORDER BY cr.round_no
    LIMIT 1;

    IF v_sched.id IS NULL OR v_sched.lock_at > now() THEN
      RAISE EXCEPTION 'no round is ready to score';
    END IF;

    UPDATE contest_rounds SET status = 'locked'
    WHERE id = v_sched.id AND status = 'scheduled';
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows = 0 THEN
      RAISE EXCEPTION 'no round is ready to score';
    END IF;

    v_target_id := v_sched.id;
    v_target := v_sched.round_no;
    v_advance_count := v_sched.advance_count;
  END IF;

  -- FIX 1(b) (batch 1): re-take the target round under a row lock (lock order:
  -- pools -> round; pools are already locked in step 3) and re-verify it is
  -- still 'locked' BEFORE validating results or writing anything. The
  -- lower-round completeness check below now also runs under this lock.
  SELECT cr.id, cr.advance_count
  INTO v_lock_id, v_advance_count
  FROM contest_rounds cr
  WHERE cr.id = v_target_id AND cr.status = 'locked'
  FOR UPDATE;

  IF v_lock_id IS NULL THEN
    RAISE EXCEPTION 'concurrent scoring run';
  END IF;

  SELECT count(*) INTO v_unscored_before
  FROM contest_rounds cr
  WHERE cr.template_id = p_template_id AND cr.round_no < v_target AND cr.status <> 'scored';

  IF v_unscored_before > 0 THEN
    RAISE EXCEPTION 'rounds must be scored in order';
  END IF;

  SELECT max(cr.round_no) INTO v_max_round
  FROM contest_rounds cr WHERE cr.template_id = p_template_id;

  -- 5. Results completeness for the target round
  SELECT count(*) INTO v_race_count
  FROM contest_races r
  WHERE r.template_id = p_template_id AND r.round_no = v_target;

  IF v_race_count = 0 THEN
    RAISE EXCEPTION 'round % has no races', v_target;
  END IF;

  SELECT count(*) INTO v_incomplete
  FROM contest_race_entries re
  JOIN contest_races r ON r.id = re.race_id
  LEFT JOIN contest_race_results rr
    ON rr.race_id = re.race_id AND rr.competitor_id = re.competitor_id
  WHERE r.template_id = p_template_id
    AND r.round_no = v_target
    AND (rr.race_id IS NULL OR rr.status = 'PENDING' OR (rr.status = 'OK' AND rr.place IS NULL));

  IF v_incomplete > 0 THEN
    RAISE EXCEPTION 'results incomplete for round %', v_target;
  END IF;

  -- 7. Per locked pool
  FOR v_pool IN
    SELECT cp.id, cp.max_entries
    FROM contest_pools cp
    WHERE cp.contest_template_id = p_template_id AND cp.status = 'locked'
    ORDER BY cp.created_at
  LOOP
    -- 6. Fail-closed: every submitted pick must resolve to a round race entry.
    SELECT count(*) INTO v_unmatched
    FROM contest_entries ce
    JOIN contest_entry_rounds er ON er.entry_id = ce.id AND er.round_no = v_target
    CROSS JOIN LATERAL jsonb_array_elements(er.picks) AS elem
    WHERE ce.pool_id = v_pool.id
      AND ce.status = 'active'
      AND NOT EXISTS (
        SELECT 1 FROM contest_rounds r0
        WHERE r0.template_id = p_template_id AND r0.status = 'scored'
          AND NOT EXISTS (
            SELECT 1 FROM contest_entry_rounds er0
            WHERE er0.entry_id = ce.id AND er0.round_no = r0.round_no AND er0.advanced = true))
      AND NOT EXISTS (
        SELECT 1
        FROM contest_race_entries re
        JOIN contest_races r ON r.id = re.race_id
        JOIN contest_competitors c ON c.id = re.competitor_id
        WHERE r.template_id = p_template_id
          AND c.template_id = p_template_id
          AND r.round_no = v_target
          AND r.race_key = elem->>'event_id'
          AND c.competitor_key = elem->>'crewId');

    IF v_unmatched > 0 THEN
      RAISE EXCEPTION 'survivor scoring: % unmatched pick(s) in round % of pool %', v_unmatched, v_target, v_pool.id;
    END IF;

    -- Points for the scored set (alive entries that submitted this round).
    UPDATE contest_entry_rounds er
    SET points = sub.pts, updated_at = now()
    FROM (
      SELECT ce.id AS entry_id,
        COALESCE((
          SELECT SUM(CASE WHEN rr.status = 'OK'
                          THEN COALESCE((v_scoring_config->'points_table'->>(rr.place::text))::numeric, 0)
                          ELSE 0 END)
          FROM jsonb_array_elements(er2.picks) elem
          JOIN contest_races r ON r.template_id = p_template_id AND r.round_no = v_target
                              AND r.race_key = elem->>'event_id'
          JOIN contest_competitors c ON c.template_id = p_template_id
                              AND c.competitor_key = elem->>'crewId'
          JOIN contest_race_entries re ON re.race_id = r.id AND re.competitor_id = c.id
          JOIN contest_race_results rr ON rr.race_id = r.id AND rr.competitor_id = c.id
        ), 0) AS pts
      FROM contest_entries ce
      JOIN contest_entry_rounds er2 ON er2.entry_id = ce.id AND er2.round_no = v_target
      WHERE ce.pool_id = v_pool.id
        AND ce.status = 'active'
        AND NOT EXISTS (
          SELECT 1 FROM contest_rounds r0
          WHERE r0.template_id = p_template_id AND r0.status = 'scored'
            AND NOT EXISTS (
              SELECT 1 FROM contest_entry_rounds er0
              WHERE er0.entry_id = ce.id AND er0.round_no = r0.round_no AND er0.advanced = true))
    ) sub
    WHERE er.entry_id = sub.entry_id AND er.round_no = v_target;

    SELECT count(*) INTO v_scored_count
    FROM contest_entries ce
    JOIN contest_entry_rounds er ON er.entry_id = ce.id AND er.round_no = v_target
    WHERE ce.pool_id = v_pool.id
      AND ce.status = 'active'
      AND NOT EXISTS (
        SELECT 1 FROM contest_rounds r0
        WHERE r0.template_id = p_template_id AND r0.status = 'scored'
          AND NOT EXISTS (
            SELECT 1 FROM contest_entry_rounds er0
            WHERE er0.entry_id = ce.id AND er0.round_no = r0.round_no AND er0.advanced = true));

    v_threshold := NULL;
    IF v_scored_count > 0 THEN
      SELECT er.points INTO v_threshold
      FROM contest_entries ce
      JOIN contest_entry_rounds er ON er.entry_id = ce.id AND er.round_no = v_target
      WHERE ce.pool_id = v_pool.id
        AND ce.status = 'active'
        AND NOT EXISTS (
          SELECT 1 FROM contest_rounds r0
          WHERE r0.template_id = p_template_id AND r0.status = 'scored'
            AND NOT EXISTS (
              SELECT 1 FROM contest_entry_rounds er0
              WHERE er0.entry_id = ce.id AND er0.round_no = r0.round_no AND er0.advanced = true))
      ORDER BY er.points DESC
      OFFSET LEAST(v_advance_count, v_scored_count) - 1
      LIMIT 1;

      UPDATE contest_entry_rounds er
      SET round_rank = z.rnk,
          advanced = (er.points >= v_threshold),
          updated_at = now()
      FROM (
        SELECT er2.entry_id, RANK() OVER (ORDER BY er2.points DESC) AS rnk
        FROM contest_entries ce
        JOIN contest_entry_rounds er2 ON er2.entry_id = ce.id AND er2.round_no = v_target
        WHERE ce.pool_id = v_pool.id
          AND ce.status = 'active'
          AND NOT EXISTS (
            SELECT 1 FROM contest_rounds r0
            WHERE r0.template_id = p_template_id AND r0.status = 'scored'
              AND NOT EXISTS (
                SELECT 1 FROM contest_entry_rounds er0
                WHERE er0.entry_id = ce.id AND er0.round_no = r0.round_no AND er0.advanced = true))
      ) z
      WHERE er.entry_id = z.entry_id AND er.round_no = v_target;
    END IF;

    -- Alive entries that submitted nothing: eliminated by missed picks.
    INSERT INTO contest_entry_rounds (entry_id, template_id, round_no, picks, points, round_rank, advanced)
    SELECT ce.id, p_template_id, v_target, '[]'::jsonb, NULL, NULL, false
    FROM contest_entries ce
    WHERE ce.pool_id = v_pool.id
      AND ce.status = 'active'
      AND NOT EXISTS (
        SELECT 1 FROM contest_rounds r0
        WHERE r0.template_id = p_template_id AND r0.status = 'scored'
          AND NOT EXISTS (
            SELECT 1 FROM contest_entry_rounds er0
            WHERE er0.entry_id = ce.id AND er0.round_no = r0.round_no AND er0.advanced = true))
      AND NOT EXISTS (
        SELECT 1 FROM contest_entry_rounds er2
        WHERE er2.entry_id = ce.id AND er2.round_no = v_target);

    SELECT count(*) INTO v_advancers
    FROM contest_entries ce
    JOIN contest_entry_rounds er ON er.entry_id = ce.id AND er.round_no = v_target
    WHERE ce.pool_id = v_pool.id AND ce.status = 'active' AND er.advanced = true;

    v_alive_count := v_advancers;
    v_pools_scored := v_pools_scored + 1;
    v_alive_by_pool := v_alive_by_pool || jsonb_build_object(v_pool.id::text, v_alive_count);

    v_finalize := (v_advancers <= 1) OR (v_target = v_max_round);

    IF v_finalize THEN
      SELECT count(*) INTO v_pool_active
      FROM contest_entries ce WHERE ce.pool_id = v_pool.id AND ce.status = 'active';

      SELECT count(*) FILTER (WHERE f.rnk = 1), array_agg(f.user_id) FILTER (WHERE f.rnk = 1)
      INTO v_rank1_count, v_winner_ids
      FROM (
        SELECT ce.user_id,
               RANK() OVER (ORDER BY COALESCE(
                 (SELECT min(er.round_no) FROM contest_entry_rounds er
                  WHERE er.entry_id = ce.id AND er.advanced = false), 2147483647) DESC) AS rnk
        FROM contest_entries ce
        WHERE ce.pool_id = v_pool.id AND ce.status = 'active'
      ) f;

      v_is_tie_refund := (COALESCE(v_pool.max_entries, 0) = 2 AND v_pool_active = 2 AND COALESCE(v_rank1_count, 0) = 2);

      IF v_is_tie_refund THEN
        v_winner_ids := '{}'::uuid[];
      END IF;

      -- FIX 7: bound the aggregates to rounds up to and including the target so
      -- pre-submitted future-round rows cannot pollute crew_scores/total_points.
      INSERT INTO contest_scores (
        entry_id, pool_id, user_id, total_points, margin_bonus, rank,
        is_tiebreak_resolved, is_winner, crew_scores, score_value, tiebreak_value
      )
      SELECT f.entry_id, v_pool.id, f.user_id, f.total_points, 0, f.rnk,
             false,
             (f.rnk = 1 AND NOT v_is_tie_refund),
             f.crew_scores, NULL, NULL
      FROM (
        SELECT ce.id AS entry_id, ce.user_id,
               COALESCE((SELECT SUM(COALESCE(er.points, 0)) FROM contest_entry_rounds er WHERE er.entry_id = ce.id AND er.round_no <= v_target), 0)::integer AS total_points,
               COALESCE((SELECT jsonb_agg(jsonb_build_object(
                            'round_no', er.round_no,
                            'points', er.points,
                            'round_rank', er.round_rank,
                            'advanced', er.advanced) ORDER BY er.round_no)
                         FROM contest_entry_rounds er WHERE er.entry_id = ce.id AND er.round_no <= v_target), '[]'::jsonb) AS crew_scores,
               RANK() OVER (ORDER BY COALESCE(
                 (SELECT min(er.round_no) FROM contest_entry_rounds er
                  WHERE er.entry_id = ce.id AND er.advanced = false), 2147483647) DESC) AS rnk
        FROM contest_entries ce
        WHERE ce.pool_id = v_pool.id AND ce.status = 'active'
      ) f
      ON CONFLICT (entry_id) DO UPDATE
        SET pool_id = EXCLUDED.pool_id,
            user_id = EXCLUDED.user_id,
            total_points = EXCLUDED.total_points,
            margin_bonus = EXCLUDED.margin_bonus,
            rank = EXCLUDED.rank,
            is_tiebreak_resolved = EXCLUDED.is_tiebreak_resolved,
            is_winner = EXCLUDED.is_winner,
            crew_scores = EXCLUDED.crew_scores,
            score_value = EXCLUDED.score_value,
            tiebreak_value = EXCLUDED.tiebreak_value,
            updated_at = now();

      UPDATE contest_entries ce
      SET total_points = f.total_points,
          rank = f.rnk,
          margin_error = NULL,
          updated_at = now()
      FROM (
        SELECT ce2.id AS entry_id,
               COALESCE((SELECT SUM(COALESCE(er.points, 0)) FROM contest_entry_rounds er WHERE er.entry_id = ce2.id AND er.round_no <= v_target), 0)::integer AS total_points,
               RANK() OVER (ORDER BY COALESCE(
                 (SELECT min(er.round_no) FROM contest_entry_rounds er
                  WHERE er.entry_id = ce2.id AND er.advanced = false), 2147483647) DESC) AS rnk
        FROM contest_entries ce2
        WHERE ce2.pool_id = v_pool.id AND ce2.status = 'active'
      ) f
      WHERE ce.id = f.entry_id;

      UPDATE contest_pools
      SET status = 'scoring_completed',
          winner_ids = COALESCE(v_winner_ids, '{}'::uuid[])
      WHERE id = v_pool.id
        AND status NOT IN ('settling','settled','voided','cancelled');
      GET DIAGNOSTICS v_flip = ROW_COUNT;
      IF v_flip = 0 THEN
        RAISE EXCEPTION 'pool % reached a terminal status mid-scoring', v_pool.id;
      END IF;

      v_pools_finalized := v_pools_finalized + 1;

      INSERT INTO compliance_audit_logs (event_type, severity, description, metadata)
      VALUES (
        'survivor_pool_finalized', 'info',
        'Survivor pool finalized after round ' || v_target,
        jsonb_build_object(
          'pool_id', v_pool.id,
          'round_no', v_target,
          'alive_count', v_alive_count,
          'winner_ids', COALESCE(v_winner_ids, '{}'::uuid[]),
          'is_tie_refund', COALESCE(v_is_tie_refund, false))
      );
    END IF;
  END LOOP;

  -- 8. Flip the round
  UPDATE contest_rounds
  SET status = 'scored', scored_at = now()
  WHERE id = v_target_id AND status = 'locked';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RAISE EXCEPTION 'concurrent scoring run';
  END IF;

  -- 9. Late-scoring detection
  SELECT array_agg(cr.round_no ORDER BY cr.round_no) INTO v_late_rounds
  FROM contest_rounds cr
  WHERE cr.template_id = p_template_id
    AND cr.round_no > v_target
    AND (cr.status = 'locked' OR cr.lock_at <= now());

  IF v_late_rounds IS NOT NULL AND array_length(v_late_rounds, 1) > 0 THEN
    v_late := true;
    -- FIX 1: severity must be one of ('info','warning','critical'); the old
    -- 'warn' violated compliance_audit_logs_severity_check and rolled back the
    -- entire scoring transaction. This advisory log must never be able to
    -- abort settlement-critical work, so it degrades to a missing log line.
    BEGIN
      INSERT INTO compliance_audit_logs (event_type, severity, description, metadata)
      VALUES (
        'survivor_late_round_scoring', 'warning',
        'Later survivor round(s) already locked or past lock_at while scoring round ' || v_target,
        jsonb_build_object('template_id', p_template_id, 'round_no', v_target, 'affected_round_nos', v_late_rounds)
      );
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END IF;

  -- 10. Audit
  INSERT INTO compliance_audit_logs (event_type, severity, description, metadata)
  VALUES (
    'survivor_round_scored', 'info',
    'Survivor round ' || v_target || ' scored',
    jsonb_build_object(
      'template_id', p_template_id,
      'round_no', v_target,
      'pools_scored', v_pools_scored,
      'pools_finalized', v_pools_finalized,
      'alive_by_pool', v_alive_by_pool)
  );

  RETURN jsonb_build_object(
    'round_no', v_target,
    'pools_scored', v_pools_scored,
    'pools_finalized', v_pools_finalized,
    'alive_by_pool', v_alive_by_pool,
    'late_scoring', v_late
  );
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.score_survivor_round_atomic(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.score_survivor_round_atomic(uuid, uuid) TO service_role;


-- ---------- FIX 8(b): auto_lock_expired_contests audit copy ----------
CREATE OR REPLACE FUNCTION public.auto_lock_expired_contests()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_locked_count integer := 0;
  v_locked_rounds integer := 0;
BEGIN
  UPDATE contest_pools
  SET status = 'locked'
  WHERE status = 'open'
    AND lock_time <= now();

  GET DIAGNOSTICS v_locked_count = ROW_COUNT;

  UPDATE contest_rounds SET status = 'locked'
  WHERE status = 'scheduled' AND lock_at <= now();

  GET DIAGNOSTICS v_locked_rounds = ROW_COUNT;

  IF v_locked_count > 0 OR v_locked_rounds > 0 THEN
    INSERT INTO compliance_audit_logs (event_type, severity, description, metadata)
    VALUES (
      'auto_lock',
      'info',
      v_locked_count || ' contest pool(s) and ' || v_locked_rounds || ' round(s) auto-locked',
      jsonb_build_object('locked_count', v_locked_count, 'locked_rounds', v_locked_rounds, 'locked_at', now())
    );
  END IF;

  RETURN v_locked_count;
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.auto_lock_expired_contests() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auto_lock_expired_contests() TO service_role;

NOTIFY pgrst, 'reload schema';