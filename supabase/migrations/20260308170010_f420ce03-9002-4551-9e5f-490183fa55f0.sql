CREATE OR REPLACE FUNCTION public.enter_contest_pool(p_user_id uuid, p_contest_pool_id uuid, p_picks jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_pool record;
  v_user_balance bigint;
  v_entry_fee_cents bigint;
  v_existing_entry uuid;
  v_wallet_id uuid;
  v_wallet_result record;
BEGIN
  -- Lock the contest pool row to prevent concurrent modifications
  SELECT * INTO v_pool
  FROM contest_pools
  WHERE id = p_contest_pool_id
  FOR UPDATE;
  
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Contest pool not found';
  END IF;
  
  -- Check if pool is full
  IF v_pool.current_entries >= v_pool.max_entries THEN
    RAISE EXCEPTION 'Pool is full';
  END IF;
  
  -- Check if pool is still open
  IF v_pool.status != 'open' THEN
    RAISE EXCEPTION 'Pool is not open for entry';
  END IF;
  
  -- Check if lock time has passed
  IF v_pool.lock_time < now() THEN
    RAISE EXCEPTION 'Entry period has ended';
  END IF;
  
  -- Check if user already entered this pool
  SELECT id INTO v_existing_entry
  FROM contest_entries
  WHERE user_id = p_user_id
    AND pool_id = p_contest_pool_id
    AND status = 'active';
  
  IF FOUND THEN
    RAISE EXCEPTION 'Already entered this pool';
  END IF;
  
  -- Get entry fee from pool
  v_entry_fee_cents := v_pool.entry_fee_cents;
  
  -- Get wallet ID and lock it
  SELECT id INTO v_wallet_id
  FROM wallets
  WHERE user_id = p_user_id
  FOR UPDATE;
  
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Wallet not found';
  END IF;
  
  -- Calculate user balance using existing function
  v_user_balance := get_user_balance(p_user_id);
  
  -- Check if user has sufficient funds
  IF v_user_balance < v_entry_fee_cents THEN
    RAISE EXCEPTION 'Insufficient funds';
  END IF;
  
  -- All checks passed - execute the entry
  
  -- 1. Deduct from wallet using update_wallet_balance RPC
  SELECT * INTO v_wallet_result
  FROM update_wallet_balance(
    _wallet_id := v_wallet_id,
    _available_delta := -v_entry_fee_cents,
    _pending_delta := 0
  );
  
  IF NOT v_wallet_result.success THEN
    RAISE EXCEPTION 'Failed to deduct wallet balance';
  END IF;
  
  -- 2. Insert ledger entry (negative amount for fee)
  INSERT INTO ledger_entries (
    user_id,
    amount,
    transaction_type,
    description,
    reference_id
  ) VALUES (
    p_user_id,
    -v_entry_fee_cents,
    'ENTRY_FEE',
    'Contest Entry Fee',
    p_contest_pool_id
  );
  
  -- 3. Insert contest entry
  INSERT INTO contest_entries (
    user_id,
    pool_id,
    contest_template_id,
    picks,
    entry_fee_cents,
    status
  ) VALUES (
    p_user_id,
    p_contest_pool_id,
    v_pool.contest_template_id,
    p_picks,
    v_entry_fee_cents,
    'active'
  );
  
  -- 4. Increment current_entries in contest_pools
  UPDATE contest_pools
  SET current_entries = current_entries + 1
  WHERE id = p_contest_pool_id;
  
  -- Return success
  RETURN jsonb_build_object('success', true, 'entry_fee_cents', v_entry_fee_cents);
END;
$function$