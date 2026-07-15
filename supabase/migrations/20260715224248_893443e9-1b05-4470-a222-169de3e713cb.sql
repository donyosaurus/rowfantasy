
-- Server-side username enforcement: single validation function + two enforcement points.
-- Mirrors supabase/functions/shared/username-filter.ts (the DB is the enforcement layer;
-- the client filter remains the UX layer).

CREATE OR REPLACE FUNCTION public.check_username_valid(_username text)
RETURNS void
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_lower text;
  v_stripped text;
  v_decoded text;
  v_blocked_words text[] := ARRAY[
    'fuck','shit','ass','damn','bitch','bastard','dick','cock','pussy',
    'cunt','whore','slut','fag','faggot','nigger','nigga','retard',
    'twat','wanker','prick','douche','jackass','asshole','motherfucker',
    'kike','chink','spic','wetback','gook','raghead','towelhead',
    'tranny','shemale',
    'porn','xxx','sex','penis','vagina','dildo','blowjob','handjob',
    'cumshot','orgasm','erection','masturbat','hentai',
    'kill','murder','rape','molest','terrorist','bomb','shoot',
    'admin','moderator','support','staff','official','rowfantasy',
    'helpdesk','system','root','superuser'
  ];
  v_blocked_exact text[] := ARRAY[
    'god','satan','devil','hitler','nazi','kkk','isis',
    'null','undefined','anonymous','test','user','unknown'
  ];
  w text;
BEGIN
  IF _username IS NULL THEN
    RAISE EXCEPTION 'Username is required';
  END IF;

  IF char_length(_username) < 3 OR char_length(_username) > 20 THEN
    RAISE EXCEPTION 'Username must be 3-20 characters';
  END IF;

  v_lower := lower(_username);

  IF v_lower !~ '^[a-z0-9_]+$' THEN
    RAISE EXCEPTION 'Username can only contain lowercase letters, numbers, and underscores';
  END IF;

  -- Strip separators for content check (mirrors shared/username-filter.ts)
  v_stripped := regexp_replace(v_lower, '[_\-\.]', '', 'g');

  IF v_stripped = ANY (v_blocked_exact) THEN
    RAISE EXCEPTION 'This username is not allowed. Please choose another.';
  END IF;

  FOREACH w IN ARRAY v_blocked_words LOOP
    IF position(w in v_stripped) > 0 THEN
      RAISE EXCEPTION 'This username contains inappropriate language. Please choose another.';
    END IF;
  END LOOP;

  -- l33tspeak decode
  v_decoded := translate(v_stripped, '0134578@', 'oieasteb');
  IF v_decoded <> v_stripped THEN
    FOREACH w IN ARRAY v_blocked_words LOOP
      IF position(w in v_decoded) > 0 THEN
        RAISE EXCEPTION 'This username contains inappropriate language. Please choose another.';
      END IF;
    END LOOP;
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.check_username_valid(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.check_username_valid(text) TO authenticated, service_role;

-- Trigger enforcement on profiles
CREATE OR REPLACE FUNCTION public.validate_username()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  -- LOAD-BEARING bypass: soft-delete redaction writes 'deleted_<8-hex>' emails/usernames
  -- that can leet-decode into a blocked substring (e.g. a55 -> ass). Skip the check
  -- when the migration role or service_role performs the write.
  IF current_user IN ('postgres','service_role','supabase_admin') THEN
    RETURN NEW;
  END IF;

  -- Admin-API/invite-created users have no username yet.
  IF NEW.username IS NULL THEN
    RETURN NEW;
  END IF;

  PERFORM public.check_username_valid(NEW.username);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_username_trigger ON public.profiles;
CREATE TRIGGER validate_username_trigger
  BEFORE INSERT OR UPDATE OF username ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.validate_username();

-- Redefine handle_new_user to lowercase + validate username before insert.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_dob_raw TEXT;
  v_dob DATE;
  v_username TEXT;
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

  v_username := NULLIF(lower(btrim(NEW.raw_user_meta_data->>'username')), '');

  IF v_username IS NOT NULL THEN
    PERFORM public.check_username_valid(v_username);
  END IF;

  INSERT INTO public.profiles (id, email, full_name, username, date_of_birth, state, age_confirmed_at)
  VALUES (
    NEW.id,
    NEW.email,
    NEW.raw_user_meta_data->>'full_name',
    v_username,
    v_dob,
    NEW.raw_user_meta_data->>'state_code',
    CASE WHEN v_dob IS NOT NULL THEN now() ELSE NULL END
  );

  INSERT INTO public.wallets (user_id) VALUES (NEW.id);
  INSERT INTO public.user_roles (user_id, role) VALUES (NEW.id, 'user');

  RETURN NEW;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';
