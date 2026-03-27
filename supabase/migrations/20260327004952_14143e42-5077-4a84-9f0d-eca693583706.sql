
CREATE OR REPLACE FUNCTION public.admin_create_contest(p_regatta_name text, p_gender_category text, p_entry_fee_cents bigint, p_max_entries integer, p_lock_time timestamp with time zone, p_crews jsonb, p_payout_structure jsonb DEFAULT NULL::jsonb, p_allow_overflow boolean DEFAULT false, p_entry_tiers jsonb DEFAULT NULL::jsonb, p_banner_url text DEFAULT NULL::text, p_contest_group_id uuid DEFAULT NULL::uuid, p_void_unfilled_on_settle boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_template_id uuid;
  v_pool_id uuid;
  v_crew jsonb;
  v_crews_added integer := 0;
  v_total_payout bigint := 0;
  v_tier_id text;
  v_tier jsonb;
  v_tier_fee bigint;
  v_tier_payout jsonb;
  v_tier_name text;
  v_tier_total bigint;
  v_first_pool_id uuid;
  v_pools_created integer := 0;
BEGIN
  IF p_regatta_name IS NULL OR p_regatta_name = '' THEN
    RAISE EXCEPTION 'Regatta name is required';
  END IF;

  INSERT INTO public.contest_templates (
    regatta_name, gender_category, lock_time, status, crews, divisions, entry_tiers, min_picks, max_picks, banner_url, contest_group_id
  ) VALUES (
    p_regatta_name, p_gender_category, p_lock_time, 'open', p_crews, '[]'::jsonb, COALESCE(p_entry_tiers, '[]'::jsonb), 2, 4, p_banner_url, p_contest_group_id
  )
  RETURNING id INTO v_template_id;

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

      IF v_first_pool_id IS NULL THEN
        v_first_pool_id := v_pool_id;
      END IF;

      v_crews_added := 0;
      FOR v_crew IN SELECT * FROM jsonb_array_elements(p_crews)
      LOOP
        INSERT INTO public.contest_pool_crews (contest_pool_id, crew_id, crew_name, event_id, logo_url)
        VALUES (v_pool_id, v_crew->>'crew_id', v_crew->>'crew_name', v_crew->>'event_id', v_crew->>'logo_url');
        v_crews_added := v_crews_added + 1;
      END LOOP;

      v_pools_created := v_pools_created + 1;
    END LOOP;
  ELSE
    IF p_payout_structure IS NOT NULL THEN
      SELECT COALESCE(SUM((value)::bigint), 0)
      INTO v_total_payout
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

    FOR v_crew IN SELECT * FROM jsonb_array_elements(p_crews)
    LOOP
      INSERT INTO public.contest_pool_crews (contest_pool_id, crew_id, crew_name, event_id, logo_url)
      VALUES (v_pool_id, v_crew->>'crew_id', v_crew->>'crew_name', v_crew->>'event_id', v_crew->>'logo_url');
      v_crews_added := v_crews_added + 1;
    END LOOP;

    v_pools_created := 1;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'contest_template_id', v_template_id,
    'contest_pool_id', v_first_pool_id,
    'crews_added', v_crews_added,
    'pools_created', v_pools_created,
    'total_payout_cents', v_total_payout
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.clone_contest_pool(p_original_pool_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_original_pool RECORD;
  v_new_pool_id uuid;
BEGIN
  SELECT * INTO v_original_pool FROM contest_pools WHERE id = p_original_pool_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Original pool not found: %', p_original_pool_id; END IF;

  INSERT INTO contest_pools (
    contest_template_id, entry_fee_cents, max_entries, lock_time, prize_pool_cents,
    payout_structure, tier_id, tier_name, allow_overflow, status, current_entries, entry_tiers, void_unfilled_on_settle
  ) VALUES (
    v_original_pool.contest_template_id, v_original_pool.entry_fee_cents, v_original_pool.max_entries,
    v_original_pool.lock_time, v_original_pool.prize_pool_cents, v_original_pool.payout_structure,
    v_original_pool.tier_id, v_original_pool.tier_name, v_original_pool.allow_overflow, 'open', 0, v_original_pool.entry_tiers, v_original_pool.void_unfilled_on_settle
  )
  RETURNING id INTO v_new_pool_id;

  INSERT INTO contest_pool_crews (contest_pool_id, crew_id, crew_name, event_id, logo_url)
  SELECT v_new_pool_id, crew_id, crew_name, event_id, logo_url
  FROM contest_pool_crews WHERE contest_pool_id = p_original_pool_id;

  RETURN v_new_pool_id;
END;
$function$;
