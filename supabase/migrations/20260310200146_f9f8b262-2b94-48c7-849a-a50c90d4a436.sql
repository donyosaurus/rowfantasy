
-- C2: Drop vulnerable 3-param enter_contest_pool that accepts arbitrary user_id
DROP FUNCTION IF EXISTS public.enter_contest_pool(uuid, uuid, jsonb);

-- C3: Drop old withdraw_contest_entry that accepts arbitrary user_id
DROP FUNCTION IF EXISTS public.withdraw_contest_entry(uuid, uuid);

-- C3: Recreate withdraw_contest_entry using auth.uid() internally
CREATE OR REPLACE FUNCTION public.withdraw_contest_entry(p_contest_pool_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_pool record;
  v_entry record;
  v_entry_fee_cents bigint;
  v_wallet_id uuid;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  SELECT * INTO v_pool
  FROM contest_pools
  WHERE id = p_contest_pool_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Contest pool not found';
  END IF;

  IF now() >= v_pool.lock_time THEN
    RAISE EXCEPTION 'Contest is locked. Cannot withdraw.';
  END IF;

  IF v_pool.status != 'open' THEN
    RAISE EXCEPTION 'Contest is not open. Cannot withdraw.';
  END IF;

  SELECT * INTO v_entry
  FROM contest_entries
  WHERE user_id = v_user_id
    AND pool_id = p_contest_pool_id
    AND status = 'active'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Entry not found';
  END IF;

  v_entry_fee_cents := v_entry.entry_fee_cents;

  UPDATE contest_entries
  SET status = 'withdrawn', updated_at = now()
  WHERE id = v_entry.id;

  UPDATE contest_pools
  SET current_entries = current_entries - 1
  WHERE id = p_contest_pool_id;

  INSERT INTO ledger_entries (user_id, amount, transaction_type, description, reference_id)
  VALUES (v_user_id, v_entry_fee_cents, 'REFUND', 'Contest Withdrawal', v_entry.id);

  SELECT id INTO v_wallet_id FROM wallets WHERE user_id = v_user_id;
  IF v_wallet_id IS NOT NULL THEN
    PERFORM update_wallet_balance(
      _wallet_id := v_wallet_id,
      _available_delta := v_entry_fee_cents,
      _pending_delta := 0
    );
  END IF;

  RETURN jsonb_build_object('success', true, 'refunded_amount', v_entry_fee_cents, 'entry_id', v_entry.id);
END;
$$;

-- H1: Remove direct INSERT policy on contest_entries (prevents free entry bypass)
DROP POLICY IF EXISTS "Users can insert their own entries" ON public.contest_entries;

-- H3: Restrict transactions INSERT to service_role only
DROP POLICY IF EXISTS "System can insert transactions" ON public.transactions;
CREATE POLICY "Only service_role can insert transactions" ON public.transactions FOR INSERT TO authenticated WITH CHECK (false);

-- H9: Restrict get_user_balance to own user or admin
CREATE OR REPLACE FUNCTION public.get_user_balance(target_user_id uuid)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() != target_user_id THEN
    IF NOT has_role(auth.uid(), 'admin') THEN
      RAISE EXCEPTION 'Access denied: cannot view other users balance';
    END IF;
  END IF;

  RETURN COALESCE(
    (SELECT w.available_balance::bigint FROM public.wallets w WHERE w.user_id = target_user_id),
    0
  );
END;
$$;
