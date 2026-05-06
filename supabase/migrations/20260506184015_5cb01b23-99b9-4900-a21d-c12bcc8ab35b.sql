-- 1. Augment race_results_imports
ALTER TABLE public.race_results_imports
  ADD COLUMN IF NOT EXISTS idempotency_key uuid,
  ADD COLUMN IF NOT EXISTS import_run_id uuid;

CREATE UNIQUE INDEX IF NOT EXISTS race_results_imports_idempotency_key_uniq
  ON public.race_results_imports (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- 2. scoring_jobs queue
CREATE TABLE IF NOT EXISTS public.scoring_jobs (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  import_id uuid NOT NULL REFERENCES public.race_results_imports(id) ON DELETE CASCADE,
  pool_id uuid NOT NULL,
  contest_template_id uuid NOT NULL,
  race_results jsonb NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  picked_up_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scoring_jobs_status_chk CHECK (status IN ('queued','running','done','failed'))
);

CREATE UNIQUE INDEX IF NOT EXISTS scoring_jobs_import_pool_uniq
  ON public.scoring_jobs (import_id, pool_id);
CREATE INDEX IF NOT EXISTS scoring_jobs_status_created_idx
  ON public.scoring_jobs (status, created_at);

ALTER TABLE public.scoring_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can view scoring_jobs"
  ON public.scoring_jobs FOR SELECT TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Deny authenticated insert on scoring_jobs"
  ON public.scoring_jobs FOR INSERT TO authenticated
  WITH CHECK (false);

CREATE POLICY "Deny authenticated update on scoring_jobs"
  ON public.scoring_jobs FOR UPDATE TO authenticated
  USING (false) WITH CHECK (false);

CREATE POLICY "Deny authenticated delete on scoring_jobs"
  ON public.scoring_jobs FOR DELETE TO authenticated
  USING (false);

-- 3. Atomic import function
CREATE OR REPLACE FUNCTION public.import_race_results_atomic(
  _admin_user_id uuid,
  _import_payload jsonb,
  _idempotency_key uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_import_run_id uuid := gen_random_uuid();
  v_existing_import_id uuid;
  v_existing_status text;
  v_template_id uuid;
  v_regatta_name text;
  v_results jsonb;
  v_file_hash text;
  v_results_count int;
  v_template record;
  v_import_id uuid;
  v_pool record;
  v_pools_queued int := 0;
  v_admin_exists boolean;
BEGIN
  -- STEP 0: caller guard
  IF session_user NOT IN ('postgres', 'service_role', 'supabase_admin') THEN
    RAISE EXCEPTION 'import_race_results_atomic: forbidden caller %', session_user
      USING ERRCODE = '42501';
  END IF;

  -- STEP 0.5: admin re-validation (user_roles JOIN auth.users)
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles ur
    JOIN auth.users au ON au.id = ur.user_id
    WHERE ur.user_id = _admin_user_id AND ur.role = 'admin'::app_role
  ) INTO v_admin_exists;

  IF NOT v_admin_exists THEN
    RAISE EXCEPTION 'admin_not_found' USING ERRCODE = '42501';
  END IF;

  -- STEP 1: idempotency
  IF _idempotency_key IS NULL THEN
    RAISE EXCEPTION 'idempotency_key_required' USING ERRCODE = '22023';
  END IF;

  SELECT id, status INTO v_existing_import_id, v_existing_status
  FROM public.race_results_imports
  WHERE idempotency_key = _idempotency_key;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'success', true,
      'replayed', true,
      'import_id', v_existing_import_id,
      'import_run_id', v_import_run_id,
      'prior_status', v_existing_status
    );
  END IF;

  -- STEP 2: extract & validate payload
  v_template_id  := (_import_payload->>'contestTemplateId')::uuid;
  v_regatta_name := _import_payload->>'regattaName';
  v_results      := _import_payload->'results';
  v_file_hash    := _import_payload->>'fileHash';

  IF v_template_id IS NULL OR v_regatta_name IS NULL OR v_results IS NULL THEN
    RAISE EXCEPTION 'invalid_payload' USING ERRCODE = '22023';
  END IF;

  v_results_count := jsonb_array_length(v_results);

  SELECT id, crews, divisions INTO v_template
  FROM public.contest_templates
  WHERE id = v_template_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'template_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- STEP 3: insert import record
  INSERT INTO public.race_results_imports (
    contest_template_id, admin_id, regatta_name,
    results_data, rows_processed, status, file_hash, errors,
    idempotency_key, import_run_id, metadata
  )
  VALUES (
    v_template_id, _admin_user_id, v_regatta_name,
    v_results, v_results_count, 'completed', v_file_hash, '[]'::jsonb,
    _idempotency_key, v_import_run_id,
    jsonb_build_object('import_run_id', v_import_run_id)
  )
  RETURNING id INTO v_import_id;

  -- STEP 4: update template results
  UPDATE public.contest_templates
  SET results = v_results,
      status = 'locked',
      updated_at = now()
  WHERE id = v_template_id;

  -- STEP 5: enqueue scoring jobs for locked/live pools
  FOR v_pool IN
    SELECT id FROM public.contest_pools
    WHERE contest_template_id = v_template_id
      AND status IN ('locked', 'live', 'results_entered')
  LOOP
    INSERT INTO public.scoring_jobs (
      import_id, pool_id, contest_template_id, race_results, status
    ) VALUES (
      v_import_id, v_pool.id, v_template_id, v_results, 'queued'
    );
    v_pools_queued := v_pools_queued + 1;
  END LOOP;

  -- STEP 6: compliance audit row (inside the same transaction)
  INSERT INTO public.compliance_audit_logs (
    admin_id, event_type, severity, description, metadata
  ) VALUES (
    _admin_user_id, 'race_results_imported', 'info',
    format('Race results imported for %s', v_regatta_name),
    jsonb_build_object(
      'import_id', v_import_id,
      'import_run_id', v_import_run_id,
      'contest_template_id', v_template_id,
      'results_count', v_results_count,
      'pools_queued', v_pools_queued,
      'idempotency_key', _idempotency_key
    )
  );

  RETURN jsonb_build_object(
    'success', true,
    'replayed', false,
    'import_id', v_import_id,
    'import_run_id', v_import_run_id,
    'rows_processed', v_results_count,
    'pools_queued', v_pools_queued
  );
END;
$$;

REVOKE ALL ON FUNCTION public.import_race_results_atomic(uuid, jsonb, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.import_race_results_atomic(uuid, jsonb, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.import_race_results_atomic(uuid, jsonb, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.import_race_results_atomic(uuid, jsonb, uuid) TO service_role;