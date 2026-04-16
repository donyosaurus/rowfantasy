-- 1. Restrict winner_ids column on contest_pools — sensitive (user UUIDs of winners)
-- Revoke broad column access; only service_role and admins (via separate grant) need read access.
REVOKE SELECT (winner_ids) ON public.contest_pools FROM anon, authenticated;

-- 2. Fix admin transaction update policy: scope to authenticated role instead of public
DROP POLICY IF EXISTS "Admins can update transactions" ON public.transactions;
CREATE POLICY "Admins can update transactions"
ON public.transactions
FOR UPDATE
TO authenticated
USING (has_role(auth.uid(), 'admin'::app_role))
WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

-- 3. Restrict listing of contest-banners storage bucket.
-- Bucket remains public so individual files load via public URL, but drop any broad SELECT
-- policy that allows enumerating object names.
DROP POLICY IF EXISTS "Public can view contest banners" ON storage.objects;
DROP POLICY IF EXISTS "Anyone can view contest banners" ON storage.objects;
DROP POLICY IF EXISTS "Public read contest banners" ON storage.objects;
DROP POLICY IF EXISTS "contest-banners public read" ON storage.objects;
DROP POLICY IF EXISTS "Public Access" ON storage.objects;