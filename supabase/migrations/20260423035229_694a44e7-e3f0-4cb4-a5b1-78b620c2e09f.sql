CREATE OR REPLACE FUNCTION public.get_pool_entrants(p_pool_id uuid)
RETURNS TABLE(
  id uuid,
  user_id uuid,
  picks jsonb,
  total_points integer,
  margin_error numeric,
  rank integer,
  payout_cents bigint,
  status text,
  created_at timestamptz,
  tier_name text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_is_member boolean;
  v_is_admin boolean;
  v_lock_passed boolean;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM contest_entries ce
    WHERE ce.pool_id = p_pool_id
      AND ce.user_id = v_caller
      AND ce.status IN ('active', 'scored', 'settled', 'voided')
  ) INTO v_is_member;

  SELECT has_role(v_caller, 'admin'::app_role) INTO v_is_admin;

  IF NOT (v_is_member OR v_is_admin) THEN
    RAISE EXCEPTION 'Not authorized to view this pool';
  END IF;

  SELECT (cp.lock_time <= now()) INTO v_lock_passed
  FROM contest_pools cp
  WHERE cp.id = p_pool_id;

  IF v_lock_passed IS NULL THEN
    RAISE EXCEPTION 'Pool not found';
  END IF;

  RETURN QUERY
  SELECT
    ce.id,
    ce.user_id,
    CASE
      WHEN ce.user_id = v_caller OR v_lock_passed OR v_is_admin THEN ce.picks
      ELSE NULL::jsonb
    END AS picks,
    ce.total_points,
    ce.margin_error,
    ce.rank,
    ce.payout_cents,
    ce.status,
    ce.created_at,
    ce.tier_name
  FROM contest_entries ce
  WHERE ce.pool_id = p_pool_id
    AND ce.status IN ('active', 'scored', 'settled', 'voided')
  ORDER BY ce.created_at ASC;
END;
$$;

REVOKE ALL ON FUNCTION public.get_pool_entrants(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_pool_entrants(uuid) TO authenticated;