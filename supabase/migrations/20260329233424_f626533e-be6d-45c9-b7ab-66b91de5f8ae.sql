
-- 1. Fix: Restrict "System can update transaction status" to service_role only
DROP POLICY IF EXISTS "System can update transaction status" ON public.transactions;

CREATE POLICY "System can update transaction status"
  ON public.transactions FOR UPDATE
  TO service_role
  USING (status = 'pending'::transaction_status)
  WITH CHECK (
    status IN ('completed'::transaction_status, 'failed'::transaction_status)
    AND user_id   = (SELECT t.user_id   FROM transactions t WHERE t.id = transactions.id)
    AND wallet_id = (SELECT t.wallet_id FROM transactions t WHERE t.id = transactions.id)
    AND amount    = (SELECT t.amount    FROM transactions t WHERE t.id = transactions.id)
    AND type      = (SELECT t.type      FROM transactions t WHERE t.id = transactions.id)
  );

-- 2. Fix: Deny INSERT/UPDATE/DELETE on user_roles for authenticated users
CREATE POLICY "Deny authenticated insert on user_roles"
  ON public.user_roles FOR INSERT
  TO authenticated
  WITH CHECK (false);

CREATE POLICY "Deny authenticated update on user_roles"
  ON public.user_roles FOR UPDATE
  TO authenticated
  USING (false);

CREATE POLICY "Deny authenticated delete on user_roles"
  ON public.user_roles FOR DELETE
  TO authenticated
  USING (false);

-- 3. Fix: Deny INSERT/UPDATE/DELETE on wallets for authenticated users
CREATE POLICY "Deny authenticated insert on wallets"
  ON public.wallets FOR INSERT
  TO authenticated
  WITH CHECK (false);

CREATE POLICY "Deny authenticated update on wallets"
  ON public.wallets FOR UPDATE
  TO authenticated
  USING (false);

CREATE POLICY "Deny authenticated delete on wallets"
  ON public.wallets FOR DELETE
  TO authenticated
  USING (false);
