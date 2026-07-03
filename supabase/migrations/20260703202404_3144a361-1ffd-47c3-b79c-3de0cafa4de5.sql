-- Fix admin_resize_contest_pool_atomic: contest_pools has no updated_at column.
-- Live deployed function references it and errors out. Repatch by removing that assignment.

CREATE OR REPLACE FUNCTION public.admin_resize_contest_pool_atomic(
  _pool_id uuid,
  _admin_user_id uuid,
  _new_max_entries integer
)
RETURNS TABLE(
  allowed boolean,
  reason text,
  old_max_entries integer,
  new_max_entries integer,
  new_payout_structure jsonb,
  new_prize_pool_cents bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  _is_admin boolean;
  _pool contest_pools%ROWTYPE;
  _old_max integer;
  _old_payout jsonb;
  _old_prize_pool bigint;
  _active_count integer;
  _max_by_user integer;
  _scaled jsonb := '{}'::jsonb;
  _sum_cents bigint := 0;
  _old_scaled_total bigint := 0;
  _rounding_dust bigint := 0;
  _rank_key text;
  _rank_int integer;
  _cents_numeric numeric;
  _scaled_numeric numeric;
  _scaled_cents bigint;
  _max_paid_rank integer := 0;
  _max_bigint constant numeric := 9223372036854775807::numeric;
BEGIN
  -- Re-verify admin
  SELECT EXISTS (
    SELECT 1 FROM user_roles ur
    WHERE ur.user_id = _admin_user_id AND ur.role = 'admin'
  ) INTO _is_admin;

  IF NOT _is_admin THEN
    RETURN QUERY SELECT false, 'not_admin'::text, NULL::integer, _new_max_entries, NULL::jsonb, NULL::bigint;
    RETURN;
  END IF;

  -- Advisory lock scoped to this pool resize
  PERFORM pg_advisory_xact_lock(hashtext('resize_pool:' || _pool_id::text));

  SELECT * INTO _pool FROM contest_pools cp WHERE cp.id = _pool_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'pool_not_found'::text, NULL::integer, _new_max_entries, NULL::jsonb, NULL::bigint;
    RETURN;
  END IF;

  _old_max := _pool.max_entries;
  _old_payout := _pool.payout_structure;
  _old_prize_pool := _pool.prize_pool_cents;

  IF _pool.status NOT IN ('open', 'locked') THEN
    RETURN QUERY SELECT false, 'pool_not_resizable'::text, _old_max, _new_max_entries, _old_payout, _old_prize_pool;
    RETURN;
  END IF;

  IF _new_max_entries < 2 THEN
    RETURN QUERY SELECT false, 'new_max_below_minimum'::text, _old_max, _new_max_entries, _old_payout, _old_prize_pool;
    RETURN;
  END IF;

  IF _new_max_entries > _old_max THEN
    RETURN QUERY SELECT false, 'up_resize_forbidden'::text, _old_max, _new_max_entries, _old_payout, _old_prize_pool;
    RETURN;
  END IF;

  SELECT count(*)::integer INTO _active_count
  FROM contest_entries ce
  WHERE ce.pool_id = _pool_id AND ce.status = 'active';

  IF _new_max_entries < _active_count THEN
    RETURN QUERY SELECT false, 'below_active_count'::text, _old_max, _new_max_entries, _old_payout, _old_prize_pool;
    RETURN;
  END IF;

  IF _pool.status = 'locked' AND _new_max_entries <> _active_count THEN
    RETURN QUERY SELECT false, 'locked_requires_exact_active'::text, _old_max, _new_max_entries, _old_payout, _old_prize_pool;
    RETURN;
  END IF;

  IF _pool.status = 'open' AND _pool.allow_overflow THEN
    RETURN QUERY SELECT false, 'overflow_must_be_disabled'::text, _old_max, _new_max_entries, _old_payout, _old_prize_pool;
    RETURN;
  END IF;

  SELECT COALESCE(max(cnt), 0) INTO _max_by_user
  FROM (
    SELECT count(*)::integer AS cnt
    FROM contest_entries ce
    WHERE ce.pool_id = _pool_id AND ce.status = 'active'
    GROUP BY ce.user_id
  ) sub;

  IF _max_by_user >= _new_max_entries THEN
    RETURN QUERY SELECT false, 'single_user_would_dominate'::text, _old_max, _new_max_entries, _old_payout, _old_prize_pool;
    RETURN;
  END IF;

  IF _old_payout IS NULL OR jsonb_typeof(_old_payout) <> 'object' THEN
    RETURN QUERY SELECT false, 'invalid_payout_structure'::text, _old_max, _new_max_entries, _old_payout, _old_prize_pool;
    RETURN;
  END IF;

  FOR _rank_key, _cents_numeric IN
    SELECT key, (value)::text::numeric FROM jsonb_each(_old_payout)
  LOOP
    BEGIN
      _rank_int := _rank_key::integer;
    EXCEPTION WHEN OTHERS THEN
      RETURN QUERY SELECT false, 'invalid_payout_rank_key'::text, _old_max, _new_max_entries, _old_payout, _old_prize_pool;
      RETURN;
    END;

    IF _rank_int < 1 THEN
      RETURN QUERY SELECT false, 'invalid_payout_rank_key'::text, _old_max, _new_max_entries, _old_payout, _old_prize_pool;
      RETURN;
    END IF;

    IF _cents_numeric IS NULL OR _cents_numeric < 0 OR _cents_numeric <> trunc(_cents_numeric) OR _cents_numeric > _max_bigint THEN
      RETURN QUERY SELECT false, 'invalid_payout_value'::text, _old_max, _new_max_entries, _old_payout, _old_prize_pool;
      RETURN;
    END IF;

    BEGIN
      _old_scaled_total := _old_scaled_total + _cents_numeric::bigint;
    EXCEPTION WHEN OTHERS THEN
      RETURN QUERY SELECT false, 'invalid_payout_value'::text, _old_max, _new_max_entries, _old_payout, _old_prize_pool;
      RETURN;
    END;

    IF _rank_int > _max_paid_rank THEN
      _max_paid_rank := _rank_int;
    END IF;
  END LOOP;

  IF _max_paid_rank > _new_max_entries THEN
    RETURN QUERY SELECT false, 'new_max_below_paid_ranks'::text, _old_max, _new_max_entries, _old_payout, _old_prize_pool;
    RETURN;
  END IF;

  FOR _rank_key, _cents_numeric IN
    SELECT key, (value)::text::numeric FROM jsonb_each(_old_payout)
  LOOP
    _scaled_numeric := floor((_cents_numeric * _new_max_entries::numeric) / _old_max::numeric);

    IF _scaled_numeric < 0 OR _scaled_numeric > _max_bigint THEN
      RETURN QUERY SELECT false, 'invalid_payout_value'::text, _old_max, _new_max_entries, _old_payout, _old_prize_pool;
      RETURN;
    END IF;

    BEGIN
      _scaled_cents := _scaled_numeric::bigint;
    EXCEPTION WHEN OTHERS THEN
      RETURN QUERY SELECT false, 'invalid_payout_value'::text, _old_max, _new_max_entries, _old_payout, _old_prize_pool;
      RETURN;
    END;

    IF _scaled_cents = 0 THEN
      RETURN QUERY SELECT false, 'prize_scales_to_zero'::text, _old_max, _new_max_entries, _old_payout, _old_prize_pool;
      RETURN;
    END IF;

    _scaled := _scaled || jsonb_build_object(_rank_key, _scaled_cents);
    _sum_cents := _sum_cents + _scaled_cents;
  END LOOP;

  _rounding_dust := ((_old_scaled_total::numeric * _new_max_entries::numeric) / _old_max::numeric)::bigint - _sum_cents;

  UPDATE contest_pools cp
  SET max_entries      = _new_max_entries,
      payout_structure = _scaled,
      prize_pool_cents = _sum_cents,
      current_entries  = _active_count
  WHERE cp.id = _pool_id;

  INSERT INTO compliance_audit_logs (
    admin_id, event_type, description, severity, metadata
  ) VALUES (
    _admin_user_id,
    'pool_resized',
    'Admin resized contest pool ' || _pool_id::text,
    'warning',
    jsonb_build_object(
      'pool_id', _pool_id,
      'old_max_entries', _old_max,
      'new_max_entries', _new_max_entries,
      'old_payout_structure', _old_payout,
      'new_payout_structure', _scaled,
      'old_prize_pool_cents', _old_prize_pool,
      'new_prize_pool_cents', _sum_cents,
      'active_count', _active_count,
      'rounding_dust_cents', _rounding_dust
    )
  );

  RETURN QUERY SELECT true, 'resized'::text, _old_max, _new_max_entries, _scaled, _sum_cents;
END;
$function$;

REVOKE ALL ON FUNCTION public.admin_resize_contest_pool_atomic(uuid, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_resize_contest_pool_atomic(uuid, uuid, integer) TO service_role;

NOTIFY pgrst, 'reload schema';