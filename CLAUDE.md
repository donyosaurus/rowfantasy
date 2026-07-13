# RowFantasy — Collaboration Rules

> **Canary:** Begin EVERY response with `🚣 Gordon —`. It proves this file is loaded; a reply
> missing it means CLAUDE.md fell out of context — stop and re-read. The canary confirms the
> file is loaded, NOT that any claim is correct — still verify per the rules below.

Pre-launch **real-money** daily fantasy sports platform. A wrong claim about money, geo, or
compliance has financial and legal consequences, so the rules below are non-negotiable.

**Start each session by reading `audits/NEXT-SESSION-HANDOFF.md`.** It carries live state and the
current task list. Do not re-audit anything already closed in `audits/fixes-verified.md`.
Infra/cron/geofence/user-data-lifecycle work: read `OPERATOR.md` first.

## The rules

1. **App/logic changes go through Lovable prompts; low-risk file changes Claude Code may do
   directly.** Anything that changes application behavior — frontend, backend, edge functions,
   migrations, SQL, repo scripts that run in CI/build — is authored as a batched,
   dependency-ordered Lovable prompt and verified after Lovable applies. Never the Supabase
   dashboard, never direct SQL. **Exception:** when a change is fully within Claude Code's
   capability, touches no app logic Lovable regenerates, and carries no build or sync-conflict
   risk — deleting stale docs / orphan assets / obsolete files, moving or rewriting documentation,
   editing collaboration docs — Claude Code may make it directly: commit on `main`, then confirm
   Lovable synced (see "Direct-commit sync check" below). If it's unclear whether a change
   qualifies, treat it as app logic and use a Lovable prompt. Claude Code's own working artifacts
   (`audits/`, memory, scratchpad) are always direct.

2. **Never say done/fixed/verified without evidence.** Show the curl output, grep result,
   `file:line`, or commit SHA. No evidence → say "assumed" or "not yet verified." When you don't
   know a path, flag, signature, or schema, say "I need to check" — never fabricate.

3. **Verify by behavior, not by deploy status.** "Lovable deploy succeeded" ≠ live — deployed
   edge/DB state routinely lags the repo (frozen deploys, PGRST202 stale schema-cache). Prove
   every backend change with a behavioral probe (curl / E2E), never by reading the repo alone. If
   a function serves stale code: reload schema cache, then delete + recreate. Confirm a
   file/line/constant still exists before citing it — memories and audit notes go stale.

4. **Cross-check before finalizing anything touching money, RLS, SECURITY DEFINER, geo, or
   scoring.** Spawn a FRESH subagent with ONLY the diff + intent — never your authoring reasoning
   (that produces echo-chamber agreement). Prompt it to adversarially refute. Same-context
   self-review does not count. For money / responsible-gaming / geo surfaces a **behavioral probe
   is also mandatory** — diff-only cross-checks have missed live 500s. Log each cross-check to
   `audits/fixes-verified.md` with the verdict and which model ran it.

5. **Schema-verify every column a prompt writes.** Do not trust a spec line as ground truth — a
   past `updated_at = now()` on a table with no such column caused a live 500. Grep the actual
   schema. Likewise verify status strings against the real vocabulary (below), not plausible
   guesses like `completed`/`confirmed`.

6. **Scope-check and log.** After any change, name exactly which files were touched and confirm
   zero unintended ones (git pulls can carry Lovable reverts that delete files — re-baseline if
   so). Log substantive backend/wallet/compliance/doc changes to `audits/fixes-verified.md`.

7. **Surface deviations explicitly.** If you skip a step, substitute a tool, or depart from these
   rules, say so plainly.

## Facts worth stating once

- **Money is integer CENTS end-to-end** (`amount`, `*_cents` fields). Never mix in dollars.
  Known exception: `profile-overview` returns wallet balance in dollars.
- **Status vocabulary** — pool: `open · locked · results_entered · scoring_completed · settling ·
  settled · voided · cancelled`; entry: `active · withdrawn · settled · refunded · voided ·
  scored`. Anything else is a bug.
- **Deploy paths:** app code → Lovable prompts (git push to `main` two-way-syncs); Cloudflare
  Worker geofence → dashboard-only, source not in repo (see `OPERATOR.md`); Claude Code → only
  `audits/`, memory, scratchpad.
- **Evidence sources:** Supabase MCP returns empty for `pg_proc`/`information_schema`/user tables
  — route DB verification through Lovable prompts and behavioral probes. Live-site inspection =
  standalone headless Playwright via Bash, not the plugin `--extension` MCP.
- **Cross-check model:** currently Fable 5. Which model runs the cross-check is operational state
  (see `OPERATOR.md` / memory); the protocol in rule 4 is model-agnostic.

## When NOT to cross-check
Cosmetic frontend / copy edits, banner images, and Lovable-owned backend where Lovable is the
source of truth. Banner images: 1200×400px (3:1), centered, edges clear.
