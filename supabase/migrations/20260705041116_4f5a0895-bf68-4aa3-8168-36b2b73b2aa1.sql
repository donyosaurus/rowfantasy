-- Deduplicate any pre-existing rate_limits rows (keep newest per identifier+endpoint)
DELETE FROM public.rate_limits a
USING public.rate_limits b
WHERE a.identifier = b.identifier
  AND a.endpoint = b.endpoint
  AND a.ctid < b.ctid;

-- Add unique constraint if not present
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'rate_limits_identifier_endpoint_key'
      AND conrelid = 'public.rate_limits'::regclass
  ) THEN
    ALTER TABLE public.rate_limits
      ADD CONSTRAINT rate_limits_identifier_endpoint_key UNIQUE (identifier, endpoint);
  END IF;
END $$;

-- Atomic check_and_increment
CREATE OR REPLACE FUNCTION public.check_rate_limit_atomic(
  _identifier text,
  _endpoint text,
  _max_requests integer,
  _window_minutes integer
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _now timestamptz := now();
  _window_start_cutoff timestamptz := _now - make_interval(mins => _window_minutes);
  _new_count integer;
BEGIN
  INSERT INTO public.rate_limits (identifier, endpoint, request_count, window_start)
  VALUES (_identifier, _endpoint, 1, _now)
  ON CONFLICT (identifier, endpoint) DO UPDATE
  SET
    request_count = CASE
      WHEN public.rate_limits.window_start < _window_start_cutoff THEN 1
      ELSE public.rate_limits.request_count + 1
    END,
    window_start = CASE
      WHEN public.rate_limits.window_start < _window_start_cutoff THEN _now
      ELSE public.rate_limits.window_start
    END
  RETURNING request_count INTO _new_count;

  RETURN _new_count <= _max_requests;
END;
$$;

REVOKE ALL ON FUNCTION public.check_rate_limit_atomic(text, text, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.check_rate_limit_atomic(text, text, integer, integer) FROM anon;
REVOKE ALL ON FUNCTION public.check_rate_limit_atomic(text, text, integer, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.check_rate_limit_atomic(text, text, integer, integer) TO service_role;

NOTIFY pgrst, 'reload schema';
