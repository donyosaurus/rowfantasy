
CREATE TABLE IF NOT EXISTS public.contest_groups (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  name text NOT NULL,
  description text DEFAULT NULL,
  display_order integer NOT NULL DEFAULT 0,
  is_visible boolean NOT NULL DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE public.contest_groups ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can view visible contest groups"
  ON public.contest_groups FOR SELECT
  TO public
  USING (is_visible = true);

CREATE POLICY "Admins can manage contest groups"
  ON public.contest_groups FOR ALL
  TO authenticated
  USING (has_role(auth.uid(), 'admin'))
  WITH CHECK (has_role(auth.uid(), 'admin'));

ALTER TABLE public.contest_templates
  ADD COLUMN IF NOT EXISTS contest_group_id uuid REFERENCES public.contest_groups(id) DEFAULT NULL;

ALTER TABLE public.contest_templates
  ADD COLUMN IF NOT EXISTS display_order_in_group integer DEFAULT 0;

CREATE OR REPLACE FUNCTION public.admin_create_contest(
  p_regatta_name text,
  p_gender_category text,
  p_entry_fee_cents bigint,
  p_max_entries integer,
  p_lock_time timestamp with time zone,
  p_crews jsonb,
  p_payout_structure jsonb DEFAULT NULL,
  p_allow_overflow boolean DEFAULT false,
  p_entry_tiers jsonb DEFAULT NULL,
  p_banner_url text DEFAULT NULL,
  p_contest_group_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
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

  IF p_payout_structure IS NOT NULL THEN
    SELECT COALESCE(SUM((value)::bigint), 0)
    INTO v_total_payout
    FROM jsonb_each_text(p_payout_structure);
  END IF;

  v_tier_id := 'tier_' || p_entry_fee_cents::text;

  INSERT INTO public.contest_templates (
    regatta_name, gender_category, lock_time, status, crews, divisions, entry_tiers, min_picks, max_picks, banner_url, contest_group_id
  ) VALUES (
    p_regatta_name, p_gender_category, p_lock_time, 'open', p_crews, '[]'::jsonb, '[]'::jsonb, 2, 4, p_banner_url, p_contest_group_id
  )
  RETURNING id INTO v_template_id;

  INSERT INTO public.contest_pools (
    contest_template_id, tier_id, entry_fee_cents, prize_pool_cents, max_entries, lock_time, status, payout_structure, allow_overflow, entry_tiers
  ) VALUES (
    v_template_id, v_tier_id, p_entry_fee_cents, v_total_payout, p_max_entries, p_lock_time, 'open', p_payout_structure, p_allow_overflow, p_entry_tiers
  )
  RETURNING id INTO v_pool_id;

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
$$;
