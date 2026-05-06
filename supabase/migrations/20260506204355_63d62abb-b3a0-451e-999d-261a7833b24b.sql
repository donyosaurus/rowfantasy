CREATE UNIQUE INDEX IF NOT EXISTS uniq_compliance_export_per_day
ON public.compliance_audit_logs ((metadata->>'report_date'))
WHERE event_type = 'compliance_export_completed';

CREATE OR REPLACE FUNCTION public.record_compliance_export_completed(
  _report_date text,
  _run_id uuid,
  _metadata jsonb,
  _description text
)
RETURNS TABLE (inserted boolean, existing_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE _new_id uuid;
BEGIN
  IF session_user NOT IN ('postgres', 'service_role', 'supabase_admin') THEN
    RAISE EXCEPTION 'unauthorized: not service_role';
  END IF;

  INSERT INTO public.compliance_audit_logs (event_type, severity, description, metadata)
  VALUES (
    'compliance_export_completed',
    'info',
    _description,
    jsonb_set(
      jsonb_set(COALESCE(_metadata, '{}'::jsonb), '{run_id}', to_jsonb(_run_id::text)),
      '{report_date}', to_jsonb(_report_date)
    )
  )
  ON CONFLICT DO NOTHING
  RETURNING id INTO _new_id;

  IF _new_id IS NOT NULL THEN
    RETURN QUERY SELECT true, _new_id;
  ELSE
    RETURN QUERY
    SELECT false, c.id
    FROM public.compliance_audit_logs c
    WHERE c.event_type = 'compliance_export_completed'
      AND c.metadata->>'report_date' = _report_date
    LIMIT 1;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.record_compliance_export_completed(text, uuid, jsonb, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_compliance_export_completed(text, uuid, jsonb, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_compliance_export_completed(text, uuid, jsonb, text) TO service_role;