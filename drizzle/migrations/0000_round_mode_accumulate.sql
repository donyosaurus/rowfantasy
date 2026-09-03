ALTER TABLE public.contest_rounds
  ADD COLUMN IF NOT EXISTS round_mode text NOT NULL DEFAULT 'eliminate';

DO $c$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.contest_rounds'::regclass AND conname = 'contest_rounds_round_mode_check'
  ) THEN
    ALTER TABLE public.contest_rounds
      ADD CONSTRAINT contest_rounds_round_mode_check CHECK (round_mode IN ('eliminate','accumulate'));
  END IF;
END
$c$;

DO $mig$
DECLARE
  d text;
  o text;
  n text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO d FROM pg_proc p
    JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'admin_create_contest_v2';
  IF d IS NULL THEN RAISE EXCEPTION 'missing admin_create_contest_v2'; END IF;
  o := $p1a$    IF p_rounds IS NULL OR jsonb_typeof(p_rounds) <> 'array' OR jsonb_array_length(p_rounds) < 2 THEN
$p1a$;
  n := $p1b$    IF p_scoring_config ? 'round_mode'
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
$p1b$;
  IF (length(d) - length(replace(d, o, ''))) / length(o) <> 1 THEN RAISE EXCEPTION 'anchor % not unique', 1; END IF;
  d := replace(d, o, n);
  o := $p2a$    IF (SELECT (e->>'advance_count')::int FROM jsonb_array_elements(p_rounds) e
$p2a$;
  n := $p2b$    IF COALESCE(p_scoring_config->>'round_mode', 'eliminate') = 'accumulate' THEN
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_rounds) e
      WHERE (e->>'advance_count')::int <> 1
    ) THEN
      RAISE EXCEPTION 'accumulate rounds must use advance_count 1';
    END IF;
    ELSE
    IF (SELECT (e->>'advance_count')::int FROM jsonb_array_elements(p_rounds) e
$p2b$;
  IF (length(d) - length(replace(d, o, ''))) / length(o) <> 1 THEN RAISE EXCEPTION 'anchor % not unique', 2; END IF;
  d := replace(d, o, n);
  o := $p3a$      RAISE EXCEPTION 'survivor advance_count must strictly decrease';
    END IF;
$p3a$;
  n := $p3b$      RAISE EXCEPTION 'survivor advance_count must strictly decrease';
    END IF;
    END IF;
$p3b$;
  IF (length(d) - length(replace(d, o, ''))) / length(o) <> 1 THEN RAISE EXCEPTION 'anchor % not unique', 3; END IF;
  d := replace(d, o, n);
  o := $p4a$    INSERT INTO public.contest_rounds (template_id, round_no, lock_at, advance_count)
    SELECT v_template_id,
           (e->>'round_no')::int,
           (e->>'lock_at')::timestamptz,
           (e->>'advance_count')::int
    FROM jsonb_array_elements(p_rounds) e;$p4a$;
  n := $p4b$    INSERT INTO public.contest_rounds (template_id, round_no, lock_at, advance_count, round_mode)
    SELECT v_template_id,
           (e->>'round_no')::int,
           (e->>'lock_at')::timestamptz,
           (e->>'advance_count')::int,
           COALESCE(p_scoring_config->>'round_mode', 'eliminate')
    FROM jsonb_array_elements(p_rounds) e;$p4b$;
  IF (length(d) - length(replace(d, o, ''))) / length(o) <> 1 THEN RAISE EXCEPTION 'anchor % not unique', 4; END IF;
  d := replace(d, o, n);
  EXECUTE d;
  SELECT pg_get_functiondef(p.oid) INTO d FROM pg_proc p
    JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'submit_survivor_round_picks';
  IF d IS NULL THEN RAISE EXCEPTION 'missing submit_survivor_round_picks'; END IF;
  o := $p5a$  _primitive text;
$p5a$;
  n := $p5b$  _primitive text;
  _scoring_config jsonb;
$p5b$;
  IF (length(d) - length(replace(d, o, ''))) / length(o) <> 1 THEN RAISE EXCEPTION 'anchor % not unique', 5; END IF;
  d := replace(d, o, n);
  o := $p6a$  SELECT scoring_config->>'primitive', min_picks, max_picks
  INTO _primitive, _min_picks, _max_picks$p6a$;
  n := $p6b$  SELECT scoring_config, scoring_config->>'primitive', min_picks, max_picks
  INTO _scoring_config, _primitive, _min_picks, _max_picks$p6b$;
  IF (length(d) - length(replace(d, o, ''))) / length(o) <> 1 THEN RAISE EXCEPTION 'anchor % not unique', 6; END IF;
  d := replace(d, o, n);
  o := $p7a$  -- Alive: advanced in every already-scored round.
$p7a$;
  n := $p7b$  IF COALESCE(_scoring_config->>'round_mode', 'eliminate') <> 'accumulate' THEN
  -- Alive: advanced in every already-scored round.
$p7b$;
  IF (length(d) - length(replace(d, o, ''))) / length(o) <> 1 THEN RAISE EXCEPTION 'anchor % not unique', 7; END IF;
  d := replace(d, o, n);
  o := $p8a$    RETURN jsonb_build_object('allowed', false, 'reason', 'eliminated');
  END IF;
$p8a$;
  n := $p8b$    RETURN jsonb_build_object('allowed', false, 'reason', 'eliminated');
  END IF;
  END IF;
$p8b$;
  IF (length(d) - length(replace(d, o, ''))) / length(o) <> 1 THEN RAISE EXCEPTION 'anchor % not unique', 8; END IF;
  d := replace(d, o, n);
  o := $p9a$  INSERT INTO contest_entry_rounds (entry_id, template_id, round_no, picks)
$p9a$;
  n := $p9b$  IF COALESCE((_scoring_config->>'no_reuse')::boolean, false) THEN
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
$p9b$;
  IF (length(d) - length(replace(d, o, ''))) / length(o) <> 1 THEN RAISE EXCEPTION 'anchor % not unique', 9; END IF;
  d := replace(d, o, n);
  EXECUTE d;
  SELECT pg_get_functiondef(p.oid) INTO d FROM pg_proc p
    JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'score_survivor_round_atomic';
  IF d IS NULL THEN RAISE EXCEPTION 'missing score_survivor_round_atomic'; END IF;
  o := $p10a$  v_lock_id uuid;
$p10a$;
  n := $p10b$  v_lock_id uuid;
  v_accumulate boolean;
$p10b$;
  IF (length(d) - length(replace(d, o, ''))) / length(o) <> 1 THEN RAISE EXCEPTION 'anchor % not unique', 10; END IF;
  d := replace(d, o, n);
  o := $p11a$    RAISE EXCEPTION 'not a survivor template';
  END IF;
$p11a$;
  n := $p11b$    RAISE EXCEPTION 'not a survivor template';
  END IF;

  v_accumulate := COALESCE(v_scoring_config->>'round_mode', 'eliminate') = 'accumulate';

  IF EXISTS (
    SELECT 1 FROM contest_rounds cr
    WHERE cr.template_id = p_template_id
      AND cr.round_mode IS DISTINCT FROM CASE WHEN v_accumulate THEN 'accumulate' ELSE 'eliminate' END
  ) THEN
    RAISE EXCEPTION 'mixed round modes';
  END IF;
$p11b$;
  IF (length(d) - length(replace(d, o, ''))) / length(o) <> 1 THEN RAISE EXCEPTION 'anchor % not unique', 11; END IF;
  d := replace(d, o, n);
  o := $p12a$    v_threshold := NULL;
$p12a$;
  n := $p12b$    IF v_accumulate THEN
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
$p12b$;
  IF (length(d) - length(replace(d, o, ''))) / length(o) <> 1 THEN RAISE EXCEPTION 'anchor % not unique', 12; END IF;
  d := replace(d, o, n);
  o := $p13a$        WHERE er2.entry_id = ce.id AND er2.round_no = v_target);

    SELECT count(*) INTO v_advancers$p13a$;
  n := $p13b$        WHERE er2.entry_id = ce.id AND er2.round_no = v_target);
    END IF;

    SELECT count(*) INTO v_advancers$p13b$;
  IF (length(d) - length(replace(d, o, ''))) / length(o) <> 1 THEN RAISE EXCEPTION 'anchor % not unique', 13; END IF;
  d := replace(d, o, n);
  o := $p14a$    v_finalize := (v_advancers <= 1) OR (v_target = v_max_round);$p14a$;
  n := $p14b$    v_finalize := CASE WHEN v_accumulate THEN (v_target = v_max_round)
                       ELSE (v_advancers <= 1) OR (v_target = v_max_round) END;$p14b$;
  IF (length(d) - length(replace(d, o, ''))) / length(o) <> 1 THEN RAISE EXCEPTION 'anchor % not unique', 14; END IF;
  d := replace(d, o, n);
  o := $p15a$      SELECT count(*) FILTER (WHERE f.rnk = 1), array_agg(f.user_id) FILTER (WHERE f.rnk = 1)
