// Wallet Withdraw Cancel — atomic single-RPC implementation.
// All state transitions (transactions.status -> 'failed', wallets pending->available
// restoration, ledger entry) happen inside cancel_pending_withdrawal_atomic so
// the previous partial-state class (tx flipped but funds still locked in pending)
// is impossible.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.76.1';
import { z } from 'https://deno.land/x/zod@v3.22.4/mod.ts';
import { getCorsHeaders } from '../shared/cors.ts';
import { authenticateUser, checkRateLimit } from '../shared/auth-helpers.ts';
import { ERROR_MESSAGES, logSecureError, mapErrorToClient } from '../shared/error-handler.ts';

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Allow': 'POST, OPTIONS' },
    });
  }

  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
    const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

    const auth = await authenticateUser(req, SUPABASE_URL, ANON_KEY);
    if (!auth) {
      return new Response(JSON.stringify({ error: ERROR_MESSAGES.UNAUTHORIZED }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const userId = auth.user.id;

    const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_KEY);

    const rateOk = await checkRateLimit(supabaseAdmin, userId, 'wallet-withdraw-cancel', 5, 1);
    if (!rateOk) {
      return new Response(JSON.stringify({ error: ERROR_MESSAGES.RATE_LIMIT }), {
        status: 429,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const cancelSchema = z.object({ request_id: z.string().uuid() });
    let body: z.infer<typeof cancelSchema>;
    try {
      body = cancelSchema.parse(await req.json());
    } catch {
      return new Response(JSON.stringify({ error: ERROR_MESSAGES.INVALID_INPUT }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { data: result, error: rpcError } = await supabaseAdmin.rpc(
      'cancel_pending_withdrawal_atomic',
      { _user_id: userId, _transaction_id: body.request_id },
    );

    if (rpcError) {
      const requestId = logSecureError('wallet-withdraw-cancel', rpcError);
      return new Response(
        JSON.stringify({ error: mapErrorToClient(rpcError), requestId }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const cancel = Array.isArray(result) ? result[0] : result;
    if (!cancel) {
      const requestId = logSecureError('wallet-withdraw-cancel', new Error('Empty result'));
      return new Response(
        JSON.stringify({ error: ERROR_MESSAGES.INTERNAL_ERROR, requestId }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    if (!cancel.allowed) {
      const errorMap: Record<string, { status: number; message: string }> = {
        transaction_not_found: { status: 404, message: 'Withdrawal request not found' },
        not_pending: { status: 400, message: 'Only pending withdrawals can be cancelled' },
        wallet_not_found: { status: 404, message: ERROR_MESSAGES.NOT_FOUND },
        pending_balance_insufficient: { status: 409, message: 'Wallet state inconsistent — contact support' },
      };
      // Unknown reason indicates contract drift between SQL and JS — surface as
      // 500 (server error) rather than 400 (client error). Operator reads the
      // requestId, traces the SQL function, and updates the errorMap.
      const mapped = errorMap[cancel.reason] ?? { status: 500, message: ERROR_MESSAGES.INTERNAL_ERROR };
      if (!errorMap[cancel.reason]) {
        logSecureError(
          'wallet-withdraw-cancel',
          new Error(`Unknown reason from cancel_pending_withdrawal_atomic: ${cancel.reason}`),
        );
      }
      return new Response(JSON.stringify({ error: mapped.message }), {
        status: mapped.status,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Best-effort compliance audit log — never block success on logging failure.
    try {
      await supabaseAdmin.from('compliance_audit_logs').insert({
        user_id: userId,
        event_type: 'withdrawal_cancelled',
        description: 'User cancelled withdrawal request (atomic)',
        severity: 'info',
        metadata: {
          transaction_id: body.request_id,
          amount_cents: cancel.amount_cents,
          balance_after_cents: cancel.available_balance_cents,
        },
      });
    } catch (logError) {
      logSecureError('wallet-withdraw-cancel', logError);
    }

    return new Response(
      JSON.stringify({
        success: true,
        transactionId: body.request_id,
        refundedCents: cancel.amount_cents,
        balanceCents: cancel.available_balance_cents,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (error: any) {
    console.error('[wallet-withdraw-cancel] Error:', error);
    return new Response(JSON.stringify({ error: 'Failed to cancel withdrawal' }), {
      status: 500,
      headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
    });
  }
});
