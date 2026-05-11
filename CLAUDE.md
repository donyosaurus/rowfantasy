# RowFantasy — Collaboration Rules

> Operational state (system accounts, cron schedules, account-deletion rules, dependency posture) lives in OPERATOR.md. Read it when working on infrastructure, scheduled jobs, or user-data lifecycle code.

## Context
Real-money daily fantasy sports platform. Pre-launch. Backend lives in
Supabase, accessed exclusively through Lovable Cloud prompts — never the
Supabase dashboard, never direct SQL. Claude Code is secondary to Lovable
for backend work; primary for local frontend, scripting, and review.

## When to invoke Codex (MCP tool)
Always cross-check with Codex before finalizing changes that touch:
- **RLS policies** — past bugs include hiding opponent entries pre-lock
  and blocking unauthenticated contest browsing. Verify scope explicitly.
- **Wallet logic** — units must be consistent (dollars throughout, never
  cents). Past bug: deposits stored in cents while transactions used dollars.
- **Security DEFINER RPCs** — must use `auth.uid()` internally. Never
  accept caller-supplied user IDs. Codex should verify this on every RPC.
- **Scoring constants** — `FINISH_POINTS` has historically existed in
  multiple files with inconsistent values. Grep all before changing any.
- **H2H self-match logic** — duplicate-pool prevention must be scoped
  to the triggered tier only, never cascade across tiers.
- **Cloudflare Worker geofencing** — `BLOCKED_STATES` changes affect
  legal compliance. DC is currently blocked for testing; remove post-test.
- **Payment adapter integration** — when replacing the mock with Aeropay.

## When NOT to invoke Codex
- Cosmetic frontend changes, copy edits, banner image generation
- Lovable-managed backend work (Lovable is the source of truth there)
- Anything where you'd be sending the same context to both models —
  that produces echo-chamber agreement, not a real second opinion

## Cross-check pattern
Send Codex the diff plus intent only — not your reasoning. The independent
review is the value.

## Debugging constraint
Supabase MCP is unreliable for this project (`pg_proc`,
`information_schema.routines`, and user table queries return empty).
Reason from behavioral and UI evidence. Do not assume MCP query results
reflect actual database state. Route verification through Lovable prompts.

## Output style
- Backend changes: deliver as Lovable prompts, batched and sequenced
  to respect dependency ordering. Do not write SQL directly.
- Command-line tasks: numbered list, one step per action, no repetition.
- Banner images: 1200×400px (3:1), centered logos/text, edges clear.

## Sandbox posture
This is a pre-launch real-money platform. Do not use Codex wrappers that
bypass approvals/sandbox (`--dangerously-bypass-approvals-and-sandbox`).
Stick with `codex mcp-server` directly so confirmations stay in the loop.
