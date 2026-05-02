-- ============================================================
-- TIER 1 #5: Lock down SECURITY DEFINER admin/financial RPCs
-- ============================================================

-- =========================
-- CHANGE 1: CRITICAL real-money functions
-- =========================
REVOKE EXECUTE ON FUNCTION public.update_wallet_balance(uuid, bigint, bigint, bigint, bigint, bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.update_wallet_balance(uuid, bigint, bigint, bigint, bigint, bigint) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.update_wallet_balance(uuid, bigint, bigint, bigint, bigint, bigint) FROM anon;
GRANT EXECUTE ON FUNCTION public.update_wallet_balance(uuid, bigint, bigint, bigint, bigint, bigint) TO service_role;

REVOKE EXECUTE ON FUNCTION public.process_deposit_atomic(uuid, uuid, bigint, text, text, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.process_deposit_atomic(uuid, uuid, bigint, text, text, text, text) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.process_deposit_atomic(uuid, uuid, bigint, text, text, text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.process_deposit_atomic(uuid, uuid, bigint, text, text, text, text) TO service_role;

REVOKE EXECUTE ON FUNCTION public.initiate_withdrawal_atomic(uuid, uuid, bigint, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.initiate_withdrawal_atomic(uuid, uuid, bigint, text) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.initiate_withdrawal_atomic(uuid, uuid, bigint, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.initiate_withdrawal_atomic(uuid, uuid, bigint, text) TO service_role;

REVOKE EXECUTE ON FUNCTION public.enter_contest_pool_atomic(uuid, uuid, uuid, text, jsonb, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.enter_contest_pool_atomic(uuid, uuid, uuid, text, jsonb, text) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.enter_contest_pool_atomic(uuid, uuid, uuid, text, jsonb, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.enter_contest_pool_atomic(uuid, uuid, uuid, text, jsonb, text) TO service_role;

-- =========================
-- CHANGE 2: admin_update_race_results — add internal admin check, add _admin_user_id param, lock down
-- Drop existing 2-arg version to replace with new 3-arg signature
-- =========================
DROP FUNCTION IF EXISTS public.admin_update_race_results(uuid, jsonb);

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
  v_pool_exists boolean;
BEGIN
  -- STEP 0: Verify caller is admin (defense in depth)
  IF NOT EXISTS (
    SELECT 1 FROM user_roles ur
    JOIN auth.users u ON u.id = ur.user_id
    WHERE ur.user_id = _admin_user_id
      AND ur.role = 'admin'
  ) THEN
    RAISE EXCEPTION 'unauthorized: caller is not an admin';
  END IF;

  -- Verify the contest pool exists
  SELECT EXISTS (
    SELECT 1 FROM contest_pools WHERE id = p_contest_pool_id
  ) INTO v_pool_exists;

  IF NOT v_pool_exists THEN
    RAISE EXCEPTION 'Contest pool not found';
  END IF;

  -- Iterate through each result and update contest_pool_crews
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
GRANT EXECUTE ON FUNCTION public.admin_update_race_results(uuid, jsonb, uuid) TO service_role;

-- =========================
-- CHANGE 3: admin_create_contest — drop broken overloads, replace canonical with admin check + lock down
-- =========================
DROP FUNCTION IF EXISTS public.admin_create_contest(text, text, bigint, integer, timestamptz, jsonb, jsonb, boolean, jsonb, text);
DROP FUNCTION IF EXISTS public.admin_create_contest(text, text, bigint, integer, timestamptz, jsonb, jsonb, boolean, jsonb, text, uuid);
DROP FUNCTION IF EXISTS public.admin_create_contest(text, text, bigint, integer, timestamptz, jsonb, jsonb, boolean, jsonb, text, uuid, boolean);
-- Drop the canonical 13-arg too so we can replace with 14-arg signature cleanly
DROP FUNCTION IF EXISTS public.admin_create_contest(text, text, bigint, integer, timestamptz, jsonb, jsonb, boolean, jsonb, text, text, uuid, boolean);

CREATE OR REPLACE FUNCTION public.admin_create_contest(
  p_regatta_name text,
  p_gender_category text,
  p_entry_fee_cents bigint,
  p_max_entries integer,
  p_lock_time timestamp with time zone,
  p_crews jsonb,
  p_payout_structure jsonb DEFAULT NULL::jsonb,
  p_allow_overflow boolean DEFAULT false,
  p_entry_tiers jsonb DEFAULT NULL::jsonb,
  p_card_banner_url text DEFAULT NULL::text,
  p_draft_banner_url text DEFAULT NULL::text,
  p_contest_group_id uuid DEFAULT NULL::uuid,
  p_void_unfilled_on_settle boolean DEFAULT false,
  _admin_user_id uuid DEFAULT NULL::uuid
)
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
  -- STEP 0: Verify caller is admin (defense in depth)
  IF NOT EXISTS (
    SELECT 1 FROM user_roles ur
    JOIN auth.users u ON u.id = ur.user_id
    WHERE ur.user_id = _admin_user_id
      AND ur.role = 'admin'
  ) THEN
    RAISE EXCEPTION 'unauthorized: caller is not an admin';
  END IF;

  IF p_regatta_name IS NULL OR p_regatta_name = '' THEN
    RAISE EXCEPTION 'Regatta name is required';
  END IF;

  INSERT INTO public.contest_templates (
    regatta_name, gender_category, lock_time, status, crews, divisions, entry_tiers, min_picks, max_picks, card_banner_url, draft_banner_url, contest_group_id
  ) VALUES (
    p_regatta_name, p_gender_category, p_lock_time, 'open', p_crews, '[]'::jsonb, COALESCE(p_entry_tiers, '[]'::jsonb), 2, 4, p_card_banner_url, p_draft_banner_url, p_contest_group_id
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

REVOKE EXECUTE ON FUNCTION public.admin_create_contest(text, text, bigint, integer, timestamptz, jsonb, jsonb, boolean, jsonb, text, text, uuid, boolean, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.admin_create_contest(text, text, bigint, integer, timestamptz, jsonb, jsonb, boolean, jsonb, text, text, uuid, boolean, uuid) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.admin_create_contest(text, text, bigint, integer, timestamptz, jsonb, jsonb, boolean, jsonb, text, text, uuid, boolean, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_create_contest(text, text, bigint, integer, timestamptz, jsonb, jsonb, boolean, jsonb, text, text, uuid, boolean, uuid) TO service_role;

-- =========================
-- CHANGE 4: Drop dead code
-- =========================
DROP FUNCTION IF EXISTS public.calculate_pool_scores(uuid, numeric);

-- =========================
-- CHANGE 5: Lock helper functions
-- =========================
REVOKE EXECUTE ON FUNCTION public.clone_contest_pool(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.clone_contest_pool(uuid) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.clone_contest_pool(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.clone_contest_pool(uuid) TO service_role;

REVOKE EXECUTE ON FUNCTION public.increment_pool_entries(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.increment_pool_entries(uuid) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.increment_pool_entries(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.increment_pool_entries(uuid) TO service_role;

REVOKE EXECUTE ON FUNCTION public.check_deposit_limit(uuid, bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.check_deposit_limit(uuid, bigint) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.check_deposit_limit(uuid, bigint) FROM anon;
GRANT EXECUTE ON FUNCTION public.check_deposit_limit(uuid, bigint) TO service_role;