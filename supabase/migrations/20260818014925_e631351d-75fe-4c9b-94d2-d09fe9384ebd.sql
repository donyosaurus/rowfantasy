DROP TABLE IF EXISTS public.match_queue CASCADE;
DROP FUNCTION IF EXISTS public.import_race_results_atomic(uuid, jsonb, uuid);
DROP TABLE IF EXISTS public.scoring_jobs CASCADE;
DROP TABLE IF EXISTS public.race_results_imports CASCADE;