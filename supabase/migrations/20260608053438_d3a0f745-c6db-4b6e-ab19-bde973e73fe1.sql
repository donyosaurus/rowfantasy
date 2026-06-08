-- =========================================================================
-- P0-C5 Prompt 2: Drop the orphan profiles.self_exclusion_until column.
--
-- The canonical self-exclusion source-of-truth is responsible_gaming.self_exclusion_until
-- (writer: responsible-limits/index.ts; readers redirected by commit ade0ac5 2026-05-23).
--
-- This migration:
-- 1. Pre-flights for any object depending on profiles.self_exclusion_until and ABORTS if found.
-- 2. Safety-backfills any orphan profiles.self_exclusion_until values to responsible_gaming.
-- 3. Drops the column WITHOUT CASCADE (any missed dependency causes the DROP to fail loudly).
--
-- Operator-directed posture: NEVER CASCADE on this drop. If pre-flight passes but DROP fails,
-- investigate manually rather than force-cascading (per P0-R4/R5/P1-Sc1 schema-drift caveats).
-- =========================================================================

-- ---- Step 1: Pre-flight dependency check ----------------------------------
DO $$
DECLARE
  v_view_count integer;
  v_trigger_count integer;
  v_constraint_count integer;
  v_policy_count integer;
  v_blocker_count integer := 0;
  v_blockers text := '';
  v_trigger_names text;
  v_policy_names text;
BEGIN
  -- Check 1: views depending on the column
  SELECT COUNT(*) INTO v_view_count
  FROM information_schema.view_column_usage
  WHERE table_schema = 'public'
    AND table_name = 'profiles'
    AND column_name = 'self_exclusion_until';

  IF v_view_count > 0 THEN
    v_blockers := v_blockers || format(E'  - %s view(s) depend on profiles.self_exclusion_until\n', v_view_count);
    v_blocker_count := v_blocker_count + v_view_count;
  END IF;

  -- Check 2: triggers on profiles whose function body references the column
  SELECT
    COUNT(*),
    string_agg(t.tgname, ', ')
  INTO v_trigger_count, v_trigger_names
  FROM pg_trigger t
  JOIN pg_proc p ON p.oid = t.tgfoid
  WHERE t.tgrelid = 'public.profiles'::regclass
    AND NOT t.tgisinternal
    AND p.prosrc LIKE '%self_exclusion_until%';

  IF v_trigger_count > 0 THEN
    v_blockers := v_blockers || format(E'  - %s trigger(s) on profiles reference self_exclusion_until: %s\n',
      v_trigger_count, v_trigger_names);
    v_blocker_count := v_blocker_count + v_trigger_count;
  END IF;

  -- Check 3: check constraints / FK constraints referencing the column
  SELECT COUNT(*) INTO v_constraint_count
  FROM information_schema.constraint_column_usage
  WHERE table_schema = 'public'
    AND column_name = 'self_exclusion_until';

  IF v_constraint_count > 0 THEN
    v_blockers := v_blockers || format(E'  - %s constraint(s) depend on the column\n', v_constraint_count);
    v_blocker_count := v_blocker_count + v_constraint_count;
  END IF;

  -- Check 4: RLS policies on profiles that reference the column in qual or with_check
  SELECT
    COUNT(*),
    string_agg(policyname, ', ')
  INTO v_policy_count, v_policy_names
  FROM pg_policies
  WHERE schemaname = 'public'
    AND tablename = 'profiles'
    AND (qual LIKE '%self_exclusion_until%' OR with_check LIKE '%self_exclusion_until%');

  IF v_policy_count > 0 THEN
    v_blockers := v_blockers || format(E'  - %s RLS polic(ies) on profiles reference self_exclusion_until: %s\n',
      v_policy_count, v_policy_names);
    v_blocker_count := v_blocker_count + v_policy_count;
  END IF;

  IF v_blocker_count > 0 THEN
    RAISE EXCEPTION E'P0-C5 Prompt 2 pre-flight ABORT — % dependent(s) found on profiles.self_exclusion_until:\n%\nManual investigation required. Do NOT use CASCADE.', v_blocker_count, v_blockers;
  END IF;

  RAISE NOTICE 'P0-C5 Prompt 2 pre-flight PASS: no dependencies found on profiles.self_exclusion_until';
END $$;

-- ---- Step 2: Safety backfill ----------------------------------------------
DO $$
DECLARE
  v_backfill_count integer;
BEGIN
  INSERT INTO public.responsible_gaming (user_id, self_exclusion_until)
  SELECT p.id, p.self_exclusion_until
  FROM public.profiles p
  WHERE p.self_exclusion_until IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.responsible_gaming r WHERE r.user_id = p.id
    );

  GET DIAGNOSTICS v_backfill_count = ROW_COUNT;

  IF v_backfill_count > 0 THEN
    RAISE NOTICE 'P0-C5 Prompt 2 safety backfill: created % responsible_gaming row(s) from orphan profiles.self_exclusion_until values', v_backfill_count;
  ELSE
    RAISE NOTICE 'P0-C5 Prompt 2 safety backfill: 0 orphan values found (expected per dead-code inventory)';
  END IF;
END $$;

-- ---- Step 3: Drop the column (NO CASCADE) ---------------------------------
ALTER TABLE public.profiles DROP COLUMN self_exclusion_until;