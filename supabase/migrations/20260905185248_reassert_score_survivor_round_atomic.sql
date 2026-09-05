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
      AND (v_accumulate OR NOT EXISTS (
        SELECT 1 FROM contest_rounds r0
        WHERE r0.template_id = p_template_id AND r0.status = 'scored'
          AND NOT EXISTS (
            SELECT 1 FROM contest_entry_rounds er0
            WHERE er0.entry_id = ce.id AND er0.round_no = r0.round_no AND er0.advanced = true)))
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

DO $$
BEGIN
  IF (
    SELECT count(*)
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'score_survivor_round_atomic'
  ) <> 1 THEN
    RAISE EXCEPTION 'score_survivor_round_atomic must have exactly 1 overload';
  END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';
