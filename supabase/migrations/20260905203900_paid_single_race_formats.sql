-- Phase 4i-1: allow PAID single-race contests for exactly two shapes:
--   * TIER contests (roster_tiers present, per_competitor placement)
--   * CONFIDENCE contests (scoring_config.confidence = true, per_race placement, 1 race)
-- Every other paid shape keeps the >=2-race floor. Both function bodies are the
-- latest bases restated verbatim with only the described changes.
--   admin_create_contest_v2   <- 20260903170000_round_mode_accumulate.sql
--   enter_contest_pool_atomic <- 20260903060000_confidence_pickem_backend.sql

CREATE OR REPLACE FUNCTION public.admin_create_contest_v2(p_name text, p_sport text, p_gender_category text, p_lock_time timestamp with time zone, p_races jsonb, p_competitors jsonb, p_race_entries jsonb, p_entry_fee_cents bigint, p_max_entries integer, p_payout_structure jsonb DEFAULT NULL::jsonb, p_entry_tiers jsonb DEFAULT NULL::jsonb, p_allow_overflow boolean DEFAULT false, p_void_unfilled_on_settle boolean DEFAULT false, p_card_banner_url text DEFAULT NULL::text, p_draft_banner_url text DEFAULT NULL::text, p_contest_group_id uuid DEFAULT NULL::uuid, p_primitive text DEFAULT 'placement'::text, p_roster_mode text DEFAULT 'per_race'::text, p_scoring_config jsonb DEFAULT NULL::jsonb, p_min_picks integer DEFAULT 2, p_max_picks integer DEFAULT 4, _admin_user_id uuid DEFAULT NULL::uuid, p_rounds jsonb DEFAULT NULL::jsonb, p_roster_tiers jsonb DEFAULT NULL::jsonb)
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
  v_podium_size integer;
  v_points_exact numeric;
  v_points_podium numeric;
  v_conf1 boolean := false;
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
  v_conf1 := (COALESCE(p_scoring_config->>'confidence', '') = 'true') AND (v_race_count = 1);
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

  -- Dual-signal mismatch test hoisted ahead of the generic min/max-picks
  -- checks so a call whose two survivor signals disagree always reports the
  -- mismatch. Fires only when at least one signal is survivor.
  IF COALESCE(p_primitive, 'placement') = 'survivor'
     OR p_scoring_config->>'primitive' = 'survivor' THEN
    IF COALESCE(p_primitive, 'placement') <> 'survivor'
       OR p_scoring_config->>'primitive' IS DISTINCT FROM 'survivor' THEN
      RAISE EXCEPTION 'scoring_config primitive mismatch';
    END IF;
  END IF;

  -- Survivor fixed-pick-count check precedes the generic min/max checks.
  IF COALESCE(p_primitive, 'placement') = 'survivor'
     AND (p_min_picks IS NULL OR p_max_picks IS NULL OR p_min_picks <> p_max_picks OR p_min_picks < 2) THEN
    RAISE EXCEPTION 'survivor requires a fixed pick count';
  END IF;

  -- ===== Phase 4c-1: prediction (Podium Predictor) validation =====
  -- Mirrors the survivor dual-signal gate and precedes the generic pick-count
  -- checks so a prediction contest is judged by its own rules.
  IF COALESCE(p_primitive, 'placement') = 'prediction'
     OR p_scoring_config->>'primitive' = 'prediction' THEN
    IF COALESCE(p_primitive, 'placement') <> 'prediction'
       OR p_scoring_config->>'primitive' IS DISTINCT FROM 'prediction' THEN
      RAISE EXCEPTION 'scoring_config primitive mismatch';
    END IF;

    IF p_entry_fee_cents IS DISTINCT FROM 0 OR p_entry_tiers IS NOT NULL THEN
      RAISE EXCEPTION 'prediction contests must be free';
    END IF;

    IF p_rounds IS NOT NULL THEN
      RAISE EXCEPTION 'prediction contests do not use rounds';
    END IF;

    IF COALESCE(p_roster_mode, 'per_race') <> 'per_race' THEN
      RAISE EXCEPTION 'prediction requires per_race roster';
    END IF;

    IF v_race_count <> 1 THEN
      RAISE EXCEPTION 'prediction contests take exactly one race';
    END IF;

    -- Shape first (no casts), so a malformed podium_size can never raise a
    -- Postgres cast error instead of 'invalid podium_size'.
    IF jsonb_typeof(p_scoring_config->'podium_size') IS DISTINCT FROM 'number'
       OR (p_scoring_config->>'podium_size') !~ '^[0-9]+$'
       OR (p_scoring_config->>'podium_size')::numeric NOT BETWEEN 0 AND 2147483647 THEN
      RAISE EXCEPTION 'invalid podium_size';
    END IF;
    v_podium_size := (p_scoring_config->>'podium_size')::int;
    IF v_podium_size NOT BETWEEN 2 AND 10 THEN
      RAISE EXCEPTION 'invalid podium_size';
    END IF;

    IF p_min_picks IS DISTINCT FROM v_podium_size
       OR p_max_picks IS DISTINCT FROM v_podium_size THEN
      RAISE EXCEPTION 'prediction pick count must equal podium_size';
    END IF;

    IF jsonb_typeof(p_scoring_config->'points_exact') IS DISTINCT FROM 'number'
       OR (p_scoring_config->>'points_exact') !~ '^[0-9]+$'
       OR jsonb_typeof(p_scoring_config->'points_podium') IS DISTINCT FROM 'number'
       OR (p_scoring_config->>'points_podium') !~ '^[0-9]+$' THEN
      RAISE EXCEPTION 'invalid prediction points';
    END IF;
    v_points_exact := (p_scoring_config->>'points_exact')::numeric;
    v_points_podium := (p_scoring_config->>'points_podium')::numeric;
    IF v_points_exact <= 0 OR v_points_podium < 0 OR v_points_podium >= v_points_exact THEN
      RAISE EXCEPTION 'invalid prediction points';
    END IF;

    IF (
      SELECT count(DISTINCT e->>'competitor_key')
      FROM jsonb_array_elements(p_race_entries) e
    ) < v_podium_size THEN
      RAISE EXCEPTION 'not enough distinct entered competitors for the podium';
    END IF;
  END IF;

  IF p_min_picks IS NULL OR p_min_picks < 2 THEN RAISE EXCEPTION 'p_min_picks must be >= 2'; END IF;
  IF p_max_picks IS NULL OR p_max_picks < p_min_picks THEN RAISE EXCEPTION 'p_max_picks must be >= p_min_picks'; END IF;
  IF COALESCE(p_roster_mode, 'per_race') = 'per_competitor' THEN
    IF p_max_picks > v_competitor_count THEN RAISE EXCEPTION 'p_max_picks exceeds competitor count'; END IF;
  ELSE
    -- Phase 4c-1: prediction is the sole exception (exactly 1 race, N podium picks).
    IF v_conf1 IS NOT TRUE
       AND COALESCE(p_primitive, 'placement') <> 'prediction'
       AND p_scoring_config->>'primitive' IS DISTINCT FROM 'prediction'
       AND p_min_picks > v_race_count THEN RAISE EXCEPTION 'p_min_picks (%) exceeds race count (%)', p_min_picks, v_race_count; END IF;
    -- Phase 4i-1: single-race confidence contests pick N competitors from one race.
    IF v_conf1 IS TRUE THEN
      IF p_max_picks > (SELECT count(DISTINCT e->>'competitor_key') FROM jsonb_array_elements(p_race_entries) e) THEN
        RAISE EXCEPTION 'p_max_picks exceeds entered competitors';
      END IF;
    END IF;
  END IF;
  IF p_entry_fee_cents IS NULL OR p_entry_fee_cents < 0 THEN RAISE EXCEPTION 'p_entry_fee_cents must be >= 0'; END IF;

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
  IF v_has_paid AND v_race_count < 2 AND p_roster_tiers IS NULL AND v_conf1 IS NOT TRUE THEN
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

  -- Phase 4b: with the same-athlete guard in enter_contest_pool_atomic, a v2
  -- per_race contest must have at least as many DISTINCT ENTERED competitors
  -- as picks per entry, otherwise no valid entry can be built. Counts
  -- competitors present in p_race_entries (an unentered competitor inflates
  -- p_competitors). Legacy (p_scoring_config IS NULL) and per_competitor
  -- creates are untouched.
  IF p_scoring_config IS NOT NULL
     AND COALESCE(p_roster_mode, 'per_race') = 'per_race'
     AND COALESCE(p_primitive, 'placement') <> 'survivor'
     AND p_scoring_config->>'primitive' IS DISTINCT FROM 'survivor'
     AND COALESCE(p_primitive, 'placement') <> 'prediction'
     AND p_scoring_config->>'primitive' IS DISTINCT FROM 'prediction' THEN
    IF (
      SELECT count(DISTINCT e->>'competitor_key')
      FROM jsonb_array_elements(p_race_entries) e
    ) < GREATEST(COALESCE(p_min_picks, 2), 2) THEN
      RAISE EXCEPTION 'not enough distinct entered competitors for the pick count';
    END IF;
  END IF;

  -- ===== Phase 4g-A: Confidence Pick'em validation =====
  -- Entirely gated on p_scoring_config->>'confidence' = 'true'. Absent or NULL
  -- confidence leaves every existing path byte-identical.
  IF p_scoring_config->>'confidence' = 'true' THEN
    IF COALESCE(p_primitive, 'placement') <> 'placement'
       OR p_scoring_config->>'primitive' IS DISTINCT FROM 'placement' THEN
      RAISE EXCEPTION 'confidence is not valid for this contest type';
    END IF;

    IF COALESCE(p_roster_mode, 'per_race') <> 'per_race'
       OR p_roster_tiers IS NOT NULL
       OR p_rounds IS NOT NULL THEN
      RAISE EXCEPTION 'confidence requires per-race placement';
    END IF;

    IF p_scoring_config->>'direction' IS DISTINCT FROM 'high'
       OR p_scoring_config->>'dnf_policy' IS DISTINCT FROM 'zero' THEN
      RAISE EXCEPTION 'confidence requires direction high and dnf_policy zero';
    END IF;
  END IF;

  -- ===== Phase 4e-1: roster_tiers validation =====
  -- Entirely gated on p_roster_tiers IS NOT NULL: when NULL there is no
  -- behavior change anywhere. Shape is verified in strict sequence so a
  -- malformed value can never reach jsonb_array_elements / a cast.
  IF p_roster_tiers IS NOT NULL THEN
    IF jsonb_typeof(p_roster_tiers) IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'invalid roster_tiers';
    END IF;

    IF jsonb_array_length(p_roster_tiers) < 2 OR jsonb_array_length(p_roster_tiers) > 10 THEN
      RAISE EXCEPTION 'invalid roster_tiers';
    END IF;

    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_roster_tiers) t
      WHERE jsonb_typeof(t) IS DISTINCT FROM 'object'
         OR jsonb_typeof(t->'name') IS DISTINCT FROM 'string'
         OR btrim(COALESCE(t->>'name', '')) = ''
         OR jsonb_typeof(t->'competitors') IS DISTINCT FROM 'array'
    ) THEN
      RAISE EXCEPTION 'invalid roster_tiers';
    END IF;

    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_roster_tiers) t
      WHERE jsonb_array_length(t->'competitors') < 1
         OR jsonb_array_length(t->'competitors') > 200
    ) THEN
      RAISE EXCEPTION 'invalid roster_tiers';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM jsonb_array_elements(p_roster_tiers) t,
           jsonb_array_elements(t->'competitors') ck
      WHERE jsonb_typeof(ck) IS DISTINCT FROM 'string'
         OR btrim(ck #>> '{}') = ''
    ) THEN
      RAISE EXCEPTION 'invalid roster_tiers';
    END IF;

    -- Contest-type gate FIRST so survivor/prediction/rounds inputs get the
    -- type message rather than the placement message.
    IF COALESCE(p_primitive, 'placement') = 'survivor'
       OR p_scoring_config->>'primitive' = 'survivor'
       OR COALESCE(p_primitive, 'placement') = 'prediction'
       OR p_scoring_config->>'primitive' = 'prediction'
       OR p_rounds IS NOT NULL THEN
      RAISE EXCEPTION 'roster_tiers is not valid for this contest type';
    END IF;

    IF COALESCE(p_primitive, 'placement') <> 'placement'
       OR p_scoring_config->>'primitive' IS DISTINCT FROM 'placement'
       OR COALESCE(p_roster_mode, 'per_race') <> 'per_competitor'
       OR p_scoring_config->>'tiebreak' IS DISTINCT FROM 'none' THEN
      RAISE EXCEPTION 'roster_tiers requires per-competitor placement';
    END IF;

    IF (
         SELECT count(*)
         FROM jsonb_array_elements(p_roster_tiers) t,
              jsonb_array_elements(t->'competitors') ck
       ) <> (
         SELECT count(DISTINCT ck #>> '{}')
         FROM jsonb_array_elements(p_roster_tiers) t,
              jsonb_array_elements(t->'competitors') ck
       )
       OR EXISTS (
         SELECT 1
         FROM jsonb_array_elements(p_roster_tiers) t,
              jsonb_array_elements(t->'competitors') ck
         WHERE NOT EXISTS (
                 SELECT 1 FROM jsonb_array_elements(p_competitors) c
                 WHERE c->>'competitor_key' = ck #>> '{}')
            OR EXISTS (
                 SELECT 1 FROM jsonb_array_elements(p_races) r
                 WHERE NOT EXISTS (
                   SELECT 1 FROM jsonb_array_elements(p_race_entries) e
                   WHERE e->>'race_key' = r->>'race_key'
                     AND e->>'competitor_key' = ck #>> '{}'))
       ) THEN
      RAISE EXCEPTION 'roster_tiers competitors must be distinct and entered in every race';
    END IF;

    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_roster_tiers) t
      WHERE jsonb_array_length(t->'competitors') < 2
    ) THEN
      RAISE EXCEPTION 'each roster tier needs at least 2 competitors';
    END IF;

    IF p_min_picks IS DISTINCT FROM jsonb_array_length(p_roster_tiers)
       OR p_max_picks IS DISTINCT FROM jsonb_array_length(p_roster_tiers) THEN
      RAISE EXCEPTION 'tier contests require one pick per tier';
    END IF;
  END IF;

  -- ===== survivor validation (all checks precede every INSERT) =====
  IF COALESCE(p_primitive, 'placement') = 'survivor'
     OR p_scoring_config->>'primitive' = 'survivor' THEN

    IF COALESCE(p_roster_mode, 'per_race') <> 'per_race' THEN
      RAISE EXCEPTION 'survivor requires per_race roster';
    END IF;

    IF COALESCE(p_void_unfilled_on_settle, false) IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'survivor contests require void_unfilled_on_settle';
    END IF;

    IF p_scoring_config->'points_table' IS NULL
       OR jsonb_typeof(p_scoring_config->'points_table') <> 'object'
       OR NOT EXISTS (
         SELECT 1 FROM jsonb_each_text(p_scoring_config->'points_table') kv
         WHERE kv.key = '1' AND kv.value ~ '^[0-9]+$' AND kv.value::numeric > 0)
    THEN
      RAISE EXCEPTION 'survivor requires a points_table with a positive value for place 1';
    END IF;

    IF p_scoring_config ? 'round_mode'
       AND (jsonb_typeof(p_scoring_config->'round_mode') <> 'string'
            OR p_scoring_config->>'round_mode' NOT IN ('eliminate','accumulate')) THEN
      RAISE EXCEPTION 'invalid round_mode';
    END IF;

    IF p_scoring_config ? 'no_reuse'
       AND jsonb_typeof(p_scoring_config->'no_reuse') <> 'boolean' THEN
      RAISE EXCEPTION 'invalid no_reuse';
    END IF;

    IF COALESCE((p_scoring_config->>'no_reuse')::boolean, false)
       AND COALESCE(p_scoring_config->>'round_mode', 'eliminate') <> 'accumulate' THEN
      RAISE EXCEPTION 'no_reuse requires accumulate';
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

    IF COALESCE(p_scoring_config->>'round_mode', 'eliminate') = 'accumulate' THEN
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_rounds) e
      WHERE (e->>'advance_count')::int <> 1
    ) THEN
      RAISE EXCEPTION 'accumulate rounds must use advance_count 1';
    END IF;
    ELSE
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
    END IF;

    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_races) r
      WHERE jsonb_typeof(r->'round_no') <> 'number'
         OR (r->>'round_no') !~ '^[0-9]+$'
    ) THEN
      RAISE EXCEPTION 'every survivor race needs a round_no';
    END IF;

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

    -- Phase 4b: raised from 2 to the per-entry pick count so every survivor
    -- round is playable under the same-athlete guard.
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_rounds) e
      WHERE (
        SELECT count(DISTINCT en->>'competitor_key')
        FROM jsonb_array_elements(p_race_entries) en
        WHERE EXISTS (
          SELECT 1 FROM jsonb_array_elements(p_races) r
          WHERE r->>'race_key' = en->>'race_key'
            AND (r->>'round_no')::int = (e->>'round_no')::int)
      ) < GREATEST(COALESCE(p_min_picks, 2), 2)
    ) THEN
      RAISE EXCEPTION 'each survivor round needs at least as many distinct competitors as picks per entry';
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
    min_picks, max_picks, card_banner_url, draft_banner_url, contest_group_id,
    roster_tiers
  ) VALUES (
    p_name, p_name, COALESCE(p_sport, 'rowing'), COALESCE(p_primitive, 'placement'),
    COALESCE(p_roster_mode, 'per_race'), p_scoring_config,
    p_gender_category, p_lock_time, 'open', '[]'::jsonb, '[]'::jsonb,
    COALESCE(p_entry_tiers, '[]'::jsonb), p_min_picks, p_max_picks,
    p_card_banner_url, p_draft_banner_url, p_contest_group_id,
    p_roster_tiers
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

  IF COALESCE(p_primitive, 'placement') = 'survivor'
     OR p_scoring_config->>'primitive' = 'survivor' THEN
    INSERT INTO public.contest_rounds (template_id, round_no, lock_at, advance_count, round_mode)
    SELECT v_template_id,
           (e->>'round_no')::int,
           (e->>'lock_at')::timestamptz,
           (e->>'advance_count')::int,
           COALESCE(p_scoring_config->>'round_mode', 'eliminate')
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
  _scoring_config jsonb;
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

  -- Lock order: pool -> entry -> round (shared prefix with
  -- score_survivor_round_atomic, so the two functions can never deadlock).
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

  SELECT scoring_config, scoring_config->>'primitive', min_picks, max_picks
  INTO _scoring_config, _primitive, _min_picks, _max_picks
  FROM contest_templates
  WHERE id = _template_id;

  IF _primitive IS DISTINCT FROM 'survivor' THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'not_survivor');
  END IF;

  IF _round_no IS NULL OR _round_no < 2 THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'round_one_fixed');
  END IF;

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

  IF COALESCE(_scoring_config->>'round_mode', 'eliminate') <> 'accumulate' THEN
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

  -- Phase 4b: each competitor may be picked at most once per round.
  IF _distinct_crews < _pick_count THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'duplicate_competitor');
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

  IF COALESCE((_scoring_config->>'no_reuse')::boolean, false) THEN
    IF EXISTS (
      SELECT 1
      FROM jsonb_array_elements(_picks) e
      WHERE EXISTS (
        SELECT 1
        FROM contest_entry_rounds er
        CROSS JOIN LATERAL jsonb_array_elements(er.picks) prev
        WHERE er.entry_id = _entry_id
          AND er.round_no < _round_no
          AND prev->>'crewId' = e->>'crewId')
    ) THEN
      RETURN jsonb_build_object('allowed', false, 'reason', 'competitor_reused');
    END IF;
  END IF;

  INSERT INTO contest_entry_rounds (entry_id, template_id, round_no, picks)
  VALUES (_entry_id, _template_id, _round_no, _picks)
  ON CONFLICT (entry_id, round_no) DO UPDATE
    SET picks = EXCLUDED.picks,
        updated_at = now();

  RETURN jsonb_build_object('allowed', true, 'reason', 'approved', 'round_no', _round_no);
