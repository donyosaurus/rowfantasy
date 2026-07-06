CREATE OR REPLACE FUNCTION public.responsible_gaming_audit()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public
AS $function$
DECLARE
  _events jsonb[] := ARRAY[]::jsonb[];
  _ev jsonb;
  _before jsonb;
  _after jsonb;
  _total int;
  _idx int;
  _target_user uuid;
  _limit_changed boolean := false;
BEGIN
  -- Build before/after snapshots for the metadata blob.
  IF TG_OP = 'INSERT' THEN
    _target_user := NEW.user_id;
    _before := 'null'::jsonb;
    _after := jsonb_build_object(
      'deposit_limit_monthly_cents', NEW.deposit_limit_monthly_cents,
      'pending_deposit_limit_monthly_cents', NEW.pending_deposit_limit_monthly_cents,
      'pending_limit_effective_at', NEW.pending_limit_effective_at,
      'self_exclusion_until', NEW.self_exclusion_until
    );
    _events := array_append(_events, jsonb_build_object(
      'event_type', 'rg_initial_set',
      'severity',   'info',
      'description','Responsible gaming row created'
    ));

  ELSIF TG_OP = 'DELETE' THEN
    _target_user := OLD.user_id;
    _before := jsonb_build_object(
      'deposit_limit_monthly_cents', OLD.deposit_limit_monthly_cents,
      'pending_deposit_limit_monthly_cents', OLD.pending_deposit_limit_monthly_cents,
      'pending_limit_effective_at', OLD.pending_limit_effective_at,
      'self_exclusion_until', OLD.self_exclusion_until
    );
    _after := 'null'::jsonb;
    _events := array_append(_events, jsonb_build_object(
      'event_type', 'rg_deleted',
      'severity',   'critical',
      'description','Responsible gaming row deleted'
    ));

  ELSE -- UPDATE
    _target_user := NEW.user_id;
    _before := jsonb_build_object(
      'deposit_limit_monthly_cents', OLD.deposit_limit_monthly_cents,
      'pending_deposit_limit_monthly_cents', OLD.pending_deposit_limit_monthly_cents,
      'pending_limit_effective_at', OLD.pending_limit_effective_at,
      'self_exclusion_until', OLD.self_exclusion_until
    );
    _after := jsonb_build_object(
      'deposit_limit_monthly_cents', NEW.deposit_limit_monthly_cents,
      'pending_deposit_limit_monthly_cents', NEW.pending_deposit_limit_monthly_cents,
      'pending_limit_effective_at', NEW.pending_limit_effective_at,
      'self_exclusion_until', NEW.self_exclusion_until
    );

    IF OLD.deposit_limit_monthly_cents IS DISTINCT FROM NEW.deposit_limit_monthly_cents THEN
      _limit_changed := true;
      IF OLD.deposit_limit_monthly_cents IS NULL AND NEW.deposit_limit_monthly_cents IS NOT NULL THEN
        _events := array_append(_events, jsonb_build_object(
          'event_type', 'rg_initial_set',
          'severity',   'info',
          'description','Initial monthly deposit limit set'
        ));
      ELSIF OLD.deposit_limit_monthly_cents IS NOT NULL
        AND NEW.deposit_limit_monthly_cents IS NOT NULL
        AND OLD.deposit_limit_monthly_cents < NEW.deposit_limit_monthly_cents THEN
        _events := array_append(_events, jsonb_build_object(
          'event_type', 'rg_limit_increased',
          'severity',   'info',
          'description','Monthly deposit limit increased'
        ));
      ELSIF OLD.deposit_limit_monthly_cents IS NOT NULL
        AND NEW.deposit_limit_monthly_cents IS NOT NULL
        AND OLD.deposit_limit_monthly_cents > NEW.deposit_limit_monthly_cents THEN
        _events := array_append(_events, jsonb_build_object(
          'event_type', 'rg_limit_decreased',
          'severity',   'warning',
          'description','Monthly deposit limit decreased'
        ));
      END IF;
    END IF;

    IF OLD.pending_deposit_limit_monthly_cents IS DISTINCT FROM NEW.pending_deposit_limit_monthly_cents THEN
      IF OLD.pending_deposit_limit_monthly_cents IS NULL
         AND NEW.pending_deposit_limit_monthly_cents IS NOT NULL THEN
        _events := array_append(_events, jsonb_build_object(
          'event_type', 'rg_pending_staged',
          'severity',   'info',
          'description','Pending deposit limit staged'
        ));
      ELSIF OLD.pending_deposit_limit_monthly_cents IS NOT NULL
            AND NEW.pending_deposit_limit_monthly_cents IS NULL
            AND NOT _limit_changed THEN
        _events := array_append(_events, jsonb_build_object(
          'event_type', 'rg_pending_cancelled',
          'severity',   'info',
          'description','Pending deposit limit cancelled'
        ));
      END IF;
    END IF;

    IF OLD.self_exclusion_until IS DISTINCT FROM NEW.self_exclusion_until THEN
      IF OLD.self_exclusion_until IS NULL AND NEW.self_exclusion_until IS NOT NULL THEN
        _events := array_append(_events, jsonb_build_object(
          'event_type', 'rg_self_exclusion_set',
          'severity',   'warning',
          'description','Self-exclusion set'
        ));
      ELSIF OLD.self_exclusion_until IS NOT NULL
            AND (NEW.self_exclusion_until IS NULL OR NEW.self_exclusion_until <= now()) THEN
        _events := array_append(_events, jsonb_build_object(
          'event_type', 'rg_self_exclusion_lifted',
          'severity',   'warning',
          'description','Self-exclusion lifted or expired'
        ));
      END IF;
    END IF;
  END IF;

  _total := array_length(_events, 1);
  IF _total IS NULL OR _total = 0 THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  FOR _idx IN 1.._total LOOP
    _ev := _events[_idx];
    INSERT INTO public.compliance_audit_logs (
      user_id, event_type, description, severity, metadata
    ) VALUES (
      _target_user,
      _ev->>'event_type',
      _ev->>'description',
      _ev->>'severity',
      jsonb_build_object(
        'before', _before,
        'after',  _after,
        'actor_session_user', session_user,
        'operation', TG_OP,
        'trigger_emission_index', _idx - 1,
        'trigger_emission_total', _total
      )
    );
  END LOOP;

  RETURN COALESCE(NEW, OLD);
END;
$function$;

NOTIFY pgrst, 'reload schema';