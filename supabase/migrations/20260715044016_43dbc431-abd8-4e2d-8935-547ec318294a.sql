-- Harden soft_delete_user_account: deactivate profile + ban auth account + redact identity + kill sessions
CREATE OR REPLACE FUNCTION public.soft_delete_user_account(
  _admin_user_id uuid,
  _target_user_id uuid,
  _reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_profile public.profiles%ROWTYPE;
  v_admin_exists boolean;
  v_email_sample text;
BEGIN
  -- STEP 0a: Caller-role guard.
  IF NOT (
    auth.role() = 'service_role'
    OR session_user IN ('postgres', 'supabase_admin')
  ) THEN
    RAISE EXCEPTION 'soft_delete_user_account: forbidden caller role (session_user=%, auth.role=%)',
      session_user, auth.role()
      USING ERRCODE = '42501';
  END IF;

  -- STEP 0b: Validate inputs.
  IF _admin_user_id IS NULL OR _target_user_id IS NULL THEN
    RAISE EXCEPTION 'soft_delete_user_account: admin and target ids required'
      USING ERRCODE = '22023';
  END IF;
  IF _reason IS NULL OR length(trim(_reason)) < 10 THEN
    RAISE EXCEPTION 'soft_delete_user_account: reason must be at least 10 characters'
      USING ERRCODE = '22023';
  END IF;

  -- STEP 0c: Verify admin exists AND has admin role.
  SELECT EXISTS (
    SELECT 1
    FROM auth.users u
    JOIN public.user_roles r ON r.user_id = u.id
    WHERE u.id = _admin_user_id AND r.role = 'admin'::app_role
  ) INTO v_admin_exists;

  IF NOT v_admin_exists THEN
    RAISE EXCEPTION 'soft_delete_user_account: admin % not found or not admin', _admin_user_id
      USING ERRCODE = '42501';
  END IF;

  -- STEP 1: Lock profile row.
  SELECT * INTO v_profile
  FROM public.profiles
  WHERE id = _target_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'soft_delete_user_account: target profile % not found', _target_user_id
      USING ERRCODE = 'P0002';
  END IF;

  -- STEP 2: Idempotency.
  IF v_profile.deleted_at IS NOT NULL THEN
    RETURN jsonb_build_object(
      'success', true,
      'profile_id', v_profile.id,
      'redacted_at', v_profile.deleted_at,
      'was_already_deleted', true
    );
  END IF;

  -- STEP 3a: Redact profile PII + deactivate.
  UPDATE public.profiles
  SET
    email = format('deleted_%s@redacted.invalid', id),
    username = format('deleted_%s', substring(id::text, 1, 8)),
    full_name = NULL,
    date_of_birth = NULL,
    address_line1 = NULL,
    address_line2 = NULL,
    city = NULL,
    state = NULL,
    zip_code = NULL,
    phone = NULL,
    is_active = false,
    deleted_at = now(),
    deleted_reason = _reason,
    updated_at = now()
  WHERE id = _target_user_id;

  -- STEP 3a.1: Ban + redact the auth account (200y — GoTrue rejects 'infinity').
  UPDATE auth.users
     SET banned_until = now() + interval '200 years',
         email = format('deleted_%s@redacted.invalid', _target_user_id),
         raw_user_meta_data = '{}'::jsonb
   WHERE id = _target_user_id;

  -- STEP 3a.2: Redact identity_data (identities.email is GENERATED from it).
  UPDATE auth.identities
     SET identity_data = jsonb_build_object(
           'sub', _target_user_id::text,
           'email', format('deleted_%s@redacted.invalid', _target_user_id))
   WHERE user_id = _target_user_id;

  -- STEP 3a.3: Kill live sessions and refresh tokens.
  DELETE FROM auth.refresh_tokens WHERE user_id = _target_user_id::text;
  DELETE FROM auth.sessions WHERE user_id = _target_user_id;

  -- STEP 3b: geofence_logs PII.
  UPDATE public.geofence_logs
  SET ip_address = NULL,
      gps_latitude = NULL,
      gps_longitude = NULL,
      zip_code = NULL,
      metadata = NULL
  WHERE user_id = _target_user_id;

  -- STEP 3c: KYC.
  UPDATE public.kyc_verifications
  SET verification_data = '{"redacted": true}'::jsonb,
      verification_id = NULL,
      failure_reason = NULL
  WHERE user_id = _target_user_id;

  -- STEP 3d: Payment sessions.
  UPDATE public.payment_sessions
  SET checkout_url = NULL,
      client_token = NULL,
      metadata = '{"redacted": true}'::jsonb
  WHERE user_id = _target_user_id;

  -- STEP 3e: Privacy requests.
  UPDATE public.privacy_requests
  SET metadata = '{"redacted": true}'::jsonb
  WHERE user_id = _target_user_id;

  -- STEP 3f: User consents.
  UPDATE public.user_consents
  SET ip_address = NULL,
      user_agent = NULL
  WHERE user_id = _target_user_id;

  -- STEP 3g: Support tickets.
  UPDATE public.support_tickets
  SET message = '[REDACTED]',
      subject = '[REDACTED]',
      email = format('deleted_%s@redacted.invalid', _target_user_id),
      metadata = '{"redacted": true}'::jsonb
  WHERE user_id = _target_user_id;

  -- STEP 6: Compliance audit log entry.
  v_email_sample := format('*****@redacted.invalid');
  INSERT INTO public.compliance_audit_logs (
    user_id, admin_id, event_type, severity, description, metadata
  ) VALUES (
    _target_user_id,
    _admin_user_id,
    'account_soft_deleted',
    'warning',
    format('Account soft-deleted by admin. Reason: %s', _reason),
    jsonb_build_object(
      'reason', _reason,
      'redacted_email_sample', v_email_sample,
      'tables_redacted', jsonb_build_array(
        'profiles','geofence_logs','kyc_verifications',
        'payment_sessions','privacy_requests','user_consents','support_tickets',
        'auth.users','auth.identities','auth.sessions'
      )
    )
  );

  RETURN jsonb_build_object(
    'success', true,
    'profile_id', _target_user_id,
    'redacted_at', now(),
    'was_already_deleted', false
  );
END;
$$;

REVOKE ALL ON FUNCTION public.soft_delete_user_account(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.soft_delete_user_account(uuid, uuid, text) FROM authenticated;
REVOKE ALL ON FUNCTION public.soft_delete_user_account(uuid, uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.soft_delete_user_account(uuid, uuid, text) TO service_role;

-- Backfill already-deleted accounts (idempotent RPC won't re-run for them).
DO $backfill$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT id FROM public.profiles WHERE deleted_at IS NOT NULL LOOP
    UPDATE public.profiles
       SET is_active = false,
           updated_at = now()
     WHERE id = r.id;

    UPDATE auth.users
       SET banned_until = now() + interval '200 years',
           email = format('deleted_%s@redacted.invalid', r.id),
           raw_user_meta_data = '{}'::jsonb
     WHERE id = r.id;

    UPDATE auth.identities
       SET identity_data = jsonb_build_object(
             'sub', r.id::text,
             'email', format('deleted_%s@redacted.invalid', r.id))
     WHERE user_id = r.id;

    DELETE FROM auth.refresh_tokens WHERE user_id = r.id::text;
    DELETE FROM auth.sessions WHERE user_id = r.id;
  END LOOP;
END;
$backfill$;

NOTIFY pgrst, 'reload schema';