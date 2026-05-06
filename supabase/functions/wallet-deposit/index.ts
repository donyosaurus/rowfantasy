// Wallet Deposit
//
// ───────────────────────────────────────────────────────────────────────────
// Payment ordering invariant (Aeropay-readiness contract):
//
//   Every payment provider call (capture) MUST be preceded by
//   check_deposit_eligibility() in the SAME request. Any post-charge RPC
//   rejection MUST trigger refundPayment() and a compliance_audit_logs
//   critical entry. Any AMBIGUOUS post-charge failure (network timeout /
//   abort) MUST NOT auto-refund — write a `deposit_post_charge_unknown_state`
//   critical log instead and require operator reconciliation.
//
//   The Aeropay swap (and any future processor) inherits this contract.
// ───────────────────────────────────────────────────────────────────────────

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.76.1';
import { z } from 'https://deno.land/x/zod@v3.22.4/mod.ts';
import { MockPaymentAdapter } from '../shared/payment-providers/mock-adapter.ts';
import { getCorsHeaders } from '../shared/cors.ts';
import { authenticateUser, checkRateLimit } from '../shared/auth-helpers.ts';
import { ERROR_MESSAGES, logSecureError, mapErrorToClient } from '../shared/error-handler.ts';

// Map RPC reason codes → HTTP responses. Shared between pre-flight and post-charge race paths.
const ELIGIBILITY_ERROR_MAP: Record<string, { status: number; message: string }> = {
  per_transaction_limit: { status: 400, message: 'Per-transaction deposit limit is $5 to $500' },
  self_excluded: { status: 403, message: 'Account is self-excluded' },
  monthly_deposit_limit: { status: 400, message: 'Monthly deposit limit exceeded' },
  wallet_not_found: { status: 404, message: ERROR_MESSAGES.NOT_FOUND },
  idempotency_key_in_progress: { status: 409, message: 'A deposit with this idempotency key is already being processed' },
};

/**
 * Classify a JS exception thrown during the post-charge RPC call.
 *
 *  - DETERMINATE: the RPC did NOT commit. Safe to refund.
 *      Signals: structured Postgres error (has `code` like '23505'), or
 *      Supabase error envelope with a non-empty `code`/`message` we recognize.
 *  - AMBIGUOUS:   the RPC may have committed silently. Do NOT refund.
 *      Signals: bare network failure, AbortError, TypeError fetch failure,
 *      no `code` field, or a generic timeout.
 *
 * Rationale: a silent ghost charge is unacceptable, but a duplicate refund is
 * also unacceptable. Genuinely ambiguous cases require operator escalation.
 */
function classifyRpcException(err: unknown): 'determinate' | 'ambiguous' {
  if (!err || typeof err !== 'object') return 'ambiguous';
  const e = err as { code?: unknown; name?: unknown; message?: unknown };
  if (e.name === 'AbortError' || e.name === 'TypeError') return 'ambiguous';
  if (typeof e.code === 'string' && e.code.length > 0) return 'determinate';
  const msg = typeof e.message === 'string' ? e.message.toLowerCase() : '';
  if (msg.includes('timeout') || msg.includes('fetch failed') || msg.includes('network')) return 'ambiguous';
  return 'ambiguous';
}

