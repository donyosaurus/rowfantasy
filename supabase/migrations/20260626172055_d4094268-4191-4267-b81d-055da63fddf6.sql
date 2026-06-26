-- Part 2 closure: reaffirm IPBase off (idempotent)
UPDATE public.feature_flags SET value = '{"enabled": false}'::jsonb WHERE key = 'ipbase_enabled';

-- P0-S1: atomic, idempotent deposit-credit RPC for payments-webhook
CREATE OR REPLACE FUNCTION public.process_webhook_deposit_atomic(
  _session_id uuid,
  _webhook_id text,
  _provider text
)
RETURNS TABLE(credited boolean, reason text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _session public.payment_sessions%ROWTYPE;
  _wallet  public.wallets%ROWTYPE;
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
    _session.provider_session_id,
    'payment_session',
    'Deposit via payment processor',
    now(),
    jsonb_build_object('provider', _provider, 'webhook_id', _webhook_id)
  );

  UPDATE public.wallets
     SET available_balance  = available_balance  + _session.amount_cents,
         lifetime_deposits  = lifetime_deposits  + _session.amount_cents,
         updated_at         = now()
   WHERE id = _wallet.id;

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

REVOKE ALL ON FUNCTION public.process_webhook_deposit_atomic(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.process_webhook_deposit_atomic(uuid, text, text) FROM anon;
REVOKE ALL ON FUNCTION public.process_webhook_deposit_atomic(uuid, text, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.process_webhook_deposit_atomic(uuid, text, text) TO service_role;