$p15a$;
  n := $p15b$      IF v_accumulate THEN
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
$p15b$;
  IF (length(d) - length(replace(d, o, ''))) / length(o) <> 1 THEN RAISE EXCEPTION 'anchor % not unique', 15; END IF;
  d := replace(d, o, n);
  o := $p16a$        WHERE ce.pool_id = v_pool.id AND ce.status = 'active'
      ) f;
$p16a$;
  n := $p16b$        WHERE ce.pool_id = v_pool.id AND ce.status = 'active'
      ) f;
      END IF;
$p16b$;
  IF (length(d) - length(replace(d, o, ''))) / length(o) <> 1 THEN RAISE EXCEPTION 'anchor % not unique', 16; END IF;
  d := replace(d, o, n);
  o := $p17a$      -- FIX 7: bound the aggregates to rounds up to and including the target so
$p17a$;
  n := $p17b$      IF v_accumulate THEN
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
$p17b$;
  IF (length(d) - length(replace(d, o, ''))) / length(o) <> 1 THEN RAISE EXCEPTION 'anchor % not unique', 17; END IF;
  d := replace(d, o, n);
  o := $p18a$      WHERE ce.id = f.entry_id;
$p18a$;
  n := $p18b$      WHERE ce.id = f.entry_id;
      END IF;
