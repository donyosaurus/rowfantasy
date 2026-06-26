-- Replace process_webhook_deposit_atomic with provider + amount binding and ledger insert
DROP FUNCTION IF EXISTS public.process_webhook_deposit_atomic(uuid, text, text);

CREATE OR REPLACE FUNCTION public.process_webhook_deposit_atomic(
  _session_id uuid,
  _webhook_id text,
  _provider text,
  _event_amount_cents bigint
)
RETURNS TABLE(credited boolean, reason text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _session public.payment_sessions%ROWTYPE;
  _wallet  public.wallets%ROWTYPE;
  _new_transaction_id uuid;
BEGIN
  SELECT * INTO _session FROM public.payment_sessions WHERE id = _session_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'session_not_found'::text;
    RETURN;
  END IF;

  IF _session.status <> 'pending' THEN
    RETURN QUERY SELECT false, 'already_processed'::text;
    RETURN;
  END IF;

  -- Bind credit to the provider that created the session
  IF _session.provider <> _provider THEN
    RETURN QUERY SELECT false, 'provider_mismatch'::text;
    RETURN;
  END IF;

  -- Bind credit to the exact session amount; provider must not change it
  IF _session.amount_cents <> _event_amount_cents THEN
    RETURN QUERY SELECT false, 'amount_mismatch'::text;
    RETURN;
  END IF;

  SELECT * INTO _wallet FROM public.wallets WHERE user_id = _session.user_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'wallet_not_found'::text;
    RETURN;
  END IF;

  UPDATE public.payment_sessions
     SET status = 'succeeded',
         completed_at = now()
   WHERE id = _session_id;

  INSERT INTO public.transactions (
    user_id, wallet_id, type, amount, status,
    reference_id, reference_type, description, completed_at, metadata
  ) VALUES (
    _session.user_id,
    _wallet.id,
    'deposit',
    _session.amount_cents,
    'completed',
    _session.id::text,
    'payment_session',
    'Deposit via payment processor',
    now(),
    jsonb_build_object(
      'provider', _provider,
      'webhook_id', _webhook_id,
      'provider_session_id', _session.provider_session_id
    )
  )
  RETURNING id INTO _new_transaction_id;

  UPDATE public.wallets
     SET available_balance  = available_balance  + _session.amount_cents,
         lifetime_deposits  = lifetime_deposits  + _session.amount_cents,
         updated_at         = now()
   WHERE id = _wallet.id;

  -- Ledger entry mirrors process_deposit_atomic so webhook deposits count toward RG monthly limit
  INSERT INTO public.ledger_entries (user_id, transaction_type, amount, reference_id, description)
  VALUES (
    _session.user_id,
    'DEPOSIT',
    _session.amount_cents,
    _new_transaction_id,
    'Deposit credit'
  );

  INSERT INTO public.compliance_audit_logs (
    user_id, event_type, description, severity, state_code, metadata
  ) VALUES (
    _session.user_id,
    'deposit_completed',
    'Deposit processed via webhook',
    'info',
    _session.state_code,
    jsonb_build_object(
      'amount_cents', _session.amount_cents,
      'provider', _provider,
      'session_id', _session.id,
      'webhook_id', _webhook_id
    )
  );

  RETURN QUERY SELECT true, 'ok'::text;
END;
$$;

REVOKE ALL ON FUNCTION public.process_webhook_deposit_atomic(uuid, text, text, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.process_webhook_deposit_atomic(uuid, text, text, bigint) FROM anon;
REVOKE ALL ON FUNCTION public.process_webhook_deposit_atomic(uuid, text, text, bigint) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.process_webhook_deposit_atomic(uuid, text, text, bigint) TO service_role;