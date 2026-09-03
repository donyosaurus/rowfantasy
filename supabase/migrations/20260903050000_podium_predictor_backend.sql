-- =====================================================================
-- Phase 4c-1: Podium Predictor backend
--   1. contest_templates primitive CHECK gains 'prediction'
--   2. admin_create_contest_v2      -> prediction create-side validation
--   3. enter_contest_pool_atomic    -> prediction entry validation + free guard
-- Both bodies are the current repository bodies restated verbatim with only
-- the described blocks/gates added. Non-prediction validation order and
-- messages (legacy, survivor, per_competitor) are byte-identical.
-- =====================================================================

ALTER TABLE public.contest_templates DROP CONSTRAINT contest_templates_primitive_check;
ALTER TABLE public.contest_templates ADD CONSTRAINT contest_templates_primitive_check
  CHECK (primitive IN ('placement','time_vs_ref','survivor','prediction'));

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
  v_podium_size integer;
  v_points_exact numeric;
  v_points_podium numeric;
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
    IF jsonb_typeof(p_scoring_config->'podium_size') <> 'number'
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

    IF jsonb_typeof(p_scoring_config->'points_exact') <> 'number'
       OR (p_scoring_config->>'points_exact') !~ '^[0-9]+$'
       OR jsonb_typeof(p_scoring_config->'points_podium') <> 'number'
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
    IF COALESCE(p_primitive, 'placement') <> 'prediction'
       AND p_scoring_config->>'primitive' IS DISTINCT FROM 'prediction'
       AND p_min_picks > v_race_count THEN RAISE EXCEPTION 'p_min_picks (%) exceeds race count (%)', p_min_picks, v_race_count; END IF;
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
      WHERE jsonb_typeof(elem->'position') <> 'number'
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
    IF _unique_event_count < _total_event_count THEN
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

NOTIFY pgrst, 'reload schema';
