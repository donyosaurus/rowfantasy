CREATE OR REPLACE FUNCTION public.apply_pending_responsible_gaming_limit(p_user_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _row record;
BEGIN
  -- Defensive guard: only postgres or service_role should reach this code.
  -- EXECUTE is restricted to service_role, but this provides a second layer
  -- against accidental future grant changes.
  --
  -- NOTE: We use session_user (not current_user) here. Inside a SECURITY DEFINER
  -- function, current_user returns the function owner (postgres) and would make
  -- this guard always pass. session_user is invariant across SECURITY DEFINER
  -- hops and reflects the actual login role of the caller, which is what we
  -- want to authorize against.
  IF session_user NOT IN ('postgres', 'service_role') THEN
    RAISE EXCEPTION 'unauthorized: apply_pending_responsible_gaming_limit may only be called by service_role';
  END IF;

  -- Lock the user's row first, then re-check pending state inside the lock
  SELECT * INTO _row
  FROM public.responsible_gaming
  WHERE user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN;  -- no row to update
  END IF;

  -- Only proceed if pending is set and elapsed
  IF _row.pending_deposit_limit_monthly_cents IS NULL
     OR _row.pending_limit_effective_at IS NULL
     OR _row.pending_limit_effective_at > now() THEN
    RETURN;
  END IF;

  UPDATE public.responsible_gaming
  SET deposit_limit_monthly_cents = pending_deposit_limit_monthly_cents,
      pending_deposit_limit_monthly_cents = NULL,
      pending_limit_effective_at = NULL,
      updated_at = now()
  WHERE user_id = p_user_id;
END;
$function$;

-- Explicit, idempotent permission posture (self-contained for audit)
REVOKE ALL ON FUNCTION public.apply_pending_responsible_gaming_limit(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.apply_pending_responsible_gaming_limit(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.apply_pending_responsible_gaming_limit(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.apply_pending_responsible_gaming_limit(uuid) TO service_role;