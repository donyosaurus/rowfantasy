-- ============================================================
-- Multi-sport engine — Phase 3a-1: Survivor backend (schema + RPCs)
-- Every survivor branch is gated on scoring_config->>'primitive' = 'survivor';
-- placement / time_vs_ref / legacy (scoring_config IS NULL) templates are
-- byte-identical to today.
-- ============================================================

-- ---------- 1. Schema ----------
ALTER TABLE public.contest_templates DROP CONSTRAINT contest_templates_primitive_check;
ALTER TABLE public.contest_templates
  ADD CONSTRAINT contest_templates_primitive_check
  CHECK (primitive IN ('placement','time_vs_ref','survivor'));

ALTER TABLE public.contest_races ADD COLUMN IF NOT EXISTS round_no integer;
ALTER TABLE public.contest_races
  ADD CONSTRAINT contest_races_round_no_check
  CHECK (round_no IS NULL OR round_no >= 1);

CREATE TABLE public.contest_rounds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id uuid NOT NULL REFERENCES public.contest_templates(id) ON DELETE CASCADE,
  round_no integer NOT NULL CHECK (round_no >= 1),
  lock_at timestamptz NOT NULL,
  advance_count integer NOT NULL CHECK (advance_count >= 1),
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','locked','scored')),
  scored_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (template_id, round_no)
);

GRANT SELECT ON public.contest_rounds TO anon, authenticated;
GRANT ALL ON public.contest_rounds TO service_role;

ALTER TABLE public.contest_rounds ENABLE ROW LEVEL SECURITY;

-- Read-only to every JWT role. Deliberately NO write policies: all writes go
-- through service-role / SECURITY DEFINER RPCs, so a dashboard write can never
-- flip a 'scored' round back and bypass the rescore ban.
CREATE POLICY "Anyone can view contest rounds"
  ON public.contest_rounds FOR SELECT
  TO anon, authenticated
  USING (true);

CREATE TABLE public.contest_entry_rounds (
  entry_id uuid NOT NULL REFERENCES public.contest_entries(id) ON DELETE CASCADE,
  template_id uuid NOT NULL,
  round_no integer NOT NULL CHECK (round_no >= 1),
  picks jsonb NOT NULL,
  points numeric,
  round_rank integer,
  advanced boolean,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (entry_id, round_no),
  FOREIGN KEY (template_id, round_no)
    REFERENCES public.contest_rounds(template_id, round_no) ON DELETE CASCADE
);

CREATE INDEX idx_contest_entry_rounds_template_round
  ON public.contest_entry_rounds(template_id, round_no);

GRANT SELECT ON public.contest_entry_rounds TO authenticated;
GRANT ALL ON public.contest_entry_rounds TO service_role;

ALTER TABLE public.contest_entry_rounds ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own entry rounds"
  ON public.contest_entry_rounds FOR SELECT
  TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.contest_entries ce
    WHERE ce.id = entry_id AND ce.user_id = auth.uid()
  ));

CREATE POLICY "Admins can view all entry rounds"
  ON public.contest_entry_rounds FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role));


-- ---------- 2. admin_create_contest_v2: rounds support (DROP + CREATE) ----------
-- DROP first: adding a parameter via CREATE OR REPLACE would leave a SECOND
-- overload live (PGRST203 ambiguity + default EXECUTE grants on a DEFINER
-- function whose admin gate trusts a caller-supplied _admin_user_id).
DROP FUNCTION public.admin_create_contest_v2(text, text, text, timestamptz, jsonb, jsonb, jsonb, bigint, integer, jsonb, jsonb, boolean, boolean, text, text, uuid, text, text, jsonb, integer, integer, uuid);

