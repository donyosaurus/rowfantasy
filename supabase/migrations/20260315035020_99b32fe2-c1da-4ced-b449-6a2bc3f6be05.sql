
CREATE OR REPLACE FUNCTION public.user_in_pool(_user_id uuid, _pool_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.contest_entries
    WHERE user_id = _user_id AND pool_id = _pool_id AND status IN ('active', 'scored', 'settled')
  )
$$;

CREATE POLICY "Users can view entries in shared pools"
  ON public.contest_entries FOR SELECT TO authenticated
  USING (
    public.user_in_pool(auth.uid(), pool_id)
  );
