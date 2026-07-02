
CREATE OR REPLACE FUNCTION public.admin_resize_contest_pool_atomic(
  _pool_id           uuid,
  _admin_user_id     uuid,
  _new_max_entries   integer
)
RETURNS TABLE (
  allowed               boolean,
  reason                text,
  old_max_entries       integer,
  new_max_entries       integer,
  new_payout_structure  jsonb,
  new_prize_pool_cents  bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _pool                 contest_pools%ROWTYPE;
  _active_count         integer := 0;
  _old_max              integer;
  _old_payout           jsonb;
  _old_prize_pool       bigint;
  _scaled               jsonb := '{}'::jsonb;
  _sum_cents            bigint := 0;
  _old_scaled_total     bigint := 0;
  _rounding_dust        bigint := 0;
  _max_rank             integer := 0;
  _key                  text;
  _val                  jsonb;
  _rank_int             integer;
  _cents_numeric        numeric;
  _cents_int            bigint;
  _scaled_numeric       numeric;
  _scaled_val           bigint;
  _dup_user             uuid;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM user_roles ur
    WHERE ur.user_id = _admin_user_id AND ur.role = 'admin'
  ) THEN
    RAISE EXCEPTION 'unauthorized: caller is not an admin';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('resize_pool:' || _pool_id::text));

  SELECT * INTO _pool
  FROM contest_pools cp
  WHERE cp.id = _pool_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'pool_not_found'::text, 0, 0, NULL::jsonb, 0::bigint;
    RETURN;
  END IF;

  _old_max        := _pool.max_entries;
  _old_payout     := _pool.payout_structure;
  _old_prize_pool := _pool.prize_pool_cents;

  IF _pool.status NOT IN ('open', 'locked') THEN
    RETURN QUERY SELECT false, 'pool_not_resizable'::text, _old_max, _old_max,
                        _old_payout, _old_prize_pool;
    RETURN;
  END IF;

  SELECT COUNT(*)::int INTO _active_count
  FROM contest_entries ce
  WHERE ce.pool_id = _pool_id AND ce.status = 'active';

  IF _new_max_entries < 2 THEN
    RETURN QUERY SELECT false, 'new_max_below_minimum'::text, _old_max, _new_max_entries,
                        _old_payout, _old_prize_pool;
    RETURN;
  END IF;

  IF _new_max_entries >= _old_max THEN
    RETURN QUERY SELECT false, 'up_resize_forbidden'::text, _old_max, _new_max_entries,
                        _old_payout, _old_prize_pool;
    RETURN;
  END IF;

  IF _new_max_entries < _active_count THEN
    RETURN QUERY SELECT false, 'below_active_count'::text, _old_max, _new_max_entries,
                        _old_payout, _old_prize_pool;
    RETURN;
  END IF;

  IF _pool.status = 'locked' AND _new_max_entries <> _active_count THEN
    RETURN QUERY SELECT false, 'locked_requires_exact_active'::text, _old_max, _new_max_entries,
                        _old_payout, _old_prize_pool;
    RETURN;
  END IF;

  IF _pool.status = 'open' AND COALESCE(_pool.allow_overflow, false) = true THEN
    RETURN QUERY SELECT false, 'overflow_must_be_disabled'::text, _old_max, _new_max_entries,
                        _old_payout, _old_prize_pool;
    RETURN;
  END IF;

  SELECT ce.user_id INTO _dup_user
  FROM contest_entries ce
  WHERE ce.pool_id = _pool_id AND ce.status = 'active'
  GROUP BY ce.user_id
  HAVING COUNT(*) >= _new_max_entries
  LIMIT 1;

  IF _dup_user IS NOT NULL THEN
    RETURN QUERY SELECT false, 'single_user_would_dominate'::text, _old_max, _new_max_entries,
                        _old_payout, _old_prize_pool;
    RETURN;
  END IF;

  IF _old_payout IS NULL OR jsonb_typeof(_old_payout) <> 'object' THEN
    RETURN QUERY SELECT false, 'invalid_payout_structure'::text, _old_max, _new_max_entries,
                        _old_payout, _old_prize_pool;
    RETURN;
  END IF;

  FOR _key, _val IN SELECT * FROM jsonb_each(_old_payout) LOOP
    BEGIN
      _rank_int := _key::integer;
    EXCEPTION WHEN others THEN
      RETURN QUERY SELECT false, 'invalid_payout_rank_key'::text, _old_max, _new_max_entries,
                          _old_payout, _old_prize_pool;
      RETURN;
    END;

    IF _rank_int < 1 THEN
      RETURN QUERY SELECT false, 'invalid_payout_rank_key'::text, _old_max, _new_max_entries,
                          _old_payout, _old_prize_pool;
      RETURN;
    END IF;

    IF jsonb_typeof(_val) <> 'number' THEN
      RETURN QUERY SELECT false, 'invalid_payout_value'::text, _old_max, _new_max_entries,
                          _old_payout, _old_prize_pool;
      RETURN;
    END IF;

    -- Read as numeric first so we can validate integer-ness and range before casting to bigint.
    BEGIN
      _cents_numeric := (_val)::numeric;
    EXCEPTION WHEN others THEN
      RETURN QUERY SELECT false, 'invalid_payout_value'::text, _old_max, _new_max_entries,
                          _old_payout, _old_prize_pool;
      RETURN;
    END;

    -- Reject fractional cent values (must be whole integer).
    IF _cents_numeric <> trunc(_cents_numeric) THEN
      RETURN QUERY SELECT false, 'invalid_payout_value'::text, _old_max, _new_max_entries,
                          _old_payout, _old_prize_pool;
      RETURN;
    END IF;

    -- Reject negatives and out-of-bigint-range values before casting.
    IF _cents_numeric < 0 OR _cents_numeric > 9223372036854775807::numeric THEN
      RETURN QUERY SELECT false, 'invalid_payout_value'::text, _old_max, _new_max_entries,
                          _old_payout, _old_prize_pool;
      RETURN;
    END IF;

    BEGIN
      _cents_int := _cents_numeric::bigint;
    EXCEPTION WHEN others THEN
      RETURN QUERY SELECT false, 'invalid_payout_value'::text, _old_max, _new_max_entries,
                          _old_payout, _old_prize_pool;
      RETURN;
    END;

    IF _rank_int > _max_rank THEN
      _max_rank := _rank_int;
    END IF;

    -- Do scaling math in numeric to avoid intermediate bigint overflow, then range-check.
    _scaled_numeric := trunc((_cents_numeric * _new_max_entries::numeric) / _old_max::numeric);

    IF _scaled_numeric < 0 OR _scaled_numeric > 9223372036854775807::numeric THEN
      RETURN QUERY SELECT false, 'invalid_payout_value'::text, _old_max, _new_max_entries,
                          _old_payout, _old_prize_pool;
      RETURN;
    END IF;

    BEGIN
      _scaled_val := _scaled_numeric::bigint;
    EXCEPTION WHEN others THEN
      RETURN QUERY SELECT false, 'invalid_payout_value'::text, _old_max, _new_max_entries,
                          _old_payout, _old_prize_pool;
      RETURN;
    END;

    IF _cents_int > 0 AND _scaled_val = 0 THEN
      RETURN QUERY SELECT false, 'prize_scales_to_zero'::text, _old_max, _new_max_entries,
                          _old_payout, _old_prize_pool;
      RETURN;
    END IF;

    _scaled           := _scaled     || jsonb_build_object(_key, _scaled_val);
    _sum_cents        := _sum_cents  + _scaled_val;
    _old_scaled_total := _old_scaled_total + _cents_int;
  END LOOP;

  IF _new_max_entries < _max_rank THEN
    RETURN QUERY SELECT false, 'new_max_below_paid_ranks'::text, _old_max, _new_max_entries,
                        _old_payout, _old_prize_pool;
    RETURN;
  END IF;

  _rounding_dust := ((_old_scaled_total::numeric * _new_max_entries::numeric) / _old_max::numeric)::bigint - _sum_cents;

  UPDATE contest_pools cp
  SET max_entries      = _new_max_entries,
      payout_structure = _scaled,
      prize_pool_cents = _sum_cents,
      current_entries  = _active_count,
      updated_at       = now()
  WHERE cp.id = _pool_id;

  INSERT INTO compliance_audit_logs (
    admin_id, event_type, description, severity, metadata
  ) VALUES (
    _admin_user_id,
    'pool_resized',
    'Admin resized contest pool ' || _pool_id::text,
    'warning',
    jsonb_build_object(
      'admin_id',              _admin_user_id,
      'pool_id',               _pool_id,
      'old_max_entries',       _old_max,
      'new_max_entries',       _new_max_entries,
      'active_count',          _active_count,
      'old_payout_structure',  _old_payout,
      'new_payout_structure',  _scaled,
      'old_prize_pool_cents',  _old_prize_pool,
      'new_prize_pool_cents',  _sum_cents,
      'rounding_dust_cents',   _rounding_dust
    )
  );

  RETURN QUERY SELECT true, 'approved'::text, _old_max, _new_max_entries, _scaled, _sum_cents;
END;
$function$;

REVOKE ALL ON FUNCTION public.admin_resize_contest_pool_atomic(uuid, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_resize_contest_pool_atomic(uuid, uuid, integer) TO service_role;

NOTIFY pgrst, 'reload schema';
