-- ============================================================
-- Multi-sport engine Phase 1a: additive schema + backfill + v2 RPCs
-- ============================================================

-- 1. contest_templates additive columns + relaxed gender CHECK
ALTER TABLE public.contest_templates
  ADD COLUMN IF NOT EXISTS sport text NOT NULL DEFAULT 'rowing',
  ADD COLUMN IF NOT EXISTS name text,
  ADD COLUMN IF NOT EXISTS primitive text NOT NULL DEFAULT 'placement',
  ADD COLUMN IF NOT EXISTS roster_mode text NOT NULL DEFAULT 'per_race',
  ADD COLUMN IF NOT EXISTS scoring_config jsonb;

ALTER TABLE public.contest_templates
  ADD CONSTRAINT contest_templates_primitive_check CHECK (primitive IN ('placement','time_vs_ref')),
  ADD CONSTRAINT contest_templates_roster_mode_check CHECK (roster_mode IN ('per_race','per_competitor'));

UPDATE public.contest_templates SET name = regatta_name WHERE name IS NULL;

ALTER TABLE public.contest_templates DROP CONSTRAINT IF EXISTS contest_templates_gender_category_check;
ALTER TABLE public.contest_templates ADD CONSTRAINT contest_templates_gender_category_check
  CHECK (gender_category IN ('Men''s','Women''s','Mixed','Open'));

-- 2. New tables
CREATE TABLE public.contest_races (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id uuid NOT NULL REFERENCES public.contest_templates(id) ON DELETE CASCADE,
  race_key text NOT NULL,
  name text NOT NULL,
  race_order integer NOT NULL DEFAULT 0,
  event_class text, division text, round text, distance text,
  scheduled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (template_id, race_key)
);

CREATE TABLE public.contest_competitors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id uuid NOT NULL REFERENCES public.contest_templates(id) ON DELETE CASCADE,
  competitor_key text NOT NULL,
  name text NOT NULL,
  logo_url text,
  competitor_type text NOT NULL DEFAULT 'crew',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (template_id, competitor_key)
);

CREATE TABLE public.contest_race_entries (
  race_id uuid NOT NULL REFERENCES public.contest_races(id) ON DELETE CASCADE,
  competitor_id uuid NOT NULL REFERENCES public.contest_competitors(id) ON DELETE CASCADE,
  seed_time_ms bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (race_id, competitor_id)
);

CREATE TABLE public.contest_race_results (
  race_id uuid NOT NULL,
  competitor_id uuid NOT NULL,
  place integer,
  time_ms bigint,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('OK','DNF','DNS','DSQ','PENDING')),
  posted_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (race_id, competitor_id),
  FOREIGN KEY (race_id, competitor_id) REFERENCES public.contest_race_entries(race_id, competitor_id) ON DELETE CASCADE,
  CHECK (place IS NULL OR place >= 1),
  CHECK (time_ms IS NULL OR time_ms >= 0)
);

CREATE INDEX idx_contest_races_template ON public.contest_races(template_id, race_order);
CREATE INDEX idx_contest_competitors_template ON public.contest_competitors(template_id);
CREATE INDEX idx_contest_race_entries_competitor ON public.contest_race_entries(competitor_id);

ALTER TABLE public.contest_scores
  ADD COLUMN IF NOT EXISTS score_value numeric,
  ADD COLUMN IF NOT EXISTS tiebreak_value numeric;

ALTER TABLE public.contest_races ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contest_competitors ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contest_race_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contest_race_results ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can view contest_races" ON public.contest_races
  FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "Admins can manage contest_races" ON public.contest_races
  FOR ALL TO authenticated USING (public.has_role(auth.uid(),'admin'::app_role)) WITH CHECK (public.has_role(auth.uid(),'admin'::app_role));

CREATE POLICY "Anyone can view contest_competitors" ON public.contest_competitors
  FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "Admins can manage contest_competitors" ON public.contest_competitors
  FOR ALL TO authenticated USING (public.has_role(auth.uid(),'admin'::app_role)) WITH CHECK (public.has_role(auth.uid(),'admin'::app_role));

