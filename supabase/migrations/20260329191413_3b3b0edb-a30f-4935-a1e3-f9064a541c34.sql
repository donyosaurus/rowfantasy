-- 1.1 Fix contest_entries status CHECK constraint
ALTER TABLE public.contest_entries DROP CONSTRAINT IF EXISTS contest_entries_status_check;
ALTER TABLE public.contest_entries ADD CONSTRAINT contest_entries_status_check
  CHECK (status IN ('active', 'withdrawn', 'settled', 'refunded', 'voided', 'scored'));

-- 1.2 Fix ledger_entries transaction_type CHECK constraint
ALTER TABLE public.ledger_entries DROP CONSTRAINT IF EXISTS ledger_entries_transaction_type_check;
ALTER TABLE public.ledger_entries ADD CONSTRAINT ledger_entries_transaction_type_check
  CHECK (transaction_type IN (
    'DEPOSIT', 'WITHDRAWAL', 'ENTRY_FEE', 'PRIZE', 'PRIZE_PAYOUT',
    'REFUND', 'ENTRY_FEE_REFUND', 'BONUS', 'ADJUSTMENT'
  ));

-- 1.3 Fix ledger_entries INSERT policy — remove dangerously open policy
DROP POLICY IF EXISTS "Service role can insert ledger entries" ON public.ledger_entries;

-- 1.4 Fix compliance_audit_logs INSERT policies
DROP POLICY IF EXISTS "System can insert compliance logs" ON public.compliance_audit_logs;
DROP POLICY IF EXISTS "Anyone can insert compliance logs" ON public.compliance_audit_logs;
DROP POLICY IF EXISTS "Only service_role can insert compliance logs" ON public.compliance_audit_logs;

CREATE POLICY "Admins can insert compliance logs"
  ON public.compliance_audit_logs FOR INSERT
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));