-- P0-R2a: Convert 10 remaining FKs to ON DELETE RESTRICT
-- Forward-only migration; complements P0-R1.

-- Section A: CASCADE -> RESTRICT
ALTER TABLE public.user_roles DROP CONSTRAINT IF EXISTS user_roles_user_id_fkey;
ALTER TABLE public.user_roles
  ADD CONSTRAINT user_roles_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE RESTRICT;

ALTER TABLE public.transactions DROP CONSTRAINT IF EXISTS transactions_wallet_id_fkey;
ALTER TABLE public.transactions
  ADD CONSTRAINT transactions_wallet_id_fkey
  FOREIGN KEY (wallet_id) REFERENCES public.wallets(id) ON DELETE RESTRICT;

-- Section B: SET NULL -> RESTRICT
ALTER TABLE public.support_tickets DROP CONSTRAINT IF EXISTS support_tickets_user_id_fkey;
ALTER TABLE public.support_tickets
  ADD CONSTRAINT support_tickets_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE RESTRICT;

ALTER TABLE public.support_tickets DROP CONSTRAINT IF EXISTS support_tickets_assigned_to_fkey;
ALTER TABLE public.support_tickets
  ADD CONSTRAINT support_tickets_assigned_to_fkey
  FOREIGN KEY (assigned_to) REFERENCES auth.users(id) ON DELETE RESTRICT;

ALTER TABLE public.audit_logs DROP CONSTRAINT IF EXISTS audit_logs_user_id_fkey;
ALTER TABLE public.audit_logs
  ADD CONSTRAINT audit_logs_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE RESTRICT;

-- Section C: NO ACTION -> RESTRICT
ALTER TABLE public.compliance_audit_logs DROP CONSTRAINT IF EXISTS compliance_audit_logs_user_id_fkey;
ALTER TABLE public.compliance_audit_logs
  ADD CONSTRAINT compliance_audit_logs_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE RESTRICT;

ALTER TABLE public.compliance_audit_logs DROP CONSTRAINT IF EXISTS compliance_audit_logs_admin_id_fkey;
ALTER TABLE public.compliance_audit_logs
  ADD CONSTRAINT compliance_audit_logs_admin_id_fkey
  FOREIGN KEY (admin_id) REFERENCES auth.users(id) ON DELETE RESTRICT;

ALTER TABLE public.transactions DROP CONSTRAINT IF EXISTS transactions_created_by_fkey;
ALTER TABLE public.transactions
  ADD CONSTRAINT transactions_created_by_fkey
  FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE RESTRICT;

ALTER TABLE public.contest_entries DROP CONSTRAINT IF EXISTS contest_entries_contest_template_id_fkey;
ALTER TABLE public.contest_entries
  ADD CONSTRAINT contest_entries_contest_template_id_fkey
  FOREIGN KEY (contest_template_id) REFERENCES public.contest_templates(id) ON DELETE RESTRICT;

ALTER TABLE public.contest_entries DROP CONSTRAINT IF EXISTS contest_entries_pool_id_fkey;
ALTER TABLE public.contest_entries
  ADD CONSTRAINT contest_entries_pool_id_fkey
  FOREIGN KEY (pool_id) REFERENCES public.contest_pools(id) ON DELETE RESTRICT;