CREATE POLICY "Anyone can view contest_race_entries" ON public.contest_race_entries
  FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "Admins can manage contest_race_entries" ON public.contest_race_entries
  FOR ALL TO authenticated USING (public.has_role(auth.uid(),'admin'::app_role)) WITH CHECK (public.has_role(auth.uid(),'admin'::app_role));

CREATE POLICY "Anyone can view contest_race_results" ON public.contest_race_results
  FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "Admins can manage contest_race_results" ON public.contest_race_results
  FOR ALL TO authenticated USING (public.has_role(auth.uid(),'admin'::app_role)) WITH CHECK (public.has_role(auth.uid(),'admin'::app_role));

-- 3. Time helpers
CREATE OR REPLACE FUNCTION public.parse_race_time_ms(_t text)
RETURNS bigint
LANGUAGE plpgsql
IMMUTABLE STRICT
SET search_path TO 'public'
AS $fn$
DECLARE
  s text := btrim(_t);
  m text[];
  ms bigint;
BEGIN
  IF s = '' THEN RETURN NULL; END IF;

  m := regexp_match(s, '^(\d+):([0-5]?\d):([0-5]?\d)(?:[.,](\d{1,3}))?$');
  IF m IS NOT NULL THEN
    ms := (m[1]::bigint * 3600 + m[2]::bigint * 60 + m[3]::bigint) * 1000;
    IF m[4] IS NOT NULL THEN ms := ms + rpad(m[4], 3, '0')::bigint; END IF;
    RETURN ms;
  END IF;

  m := regexp_match(s, '^(\d+):([0-5]?\d)(?:[.,](\d{1,3}))?$');
  IF m IS NOT NULL THEN
    ms := (m[1]::bigint * 60 + m[2]::bigint) * 1000;
    IF m[3] IS NOT NULL THEN ms := ms + rpad(m[3], 3, '0')::bigint; END IF;
    RETURN ms;
  END IF;

  m := regexp_match(s, '^(\d+(?:[.,]\d+)?)$');
  IF m IS NOT NULL THEN
    RETURN round(replace(m[1], ',', '.')::numeric * 1000)::bigint;
  END IF;

  RETURN NULL;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.format_race_time_ms(_ms bigint)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE STRICT
SET search_path TO 'public'
AS $fn$
DECLARE
  total_cs bigint;
  mins bigint;
  secs bigint;
  cs bigint;
BEGIN
  IF _ms < 0 THEN RETURN NULL; END IF;
  total_cs := (_ms + 5) / 10;
  mins := total_cs / 6000;
  secs := (total_cs / 100) % 60;
  cs := total_cs % 100;
  RETURN mins::text || ':' || lpad(secs::text, 2, '0') || '.' || lpad(cs::text, 2, '0');
END;
$fn$;

-- 4. Backfill from contest_pool_crews
DO $backfill$
DECLARE
  v_bad integer;
  v_races integer;
  v_competitors integer;
  v_entries integer;
  v_results integer;
