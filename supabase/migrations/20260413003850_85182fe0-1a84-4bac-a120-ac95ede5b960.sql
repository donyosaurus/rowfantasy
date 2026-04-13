
-- 1. Drop the UNIQUE(user_id, pool_id) constraint that blocks multi-entry
ALTER TABLE public.contest_entries
  DROP CONSTRAINT IF EXISTS contest_entries_user_id_pool_id_key;

-- 2. Update enter_contest_pool (3-arg version) to remove duplicate check
CREATE OR REPLACE FUNCTION public.enter_contest_pool(
  p_user_id uuid,
  p_contest_pool_id uuid,
  p_picks jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_pool record;
  v_user_balance bigint;
  v_entry_fee_cents bigint;
BEGIN
  SELECT * INTO v_pool
  FROM contest_pools
  WHERE id = p_contest_pool_id
  FOR UPDATE;
  
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Contest pool not found';
  END IF;
  
  IF v_pool.current_entries >= v_pool.max_entries THEN
    RAISE EXCEPTION 'Pool is full';
  END IF;
  
  IF v_pool.status != 'open' THEN
    RAISE EXCEPTION 'Pool is not open for entry';
  END IF;
  
  IF v_pool.lock_time < now() THEN
    RAISE EXCEPTION 'Entry period has ended';
  END IF;
  
  -- NO MORE duplicate check — multi-entry is allowed
  -- Self-match prevention is handled in the matchmaking edge function
  
  v_entry_fee_cents := v_pool.entry_fee_cents;
  v_user_balance := get_user_balance(p_user_id);
  
  IF v_user_balance < v_entry_fee_cents THEN
    RAISE EXCEPTION 'Insufficient funds';
  END IF;
  
  INSERT INTO ledger_entries (user_id, amount, transaction_type, description, reference_id)
  VALUES (p_user_id, -v_entry_fee_cents, 'ENTRY_FEE', 'Contest Entry Fee', p_contest_pool_id);
  
  INSERT INTO contest_entries (user_id, pool_id, contest_template_id, picks, entry_fee_cents, status)
  VALUES (p_user_id, p_contest_pool_id, v_pool.contest_template_id, p_picks, v_entry_fee_cents, 'active');
  
  UPDATE contest_pools SET current_entries = current_entries + 1 WHERE id = p_contest_pool_id;
  
  RETURN jsonb_build_object('success', true, 'entry_fee_cents', v_entry_fee_cents);
END;
$$;

GRANT EXECUTE ON FUNCTION public.enter_contest_pool(uuid, uuid, jsonb) TO authenticated;
