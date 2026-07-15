
-- FIX 1: profiles sensitive-column guard — drop stale self_exclusion_until reference
CREATE OR REPLACE FUNCTION public.profiles_prevent_sensitive_self_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  IF current_user IN ('postgres', 'service_role', 'supabase_admin') THEN
    RETURN NEW;
  END IF;

  IF auth.uid() IS NOT NULL AND public.has_role(auth.uid(), 'admin'::app_role) THEN
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.kyc_status IS DISTINCT FROM OLD.kyc_status
     OR NEW.is_employee IS DISTINCT FROM OLD.is_employee
     OR NEW.is_active IS DISTINCT FROM OLD.is_active
     OR NEW.deposit_limit_monthly IS DISTINCT FROM OLD.deposit_limit_monthly
     OR NEW.self_exclusion_type IS DISTINCT FROM OLD.self_exclusion_type
     OR NEW.email IS DISTINCT FROM OLD.email
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'Not permitted to modify restricted profile fields'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

-- FIX 2: correct leet-decode target ('oieasteb' -> 'oieastba') so 8->b and @->a
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

  v_stripped := regexp_replace(v_lower, '[_\-\.]', '', 'g');

  IF v_stripped = ANY (v_blocked_exact) THEN
    RAISE EXCEPTION 'This username is not allowed. Please choose another.';
  END IF;

  FOREACH w IN ARRAY v_blocked_words LOOP
    IF position(w in v_stripped) > 0 THEN
      RAISE EXCEPTION 'This username contains inappropriate language. Please choose another.';
    END IF;
  END LOOP;

  v_decoded := translate(v_stripped, '0134578@', 'oieastba');
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

-- FIX 3: validate_username enforces lowercase
CREATE OR REPLACE FUNCTION public.validate_username()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  IF current_user IN ('postgres','service_role','supabase_admin') THEN
    RETURN NEW;
  END IF;

  IF NEW.username IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.username IS DISTINCT FROM lower(NEW.username) THEN
    RAISE EXCEPTION 'Username must be lowercase';
  END IF;

  PERFORM public.check_username_valid(NEW.username);
  RETURN NEW;
END;
$$;

NOTIFY pgrst, 'reload schema';