$p18b$;
  IF (length(d) - length(replace(d, o, ''))) / length(o) <> 1 THEN RAISE EXCEPTION 'anchor % not unique', 18; END IF;
  d := replace(d, o, n);
  EXECUTE d;
END
$mig$;

REVOKE ALL ON FUNCTION public.admin_create_contest_v2(text, text, text, timestamptz, jsonb, jsonb, jsonb, bigint, integer, jsonb, jsonb, boolean, boolean, text, text, uuid, text, text, jsonb, integer, integer, uuid, jsonb, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_create_contest_v2(text, text, text, timestamptz, jsonb, jsonb, jsonb, bigint, integer, jsonb, jsonb, boolean, boolean, text, text, uuid, text, text, jsonb, integer, integer, uuid, jsonb, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.admin_create_contest_v2(text, text, text, timestamptz, jsonb, jsonb, jsonb, bigint, integer, jsonb, jsonb, boolean, boolean, text, text, uuid, text, text, jsonb, integer, integer, uuid, jsonb, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.admin_create_contest_v2(text, text, text, timestamptz, jsonb, jsonb, jsonb, bigint, integer, jsonb, jsonb, boolean, boolean, text, text, uuid, text, text, jsonb, integer, integer, uuid, jsonb, jsonb) TO service_role;

REVOKE EXECUTE ON FUNCTION public.submit_survivor_round_picks(uuid, uuid, integer, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.submit_survivor_round_picks(uuid, uuid, integer, jsonb) TO service_role;

REVOKE EXECUTE ON FUNCTION public.score_survivor_round_atomic(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.score_survivor_round_atomic(uuid, uuid) TO service_role;

DO $do$
DECLARE
  v_overloads integer;
  v_name text;
BEGIN
  FOREACH v_name IN ARRAY ARRAY['admin_create_contest_v2','submit_survivor_round_picks','score_survivor_round_atomic'] LOOP
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