Deno.serve(async (req) => {
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
    const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

    // 1. Authenticate
    const auth = await authenticateUser(req, SUPABASE_URL, ANON_KEY);
    if (!auth) {
      return new Response(
        JSON.stringify({ error: ERROR_MESSAGES.UNAUTHORIZED }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    const userId = auth.user.id;

    const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_KEY);

    // 2. Rate limit
    const rateOk = await checkRateLimit(supabaseAdmin, userId, 'wallet-deposit', 10, 1);
    if (!rateOk) {
      return new Response(
        JSON.stringify({ error: ERROR_MESSAGES.RATE_LIMIT }),
        { status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // 3. Validate input
    const depositSchema = z.object({
      amount_cents: z.number().int().positive().max(100_000_000),
      payment_method: z.string().min(1).max(50).default('mock'),
      idempotency_key: z.string().uuid().optional(),
    });

    let body: z.infer<typeof depositSchema>;
    try {
      const rawBody = await req.json();
      body = depositSchema.parse(rawBody);
    } catch (_error) {
      return new Response(
        JSON.stringify({ error: ERROR_MESSAGES.INVALID_INPUT }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // 4. Wallet lookup / create
    let { data: wallet, error: walletError } = await auth.supabase
      .from('wallets')
      .select('id')
      .eq('user_id', userId)
      .single();

    if (walletError || !wallet) {
      const { data: newWallet, error: createError } = await supabaseAdmin
        .from('wallets')
        .insert({ user_id: userId })
        .select('id')
        .single();

      if (createError || !newWallet) {
        const requestId = logSecureError('wallet-deposit', createError ?? new Error('Wallet create failed'));
        return new Response(
          JSON.stringify({ error: ERROR_MESSAGES.INTERNAL_ERROR, requestId }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      wallet = newWallet;
    }

    const stateCode = req.headers.get('x-user-state') || ''; // placeholder; geofencing not yet wired

    // 5. PRE-FLIGHT eligibility check — read-only, no payment side effects.
    //    This is the gate that prevents ghost charges on rejected deposits.
    const { data: eligData, error: eligError } = await supabaseAdmin.rpc('check_deposit_eligibility', {
      _user_id: userId,
      _wallet_id: wallet.id,
      _amount_cents: body.amount_cents,
      _state_code: stateCode,
    });

    if (eligError) {
      const requestId = logSecureError('wallet-deposit', eligError);
      return new Response(
        JSON.stringify({ error: mapErrorToClient(eligError), requestId }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const eligibility = Array.isArray(eligData) ? eligData[0] : eligData;
    if (!eligibility?.allowed) {
      const reason = eligibility?.reason ?? 'unknown';
      const mapped = ELIGIBILITY_ERROR_MAP[reason] ?? { status: 400, message: ERROR_MESSAGES.INTERNAL_ERROR };
      if (!ELIGIBILITY_ERROR_MAP[reason]) {
        logSecureError('wallet-deposit', new Error(`Unknown eligibility reason: ${reason}`));
      }
      return new Response(
        JSON.stringify({ error: mapped.message }),
        { status: mapped.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // 6. Charge payment provider — only after eligibility passes.
    const paymentAdapter = new MockPaymentAdapter();
    const paymentResult = await paymentAdapter.processPayment(body.amount_cents, 'USD');

    if (!paymentResult.success) {
      return new Response(
        JSON.stringify({ error: 'Payment processing failed' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // 7. Atomic ledger write. From here on, any failure has charged the user.
    //    See Pass C: classify failures into determinate (refund) vs ambiguous (escalate).
    const idempotencyKey = body.idempotency_key ?? crypto.randomUUID();

    let result: any;
    let rpcError: any;
    try {
      const { data, error } = await supabaseAdmin.rpc('process_deposit_atomic', {
        _user_id: userId,
        _wallet_id: wallet.id,
        _amount_cents: body.amount_cents,
        _payment_provider_reference: paymentResult.transactionId,
        _payment_method: body.payment_method,
        _idempotency_key: idempotencyKey,
        _state_code: stateCode,
      });
      result = data;
      rpcError = error;
    } catch (thrown) {
      // Network / abort / TypeError — RPC may or may not have committed.
      const classification = classifyRpcException(thrown);
      if (classification === 'ambiguous') {
        // Ambiguous post-charge failure: DO NOT auto-refund. Escalate.
        try {
          await supabaseAdmin.from('compliance_audit_logs').insert({
            user_id: userId,
            event_type: 'deposit_post_charge_unknown_state',
            description: 'Deposit charged but ledger RPC outcome unknown; manual reconciliation required',
            severity: 'critical',
            metadata: {
              amount_cents: body.amount_cents,
              payment_provider_reference: paymentResult.transactionId,
              payment_method: body.payment_method,
              error: String((thrown as any)?.message ?? thrown),
              error_name: String((thrown as any)?.name ?? ''),
            },
          });
        } catch (logErr) {
          logSecureError('wallet-deposit', logErr);
        }
        const requestId = logSecureError('wallet-deposit', thrown);
        return new Response(
          JSON.stringify({ error: 'Deposit could not be confirmed. Support has been notified.', requestId }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      // Determinate exception: treat as RPC reject and fall through to refund branch.
      rpcError = thrown;
    }

    // Determinate RPC error → refund and audit.
    if (rpcError) {
      const refundContext = await refundAndAudit(
        supabaseAdmin,
        paymentAdapter,
        userId,
        body.amount_cents,
        paymentResult.transactionId,
        'rpc_error',
        rpcError,
      );
      const requestId = logSecureError('wallet-deposit', rpcError);
      return new Response(
        JSON.stringify({ error: mapErrorToClient(rpcError), requestId, refunded: refundContext.refunded }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const deposit = Array.isArray(result) ? result[0] : result;

    if (!deposit) {
      // Empty result is determinate (RPC returned nothing committed) — refund.
      await refundAndAudit(
        supabaseAdmin, paymentAdapter, userId, body.amount_cents, paymentResult.transactionId,
        'empty_result', new Error('Empty result from process_deposit_atomic'),
      );
      const requestId = logSecureError('wallet-deposit', new Error('Empty result from process_deposit_atomic'));
      return new Response(
        JSON.stringify({ error: ERROR_MESSAGES.INTERNAL_ERROR, requestId }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // 8. Race path: eligibility passed at T0 but atomic check failed at T1
    //    (e.g., concurrent deposit pushed user over monthly cap). Determinate
    //    result — RPC explicitly returned allowed=false and committed nothing.
    if (!deposit.allowed) {
      const reason = deposit.reason as string;
      const mapped = ELIGIBILITY_ERROR_MAP[reason] ?? { status: 400, message: ERROR_MESSAGES.INTERNAL_ERROR };
      if (!ELIGIBILITY_ERROR_MAP[reason]) {
        logSecureError('wallet-deposit', new Error(`Unknown deposit reason: ${reason}`));
      }

      // Idempotency-in-progress is a benign concurrency case (no charge needs reversal
      // for the OTHER request — but THIS request did charge, so we must refund).
      const refundContext = await refundAndAudit(
        supabaseAdmin, paymentAdapter, userId, body.amount_cents, paymentResult.transactionId,
        `post_charge_reject:${reason}`, null,
      );

      return new Response(
        JSON.stringify({ error: mapped.message, refunded: refundContext.refunded }),
        { status: mapped.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // 9. Compliance audit — best-effort, never fail the request on log error.
    try {
      await supabaseAdmin.from('compliance_audit_logs').insert({
        user_id: userId,
        event_type: deposit.was_duplicate ? 'deposit_idempotent_replay' : 'deposit_completed',
        description: deposit.was_duplicate ? 'Idempotent deposit replay returned existing transaction' : 'Deposit completed',
        severity: 'info',
        metadata: {
          amount_cents: body.amount_cents,
          transaction_id: deposit.transaction_id,
          payment_method: body.payment_method,
          payment_provider_reference: paymentResult.transactionId,
          balance_after_cents: deposit.available_balance_cents,
          was_duplicate: deposit.was_duplicate,
        },
      });
    } catch (logError) {
      logSecureError('wallet-deposit', logError);
    }

    return new Response(
      JSON.stringify({
        success: true,
        transactionId: deposit.transaction_id,
        depositedAmount: body.amount_cents,
        depositedDisplay: `$${(body.amount_cents / 100).toFixed(2)}`,
        balanceCents: deposit.available_balance_cents,
        balanceDisplay: `$${(Number(deposit.available_balance_cents) / 100).toFixed(2)}`,
        wasDuplicate: deposit.was_duplicate,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error: any) {
    console.error('[wallet-deposit] Error:', error);
    return new Response(
      JSON.stringify({ error: 'Deposit failed. Please try again.' }),
      { status: 500, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } }
    );
  }
});

/**
 * Refund payment and write a compliance audit log. Called only on
 * DETERMINATE post-charge failures (Pass C contract).
 *
 * If the refund itself fails, writes severity=critical
 * `deposit_post_charge_refund_failed` so an operator can intervene.
 */
async function refundAndAudit(
  admin: ReturnType<typeof createClient>,
  adapter: MockPaymentAdapter,
  userId: string,
  amountCents: number,
  providerTxnId: string,
  reasonCode: string,
  rpcError: unknown,
): Promise<{ refunded: boolean }> {
  let refunded = false;
  let refundError: unknown = null;
  try {
    const refundResult = await adapter.refundPayment(providerTxnId, amountCents, reasonCode);
    refunded = !!refundResult.success;
  } catch (err) {
    refundError = err;
  }

  try {
    await admin.from('compliance_audit_logs').insert({
      user_id: userId,
      event_type: refunded ? 'deposit_post_charge_refunded' : 'deposit_post_charge_refund_failed',
      description: refunded
        ? 'Deposit RPC rejected after charge; payment refunded'
        : 'Deposit RPC rejected after charge; refund FAILED — manual intervention required',
      severity: 'critical',
      metadata: {
        amount_cents: amountCents,
        payment_provider_reference: providerTxnId,
        rpc_error: rpcError ? String((rpcError as any)?.message ?? rpcError) : null,
        rpc_error_code: rpcError ? String((rpcError as any)?.code ?? '') : null,
        refund_error: refundError ? String((refundError as any)?.message ?? refundError) : null,
        reason_code: reasonCode,
      },
    });
  } catch (logErr) {
    logSecureError('wallet-deposit', logErr);
  }

  return { refunded };
}
