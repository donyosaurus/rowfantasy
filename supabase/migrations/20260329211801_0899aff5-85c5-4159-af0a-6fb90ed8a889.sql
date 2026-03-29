-- Auto-lock function for contests past their lock_time
CREATE OR REPLACE FUNCTION public.auto_lock_expired_contests()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_locked_count integer := 0;
BEGIN
  UPDATE contest_pools
  SET status = 'locked'
  WHERE status = 'open'
    AND lock_time <= now();

  GET DIAGNOSTICS v_locked_count = ROW_COUNT;

  IF v_locked_count > 0 THEN
    INSERT INTO compliance_audit_logs (event_type, severity, description, metadata)
    VALUES (
      'auto_lock',
      'info',
      v_locked_count || ' contest pool(s) auto-locked',
      jsonb_build_object('locked_count', v_locked_count, 'locked_at', now())
    );
  END IF;

  RETURN v_locked_count;
END;
$$;

-- Copy instance_id to pool_id where pool_id is null
UPDATE public.contest_scores
SET pool_id = instance_id
WHERE pool_id IS NULL AND instance_id IS NOT NULL;

-- Drop legacy instance_id from contest_scores
ALTER TABLE public.contest_scores DROP COLUMN IF EXISTS instance_id;

-- Drop legacy contest_instances table
DROP TABLE IF EXISTS public.contest_instances CASCADE;