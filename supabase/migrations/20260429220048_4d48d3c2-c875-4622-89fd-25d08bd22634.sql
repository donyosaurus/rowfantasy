-- Drop policy that depends on transactions.amount so we can alter the column
DROP POLICY IF EXISTS "System can update transaction status" ON public.transactions;

DO $$
DECLARE
  v_data_type text;
BEGIN
  -- ============ WALLETS ============
  ALTER TABLE public.wallets DROP CONSTRAINT IF EXISTS wallets_available_balance_check;
  ALTER TABLE public.wallets DROP CONSTRAINT IF EXISTS wallets_pending_balance_check;

  ALTER TABLE public.wallets
    ALTER COLUMN available_balance DROP DEFAULT,
    ALTER COLUMN available_balance TYPE bigint USING ROUND(available_balance * 100)::bigint,
    ALTER COLUMN available_balance SET DEFAULT 0;

  ALTER TABLE public.wallets
    ALTER COLUMN pending_balance DROP DEFAULT,
    ALTER COLUMN pending_balance TYPE bigint USING ROUND(pending_balance * 100)::bigint,
    ALTER COLUMN pending_balance SET DEFAULT 0;

  ALTER TABLE public.wallets
    ALTER COLUMN lifetime_deposits DROP DEFAULT,
    ALTER COLUMN lifetime_deposits TYPE bigint USING ROUND(lifetime_deposits * 100)::bigint,
    ALTER COLUMN lifetime_deposits SET DEFAULT 0;

  ALTER TABLE public.wallets
    ALTER COLUMN lifetime_withdrawals DROP DEFAULT,
    ALTER COLUMN lifetime_withdrawals TYPE bigint USING ROUND(lifetime_withdrawals * 100)::bigint,
    ALTER COLUMN lifetime_withdrawals SET DEFAULT 0;

  ALTER TABLE public.wallets
    ALTER COLUMN lifetime_winnings DROP DEFAULT,
    ALTER COLUMN lifetime_winnings TYPE bigint USING ROUND(lifetime_winnings * 100)::bigint,
    ALTER COLUMN lifetime_winnings SET DEFAULT 0;

  ALTER TABLE public.wallets
    ADD CONSTRAINT wallets_available_balance_check CHECK (available_balance >= 0),
    ADD CONSTRAINT wallets_pending_balance_check CHECK (pending_balance >= 0);

  -- ============ TRANSACTIONS ============
  ALTER TABLE public.transactions
    ALTER COLUMN amount TYPE bigint USING ROUND(amount * 100)::bigint;

  -- ============ VERIFICATION ============
  SELECT data_type INTO v_data_type FROM information_schema.columns
    WHERE table_schema='public' AND table_name='wallets' AND column_name='available_balance';
  IF v_data_type <> 'bigint' THEN
    RAISE EXCEPTION 'Verification failed: wallets.available_balance type is %', v_data_type;
  END IF;

  SELECT data_type INTO v_data_type FROM information_schema.columns
    WHERE table_schema='public' AND table_name='transactions' AND column_name='amount';
  IF v_data_type <> 'bigint' THEN
    RAISE EXCEPTION 'Verification failed: transactions.amount type is %', v_data_type;
  END IF;
END $$;

-- Re-create the dropped policy with identical conditions
CREATE POLICY "System can update transaction status"
ON public.transactions
FOR UPDATE
TO service_role
USING (status = 'pending'::transaction_status)
WITH CHECK (
  status = ANY (ARRAY['completed'::transaction_status, 'failed'::transaction_status])
  AND user_id = (SELECT t.user_id FROM transactions t WHERE t.id = transactions.id)
  AND wallet_id = (SELECT t.wallet_id FROM transactions t WHERE t.id = transactions.id)
  AND amount = (SELECT t.amount FROM transactions t WHERE t.id = transactions.id)
  AND type = (SELECT t.type FROM transactions t WHERE t.id = transactions.id)
);

-- ============ REWRITE initiate_withdrawal_atomic ============
CREATE OR REPLACE FUNCTION public.initiate_withdrawal_atomic(_user_id uuid, _wallet_id uuid, _amount_cents bigint, _state_code text)
 RETURNS TABLE(allowed boolean, reason text, today_total numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _today_start timestamptz;
  _today_withdrawals bigint;
  _pending_withdrawals bigint;
  _last_withdrawal_at timestamptz;
  _available_balance bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(_user_id::text));

  _today_start := date_trunc('day', now() AT TIME ZONE 'UTC');

  SELECT COALESCE(SUM(ABS(amount)), 0)::bigint
  INTO _today_withdrawals
  FROM transactions
  WHERE user_id = _user_id
    AND type = 'withdrawal'
    AND status = 'completed'
    AND created_at >= _today_start;

  SELECT COALESCE(SUM(ABS(amount)), 0)::bigint
  INTO _pending_withdrawals
  FROM transactions
  WHERE user_id = _user_id
    AND type = 'withdrawal'
    AND status = 'pending';

  IF (_today_withdrawals + _pending_withdrawals + _amount_cents) > 50000 THEN
    RETURN QUERY SELECT false, 'Daily withdrawal limit exceeded'::text, (_today_withdrawals + _pending_withdrawals)::numeric;
    RETURN;
  END IF;

  IF _amount_cents > 50000 THEN
    RETURN QUERY SELECT false, 'Per-transaction limit exceeded'::text, _today_withdrawals::numeric;
    RETURN;
  END IF;

  SELECT MAX(created_at)
  INTO _last_withdrawal_at
  FROM transactions
  WHERE user_id = _user_id
    AND type = 'withdrawal';

  IF _last_withdrawal_at IS NOT NULL AND _last_withdrawal_at > (now() - interval '10 minutes') THEN
    RETURN QUERY SELECT false, 'Please wait 10 minutes between withdrawals'::text, _today_withdrawals::numeric;
    RETURN;
  END IF;

  SELECT available_balance
  INTO _available_balance
  FROM wallets
  WHERE id = _wallet_id
  FOR UPDATE;

  IF _available_balance < _amount_cents THEN
    RETURN QUERY SELECT false, 'Insufficient balance'::text, _today_withdrawals::numeric;
    RETURN;
  END IF;

  RETURN QUERY SELECT true, 'Approved'::text, _today_withdrawals::numeric;
END;
$function$;