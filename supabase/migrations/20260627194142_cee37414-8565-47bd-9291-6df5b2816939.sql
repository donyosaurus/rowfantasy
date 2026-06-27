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

  INSERT INTO public.profiles (id, email, full_name, username, date_of_birth, state, age_confirmed_at)
  VALUES (
    NEW.id,
    NEW.email,
    NEW.raw_user_meta_data->>'full_name',
    NEW.raw_user_meta_data->>'username',
    NULLIF(NEW.raw_user_meta_data->>'date_of_birth','')::date,
    NEW.raw_user_meta_data->>'state_code',
    CASE WHEN NULLIF(NEW.raw_user_meta_data->>'date_of_birth','') IS NOT NULL THEN now() ELSE NULL END
  );

  INSERT INTO public.wallets (user_id)
  VALUES (NEW.id);

  INSERT INTO public.user_roles (user_id, role)
  VALUES (NEW.id, 'user');

  RETURN NEW;
END;
$function$;