BEGIN
  SELECT count(*) INTO v_bad FROM (
    SELECT cp.contest_template_id, cpc.crew_id, cpc.event_id
    FROM public.contest_pool_crews cpc
    JOIN public.contest_pools cp ON cp.id = cpc.contest_pool_id
    WHERE cpc.manual_finish_order IS NOT NULL
    GROUP BY 1,2,3
    HAVING count(DISTINCT cpc.manual_finish_order) > 1
  ) x;
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'backfill aborted: % (template, crew, event) tuples have conflicting manual_finish_order across sibling pools', v_bad;
  END IF;

  SELECT count(*) INTO v_bad FROM (
    SELECT cp.contest_template_id, cpc.crew_id
    FROM public.contest_pool_crews cpc
    JOIN public.contest_pools cp ON cp.id = cpc.contest_pool_id
    GROUP BY 1,2
    HAVING count(DISTINCT cpc.event_id) > 1
  ) y;
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'backfill aborted: % (template, crew) pairs span more than one event_id', v_bad;
  END IF;

  INSERT INTO public.contest_races (template_id, race_key, name, race_order)
  SELECT t.contest_template_id, t.event_id, t.event_id,
         (row_number() OVER (PARTITION BY t.contest_template_id ORDER BY t.event_id))::int - 1
  FROM (
    SELECT DISTINCT cp.contest_template_id, cpc.event_id
    FROM public.contest_pool_crews cpc
    JOIN public.contest_pools cp ON cp.id = cpc.contest_pool_id
  ) t
  ON CONFLICT (template_id, race_key) DO NOTHING;
  GET DIAGNOSTICS v_races = ROW_COUNT;

  INSERT INTO public.contest_competitors (template_id, competitor_key, name, logo_url, competitor_type)
  SELECT cp.contest_template_id,
         cpc.crew_id,
         COALESCE((array_agg(cpc.crew_name) FILTER (WHERE cpc.crew_name IS NOT NULL))[1], cpc.crew_id),
         (array_agg(cpc.logo_url) FILTER (WHERE cpc.logo_url IS NOT NULL))[1],
         'crew'
  FROM public.contest_pool_crews cpc
  JOIN public.contest_pools cp ON cp.id = cpc.contest_pool_id
  GROUP BY cp.contest_template_id, cpc.crew_id
  ON CONFLICT (template_id, competitor_key) DO NOTHING;
  GET DIAGNOSTICS v_competitors = ROW_COUNT;

  INSERT INTO public.contest_race_entries (race_id, competitor_id)
  SELECT DISTINCT r.id, c.id
  FROM public.contest_pool_crews cpc
  JOIN public.contest_pools cp ON cp.id = cpc.contest_pool_id
  JOIN public.contest_races r ON r.template_id = cp.contest_template_id AND r.race_key = cpc.event_id
  JOIN public.contest_competitors c ON c.template_id = cp.contest_template_id AND c.competitor_key = cpc.crew_id
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_entries = ROW_COUNT;

  INSERT INTO public.contest_race_results (race_id, competitor_id, place, time_ms, status)
  SELECT r.id, c.id,
         (array_agg(cpc.manual_finish_order) FILTER (WHERE cpc.manual_finish_order IS NOT NULL))[1],
         public.parse_race_time_ms((array_agg(cpc.manual_result_time) FILTER (WHERE cpc.manual_result_time IS NOT NULL))[1]),
         'OK'
  FROM public.contest_pool_crews cpc
  JOIN public.contest_pools cp ON cp.id = cpc.contest_pool_id
  JOIN public.contest_races r ON r.template_id = cp.contest_template_id AND r.race_key = cpc.event_id
  JOIN public.contest_competitors c ON c.template_id = cp.contest_template_id AND c.competitor_key = cpc.crew_id
  GROUP BY r.id, c.id
  HAVING count(cpc.manual_finish_order) > 0
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_results = ROW_COUNT;

  RAISE NOTICE 'Phase1a backfill: races=%, competitors=%, entries=%, results=%', v_races, v_competitors, v_entries, v_results;
END;
$backfill$;

-- 5. admin_create_contest_v2
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
  _admin_user_id uuid DEFAULT NULL
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
  IF p_min_picks > v_race_count THEN RAISE EXCEPTION 'p_min_picks (%) exceeds race count (%)', p_min_picks, v_race_count; END IF;
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

REVOKE EXECUTE ON FUNCTION public.admin_create_contest_v2(text, text, text, timestamptz, jsonb, jsonb, jsonb, bigint, integer, jsonb, jsonb, boolean, boolean, text, text, uuid, text, text, jsonb, integer, integer, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_create_contest_v2(text, text, text, timestamptz, jsonb, jsonb, jsonb, bigint, integer, jsonb, jsonb, boolean, boolean, text, text, uuid, text, text, jsonb, integer, integer, uuid) TO service_role;

-- 6. admin_update_race_results_v2
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
        manual_result_time = COALESCE(v_finish_time, CASE WHEN v_time_ms IS NULL THEN NULL ELSE public.format_race_time_ms(v_time_ms) END)
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