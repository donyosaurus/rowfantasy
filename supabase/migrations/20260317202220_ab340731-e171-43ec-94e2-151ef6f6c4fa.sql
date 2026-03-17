
-- Drop ALL overloaded versions of admin_create_contest
DROP FUNCTION IF EXISTS public.admin_create_contest(text, text, bigint, integer, timestamptz, jsonb, jsonb);
DROP FUNCTION IF EXISTS public.admin_create_contest(text, text, bigint, integer, timestamptz, jsonb, jsonb, boolean);
DROP FUNCTION IF EXISTS public.admin_create_contest(text, text, bigint, integer, timestamptz, jsonb, jsonb, boolean, jsonb);

-- Recreate single clean version with logo_url support
CREATE OR REPLACE FUNCTION public.admin_create_contest(
  p_regatta_name text,
  p_gender_category text,
  p_entry_fee_cents bigint,
  p_max_entries integer,
  p_lock_time timestamp with time zone,
  p_crews jsonb,
  p_payout_structure jsonb DEFAULT NULL::jsonb,
  p_allow_overflow boolean DEFAULT false
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
BEGIN
  IF p_regatta_name IS NULL OR p_regatta_name = '' THEN
    RAISE EXCEPTION 'Regatta name is required';
  END IF;

  -- Calculate total payout from structure
  IF p_payout_structure IS NOT NULL THEN
    SELECT COALESCE(SUM((value)::bigint), 0)
    INTO v_total_payout
    FROM jsonb_each_text(p_payout_structure);
  END IF;

  -- Generate tier_id based on entry fee
  v_tier_id := 'tier_' || p_entry_fee_cents::text;

  -- Create the contest template
  INSERT INTO public.contest_templates (
    regatta_name, gender_category, lock_time, status, crews, divisions, entry_tiers, min_picks, max_picks
  ) VALUES (
    p_regatta_name, p_gender_category, p_lock_time, 'open', p_crews, '[]'::jsonb, '[]'::jsonb, 2, 4
  )
  RETURNING id INTO v_template_id;

  -- Create the contest pool
  INSERT INTO public.contest_pools (
    contest_template_id, tier_id, entry_fee_cents, prize_pool_cents, max_entries, lock_time, status, payout_structure, allow_overflow
  ) VALUES (
    v_template_id, v_tier_id, p_entry_fee_cents, v_total_payout, p_max_entries, p_lock_time, 'open', p_payout_structure, p_allow_overflow
  )
  RETURNING id INTO v_pool_id;

  -- Insert crews into contest_pool_crews WITH logo_url
  FOR v_crew IN SELECT * FROM jsonb_array_elements(p_crews)
  LOOP
    INSERT INTO public.contest_pool_crews (contest_pool_id, crew_id, crew_name, event_id, logo_url)
    VALUES (v_pool_id, v_crew->>'crew_id', v_crew->>'crew_name', v_crew->>'event_id', v_crew->>'logo_url');
    v_crews_added := v_crews_added + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'contest_template_id', v_template_id,
    'contest_pool_id', v_pool_id,
    'crews_added', v_crews_added,
    'total_payout_cents', v_total_payout
  );
END;
$function$;
