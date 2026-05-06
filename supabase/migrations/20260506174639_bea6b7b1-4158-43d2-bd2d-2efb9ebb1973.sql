-- ============================================================================
-- PREREQUISITE: dblink extension for autonomous audit writes from BEFORE DELETE
-- guard. Lives in the extensions schema per Supabase convention.
-- ============================================================================
CREATE EXTENSION IF NOT EXISTS dblink WITH SCHEMA extensions;


-- ============================================================================
-- A2b. log_blocked_rg_delete — autonomous-connection audit emitter
-- Used by the BEFORE DELETE guard to record a blocked attempt before the
-- calling transaction aborts via RAISE EXCEPTION. Uses dblink so the INSERT
-- commits independently of the aborting xact.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.log_blocked_rg_delete(
  _user_id uuid,
  _session_user text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  _conn_str text;
BEGIN
  -- dbname only — relies on local trust / peer auth between the postgres
  -- backend and itself. No password handling, no network leak surface.
  _conn_str := format('dbname=%s', current_database());

  PERFORM extensions.dblink_exec(
    _conn_str,
    format(
      'INSERT INTO public.compliance_audit_logs (user_id, event_type, description, severity, metadata) VALUES (%L, %L, %L, %L, %L::jsonb)',
      _user_id,
      'rg_delete_blocked',
      'Blocked DELETE attempt on responsible_gaming',
      'critical',
      jsonb_build_object(
        'attempted_session_user', _session_user,
        'blocked_at', now()
      )::text
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.log_blocked_rg_delete(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.log_blocked_rg_delete(uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.log_blocked_rg_delete(uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.log_blocked_rg_delete(uuid, text) TO postgres;
GRANT EXECUTE ON FUNCTION public.log_blocked_rg_delete(uuid, text) TO service_role;


-- ============================================================================
-- A2. responsible_gaming_delete_guard — BEFORE DELETE block + audit
-- SECURITY INVOKER (Tier 1 #6 lesson — defending user actions uses INVOKER
-- so session_user reflects the real caller).
-- ============================================================================
CREATE OR REPLACE FUNCTION public.responsible_gaming_delete_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  IF session_user NOT IN ('postgres') THEN
    -- Audit the BLOCKED attempt BEFORE raising. Once we RAISE the DELETE
    -- aborts and the AFTER DELETE audit trigger never fires; the helper
    -- commits via a dedicated dblink connection.
    PERFORM public.log_blocked_rg_delete(OLD.user_id, session_user);
    RAISE EXCEPTION
      'unauthorized: DELETE on responsible_gaming requires postgres role; use admin_override_responsible_gaming for audited operational overrides';
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS responsible_gaming_delete_guard ON public.responsible_gaming;
CREATE TRIGGER responsible_gaming_delete_guard
  BEFORE DELETE ON public.responsible_gaming
  FOR EACH ROW EXECUTE FUNCTION public.responsible_gaming_delete_guard();


-- ============================================================================
-- A1. responsible_gaming_audit_trigger — AFTER INSERT/UPDATE/DELETE
-- Emits one compliance_audit_logs row per tracked column transition.
-- Deterministic emission order: limit -> pending -> self-exclusion.
-- SECURITY INVOKER so session_user reflects the actual caller (which inside
-- a SECURITY DEFINER function will be 'postgres' or 'service_role' — that
-- IS the correct actor identity for the trigger).
-- ============================================================================
CREATE OR REPLACE FUNCTION public.responsible_gaming_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
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
    -- Single event for any insert.
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

    -- 1) deposit_limit_monthly_cents transitions (deterministic order: limit first)
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
      -- (NULL transitions on deposit_limit_monthly_cents going to NULL are
      -- not part of the spec; intentionally not emitted.)
    END IF;

    -- 2) pending_deposit_limit_monthly_cents transitions
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
        -- Suppress if deposit_limit_monthly_cents is also changing (apply or
        -- set_limit_immediately path) — limit-change row is canonical.
        _events := array_append(_events, jsonb_build_object(
          'event_type', 'rg_pending_cancelled',
          'severity',   'info',
          'description','Pending deposit limit cancelled'
        ));
      END IF;
    END IF;

    -- 3) self_exclusion_until transitions
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
$$;

DROP TRIGGER IF EXISTS responsible_gaming_audit_trigger ON public.responsible_gaming;
CREATE TRIGGER responsible_gaming_audit_trigger
  AFTER INSERT OR UPDATE OR DELETE ON public.responsible_gaming
  FOR EACH ROW EXECUTE FUNCTION public.responsible_gaming_audit();


-- ============================================================================
-- C. admin_override_responsible_gaming — audited admin escape hatch.
-- Replaces direct DELETE-as-override (which is now blocked for service_role
-- by A2). Calling edge functions MUST authenticate the admin via
-- authenticateUser and pass auth.user.id as _admin_user_id; the session_user
-- guard at STEP 0 is the second-layer defense (Fix 19/20 pattern).
-- ============================================================================
CREATE OR REPLACE FUNCTION public.admin_override_responsible_gaming(
  _admin_user_id uuid,
  _target_user_id uuid,
  _action text,
  _new_limit_cents bigint,
  _reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _admin_check int;
BEGIN
  -- Defensive: session_user (NOT current_user) — Tier 1 #6 hotfix 4 lesson.
  IF session_user NOT IN ('postgres', 'service_role') THEN
    RAISE EXCEPTION 'unauthorized: not service_role';
  END IF;

  -- Confirm caller is an admin AND the auth.users row exists (orphan-admin
  -- guard, per Tier 1 Fix 19/20).
  SELECT 1 INTO _admin_check
  FROM public.user_roles ur
  JOIN auth.users u ON u.id = ur.user_id
  WHERE ur.user_id = _admin_user_id AND ur.role = 'admin';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unauthorized: caller is not an admin';
  END IF;

  IF _reason IS NULL OR length(trim(_reason)) < 10 THEN
    RAISE EXCEPTION 'invalid: reason required (min 10 chars)';
  END IF;

  CASE _action
    WHEN 'lift_self_exclusion' THEN
      UPDATE public.responsible_gaming
      SET self_exclusion_until = NULL,
          updated_at = now()
      WHERE user_id = _target_user_id;

    WHEN 'reset_pending' THEN
      UPDATE public.responsible_gaming
      SET pending_deposit_limit_monthly_cents = NULL,
          pending_limit_effective_at = NULL,
          updated_at = now()
      WHERE user_id = _target_user_id;

    WHEN 'set_limit_immediately' THEN
      IF _new_limit_cents IS NULL OR _new_limit_cents <= 0 THEN
        RAISE EXCEPTION 'invalid: _new_limit_cents required and positive';
      END IF;
      UPDATE public.responsible_gaming
      SET deposit_limit_monthly_cents = _new_limit_cents,
          pending_deposit_limit_monthly_cents = NULL,
          pending_limit_effective_at = NULL,
          updated_at = now()
      WHERE user_id = _target_user_id;

    ELSE
      RAISE EXCEPTION 'invalid: unknown action %', _action;
  END CASE;

  -- Belt-and-suspenders explicit audit row with admin context (the audit
  -- trigger A1 ALSO fires on the UPDATE above; this row carries the
  -- additional admin-attribution metadata).
  INSERT INTO public.compliance_audit_logs (user_id, event_type, description, severity, metadata)
  VALUES (
    _target_user_id,
    'rg_admin_override',
    format('Admin override: %s', _action),
    'warning',
    jsonb_build_object(
      'admin_user_id', _admin_user_id,
      'action', _action,
      'new_limit_cents', _new_limit_cents,
      'reason', _reason,
      'session_user', session_user
    )
  );

  RETURN jsonb_build_object('success', true, 'action', _action);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_override_responsible_gaming(uuid, uuid, text, bigint, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_override_responsible_gaming(uuid, uuid, text, bigint, text) FROM anon;
REVOKE ALL ON FUNCTION public.admin_override_responsible_gaming(uuid, uuid, text, bigint, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.admin_override_responsible_gaming(uuid, uuid, text, bigint, text) TO service_role;