END;
$function$;
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
  v_accumulate boolean;
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

  v_accumulate := COALESCE(v_scoring_config->>'round_mode', 'eliminate') = 'accumulate';

  IF EXISTS (
    SELECT 1 FROM contest_rounds cr
    WHERE cr.template_id = p_template_id
      AND cr.round_mode IS DISTINCT FROM CASE WHEN v_accumulate THEN 'accumulate' ELSE 'eliminate' END
  ) THEN
    RAISE EXCEPTION 'mixed round modes';
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

    IF v_accumulate THEN
      IF v_scored_count > 0 THEN
        UPDATE contest_entry_rounds er
        SET round_rank = z.rnk,
            advanced = true,
            updated_at = now()
        FROM (
          SELECT er2.entry_id, RANK() OVER (ORDER BY er2.points DESC) AS rnk
          FROM contest_entries ce
          JOIN contest_entry_rounds er2 ON er2.entry_id = ce.id AND er2.round_no = v_target
          WHERE ce.pool_id = v_pool.id
            AND ce.status = 'active'
        ) z
        WHERE er.entry_id = z.entry_id AND er.round_no = v_target;
      END IF;

      INSERT INTO contest_entry_rounds (entry_id, template_id, round_no, picks, points, round_rank, advanced)
      SELECT ce.id, p_template_id, v_target, '[]'::jsonb, 0, NULL, true
      FROM contest_entries ce
      WHERE ce.pool_id = v_pool.id
        AND ce.status = 'active'
        AND NOT EXISTS (
          SELECT 1 FROM contest_entry_rounds er2
          WHERE er2.entry_id = ce.id AND er2.round_no = v_target);

      IF EXISTS (
        SELECT 1 FROM contest_entries ce
        WHERE ce.pool_id = v_pool.id
          AND ce.status = 'active'
          AND (SELECT count(*) FROM contest_entry_rounds er
               WHERE er.entry_id = ce.id AND er.round_no = v_target AND er.advanced = true) <> 1
      ) THEN
        RAISE EXCEPTION 'accumulate scoring: pool % lacks exactly one advanced round % row per active entry', v_pool.id, v_target;
      END IF;
    ELSE
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
    END IF;

    SELECT count(*) INTO v_advancers
    FROM contest_entries ce
    JOIN contest_entry_rounds er ON er.entry_id = ce.id AND er.round_no = v_target
    WHERE ce.pool_id = v_pool.id AND ce.status = 'active' AND er.advanced = true;

    v_alive_count := v_advancers;
    v_pools_scored := v_pools_scored + 1;
    v_alive_by_pool := v_alive_by_pool || jsonb_build_object(v_pool.id::text, v_alive_count);

    v_finalize := CASE WHEN v_accumulate THEN (v_target = v_max_round)
                       ELSE (v_advancers <= 1) OR (v_target = v_max_round) END;

    IF v_finalize THEN
      SELECT count(*) INTO v_pool_active
      FROM contest_entries ce WHERE ce.pool_id = v_pool.id AND ce.status = 'active';

      IF v_accumulate THEN
        CREATE TEMP TABLE IF NOT EXISTS _surv_acc_rank (
          entry_id uuid,
          user_id uuid,
          total_points integer,
          crew_scores jsonb,
          rnk integer
        ) ON COMMIT DROP;
        TRUNCATE _surv_acc_rank;

        INSERT INTO _surv_acc_rank (entry_id, user_id, total_points, crew_scores, rnk)
        SELECT f.entry_id, f.user_id, f.total_points, f.crew_scores,
               RANK() OVER (ORDER BY f.total_points DESC)
        FROM (
          SELECT ce.id AS entry_id, ce.user_id,
            COALESCE((SELECT SUM(COALESCE(er.points, 0)) FROM contest_entry_rounds er
                      WHERE er.entry_id = ce.id AND er.round_no <= v_target), 0)::integer AS total_points,
            COALESCE((SELECT jsonb_agg(jsonb_build_object(
                        'round_no', er.round_no,
                        'points', er.points,
                        'round_rank', er.round_rank,
                        'advanced', er.advanced) ORDER BY er.round_no)
                      FROM contest_entry_rounds er
                      WHERE er.entry_id = ce.id AND er.round_no <= v_target), '[]'::jsonb) AS crew_scores
          FROM contest_entries ce
          WHERE ce.pool_id = v_pool.id AND ce.status = 'active'
        ) f;

        SELECT count(*) FILTER (WHERE t.rnk = 1), array_agg(t.user_id) FILTER (WHERE t.rnk = 1)
        INTO v_rank1_count, v_winner_ids
        FROM _surv_acc_rank t;
      ELSE
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
      END IF;

      v_is_tie_refund := (COALESCE(v_pool.max_entries, 0) = 2 AND v_pool_active = 2 AND COALESCE(v_rank1_count, 0) = 2);

      IF v_is_tie_refund THEN
        v_winner_ids := '{}'::uuid[];
      END IF;

      IF v_accumulate THEN
        INSERT INTO contest_scores (
          entry_id, pool_id, user_id, total_points, margin_bonus, rank,
          is_tiebreak_resolved, is_winner, crew_scores, score_value, tiebreak_value
        )
        SELECT t.entry_id, v_pool.id, t.user_id, t.total_points, 0, t.rnk,
               false,
               (t.rnk = 1 AND NOT v_is_tie_refund),
               t.crew_scores, NULL, NULL
        FROM _surv_acc_rank t
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
        SET total_points = t.total_points,
            rank = t.rnk,
            margin_error = NULL,
            updated_at = now()
        FROM _surv_acc_rank t
        WHERE ce.id = t.entry_id;
      ELSE
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
      END IF;

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
REVOKE ALL ON FUNCTION public.admin_create_contest_v2(text, text, text, timestamptz, jsonb, jsonb, jsonb, bigint, integer, jsonb, jsonb, boolean, boolean, text, text, uuid, text, text, jsonb, integer, integer, uuid, jsonb, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_create_contest_v2(text, text, text, timestamptz, jsonb, jsonb, jsonb, bigint, integer, jsonb, jsonb, boolean, boolean, text, text, uuid, text, text, jsonb, integer, integer, uuid, jsonb, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.admin_create_contest_v2(text, text, text, timestamptz, jsonb, jsonb, jsonb, bigint, integer, jsonb, jsonb, boolean, boolean, text, text, uuid, text, text, jsonb, integer, integer, uuid, jsonb, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.admin_create_contest_v2(text, text, text, timestamptz, jsonb, jsonb, jsonb, bigint, integer, jsonb, jsonb, boolean, boolean, text, text, uuid, text, text, jsonb, integer, integer, uuid, jsonb, jsonb) TO service_role;

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
  _primitive text;
  _clone_source_fee bigint;
  _roster_tiers jsonb;
  _conf1 boolean := false;
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

  SELECT id, min_picks, max_picks, scoring_config, roster_mode, max_entries_per_user, roster_tiers INTO _template_check, _min_picks, _max_picks, _scoring_config, _roster_mode, _max_entries_per_user, _roster_tiers
  FROM contest_templates
  WHERE id = _contest_template_id;

  IF _template_check IS NULL THEN
    RETURN QUERY SELECT false, 'template_not_found'::text, NULL::uuid, NULL::uuid, NULL::integer, NULL::integer, NULL::bigint;
    RETURN;
  END IF;

  -- Phase 4i-1: single-race confidence template (non-null boolean; jsonb ->> on a
  -- missing key is NULL, so COALESCE keeps this false rather than NULL).
  _conf1 := (COALESCE(_scoring_config->>'confidence', '') = 'true')
            AND ((SELECT count(*) FROM contest_races WHERE template_id = _contest_template_id) = 1);

  _primitive := _scoring_config->>'primitive';

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

  -- ===== Phase 4c-1: prediction (Podium Predictor) entry validation =====
  -- Placed after the event-id aggregation so an empty _picks still returns
  -- 'insufficient_events' at the existing early guard above.
  IF _primitive = 'prediction' THEN
    IF _total_event_count < COALESCE(_min_picks, 2) THEN
      RETURN QUERY SELECT false, 'insufficient_picks'::text, NULL::uuid, NULL::uuid, NULL::integer, NULL::integer, NULL::bigint;
      RETURN;
    END IF;

    IF _total_event_count > COALESCE(_max_picks, 4) THEN
      RETURN QUERY SELECT false, 'too_many_picks'::text, NULL::uuid, NULL::uuid, NULL::integer, NULL::integer, NULL::bigint;
      RETURN;
    END IF;

    IF _unique_event_count <> 1 THEN
      RETURN QUERY SELECT false, 'invalid_pick'::text, NULL::uuid, NULL::uuid, NULL::integer, NULL::integer, NULL::bigint;
      RETURN;
    END IF;

    -- Shape first (no casts): a missing / fractional / non-numeric position
    -- returns 'invalid_pick' rather than raising a cast error.
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(_picks) elem
      WHERE jsonb_typeof(elem->'position') IS DISTINCT FROM 'number'
         OR (elem->>'position') !~ '^[0-9]+$'
         OR (elem->>'position')::numeric NOT BETWEEN 0 AND 2147483647
    ) THEN
      RETURN QUERY SELECT false, 'invalid_pick'::text, NULL::uuid, NULL::uuid, NULL::integer, NULL::integer, NULL::bigint;
      RETURN;
    END IF;

    -- Positions must be exactly 1..pick_count, each used once.
    IF (SELECT count(DISTINCT (elem->>'position')::int) FROM jsonb_array_elements(_picks) elem) <> _total_event_count
       OR (SELECT min((elem->>'position')::int) FROM jsonb_array_elements(_picks) elem) <> 1
       OR (SELECT max((elem->>'position')::int) FROM jsonb_array_elements(_picks) elem) <> _total_event_count THEN
      RETURN QUERY SELECT false, 'invalid_pick'::text, NULL::uuid, NULL::uuid, NULL::integer, NULL::integer, NULL::bigint;
      RETURN;
    END IF;

    IF (SELECT count(DISTINCT elem->>'crewId') FROM jsonb_array_elements(_picks) elem) <> _total_event_count THEN
      RETURN QUERY SELECT false, 'duplicate_competitor'::text, NULL::uuid, NULL::uuid, NULL::integer, NULL::integer, NULL::bigint;
      RETURN;
    END IF;
  END IF;

  IF _primitive IS DISTINCT FROM 'prediction' AND (_scoring_config IS NULL OR _roster_mode = 'per_race') THEN
    IF _conf1 IS NOT TRUE AND _unique_event_count < _total_event_count THEN
      RETURN QUERY SELECT false, 'duplicate_event'::text, NULL::uuid, NULL::uuid, NULL::integer, NULL::integer, NULL::bigint;
      RETURN;
    END IF;

    -- Phase 4b: on a v2 per_race template (survivor included) every pick must
    -- name a DIFFERENT competitor. Gated on _scoring_config so LEGACY templates
    -- keep their exact validation order and responses.
    IF _scoring_config IS NOT NULL THEN
      IF (SELECT count(DISTINCT elem->>'crewId') FROM jsonb_array_elements(_picks) elem)
         < _total_event_count THEN
        RETURN QUERY SELECT false, 'duplicate_competitor'::text, NULL::uuid, NULL::uuid, NULL::integer, NULL::integer, NULL::bigint;
        RETURN;
      END IF;
    END IF;

    IF _conf1 IS NOT TRUE AND _unique_event_count < MIN_UNIQUE_EVENTS THEN
      RETURN QUERY SELECT false, 'insufficient_events'::text, NULL::uuid, NULL::uuid, NULL::integer, NULL::integer, NULL::bigint;
      RETURN;
    END IF;

    -- ===== Phase 4g-A: Confidence Pick'em weights =====
    -- Gated on the template's scoring_config; every non-confidence template is
    -- byte-identical. Shape guards precede any cast so a missing / fractional /
    -- non-numeric weight returns 'invalid_pick' instead of raising.
    IF _scoring_config->>'confidence' = 'true' THEN
      IF EXISTS (
        SELECT 1 FROM jsonb_array_elements(_picks) elem
        WHERE jsonb_typeof(elem->'weight') IS DISTINCT FROM 'number'
           OR (elem->>'weight') !~ '^[0-9]+$'
           OR (elem->>'weight')::numeric NOT BETWEEN 1 AND 2147483647
      ) THEN
        RETURN QUERY SELECT false, 'invalid_pick'::text, NULL::uuid, NULL::uuid, NULL::integer, NULL::integer, NULL::bigint;
        RETURN;
      END IF;

      -- Weights must be exactly 1.._total_event_count, each used once.
      IF (SELECT count(DISTINCT (elem->>'weight')::int) FROM jsonb_array_elements(_picks) elem) <> _total_event_count
         OR (SELECT min((elem->>'weight')::int) FROM jsonb_array_elements(_picks) elem) <> 1
         OR (SELECT max((elem->>'weight')::int) FROM jsonb_array_elements(_picks) elem) <> _total_event_count THEN
        RETURN QUERY SELECT false, 'invalid_pick'::text, NULL::uuid, NULL::uuid, NULL::integer, NULL::integer, NULL::bigint;
        RETURN;
      END IF;
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

    -- ===== Phase 4e-1: roster tier rule =====
    -- Each pick must belong to exactly one tier, and no two picks may share a
    -- tier. A duplicate rider still hits 'duplicate_competitor' above first.
    IF _roster_tiers IS NOT NULL THEN
      IF EXISTS (
        SELECT 1 FROM jsonb_array_elements(_picks) elem
        WHERE (
          SELECT count(*) FROM jsonb_array_elements(_roster_tiers) t
          WHERE EXISTS (
            SELECT 1 FROM jsonb_array_elements(t->'competitors') ck
            WHERE ck #>> '{}' = elem->>'crewId')
        ) <> 1
      ) THEN
        RETURN QUERY SELECT false, 'tier_rule_violation'::text, NULL::uuid, NULL::uuid, NULL::integer, NULL::integer, NULL::bigint;
        RETURN;
      END IF;

      IF (
        SELECT count(DISTINCT z.tier_ord)
        FROM jsonb_array_elements(_picks) elem
        CROSS JOIN LATERAL (
          SELECT a.ord AS tier_ord
          FROM jsonb_array_elements(_roster_tiers) WITH ORDINALITY AS a(t, ord)
          WHERE EXISTS (
            SELECT 1 FROM jsonb_array_elements(a.t->'competitors') ck
            WHERE ck #>> '{}' = elem->>'crewId')
        ) z
      ) <> jsonb_array_length(_picks) THEN
        RETURN QUERY SELECT false, 'tier_rule_violation'::text, NULL::uuid, NULL::uuid, NULL::integer, NULL::integer, NULL::bigint;
        RETURN;
      END IF;
    END IF;
  END IF;

  SELECT count(DISTINCT elem->>'crewId') INTO _unique_competitor_count
  FROM jsonb_array_elements(_picks) AS elem;

  IF _unique_competitor_count < 2 THEN
    RETURN QUERY SELECT false, 'insufficient_competitors'::text, NULL::uuid, NULL::uuid, NULL::integer, NULL::integer, NULL::bigint;
    RETURN;
  END IF;

  IF _scoring_config IS NOT NULL AND _roster_mode = 'per_competitor' THEN
    IF _roster_tiers IS NULL AND (SELECT count(*) FROM contest_races WHERE template_id = _contest_template_id) < 2 THEN
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

    -- Phase 4c-1: prediction contests are free; reject before the pool is
    -- selected so no money path is ever reached.
    IF _primitive = 'prediction' AND _candidate.entry_fee_cents > 0 THEN
      RETURN QUERY SELECT false, 'prediction_not_free'::text, NULL::uuid, NULL::uuid, NULL::integer, NULL::integer, NULL::bigint;
      RETURN;
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
          AND (_primitive IS DISTINCT FROM 'survivor' OR r.round_no = 1)
      );
    END IF;

    IF _invalid_pick_count > 0 THEN
      RETURN QUERY SELECT false, 'invalid_pick'::text, NULL::uuid, NULL::uuid, NULL::integer, NULL::integer, NULL::bigint;
      RETURN;
    END IF;

    -- Phase 4c-1: check the SOURCE pool's fee BEFORE cloning, so a rejected
    -- prediction entry never strands an empty cloned pool.
    IF _primitive = 'prediction' THEN
      SELECT cp.entry_fee_cents INTO _clone_source_fee
      FROM contest_pools cp WHERE cp.id = _pool_for_clone;
      IF _clone_source_fee > 0 THEN
        RETURN QUERY SELECT false, 'prediction_not_free'::text, NULL::uuid, NULL::uuid, NULL::integer, NULL::integer, NULL::bigint;
        RETURN;
      END IF;
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
        AND (_primitive IS DISTINCT FROM 'survivor' OR r.round_no = 1)
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

  IF _primitive = 'survivor' THEN
    INSERT INTO contest_entry_rounds (entry_id, template_id, round_no, picks)
    VALUES (_entry_id, _contest_template_id, 1, _picks);
  END IF;

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

DO $do$
DECLARE
  v_overloads integer;
  v_name text;
BEGIN
  FOREACH v_name IN ARRAY ARRAY['admin_create_contest_v2','enter_contest_pool_atomic'] LOOP
    SELECT count(*) INTO v_overloads
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = v_name;
    IF v_overloads <> 1 THEN
      RAISE EXCEPTION '% must have exactly 1 overload, found %', v_name, v_overloads;
    END IF;
  END LOOP;
END
$do$;

NOTIFY pgrst, 'reload schema';
