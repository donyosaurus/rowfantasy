-- ============================================================================
-- Migration 1 of 2: Extend ledger_entries.transaction_type allowlist
-- Add 'WITHDRAWAL_CANCEL' to support atomic withdrawal cancellation refunds.
-- Existing allowlist preserved verbatim.
-- ============================================================================

ALTER TABLE public.ledger_entries
  DROP CONSTRAINT IF EXISTS ledger_entries_transaction_type_check;

ALTER TABLE public.ledger_entries
  ADD CONSTRAINT ledger_entries_transaction_type_check
  CHECK (transaction_type = ANY (ARRAY[
    'DEPOSIT'::text,
    'WITHDRAWAL'::text,
    'ENTRY_FEE'::text,
    'PRIZE'::text,
    'PRIZE_PAYOUT'::text,
    'REFUND'::text,
    'ENTRY_FEE_REFUND'::text,
    'BONUS'::text,
    'ADJUSTMENT'::text,
    'WITHDRAWAL_CANCEL'::text
  ]));

-- ============================================================================
-- Migration 2 of 2: cancel_pending_withdrawal_atomic
-- Single-transaction cancel: flips withdrawal tx to 'failed' AND restores
-- funds (pending -> available) AND writes a counter-ledger entry, all-or-nothing.
-- Eliminates the partial-state class where the previous two-step JS flow
-- could leave a transaction marked failed but funds locked in pending_balance.
--
-- Defensive role guard uses session_user (NOT current_user) per Tier-1 #6
-- post-mortem: inside SECURITY DEFINER, current_user is always the function
-- owner (postgres) and cannot detect the actual caller; session_user is
-- invariant across SECURITY DEFINER hops and reflects the real connection role.
--
-- NOTE on ledger_entries shape: the table has no wallet_id or transaction_id
-- column. Per Fix 10 convention, the originating transaction is captured via
-- reference_id (uuid) + description. Sign convention: positive amount because
-- funds are returning to available balance; direction is conveyed by
-- transaction_type = 'WITHDRAWAL_CANCEL'.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.cancel_pending_withdrawal_atomic(
  _user_id uuid,
  _transaction_id uuid
)
RETURNS TABLE (
  allowed boolean,
  reason text,
  amount_cents bigint,
  available_balance_cents bigint,
  pending_balance_cents bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _tx record;
  _wallet record;
BEGIN
  -- STEP 0: Defensive role guard.
  -- session_user is correct here (NOT current_user). Inside SECURITY DEFINER,
  -- current_user equals the function owner and would always pass, defeating
  -- the guard. session_user reflects the actual connecting role.
  IF session_user NOT IN ('postgres', 'service_role') THEN
    RAISE EXCEPTION 'unauthorized: cancel_pending_withdrawal_atomic may only be called by service_role';
  END IF;

  -- STEP 1: Lock transaction row + verify ownership/state
  SELECT * INTO _tx
  FROM public.transactions
  WHERE id = _transaction_id
    AND user_id = _user_id
    AND type = 'withdrawal'
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'transaction_not_found'::text, NULL::bigint, NULL::bigint, NULL::bigint;
    RETURN;
  END IF;

  IF _tx.status <> 'pending' THEN
    RETURN QUERY SELECT false, 'not_pending'::text, NULL::bigint, NULL::bigint, NULL::bigint;
    RETURN;
  END IF;

  -- STEP 2: Lock wallet
  SELECT * INTO _wallet
  FROM public.wallets
  WHERE id = _tx.wallet_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'wallet_not_found'::text, NULL::bigint, NULL::bigint, NULL::bigint;
    RETURN;
  END IF;

  -- STEP 3: Sanity — pending must cover the refund
  IF _wallet.pending_balance < _tx.amount THEN
    RETURN QUERY SELECT false, 'pending_balance_insufficient'::text,
      _tx.amount::bigint,
      _wallet.available_balance::bigint,
      _wallet.pending_balance::bigint;
    RETURN;
  END IF;

  -- STEP 4: Mark transaction failed (single write, same xact)
  UPDATE public.transactions
  SET status = 'failed',
      metadata = COALESCE(metadata, '{}'::jsonb)
                 || jsonb_build_object('cancelled_by_user', true, 'cancelled_at', now())
  WHERE id = _transaction_id;

  -- STEP 5: Restore funds atomically
  UPDATE public.wallets
  SET available_balance = available_balance + _tx.amount,
      pending_balance   = pending_balance   - _tx.amount,
      updated_at        = now()
  WHERE id = _tx.wallet_id;

  -- STEP 6: Counter-ledger entry (compliance trail).
  -- ledger_entries shape: (user_id, amount, transaction_type, description, reference_id).
  -- Positive amount = funds returning to available; direction encoded in transaction_type.
  INSERT INTO public.ledger_entries (
    user_id, transaction_type, amount, reference_id, description
  )
  VALUES (
    _user_id,
    'WITHDRAWAL_CANCEL',
    _tx.amount,
    _transaction_id,
    'User cancelled pending withdrawal'
  );

  -- STEP 7: Return final balances
  SELECT * INTO _wallet FROM public.wallets WHERE id = _tx.wallet_id;
  RETURN QUERY SELECT true, 'ok'::text,
    _tx.amount::bigint,
    _wallet.available_balance::bigint,
    _wallet.pending_balance::bigint;
END;
$$;

-- Lock down execution to service_role only.
REVOKE ALL ON FUNCTION public.cancel_pending_withdrawal_atomic(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cancel_pending_withdrawal_atomic(uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.cancel_pending_withdrawal_atomic(uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_pending_withdrawal_atomic(uuid, uuid) TO service_role;