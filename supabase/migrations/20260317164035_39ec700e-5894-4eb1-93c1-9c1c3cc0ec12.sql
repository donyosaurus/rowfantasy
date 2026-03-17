
-- New overload of admin_create_contest that accepts p_tiers JSONB array
-- When p_tiers is provided, creates one pool per tier instead of a single pool
CREATE OR REPLACE FUNCTION public.admin_create_contest(
  p_regatta_name text,
  p_gender_category text,
  p_entry_fee_cents bigint,
  p_max_entries integer,
  p_lock_time timestamp with time zone,
  p_crews jsonb,
  p_payout_structure jsonb DEFAULT NULL::jsonb,
  p_allow_overflow boolean DEFAULT false,
  p_tiers jsonb DEFAULT NULL::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_template_id uuid;
  v_pool_id uuid;
  v_crew record;
  v_crews_added integer := 0;
  v_total_payout bigint := 0;
  v_tier_id text;
  v_tier jsonb;
  v_tier_name text;
  v_tier_fee bigint;
  v_tier_max integer;
  v_tier_payout jsonb;
  v_tier_overflow boolean;
  v_tier_payout_total bigint;
  v_pools_created integer := 0;
  v_first_pool_id uuid;
BEGIN
  IF p_regatta_name IS NULL OR p_regatta_name = '' THEN
    RAISE EXCEPTION 'Regatta name is required';
  END IF;

  -- Create the contest template (shared across all tiers)
  INSERT INTO public.contest_templates (
    regatta_name,
    gender_category,
    lock_time,
    status,
    crews,
    divisions,
    entry_tiers,
    min_picks,
    max_picks
  ) VALUES (
    p_regatta_name,
    p_gender_category,
    p_lock_time,
    'open',
    p_crews,
    '[]'::jsonb,
    COALESCE(p_tiers, '[]'::jsonb),
    2,
    10
  )
  RETURNING id INTO v_template_id;

  -- If p_tiers is provided and non-empty, create multiple pools
  IF p_tiers IS NOT NULL AND jsonb_array_length(p_tiers) > 0 THEN
    FOR v_tier IN SELECT * FROM jsonb_array_elements(p_tiers)
    LOOP
      v_tier_name := COALESCE(v_tier->>'name', 'default');
      v_tier_fee := (v_tier->>'entry_fee_cents')::bigint;
      v_tier_max := (v_tier->>'max_entries')::integer;
      v_tier_payout := v_tier->'payout_structure';
      v_tier_overflow := COALESCE((v_tier->>'allow_overflow')::boolean, false);
      
      -- Calculate tier payout total
      v_tier_payout_total := 0;
      IF v_tier_payout IS NOT NULL THEN
        SELECT COALESCE(SUM((value)::bigint), 0)
        INTO v_tier_payout_total
        FROM jsonb_each_text(v_tier_payout);
      END IF;

      -- Slugify tier name for tier_id
      v_tier_id := lower(regexp_replace(v_tier_name, '[^a-zA-Z0-9]+', '_', 'g'));

      INSERT INTO public.contest_pools (
        contest_template_id,
        tier_id,
        entry_fee_cents,
        prize_pool_cents,
        max_entries,
        lock_time,
        status,
        payout_structure,
        allow_overflow
      ) VALUES (
        v_template_id,
        v_tier_id,
        v_tier_fee,
        v_tier_payout_total,
        v_tier_max,
        p_lock_time,
        'open',
        v_tier_payout,
        v_tier_overflow
      )
      RETURNING id INTO v_pool_id;

      IF v_first_pool_id IS NULL THEN
        v_first_pool_id := v_pool_id;
      END IF;

      -- Copy crews into this pool
      FOR v_crew IN SELECT * FROM jsonb_to_recordset(p_crews) AS x(crew_name text, crew_id text, event_id text)
      LOOP
        INSERT INTO public.contest_pool_crews (
          contest_pool_id,
          crew_id,
          crew_name,
          event_id
        ) VALUES (
          v_pool_id,
          v_crew.crew_id,
          v_crew.crew_name,
          v_crew.event_id
        );
      END LOOP;

      v_pools_created := v_pools_created + 1;
    END LOOP;

    -- Count crews from the JSON array
    SELECT jsonb_array_length(p_crews) INTO v_crews_added;

    RETURN jsonb_build_object(
      'success', true,
      'contest_template_id', v_template_id,
      'contest_pool_id', v_first_pool_id,
      'pools_created', v_pools_created,
      'crews_added', v_crews_added
    );
  ELSE
    -- Single-tier fallback (original behavior)
    IF p_payout_structure IS NOT NULL THEN
      SELECT COALESCE(SUM((value)::bigint), 0)
      INTO v_total_payout
      FROM jsonb_each_text(p_payout_structure);
    END IF;

    v_tier_id := 'tier_' || p_entry_fee_cents::text;

    INSERT INTO public.contest_pools (
      contest_template_id,
      tier_id,
      entry_fee_cents,
      prize_pool_cents,
      max_entries,
      lock_time,
      status,
      payout_structure,
      allow_overflow
    ) VALUES (
      v_template_id,
      v_tier_id,
      p_entry_fee_cents,
      v_total_payout,
      p_max_entries,
      p_lock_time,
      'open',
      p_payout_structure,
      p_allow_overflow
    )
    RETURNING id INTO v_pool_id;

    FOR v_crew IN SELECT * FROM jsonb_to_recordset(p_crews) AS x(crew_name text, crew_id text, event_id text)
    LOOP
      INSERT INTO public.contest_pool_crews (
        contest_pool_id,
        crew_id,
        crew_name,
        event_id
      ) VALUES (
        v_pool_id,
        v_crew.crew_id,
        v_crew.crew_name,
        v_crew.event_id
      );
      v_crews_added := v_crews_added + 1;
    END LOOP;

    RETURN jsonb_build_object(
      'success', true,
      'contest_template_id', v_template_id,
      'contest_pool_id', v_pool_id,
      'crews_added', v_crews_added,
      'total_payout_cents', v_total_payout
    );
  END IF;
END;
$function$;
