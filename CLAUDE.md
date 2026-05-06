# RowFantasy — Operator Notes

## System accounts

### `system+auto-void@rowfantasy.internal`

Dedicated `auth.users` row used by the `auto-void-unfilled-pools` cron sweep
as `_admin_user_id` when calling `void_contest_pool_atomic`.

- **Created by**: migration provisioning `system_auto_void` admin user.
- **Role**: `admin` (in `public.user_roles`).
- **Login**: disabled — no password is set; `encrypted_password = ''`.
- **Purpose**: attribution for cron-driven void operations so that audit logs
  show a stable, identifiable system actor rather than a real admin's UUID.
- **Do not delete** — `void_contest_pool_atomic` re-validates that the
  supplied `_admin_user_id` exists in `auth.users` and has the admin role.

If the account is ever lost, re-run the provisioning migration (it is
idempotent on the email).

## Cron schedules

| Function | Recommended cadence | Mode |
|---|---|---|
| `auto-lock-contests` | every 1 min | mutating |
| `auto-void-unfilled-pools` | every 10 min | `?dry_run=false` |

The auto-void sweep defaults to `dry_run=true` for safety; production
schedule MUST pass `?dry_run=false` explicitly.

## Account deletion — HARD RULE (Wave 4 #1)

**NEVER call `auth.admin.deleteUser` without legal sign-off.** The only supported
account-removal path is `public.soft_delete_user_account(admin_id, target_id, reason)`,
which redacts PII while preserving the AML/KYC/financial audit trail required by
gaming regulators (5+ year retention).

- All FKs from public.* to `auth.users` are `ON DELETE RESTRICT`. A hard delete
  will fail at the database level until every retained row is manually purged
  (which itself violates AML retention).
- Privacy/GDPR "right to erasure" requests routed through
  `supabase/functions/privacy-requests` are queued for admin-mediated soft-delete,
  not hard-delete.
- If a regulator/court order ever truly requires hard deletion, document the
  legal basis in `compliance_audit_logs` first and only then perform the
  operation under direct DBA supervision.
