CREATE OR REPLACE FUNCTION public.change_username_atomic(
  _user_id uuid,
  _new_username text
)
RETURNS TABLE(allowed boolean, reason text, next_change_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old_username text;
  v_last_changed timestamptz;
  v_next_change timestamptz;
  v_normalized text;
  v_exists boolean;
BEGIN
  -- STEP 0: caller must be service_role or postgres
  IF session_user NOT IN ('postgres', 'service_role', 'supabase_admin') THEN
    RAISE EXCEPTION 'change_username_atomic: forbidden caller %', session_user
      USING ERRCODE = '42501';
  END IF;

  IF _user_id IS NULL THEN
    RETURN QUERY SELECT false, 'invalid_user'::text, NULL::timestamptz;
    RETURN;
  END IF;

  -- Normalize input
  v_normalized := lower(btrim(coalesce(_new_username, '')));

  -- Format check (3-20, [a-z0-9_])
  IF v_normalized !~ '^[a-z0-9_]{3,20}$' THEN
    RETURN QUERY SELECT false, 'format_invalid'::text, NULL::timestamptz;
    RETURN;
  END IF;

  -- Lock the profile row
  SELECT username, username_last_changed_at
    INTO v_old_username, v_last_changed
  FROM public.profiles
  WHERE id = _user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'profile_not_found'::text, NULL::timestamptz;
    RETURN;
  END IF;

  -- No-op
  IF v_old_username IS NOT NULL AND v_old_username = v_normalized THEN
    RETURN QUERY SELECT false, 'unchanged'::text, NULL::timestamptz;
    RETURN;
  END IF;

  -- Cooldown
  IF v_last_changed IS NOT NULL THEN
    v_next_change := v_last_changed + interval '90 days';
    IF v_next_change > now() THEN
      RETURN QUERY SELECT false, 'cooldown_active'::text, v_next_change;
      RETURN;
    END IF;
  END IF;

  -- Uniqueness pre-check inside the lock
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE lower(username) = v_normalized
      AND id <> _user_id
  ) INTO v_exists;

  IF v_exists THEN
    RETURN QUERY SELECT false, 'duplicate'::text, NULL::timestamptz;
    RETURN;
  END IF;

  -- Apply update; defense-in-depth catch on 23505
  BEGIN
    UPDATE public.profiles
    SET username = v_normalized,
        username_last_changed_at = now(),
        updated_at = now()
    WHERE id = _user_id;
  EXCEPTION
    WHEN unique_violation THEN
      RETURN QUERY SELECT false, 'duplicate'::text, NULL::timestamptz;
      RETURN;
  END;

  RETURN QUERY SELECT true, 'ok'::text, (now() + interval '90 days');
END;
$$;

REVOKE ALL ON FUNCTION public.change_username_atomic(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.change_username_atomic(uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.change_username_atomic(uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.change_username_atomic(uuid, text) TO service_role;