# Fixes Verified

## 2026-08-27 00:18 UTC — Phase 3 prerequisite: per-user entry cap

- Change: Added `max_entries_per_user` to `public.contest_templates` (default 1, CHECK >=1); updated `enter_contest_pool_atomic` to return `entry_limit_reached` when a user's `active`/`scored`/`settled` entries for a template reach the cap; added `entry_limit_reached` reason mapping in `supabase/functions/contest-matchmaking/index.ts`.
- Verification: `deno check supabase/functions/contest-matchmaking/index.ts` passed.
- Cross-check (adversarial): APPROVED by subagent `capable` (Fable 5 operational state).
  - Count query correctly excludes `withdrawn`/`refunded`/`voided`.
  - Per-user advisory xact lock serializes concurrent entry attempts and closes TOCTOU race.
  - No dynamic SQL; SECURITY DEFINER restricted to service_role; cap enforced before any wallet debit.
- Notes: Linter reported 15 pre-existing warnings on other functions (search_path / executable by roles) that were not introduced by this migration.
