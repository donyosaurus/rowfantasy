-- Phase 4f fix batch: close no_reuse forward-reuse hole and mode-branch
-- the three alive predicates in score_survivor_round_atomic.
-- Only submit_survivor_round_picks and score_survivor_round_atomic are
-- recreated here; ACLs are restated and overloads asserted.

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
          AND er.round_no <> _round_no
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
  INTO v_target_id, v_advance_count
  FROM contest_rounds cr
  WHERE cr.id = v_target_id AND cr.status = 'locked'
  FOR UPDATE OF cr;

  IF v_target_id IS NULL THEN
    RAISE EXCEPTION 'no round is ready to score';
  END IF;

  -- 5. Lower-round completeness
  SELECT count(*) INTO v_unscored_before
  FROM contest_rounds cr
  WHERE cr.template_id = p_template_id
    AND cr.round_no < v_target
    AND cr.status <> 'scored';

  IF v_unscored_before > 0 THEN
    RAISE EXCEPTION 'rounds must be scored in order';
  END IF;

  -- 6. Every race in this round must have a manual_result_time on every crew.
  SELECT count(DISTINCT r.id), count(re.id)
  INTO v_race_count, v_incomplete
  FROM contest_races r
  LEFT JOIN contest_race_entries re
    ON re.race_id = r.id
   AND re.manual_result_time IS NULL
  WHERE r.template_id = p_template_id AND r.round_no = v_target;

  IF v_race_count = 0 OR v_incomplete > 0 THEN
    RAISE EXCEPTION 'results incomplete';
  END IF;

  -- 7. Validate every active entry has a picks array for the target round.
  SELECT count(*) INTO v_unmatched
  FROM contest_entries ce
  JOIN contest_pools cp ON cp.id = ce.pool_id
  WHERE cp.contest_template_id = p_template_id
    AND ce.status = 'active'
    AND (v_accumulate OR NOT EXISTS (
      SELECT 1 FROM contest_rounds r0
      WHERE r0.template_id = p_template_id AND r0.status = 'scored'
        AND NOT EXISTS (
          SELECT 1 FROM contest_entry_rounds er0
          WHERE er0.entry_id = ce.id AND er0.round_no = r0.round_no AND er0.advanced = true)))
    AND NOT EXISTS (
      SELECT 1 FROM contest_entry_rounds er
      WHERE er.entry_id = ce.id AND er.round_no = v_target
    );

  IF v_unmatched > 0 THEN
    RAISE EXCEPTION 'unmatched entries';
  END IF;

  -- 8. Score each entry in this round.
  UPDATE contest_entry_rounds er
  SET points = sub.pts
  FROM (
    SELECT ce.id AS entry_id,
           COALESCE(SUM(
             CASE
               WHEN elem->>'finishOrder' = '1' THEN GREATEST(COALESCE((v_scoring_config->>'points_first')::int, 10), 0)
               WHEN elem->>'finishOrder' = '2' THEN GREATEST(COALESCE((v_scoring_config->>'points_second')::int, 8), 0)
               WHEN elem->>'finishOrder' = '3' THEN GREATEST(COALESCE((v_scoring_config->>'points_third')::int, 6), 0)
               ELSE 0
             END
           ), 0) AS pts
    FROM contest_entries ce
    JOIN contest_entry_rounds er2 ON er2.entry_id = ce.id AND er2.round_no = v_target
    CROSS JOIN LATERAL jsonb_array_elements(er2.picks) AS elem
    JOIN contest_races r
      ON r.template_id = p_template_id
     AND r.round_no = v_target
     AND r.race_key = elem->>'event_id'
    JOIN contest_race_entries re
      ON re.race_id = r.id
     AND re.manual_finish_order = (elem->>'finishOrder')::int
    JOIN contest_competitors c
      ON c.template_id = p_template_id
     AND c.competitor_key = elem->>'crewId'
     AND c.id = re.competitor_id
    WHERE ce.pool_id = v_pool.id
      AND ce.status = 'active'
      AND (v_accumulate OR NOT EXISTS (
        SELECT 1 FROM contest_rounds r0
        WHERE r0.template_id = p_template_id AND r0.status = 'scored'
          AND NOT EXISTS (
            SELECT 1 FROM contest_entry_rounds er0
            WHERE er0.entry_id = ce.id AND er0.round_no = r0.round_no AND er0.advanced = true)))
  ) sub
  WHERE er.entry_id = sub.entry_id AND er.round_no = v_target;

  SELECT count(*) INTO v_scored_count
  FROM contest_entries ce
  JOIN contest_entry_rounds er ON er.entry_id = ce.id AND er.round_no = v_target
  WHERE ce.pool_id = v_pool.id
    AND ce.status = 'active'
    AND (v_accumulate OR NOT EXISTS (
      SELECT 1 FROM contest_rounds r0
      WHERE r0.template_id = p_template_id AND r0.status = 'scored'
        AND NOT EXISTS (
          SELECT 1 FROM contest_entry_rounds er0
          WHERE er0.entry_id = ce.id AND er0.round_no = r0.round_no AND er0.advanced = true)));

  IF v_scored_count = 0 THEN
    RAISE EXCEPTION 'no entries to score';
  END IF;

  -- 9. Mark the round scored.
  UPDATE contest_rounds SET status = 'scored', scored_at = now()
  WHERE id = v_target_id;

  -- 10. Determine advancement.
  IF v_accumulate THEN
    -- Accumulate mode: every active entry that submitted a pick advances.
    UPDATE contest_entry_rounds er
    SET advanced = true
    FROM contest_entries ce
    WHERE er.entry_id = ce.id
      AND er.round_no = v_target
      AND ce.pool_id = v_pool.id
      AND ce.status = 'active';

    SELECT count(*) INTO v_advancers
    FROM contest_entry_rounds er
    JOIN contest_entries ce ON ce.id = er.entry_id
    WHERE ce.pool_id = v_pool.id
      AND er.round_no = v_target
      AND er.advanced = true;

    SELECT count(*) INTO v_alive_count
    FROM contest_entries ce
    WHERE ce.pool_id = v_pool.id
      AND ce.status = 'active';

    IF v_target = v_max_round THEN
      v_finalize := true;
    ELSE
      v_finalize := false;
    END IF;
  ELSE
    -- Eliminate mode: top N by points (then margin) advance; ties at the
    -- threshold are allowed to advance together.
    SELECT count(*) INTO v_alive_count
    FROM contest_entries ce
    WHERE ce.pool_id = v_pool.id
      AND ce.status = 'active'
      AND NOT EXISTS (
        SELECT 1 FROM contest_rounds r0
        WHERE r0.template_id = p_template_id AND r0.status = 'scored'
          AND NOT EXISTS (
            SELECT 1 FROM contest_entry_rounds er0
            WHERE er0.entry_id = ce.id AND er0.round_no = r0.round_no AND er0.advanced = true));

    SELECT min(rank_threshold) INTO v_threshold
    FROM (
      SELECT pts, margin, rank() OVER (ORDER BY pts DESC, margin ASC) AS rank_threshold
      FROM (
        SELECT ce.id,
               COALESCE(SUM(er.points), 0)::int AS pts,
               COALESCE((
                 SELECT SUM((c->>'marginError')::numeric)
                 FROM jsonb_array_elements(er.crew_scores) c
               ), 0) AS margin
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
        GROUP BY ce.id, er.crew_scores
      ) t
    ) ranked
    WHERE rank_threshold <= v_advance_count;

    UPDATE contest_entry_rounds er
    SET advanced = true
    WHERE er.entry_id IN (
      SELECT ce.id
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
      GROUP BY ce.id, er2.points, er2.crew_scores
      HAVING COALESCE(SUM(er2.points), 0)::int > COALESCE(v_threshold, 0)
         OR (COALESCE(SUM(er2.points), 0)::int = COALESCE(v_threshold, 0)
             AND COALESCE((SELECT SUM((c->>'marginError')::numeric) FROM jsonb_array_elements(er2.crew_scores) c), 0)
                 <= COALESCE((SELECT SUM((c->>'marginError')::numeric) FROM jsonb_array_elements(er2.crew_scores) c), 0))
    );

    SELECT count(*) INTO v_advancers
    FROM contest_entry_rounds er
    JOIN contest_entries ce ON ce.id = er.entry_id
    WHERE ce.pool_id = v_pool.id
      AND er.round_no = v_target
      AND er.advanced = true;

    -- Eliminate entries that did not advance.
    UPDATE contest_entries ce
    SET status = 'eliminated'
    WHERE ce.pool_id = v_pool.id
      AND ce.status = 'active'
      AND NOT EXISTS (
        SELECT 1 FROM contest_entry_rounds er
        WHERE er.entry_id = ce.id AND er.round_no = v_target AND er.advanced = true);

    -- Count remaining alive.
    SELECT count(*) INTO v_alive_count
    FROM contest_entries ce
    WHERE ce.pool_id = v_pool.id
      AND ce.status = 'active';

    IF v_alive_count <= v_advance_count THEN
      v_finalize := true;
    END IF;
  END IF;

  -- 11. Finalize if needed.
  IF v_finalize THEN
    -- Compute final rankings and settle pool.
    UPDATE contest_pools
    SET status = 'settling'
    WHERE id = v_pool.id;

    -- Determine winners and settle.
    WITH final_standings AS (
      SELECT ce.id,
             COALESCE(SUM(er.points), 0)::int AS total_points,
             COALESCE((SELECT SUM((c->>'marginError')::numeric) FROM jsonb_array_elements(er.crew_scores) c), 0) AS total_margin
      FROM contest_entries ce
      JOIN contest_entry_rounds er ON er.entry_id = ce.id
      WHERE ce.pool_id = v_pool.id
      GROUP BY ce.id
    ),
    ranked AS (
      SELECT id, total_points, total_margin,
             RANK() OVER (ORDER BY total_points DESC, total_margin ASC) AS rnk
      FROM final_standings
    ),
    top_rank AS (
      SELECT rnk FROM ranked ORDER BY rnk LIMIT 1
    )
    SELECT array_agg(id) INTO v_winner_ids
    FROM ranked
    WHERE rnk = (SELECT rnk FROM top_rank);

    IF array_length(v_winner_ids, 1) = 1 THEN
      -- Single winner: normal settlement.
      UPDATE contest_pools
      SET status = 'settled', winner_ids = v_winner_ids, settled_at = now()
      WHERE id = v_pool.id;
    ELSE
      -- Multiple winners: tie refund.
      UPDATE contest_pools
      SET status = 'voided', voided_at = now(), void_reason = 'survivor tie refund'
      WHERE id = v_pool.id;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'round_no', v_target,
    'pools_scored', v_pools_scored,
    'pools_finalized', v_pools_finalized,
    'advancers', COALESCE(v_advancers, 0),
    'alive', COALESCE(v_alive_count, 0),
    'finalized', COALESCE(v_finalize, false)
  );
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.submit_survivor_round_picks(uuid, uuid, integer, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.submit_survivor_round_picks(uuid, uuid, integer, jsonb) TO service_role;

REVOKE EXECUTE ON FUNCTION public.score_survivor_round_atomic(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.score_survivor_round_atomic(uuid, uuid) TO service_role;

DO $do$
DECLARE
  v_overloads integer;
  v_name text;
BEGIN
  FOREACH v_name IN ARRAY ARRAY['submit_survivor_round_picks','score_survivor_round_atomic'] LOOP
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