CREATE FUNCTION public.admin_create_contest_v2(
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

  IF p_min_picks IS NULL OR p_min_picks < 2 THEN RAISE EXCEPTION 'p_min_picks must be >= 2'; END IF;
  IF p_max_picks IS NULL OR p_max_picks < p_min_picks THEN RAISE EXCEPTION 'p_max_picks must be >= p_min_picks'; END IF;
  IF COALESCE(p_roster_mode, 'per_race') = 'per_competitor' THEN
    IF p_max_picks > v_competitor_count THEN RAISE EXCEPTION 'p_max_picks exceeds competitor count'; END IF;
  ELSE
    IF p_min_picks > v_race_count THEN RAISE EXCEPTION 'p_min_picks (%) exceeds race count (%)', p_min_picks, v_race_count; END IF;
  END IF;
  IF p_entry_fee_cents IS NULL OR p_entry_fee_cents < 0 THEN RAISE EXCEPTION 'p_entry_fee_cents must be >= 0'; END IF;

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
  IF COALESCE(p_primitive, 'placement') = 'survivor' THEN
    IF COALESCE(p_roster_mode, 'per_race') <> 'per_race' THEN
      RAISE EXCEPTION 'survivor requires per_race roster';
    END IF;

    IF p_scoring_config IS NULL OR p_scoring_config->>'primitive' IS DISTINCT FROM 'survivor' THEN
      RAISE EXCEPTION 'scoring_config primitive mismatch';
    END IF;

    IF p_entry_tiers IS NOT NULL THEN
      RAISE EXCEPTION 'survivor does not support entry tiers';
    END IF;

    IF p_min_picks IS NULL OR p_max_picks IS NULL OR p_min_picks <> p_max_picks OR p_min_picks < 2 THEN
      RAISE EXCEPTION 'survivor requires a fixed pick count';
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
      WHERE (e->>'round_no')::int < 1 OR (e->>'advance_count')::int < 1
    ) THEN
      RAISE EXCEPTION 'invalid rounds';
    END IF;

    BEGIN
      PERFORM (e->>'lock_at')::timestamptz FROM jsonb_array_elements(p_rounds) e;
    EXCEPTION WHEN others THEN
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

    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_races) r
      WHERE jsonb_typeof(r->'round_no') <> 'number'
         OR (r->>'round_no') !~ '^[0-9]+$'
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

  IF COALESCE(p_primitive, 'placement') = 'survivor' THEN
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


-- ---------- 3. enter_contest_pool_atomic: survivor round-1 gating ----------
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
          AND (_primitive IS DISTINCT FROM 'survivor' OR r.round_no = 1)
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


-- ---------- 4. submit_survivor_round_picks ----------
CREATE OR REPLACE FUNCTION public.submit_survivor_round_picks(
  _user_id uuid,
  _entry_id uuid,
  _round_no integer,
  _picks jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  _exclusion_until timestamptz;
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

  SELECT ce.id, ce.status, ce.contest_template_id, cp.status AS pool_status
  INTO _entry
  FROM contest_entries ce
  JOIN contest_pools cp ON cp.id = ce.pool_id
  WHERE ce.id = _entry_id AND ce.user_id = _user_id
  FOR UPDATE OF ce;

  IF _entry.id IS NULL THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'entry_not_found');
  END IF;

  IF _entry.status <> 'active' OR _entry.pool_status NOT IN ('open','locked') THEN
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

  SELECT * INTO _round
  FROM contest_rounds
  WHERE template_id = _template_id AND round_no = _round_no;

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
$fn$;

REVOKE EXECUTE ON FUNCTION public.submit_survivor_round_picks(uuid, uuid, integer, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.submit_survivor_round_picks(uuid, uuid, integer, jsonb) TO service_role;


-- ---------- 5. score_survivor_round_atomic (sole writer of round outcomes) ----------
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
               COALESCE((SELECT SUM(COALESCE(er.points, 0)) FROM contest_entry_rounds er WHERE er.entry_id = ce.id), 0)::integer AS total_points,
               COALESCE((SELECT jsonb_agg(jsonb_build_object(
                            'round_no', er.round_no,
                            'points', er.points,
                            'round_rank', er.round_rank,
                            'advanced', er.advanced) ORDER BY er.round_no)
                         FROM contest_entry_rounds er WHERE er.entry_id = ce.id), '[]'::jsonb) AS crew_scores,
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
               COALESCE((SELECT SUM(COALESCE(er.points, 0)) FROM contest_entry_rounds er WHERE er.entry_id = ce2.id), 0)::integer AS total_points,
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
    INSERT INTO compliance_audit_logs (event_type, severity, description, metadata)
    VALUES (
      'survivor_late_round_scoring', 'warn',
      'Later survivor round(s) already locked or past lock_at while scoring round ' || v_target,
      jsonb_build_object('template_id', p_template_id, 'round_no', v_target, 'affected_round_nos', v_late_rounds)
    );
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

-- ---------- 6. auto_lock_expired_contests: also lock survivor rounds ----------
CREATE OR REPLACE FUNCTION public.auto_lock_expired_contests()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
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
      v_locked_count || ' contest pool(s) auto-locked',
      jsonb_build_object('locked_count', v_locked_count, 'locked_rounds', v_locked_rounds, 'locked_at', now())
    );
  END IF;

  RETURN v_locked_count;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.auto_lock_expired_contests() FROM PUBLIC, anon, authenticated;


