-- =========================================================================
-- Wave 4 #1: FK CASCADE → RESTRICT + soft-delete account flow
-- =========================================================================

-- ---- A. Convert CASCADE FKs to RESTRICT ----------------------------------

-- profiles.id → auth.users
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_id_fkey;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_id_fkey
  FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE RESTRICT;

-- wallets.user_id → auth.users
ALTER TABLE public.wallets DROP CONSTRAINT IF EXISTS wallets_user_id_fkey;
ALTER TABLE public.wallets
  ADD CONSTRAINT wallets_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE RESTRICT;

-- transactions.user_id → auth.users
ALTER TABLE public.transactions DROP CONSTRAINT IF EXISTS transactions_user_id_fkey;
ALTER TABLE public.transactions
  ADD CONSTRAINT transactions_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE RESTRICT;

-- kyc_verifications.user_id → auth.users
ALTER TABLE public.kyc_verifications DROP CONSTRAINT IF EXISTS kyc_verifications_user_id_fkey;
ALTER TABLE public.kyc_verifications
  ADD CONSTRAINT kyc_verifications_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE RESTRICT;

-- geofence_logs.user_id → auth.users
ALTER TABLE public.geofence_logs DROP CONSTRAINT IF EXISTS geofence_logs_user_id_fkey;
ALTER TABLE public.geofence_logs
  ADD CONSTRAINT geofence_logs_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE RESTRICT;

-- contest_entries.user_id → auth.users
ALTER TABLE public.contest_entries DROP CONSTRAINT IF EXISTS contest_entries_user_id_fkey;
ALTER TABLE public.contest_entries
  ADD CONSTRAINT contest_entries_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE RESTRICT;

-- payment_sessions.user_id → auth.users
ALTER TABLE public.payment_sessions DROP CONSTRAINT IF EXISTS payment_sessions_user_id_fkey;
ALTER TABLE public.payment_sessions
  ADD CONSTRAINT payment_sessions_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE RESTRICT;

-- privacy_requests.user_id → auth.users
ALTER TABLE public.privacy_requests DROP CONSTRAINT IF EXISTS privacy_requests_user_id_fkey;
ALTER TABLE public.privacy_requests
  ADD CONSTRAINT privacy_requests_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE RESTRICT;

-- user_consents.user_id → auth.users
ALTER TABLE public.user_consents DROP CONSTRAINT IF EXISTS user_consents_user_id_fkey;
ALTER TABLE public.user_consents
  ADD CONSTRAINT user_consents_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE RESTRICT;

-- match_queue.user_id → auth.users
ALTER TABLE public.match_queue DROP CONSTRAINT IF EXISTS match_queue_user_id_fkey;
ALTER TABLE public.match_queue
  ADD CONSTRAINT match_queue_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE RESTRICT;

-- ledger_entries.user_id → profiles
ALTER TABLE public.ledger_entries DROP CONSTRAINT IF EXISTS ledger_entries_user_id_fkey;
ALTER TABLE public.ledger_entries
  ADD CONSTRAINT ledger_entries_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE RESTRICT;

-- responsible_gaming.user_id → profiles
ALTER TABLE public.responsible_gaming DROP CONSTRAINT IF EXISTS responsible_gaming_user_id_fkey;
ALTER TABLE public.responsible_gaming
  ADD CONSTRAINT responsible_gaming_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE RESTRICT;

-- ---- B. Soft-delete columns on profiles ----------------------------------

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS deleted_reason text NULL;

CREATE INDEX IF NOT EXISTS idx_profiles_deleted_at
  ON public.profiles(deleted_at) WHERE deleted_at IS NOT NULL;

-- ---- C. soft_delete_user_account RPC -------------------------------------

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
  -- STEP 0a: Caller-role guard. Allow service_role JWT calls or direct postgres/supabase_admin.
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

  -- STEP 0c: Verify admin exists in auth.users AND has admin role.
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

  -- STEP 3a: Redact profile PII (single UPDATE for one before/after audit pair).
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
    deleted_at = now(),
    deleted_reason = _reason,
    updated_at = now()
  WHERE id = _target_user_id;

  -- STEP 3b: Redact geofence_logs PII (preserve state_detected for aggregate/regulatory).
  UPDATE public.geofence_logs
  SET ip_address = NULL,
      gps_latitude = NULL,
      gps_longitude = NULL,
      zip_code = NULL,
      metadata = NULL
  WHERE user_id = _target_user_id;

  -- STEP 3c: Redact KYC verification_data; preserve status/provider/timestamps as control evidence.
  UPDATE public.kyc_verifications
  SET verification_data = '{"redacted": true}'::jsonb,
      verification_id = NULL,
      failure_reason = NULL
  WHERE user_id = _target_user_id;

  -- STEP 3d: Payment sessions — redact provider tokens & metadata.
  UPDATE public.payment_sessions
  SET checkout_url = NULL,
      client_token = NULL,
      metadata = '{"redacted": true}'::jsonb
  WHERE user_id = _target_user_id;

  -- STEP 3e: Privacy requests metadata.
  UPDATE public.privacy_requests
  SET metadata = '{"redacted": true}'::jsonb
  WHERE user_id = _target_user_id;

  -- STEP 3f: User consents — drop IP/UA (PII).
  UPDATE public.user_consents
  SET ip_address = NULL,
      user_agent = NULL
  WHERE user_id = _target_user_id;

  -- STEP 3g: Support tickets — redact free-form content; preserve metadata for audit.
  UPDATE public.support_tickets
  SET message = '[REDACTED]',
      subject = '[REDACTED]',
      email = format('deleted_%s@redacted.invalid', _target_user_id),
      metadata = '{"redacted": true}'::jsonb
  WHERE user_id = _target_user_id;

  -- STEP 5 (operator runbook): session revocation must be invoked from the
  -- edge function via auth.admin.signOut() — not callable from SQL DEFINER.

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
        'payment_sessions','privacy_requests','user_consents','support_tickets'
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

-- Lock execution to service_role only.
REVOKE ALL ON FUNCTION public.soft_delete_user_account(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.soft_delete_user_account(uuid, uuid, text) FROM authenticated;
REVOKE ALL ON FUNCTION public.soft_delete_user_account(uuid, uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.soft_delete_user_account(uuid, uuid, text) TO service_role;

COMMENT ON FUNCTION public.soft_delete_user_account(uuid, uuid, text) IS
  'Wave 4 #1: GDPR/CCPA right-to-erasure handler. Redacts PII across user-scoped tables while preserving AML/KYC/financial trail. Idempotent. service_role only. Never call auth.admin.deleteUser directly — use this RPC.';

COMMENT ON COLUMN public.profiles.deleted_at IS
  'Soft-delete tombstone. NULL=active. Set by soft_delete_user_account.';
COMMENT ON COLUMN public.profiles.deleted_reason IS
  'Reason supplied to soft_delete_user_account (>=10 chars).';