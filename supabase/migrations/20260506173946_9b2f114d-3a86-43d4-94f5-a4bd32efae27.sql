-- System account used as _admin_user_id for cron-driven void operations.
-- The account is created in auth.users with no password (login_disabled effectively
-- since no credential exists). Admin role is required because void_contest_pool_atomic
-- enforces admin authorization on the supplied _admin_user_id.
--
-- Idempotent: safe to re-run (uses ON CONFLICT DO NOTHING on a stable email).

DO $$
DECLARE
  _system_user_id uuid;
  _existing uuid;
BEGIN
  SELECT id INTO _existing FROM auth.users WHERE email = 'system+auto-void@rowfantasy.internal';

  IF _existing IS NULL THEN
    _system_user_id := gen_random_uuid();

    INSERT INTO auth.users (
      id,
      instance_id,
      aud,
      role,
      email,
      encrypted_password,
      email_confirmed_at,
      raw_app_meta_data,
      raw_user_meta_data,
      created_at,
      updated_at,
      is_super_admin,
      is_sso_user
    ) VALUES (
      _system_user_id,
      '00000000-0000-0000-0000-000000000000'::uuid,
      'authenticated',
      'authenticated',
      'system+auto-void@rowfantasy.internal',
      '', -- no password; account cannot sign in
      now(),
      jsonb_build_object('provider', 'system', 'providers', ARRAY['system'], 'system_account', true),
      jsonb_build_object('full_name', 'System: Auto-Void Sweep', 'system_account', true),
      now(),
      now(),
      false,
      false
    );

    -- handle_new_user trigger creates a profile + wallet + 'user' role row.
    -- Promote to admin (idempotent: ON CONFLICT on (user_id, role) is implicit via INSERT...WHERE NOT EXISTS).
    INSERT INTO public.user_roles (user_id, role)
    SELECT _system_user_id, 'admin'::app_role
    WHERE NOT EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = _system_user_id AND role = 'admin'::app_role
    );
  ELSE
    -- Account exists; ensure admin role is present.
    INSERT INTO public.user_roles (user_id, role)
    SELECT _existing, 'admin'::app_role
    WHERE NOT EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = _existing AND role = 'admin'::app_role
    );
  END IF;
END $$;

COMMENT ON TABLE public.user_roles IS
  'User role assignments. The system account system+auto-void@rowfantasy.internal '
  'holds the admin role for use by the auto-void-unfilled-pools cron sweep '
  '(see supabase/functions/auto-void-unfilled-pools/index.ts).';