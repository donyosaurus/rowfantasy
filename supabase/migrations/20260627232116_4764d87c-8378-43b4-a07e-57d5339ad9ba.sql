
-- 1) BEFORE UPDATE trigger guarding immutable age fields on profiles.
CREATE OR REPLACE FUNCTION public.profiles_protect_age_fields()
RETURNS trigger
LANGUAGE plpgsql
-- SECURITY INVOKER (default): current_user reflects the actual session role
-- under PostgREST/Supabase, mirroring responsible_gaming_validate_update().
SET search_path TO 'public'
AS $function$
BEGIN
  -- Role-based bypass: privileged DB roles may correct these fields.
  IF current_user IN ('postgres', 'service_role') THEN
    RETURN NEW;
  END IF;

  -- GUC-based bypass: server-side code (SECURITY DEFINER RPCs) may opt in
  -- by setting profiles.bypass_age_guard = 'true' for the transaction.
  IF current_setting('profiles.bypass_age_guard', true) = 'true' THEN
    RETURN NEW;
  END IF;

  IF NEW.date_of_birth IS DISTINCT FROM OLD.date_of_birth THEN
    RAISE EXCEPTION 'date_of_birth is immutable; contact support to correct it'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW.age_confirmed_at IS DISTINCT FROM OLD.age_confirmed_at THEN
    RAISE EXCEPTION 'age_confirmed_at is immutable; contact support to correct it'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS profiles_protect_age_fields ON public.profiles;
CREATE TRIGGER profiles_protect_age_fields
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.profiles_protect_age_fields();

-- 2) Harden DOB parsing in handle_new_user (single normalized parse).
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_dob_raw TEXT;
  v_dob DATE;
BEGIN
  v_dob_raw := NULLIF(btrim(NEW.raw_user_meta_data->>'date_of_birth'), '');

  IF v_dob_raw IS NOT NULL THEN
    BEGIN
      v_dob := v_dob_raw::date;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'Invalid date of birth';
    END;
  END IF;

  IF v_dob IS NOT NULL AND age(CURRENT_DATE, v_dob) < make_interval(years => 18) THEN
    RAISE EXCEPTION 'User must be at least 18 years old to register';
  END IF;

  INSERT INTO public.profiles (id, email, full_name, username, date_of_birth, state, age_confirmed_at)
  VALUES (
    NEW.id,
    NEW.email,
    NEW.raw_user_meta_data->>'full_name',
    NEW.raw_user_meta_data->>'username',
    v_dob,
    NEW.raw_user_meta_data->>'state_code',
    CASE WHEN v_dob IS NOT NULL THEN now() ELSE NULL END
  );

  INSERT INTO public.wallets (user_id)
  VALUES (NEW.id);

  INSERT INTO public.user_roles (user_id, role)
  VALUES (NEW.id, 'user');

  RETURN NEW;
END;
$function$;
