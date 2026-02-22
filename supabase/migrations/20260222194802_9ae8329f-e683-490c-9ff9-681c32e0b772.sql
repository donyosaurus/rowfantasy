
-- 1. contest_entries: drop old instance FK, add pool FK
ALTER TABLE public.contest_entries
  DROP CONSTRAINT IF EXISTS contest_entries_instance_id_fkey;

ALTER TABLE public.contest_entries
  DROP CONSTRAINT IF EXISTS contest_entries_pool_id_fkey;

ALTER TABLE public.contest_entries
  ADD CONSTRAINT contest_entries_pool_id_fkey
  FOREIGN KEY (pool_id) REFERENCES public.contest_pools(id);

-- 2. contest_scores: ensure pool_id FK exists, drop instance FK
ALTER TABLE public.contest_scores
  DROP CONSTRAINT IF EXISTS contest_scores_instance_id_fkey;

-- pool_id FK already exists on contest_scores, but ensure it
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'contest_scores_pool_id_fkey'
      AND table_name = 'contest_scores'
  ) THEN
    ALTER TABLE public.contest_scores
      ADD CONSTRAINT contest_scores_pool_id_fkey
      FOREIGN KEY (pool_id) REFERENCES public.contest_pools(id);
  END IF;
END $$;
