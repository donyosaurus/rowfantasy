-- =========================================================================
-- P0-R6: Convert match_queue.contest_template_id FK from CASCADE to RESTRICT.
-- Final preservation-FK gap; complements P0-R1 (20260512002917) and
-- P0-R2a (20260516035300). After this migration, 23/23 preservation FKs
-- are at ON DELETE RESTRICT.
-- =========================================================================

ALTER TABLE public.match_queue DROP CONSTRAINT IF EXISTS match_queue_contest_template_id_fkey;
ALTER TABLE public.match_queue
  ADD CONSTRAINT match_queue_contest_template_id_fkey
  FOREIGN KEY (contest_template_id) REFERENCES public.contest_templates(id) ON DELETE RESTRICT;