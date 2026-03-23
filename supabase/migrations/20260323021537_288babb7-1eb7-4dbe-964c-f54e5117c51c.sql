
INSERT INTO storage.buckets (id, name, public)
VALUES ('contest-banners', 'contest-banners', true)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "Anyone can view contest banners"
ON storage.objects FOR SELECT
TO public
USING (bucket_id = 'contest-banners');

CREATE POLICY "Admins can upload contest banners"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (bucket_id = 'contest-banners' AND has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can delete contest banners"
ON storage.objects FOR DELETE
TO authenticated
USING (bucket_id = 'contest-banners' AND has_role(auth.uid(), 'admin'));
