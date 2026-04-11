-- Drop the existing overly permissive policy
DROP POLICY IF EXISTS "Users can view entries in shared pools" ON public.contest_entries;

-- Recreate it with a lock_time check: only show other users' entries after the pool is locked
CREATE POLICY "Users can view entries in shared pools after lock"
ON public.contest_entries
FOR SELECT
TO authenticated
USING (
  user_in_pool(auth.uid(), pool_id)
  AND (
    -- Always allow viewing own entries
    auth.uid() = user_id
    OR
    -- Only allow viewing others' entries after lock_time
    EXISTS (
      SELECT 1 FROM public.contest_pools cp
      WHERE cp.id = pool_id
      AND cp.lock_time <= now()
    )
  )
);