-- ---------- 7a. admin_update_race_results_v2: survivor round guards ----------
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
  v_primitive text;
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

  SELECT scoring_config->>'primitive' INTO v_primitive FROM contest_templates WHERE id = p_template_id;

  IF v_primitive = 'survivor' THEN
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_results) e
      WHERE NOT EXISTS (
        SELECT 1
        FROM public.contest_races r
        JOIN public.contest_rounds cr
          ON cr.template_id = r.template_id AND cr.round_no = r.round_no
        WHERE r.template_id = p_template_id
          AND r.race_key = e->>'race_key'
          AND cr.status = 'locked'
      )
    ) THEN
      RAISE EXCEPTION 'survivor results can only be entered for a locked round';
    END IF;
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

  IF v_primitive IS DISTINCT FROM 'survivor' THEN
    UPDATE public.contest_pools
    SET status = 'results_entered'
    WHERE contest_template_id = p_template_id
      AND status IN ('open','locked','scoring_completed');
    GET DIAGNOSTICS v_flipped = ROW_COUNT;
  END IF;

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


-- ---------- 7b. admin_update_race_results (v1): reject survivor pools ----------
CREATE OR REPLACE FUNCTION public.admin_update_race_results(
  p_contest_pool_id uuid,
  p_results jsonb,
  _admin_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_result jsonb;
  v_crew_id text;
  v_finish_order int;
  v_finish_time text;
  v_status text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM user_roles ur
    JOIN auth.users u ON u.id = ur.user_id
    WHERE ur.user_id = _admin_user_id
      AND ur.role = 'admin'
  ) THEN
    RAISE EXCEPTION 'unauthorized: caller is not an admin';
  END IF;

  SELECT status INTO v_status
  FROM contest_pools
  WHERE id = p_contest_pool_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'pool % not found', p_contest_pool_id;
  END IF;

  IF v_status IN ('settled','voided','cancelled','settling') THEN
    RAISE EXCEPTION 'admin_update_race_results: pool % is % — results are frozen',
      p_contest_pool_id, v_status;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM contest_pools cp
    JOIN contest_templates ct ON ct.id = cp.contest_template_id
    WHERE cp.id = p_contest_pool_id
      AND ct.scoring_config->>'primitive' = 'survivor'
  ) THEN
    RAISE EXCEPTION 'survivor pools take results via admin_update_race_results_v2';
  END IF;

  FOR v_result IN SELECT * FROM jsonb_array_elements(p_results)
  LOOP
    v_crew_id := v_result->>'crew_id';
    v_finish_order := (v_result->>'finish_order')::int;
    v_finish_time := v_result->>'finish_time';

    UPDATE contest_pool_crews
    SET
      manual_finish_order = v_finish_order,
      manual_result_time = v_finish_time
    WHERE contest_pool_id = p_contest_pool_id
      AND crew_id = v_crew_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Crew % not found in contest pool', v_crew_id;
    END IF;
  END LOOP;

  UPDATE contest_pools
  SET status = 'results_entered'
  WHERE id = p_contest_pool_id;

  RETURN jsonb_build_object('success', true);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.admin_update_race_results(uuid, jsonb, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.admin_update_race_results(uuid, jsonb, uuid) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.admin_update_race_results(uuid, jsonb, uuid) FROM anon;
GRANT  EXECUTE ON FUNCTION public.admin_update_race_results(uuid, jsonb, uuid) TO service_role;

NOTIFY pgrst, 'reload schema';