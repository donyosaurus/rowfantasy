import { withFnVersion } from '../shared/fn-version.ts';
// Wallet Withdraw Request - Thin wrapper around initiate_withdrawal_atomic SQL function

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.76.1';
import { z } from 'https://deno.land/x/zod@v3.22.4/mod.ts';
import { authenticateUser, checkRateLimit } from '../shared/auth-helpers.ts';
import { performComplianceChecks } from '../shared/compliance-checks.ts';
import { mapErrorToClient, logSecureError, ERROR_MESSAGES } from '../shared/error-handler.ts';
import { getCorsHeaders } from '../shared/cors.ts';

Deno.serve(withFnVersion('wallet-withdraw-request', async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Allow': 'POST, OPTIONS' },
    });
  }

  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
    const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
    const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    // SECURITY: Authenticate user
    const auth = await authenticateUser(req, SUPABASE_URL, ANON_KEY);
    if (!auth) {
      return new Response(
        JSON.stringify({ error: ERROR_MESSAGES.UNAUTHORIZED }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const userId = auth.user.id;

    // Service-role client used both for the rate-limit RPC (grant is service-role only)
    // and for the SECURITY DEFINER withdrawal function below.
    const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_KEY);

    // SECURITY: Rate limit (5 requests per hour per user)
    const rateLimitOk = await checkRateLimit(supabaseAdmin, userId, 'wallet-withdraw-request', 5, 60);
    if (!rateLimitOk) {
      return new Response(
        JSON.stringify({ error: ERROR_MESSAGES.RATE_LIMIT }),
        { status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Validate input
    const withdrawSchema = z.object({
      amount_cents: z.number().int().positive().max(100_000_000), // sanity ceiling only; SQL function enforces the actual $5-$500 rule
    });

    const body = withdrawSchema.parse(await req.json());

    // Look up wallet via auth-scoped client (RLS enforced)
    const { data: wallet, error: walletError } = await auth.supabase
      .from('wallets')
      .select('id')
      .eq('user_id', userId)
      .single();

    if (walletError || !wallet) {
      return new Response(
        JSON.stringify({ error: ERROR_MESSAGES.NOT_FOUND }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // supabaseAdmin was created above for the rate-limit RPC; reused for the
    // SECURITY DEFINER withdrawal function below.

    const stateCode = req.headers.get('x-user-state') || '';
    const ipAddress = req.headers.get('cf-connecting-ip');
    if (!ipAddress) {
      return new Response(
        JSON.stringify({ error: 'Geolocation verification required' }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Application-layer compliance gates (P0-C1 / P0-C7): geo, state-reg, age, inactive, SX, employee.
    // Closes P0-C6 SX-at-withdrawal gap (initiate_withdrawal_atomic does not check SX).
    const compliance = await performComplianceChecks({
      userId,
      stateCode,
      amountCents: body.amount_cents,
      actionType: 'withdrawal',
      ipAddress,
    }, req);
    if (!compliance.allowed) {
      return new Response(
        JSON.stringify({ error: compliance.reason ?? 'Compliance check failed' }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Record-integrity: persist compliance-resolved state (not caller-supplied header).
    const resolvedStateCode = compliance.resolvedStateCode;

    const { data: result, error: rpcError } = await supabaseAdmin.rpc('initiate_withdrawal_atomic', {
      _user_id: userId,
      _wallet_id: wallet.id,
      _amount_cents: body.amount_cents,
      _state_code: resolvedStateCode,
    });

    if (rpcError) {
      const requestId = logSecureError('wallet-withdraw-request', rpcError);
      return new Response(
        JSON.stringify({ error: mapErrorToClient(rpcError), requestId }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const withdrawal = Array.isArray(result) ? result[0] : result;

    if (!withdrawal) {
      const requestId = logSecureError('wallet-withdraw-request', new Error('Empty result from initiate_withdrawal_atomic'));
      return new Response(
        JSON.stringify({ error: ERROR_MESSAGES.INTERNAL_ERROR, requestId }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (!withdrawal.allowed) {
      const errorMap: Record<string, { status: number; message: string }> = {
        per_transaction_limit: { status: 400, message: 'Per-transaction withdrawal limit is $5 to $500' },
        wallet_not_found: { status: 404, message: ERROR_MESSAGES.NOT_FOUND },
        insufficient_balance: { status: 400, message: ERROR_MESSAGES.INSUFFICIENT_FUNDS },
        pending_withdrawal_exists: { status: 400, message: 'You have a pending withdrawal. Please wait for it to complete.' },
        cooldown: { status: 400, message: ERROR_MESSAGES.WITHDRAWAL_COOLDOWN },
        daily_limit: { status: 400, message: ERROR_MESSAGES.DAILY_LIMIT },
        deposit_hold_24h: { status: 400, message: 'Please wait 24 hours after your last deposit before withdrawing' },
      };

      const mapped = errorMap[withdrawal.reason] ?? { status: 400, message: ERROR_MESSAGES.INTERNAL_ERROR };

      if (!errorMap[withdrawal.reason]) {
        logSecureError('wallet-withdraw-request', new Error(`Unknown withdrawal reason: ${withdrawal.reason}`));
      }

      return new Response(
        JSON.stringify({ error: mapped.message }),
        { status: mapped.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Best-effort compliance audit log; failures must not roll back the withdrawal
    try {
      await supabaseAdmin.from('compliance_audit_logs').insert({
        user_id: userId,
        event_type: 'withdrawal_requested',
        description: 'User requested withdrawal',
        severity: 'info',
        metadata: {
          amount_cents: body.amount_cents,
          transaction_id: withdrawal.transaction_id,
          today_total_cents: withdrawal.today_total_cents,
          remaining_balance_cents: withdrawal.available_balance_cents,
        },
      });
    } catch (logError) {
      logSecureError('wallet-withdraw-request', logError);
    }

    return new Response(
      JSON.stringify({
        requestId: withdrawal.transaction_id,
        amountCents: body.amount_cents,
        status: 'pending',
        message: 'Withdrawal request submitted successfully',
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error: any) {
    const requestId = logSecureError('wallet-withdraw-request', error);
    const clientMessage = mapErrorToClient(error);
    
    return new Response(
      JSON.stringify({ error: clientMessage, requestId }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
}));
