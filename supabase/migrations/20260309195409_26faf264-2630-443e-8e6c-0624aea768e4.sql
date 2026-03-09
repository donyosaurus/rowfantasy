-- ERROR 1: Fix compliance_audit_logs INSERT policy
DROP POLICY IF EXISTS "System can insert compliance logs" ON compliance_audit_logs;
CREATE POLICY "Only service_role can insert compliance logs"
  ON compliance_audit_logs FOR INSERT TO authenticated
  WITH CHECK (false);

-- ERROR 2: Fix enter_contest_pool RPC to use auth.uid()
CREATE OR REPLACE FUNCTION public.enter_contest_pool(p_contest_pool_id uuid, p_picks jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_user_id uuid := auth.uid();
  v_pool record;
  v_user_balance bigint;
  v_entry_fee_cents bigint;
  v_existing_entry uuid;
  v_wallet_id uuid;
  v_wallet_result record;
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
  
  IF v_pool.current_entries >= v_pool.max_entries THEN
    RAISE EXCEPTION 'Pool is full';
  END IF;
  
  IF v_pool.status != 'open' THEN
    RAISE EXCEPTION 'Pool is not open for entry';
  END IF;
  
  IF v_pool.lock_time < now() THEN
    RAISE EXCEPTION 'Entry period has ended';
  END IF;
  
  SELECT id INTO v_existing_entry
  FROM contest_entries
  WHERE user_id = v_user_id
    AND pool_id = p_contest_pool_id
    AND status = 'active';
  
  IF FOUND THEN
    RAISE EXCEPTION 'Already entered this pool';
  END IF;
  
  v_entry_fee_cents := v_pool.entry_fee_cents;
  
  SELECT id INTO v_wallet_id
  FROM wallets
  WHERE user_id = v_user_id
  FOR UPDATE;
  
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Wallet not found';
  END IF;
  
  v_user_balance := get_user_balance(v_user_id);
  
  IF v_user_balance < v_entry_fee_cents THEN
    RAISE EXCEPTION 'Insufficient funds';
  END IF;
  
  SELECT * INTO v_wallet_result
  FROM update_wallet_balance(
    _wallet_id := v_wallet_id,
    _available_delta := -v_entry_fee_cents,
    _pending_delta := 0
  );
  
  IF NOT v_wallet_result.success THEN
    RAISE EXCEPTION 'Failed to deduct wallet balance';
  END IF;
  
  INSERT INTO ledger_entries (
    user_id, amount, transaction_type, description, reference_id
  ) VALUES (
    v_user_id, -v_entry_fee_cents, 'ENTRY_FEE', 'Contest Entry Fee', p_contest_pool_id
  );
  
  INSERT INTO contest_entries (
    user_id, pool_id, contest_template_id, picks, entry_fee_cents, status
  ) VALUES (
    v_user_id, p_contest_pool_id, v_pool.contest_template_id, p_picks, v_entry_fee_cents, 'active'
  );
  
  UPDATE contest_pools
  SET current_entries = current_entries + 1
  WHERE id = p_contest_pool_id;
  
  RETURN jsonb_build_object('success', true, 'entry_fee_cents', v_entry_fee_cents);
END;
$function$;

-- WARNING 2: Fix ledger_entries overly permissive INSERT
DROP POLICY IF EXISTS "Service role can insert ledger entries" ON ledger_entries;
CREATE POLICY "Only service_role can insert ledger entries"
  ON ledger_entries FOR INSERT TO authenticated
  WITH CHECK (false);

-- WARNING 5: Add server-side age check in handle_new_user
CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_dob DATE;
BEGIN
  v_dob := (NEW.raw_user_meta_data->>'date_of_birth')::DATE;
  IF v_dob IS NOT NULL AND age(CURRENT_DATE, v_dob) < make_interval(years => 18) THEN
    RAISE EXCEPTION 'User must be at least 18 years old to register';
  END IF;

  INSERT INTO public.profiles (id, email, full_name, username)
  VALUES (
    NEW.id,
    NEW.email,
    NEW.raw_user_meta_data->>'full_name',
    NEW.raw_user_meta_data->>'username'
  );
  
  INSERT INTO public.wallets (user_id)
  VALUES (NEW.id);
  
  INSERT INTO public.user_roles (user_id, role)
  VALUES (NEW.id, 'user');
  
  RETURN NEW;
END;
$function$;