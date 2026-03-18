CREATE OR REPLACE FUNCTION public.admin_void_contest(p_contest_pool_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_pool record;
  v_entry record;
  v_wallet_id uuid;
  v_refunded_count int := 0;
BEGIN
  SELECT * INTO v_pool FROM contest_pools WHERE id = p_contest_pool_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Contest pool not found'; END IF;
  IF v_pool.status = 'settled' THEN RAISE EXCEPTION 'Cannot void a settled contest'; END IF;
  IF v_pool.status = 'voided' THEN RAISE EXCEPTION 'Contest is already voided'; END IF;

  FOR v_entry IN
    SELECT * FROM contest_entries
    WHERE pool_id = p_contest_pool_id AND status = 'active'
    FOR UPDATE
  LOOP
    -- 1. Insert refund ledger entry
    INSERT INTO ledger_entries (user_id, amount, transaction_type, description, reference_id)
    VALUES (v_entry.user_id, v_entry.entry_fee_cents, 'REFUND', 'Contest Voided', p_contest_pool_id);

    -- 2. Credit the wallet balance back
    SELECT id INTO v_wallet_id FROM wallets WHERE user_id = v_entry.user_id;
    IF v_wallet_id IS NOT NULL THEN
      PERFORM update_wallet_balance(
        _wallet_id := v_wallet_id,
        _available_delta := v_entry.entry_fee_cents,
        _pending_delta := 0
      );
    END IF;

    -- 3. Update entry status
    UPDATE contest_entries SET status = 'voided', updated_at = now() WHERE id = v_entry.id;

    v_refunded_count := v_refunded_count + 1;
  END LOOP;

  UPDATE contest_pools SET status = 'voided' WHERE id = p_contest_pool_id;

  RETURN jsonb_build_object('success', true, 'refunded_count', v_refunded_count);
END;
$function$;