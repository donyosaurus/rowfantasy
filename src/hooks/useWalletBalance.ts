// Centralized fail-closed wallet-balance hook (Wave 1 #6).
//
// All money UI MUST route balance reads through this hook (or the
// equivalent strict-validator pattern for in-flight async submission paths).
// Direct .from('wallets').select(...) on the client is an architectural bug
// — it silently renders $0.00 on RLS denial / missing rows.
//
// Contract:
// - Calls the SECURITY DEFINER RPC `get_user_wallet_balances()` which derives
//   the user from auth.uid() (no parameters → cannot be tricked across users).
// - Returns a discriminated union. Callers cannot read `availableCents`
//   without first narrowing on `status === 'ready'`. This makes the
//   fail-closed contract a compile-time invariant rather than a doc convention.
// - On any error, network failure, missing wallet row, or malformed payload,
//   `status` is 'error'. Money-action buttons must NOT be rendered in that
//   branch — never coerce a missing balance to 0.

import { useEffect, useState, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';

export type WalletBalanceState =
  | { status: 'loading' }
  | { status: 'error'; error: string }
  | { status: 'ready'; availableCents: number; pendingCents: number };

export type UseWalletBalanceReturn = WalletBalanceState & {
  refetch: () => Promise<void>;
};

export function useWalletBalance(autoload: boolean = true): UseWalletBalanceReturn {
  const [state, setState] = useState<WalletBalanceState>(
    autoload ? { status: 'loading' } : { status: 'error', error: 'not loaded' }
  );

  const refetch = useCallback(async () => {
    setState({ status: 'loading' });

    const { data, error } = await supabase.rpc('get_user_wallet_balances' as never);
    if (error) {
      setState({ status: 'error', error: error.message });
      return;
    }

    const row: any = Array.isArray(data) ? data[0] : data;
    if (!row) {
      setState({ status: 'error', error: 'No wallet found' });
      return;
    }

    // Strict validation — fail-closed on malformed payload. Coercing missing
    // fields to 0 reintroduces the silent-zero bypass class this hook exists
    // to eliminate.
    const a = row.available_balance_cents;
    const p = row.pending_balance_cents;
    if (
      a === undefined || a === null || Number.isNaN(Number(a)) ||
      p === undefined || p === null || Number.isNaN(Number(p))
    ) {
      setState({ status: 'error', error: 'Malformed balance response' });
      return;
    }

    setState({
      status: 'ready',
      availableCents: Number(a),
      pendingCents: Number(p),
    });
  }, []);

  useEffect(() => {
    if (autoload) void refetch();
  }, [autoload, refetch]);

  return { ...state, refetch };
}
