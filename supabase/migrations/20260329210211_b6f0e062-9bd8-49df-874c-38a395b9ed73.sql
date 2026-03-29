-- Restrict feature_flags SELECT to authenticated users only
DROP POLICY IF EXISTS "Anyone can view feature flags" ON public.feature_flags;
CREATE POLICY "Authenticated users can view feature flags"
  ON public.feature_flags FOR SELECT
  TO authenticated
  USING (true);