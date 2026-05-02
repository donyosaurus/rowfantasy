DROP FUNCTION IF EXISTS public.get_user_balance(uuid);

CREATE FUNCTION public.get_user_balance()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _caller_id uuid;
  _balance bigint;
BEGIN
  _caller_id := auth.uid();
  IF _caller_id IS NULL THEN
    RAISE EXCEPTION 'unauthorized: no authenticated caller';
  END IF;

  SELECT available_balance INTO _balance
  FROM public.wallets
  WHERE user_id = _caller_id;

  RETURN COALESCE(_balance, 0);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_user_balance() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_user_balance() FROM anon;
GRANT EXECUTE ON FUNCTION public.get_user_balance() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_user_balance() TO service_role;