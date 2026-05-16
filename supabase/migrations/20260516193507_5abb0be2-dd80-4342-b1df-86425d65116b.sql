-- =========================================================================
-- P0-R7: Convert match_queue.pool_id FK from SET NULL to RESTRICT.
-- FINAL preservation-FK gap; closes the lane started by P0-R1
-- (20260512002917), extended by P0-R2a (20260516035300), and P0-R6
-- (20260516041525). After this migration, 24/24 preservation FKs are at
-- ON DELETE RESTRICT per the 2026-05-16 live-DB pg_constraint sweep.
-- =========================================================================

ALTER TABLE public.match_queue DROP CONSTRAINT IF EXISTS match_queue_pool_id_fkey;
ALTER TABLE public.match_queue
  ADD CONSTRAINT match_queue_pool_id_fkey
  FOREIGN KEY (pool_id) REFERENCES public.contest_pools(id) ON DELETE RESTRICT;