
ALTER TABLE public.contest_templates ADD COLUMN IF NOT EXISTS card_banner_url text DEFAULT NULL;

UPDATE public.contest_templates SET card_banner_url = banner_url WHERE banner_url IS NOT NULL;

ALTER TABLE public.contest_templates RENAME COLUMN banner_url TO draft_banner_url;
