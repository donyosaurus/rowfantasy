CREATE TABLE public.payment_discrepancies (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  reconciliation_run_id uuid NOT NULL,
  session_id uuid NOT NULL,
  provider text NOT NULL,
  issue text NOT NULL,
  expected_cents bigint,
  actual_cents bigint,
  difference_cents bigint,
  provider_amount_cents bigint,
  our_status text,
  provider_status text,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX payment_discrepancies_run_session_issue_uniq
  ON public.payment_discrepancies (reconciliation_run_id, session_id, issue);

CREATE INDEX payment_discrepancies_run_id_idx
  ON public.payment_discrepancies (reconciliation_run_id);

CREATE INDEX payment_discrepancies_session_id_idx
  ON public.payment_discrepancies (session_id);

ALTER TABLE public.payment_discrepancies ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can view payment discrepancies"
  ON public.payment_discrepancies
  FOR SELECT
  TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Deny authenticated insert on payment_discrepancies"
  ON public.payment_discrepancies
  FOR INSERT
  TO authenticated
  WITH CHECK (false);

CREATE POLICY "Deny authenticated update on payment_discrepancies"
  ON public.payment_discrepancies
  FOR UPDATE
  TO authenticated
  USING (false)
  WITH CHECK (false);

CREATE POLICY "Deny authenticated delete on payment_discrepancies"
  ON public.payment_discrepancies
  FOR DELETE
  TO authenticated
  USING (false);