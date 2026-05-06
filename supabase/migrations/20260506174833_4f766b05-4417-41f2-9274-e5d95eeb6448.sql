-- ============================================================================
-- 1. get_user_wallet_balances() — user-facing fail-closed dual-balance RPC
--    Sibling of get_user_balance() (Tier 1 Fix 21). Returns both available
--    and pending balances. No parameters: derives user from auth.uid() so a
--    tampered JWT cannot read another user's balance. Raises if no caller.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.get_user_wallet_balances()
RETURNS TABLE (
  available_balance_cents bigint,
  pending_balance_cents bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  _uid uuid := auth.uid();
BEGIN
  IF _uid IS NULL THEN
    RAISE EXCEPTION 'unauthorized: no authenticated caller';
  END IF;

  RETURN QUERY
    SELECT w.available_balance::bigint, w.pending_balance::bigint
    FROM public.wallets w
    WHERE w.user_id = _uid;
END;
$$;

REVOKE ALL ON FUNCTION public.get_user_wallet_balances() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_user_wallet_balances() FROM anon;
GRANT EXECUTE ON FUNCTION public.get_user_wallet_balances() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_user_wallet_balances() TO service_role;


-- ============================================================================
-- 2. admin_list_wallet_balances(_admin_user_id) — admin-only bulk balance read
--    Service-role-only (called via authenticated admin edge function).
--    Defensive session_user guard + orphan-admin guard (Fix 19/20 pattern).
-- ============================================================================
CREATE OR REPLACE FUNCTION public.admin_list_wallet_balances(
  _admin_user_id uuid
)
RETURNS TABLE (
  user_id uuid,
  available_balance_cents bigint,
  pending_balance_cents bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE _admin_check int;
BEGIN
  -- STEP 0 (defense-in-depth): RPC must not be directly PostgREST-callable.
  -- session_user (NOT current_user) is correct inside SECURITY DEFINER:
  -- current_user equals the function owner and would always pass the guard.
  IF session_user NOT IN ('postgres', 'service_role') THEN
    RAISE EXCEPTION 'unauthorized: admin_list_wallet_balances may only be called by service_role';
  END IF;

  -- Orphan-admin guard: admin must exist in auth.users AND have admin role.
  SELECT 1 INTO _admin_check
  FROM public.user_roles ur
  JOIN auth.users u ON u.id = ur.user_id
  WHERE ur.user_id = _admin_user_id AND ur.role = 'admin';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unauthorized: caller is not an admin';
  END IF;

  RETURN QUERY
    SELECT w.user_id, w.available_balance::bigint, w.pending_balance::bigint
    FROM public.wallets w;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_list_wallet_balances(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_list_wallet_balances(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.admin_list_wallet_balances(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.admin_list_wallet_balances(uuid) TO service_role;