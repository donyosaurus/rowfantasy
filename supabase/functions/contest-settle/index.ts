// Contest Settlement - Thin wrapper that batches calls to atomic SQL functions
// across sibling pools sharing the same contest_template_id.
//
// All eligibility checks, locking, payouts, refunds, transactions, and ledger
// writes are performed inside settle_contest_pool_atomic and
// void_contest_pool_atomic (SECURITY DEFINER, EXECUTE-restricted to service_role).
//
// JS owns: the loop, per-pool decision (settle vs auto-void vs skip),
// and response aggregation. Per-pool failures do NOT roll back successes.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.76.1';
import { z } from 'https://esm.sh/zod@3.23.8';
import { getCorsHeaders } from '../shared/cors.ts';
import { authenticateUser } from '../shared/auth-helpers.ts';
import { mapErrorToClient, logSecureError, ERROR_MESSAGES } from '../shared/error-handler.ts';

type PoolSettlementResult = {
  poolId: string;
  action:
    | 'settled'
    | 'auto_voided'
    | 'h2h_tie_refund'
    | 'already_settled'
    | 'already_voided'
    | 'already_finalized'
    | 'pool_not_ready'
    | 'error';
  reason?: string;
  message?: string;
  requestId?: string;
  totalPayoutCents?: number;
  winnersCount?: number;
  isTieRefund?: boolean;
  totalRefundedCents?: number;
  refundedCount?: number;
};

type SiblingDecision = {
  id: string;
  status: string;
  current_entries: number;
  max_entries: number;
  void_unfilled_on_settle: boolean;
  action: 'settled' | 'auto_voided' | 'already_finalized' | 'pool_not_ready';
};

const settleSchema = z.object({ contestPoolId: z.string().uuid() });

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);

  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json', Allow: 'POST, OPTIONS' },
    });
  }

  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
    const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
    const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    // Auth
    const auth = await authenticateUser(req, SUPABASE_URL, ANON_KEY);
    if (!auth) {
      return new Response(JSON.stringify({ error: ERROR_MESSAGES.UNAUTHORIZED }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const userId = auth.user.id;

    // Admin role check
    const { data: roleRow } = await auth.supabase
      .from('user_roles')
      .select('role')
      .eq('user_id', userId)
      .eq('role', 'admin')
      .maybeSingle();

    if (!roleRow) {
      return new Response(JSON.stringify({ error: 'Admin access required' }), {
        status: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Parse body
    let rawBody: unknown;
    try {
      rawBody = await req.json();
    } catch {
      return new Response(JSON.stringify({ error: ERROR_MESSAGES.INVALID_INPUT }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const parsed = settleSchema.safeParse(rawBody);
    if (!parsed.success) {
      return new Response(
        JSON.stringify({ error: ERROR_MESSAGES.INVALID_INPUT, details: parsed.error.flatten().fieldErrors }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }
    const body = parsed.data;

    // Look up the target pool to get its contest_template_id
    const { data: targetPool, error: targetErr } = await auth.supabase
      .from('contest_pools')
      .select('id, contest_template_id, status')
      .eq('id', body.contestPoolId)
      .single();

    if (targetErr || !targetPool) {
      return new Response(JSON.stringify({ error: 'Contest pool not found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_KEY);

    // Look up all sibling pools sharing the contest_template_id
    const { data: siblings, error: sibErr } = await supabaseAdmin
      .from('contest_pools')
      .select('id, status, current_entries, max_entries, void_unfilled_on_settle')
      .eq('contest_template_id', targetPool.contest_template_id);

    if (sibErr || !siblings || siblings.length === 0) {
      const requestId = sibErr ? logSecureError('contest-settle', sibErr) : undefined;
      return new Response(
        JSON.stringify({
          error: sibErr ? mapErrorToClient(sibErr) : 'No sibling pools found',
          requestId,
        }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // Decide per-pool action
    const decisions: SiblingDecision[] = siblings.map((p: any) => {
      let action: SiblingDecision['action'];
      if (p.status === 'settled' || p.status === 'voided') {
        action = 'already_finalized';
      } else if (p.status === 'scoring_completed') {
        action = 'settled';
      } else if (
        (p.status === 'open' || p.status === 'locked') &&
        p.void_unfilled_on_settle === true &&
        (p.current_entries ?? 0) < (p.max_entries ?? 0)
      ) {
        action = 'auto_voided';
      } else {
        action = 'pool_not_ready';
      }
      return {
        id: p.id,
        status: p.status,
        current_entries: p.current_entries,
        max_entries: p.max_entries,
        void_unfilled_on_settle: p.void_unfilled_on_settle,
        action,
      };
    });

    const actionable = decisions.filter((d) => d.action === 'settled' || d.action === 'auto_voided');
    const alreadyFinalized = decisions.filter((d) => d.action === 'already_finalized');
    const notReady = decisions.filter((d) => d.action === 'pool_not_ready');

    if (actionable.length === 0) {
      return new Response(
        JSON.stringify({
          error: 'No siblings are ready for settlement or auto-void',
          siblingPoolStatuses: decisions.map((d) => ({
            poolId: d.id,
            status: d.status,
            action: d.action,
            currentEntries: d.current_entries,
            maxEntries: d.max_entries,
          })),
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // Process actionable pools serially for ordering predictability
    const results: PoolSettlementResult[] = [];

    for (const sibling of actionable) {
      try {
        if (sibling.action === 'settled') {
          const { data, error } = await supabaseAdmin.rpc('settle_contest_pool_atomic', {
            _pool_id: sibling.id,
            _admin_user_id: userId,
          });
          if (error) {
            const requestId = logSecureError('contest-settle', error);
            results.push({
              poolId: sibling.id,
              action: 'error',
              reason: 'rpc_error',
              message: mapErrorToClient(error),
              requestId,
            });
            continue;
          }
          const result: any = Array.isArray(data) ? data[0] : data;
          if (!result) {
            results.push({ poolId: sibling.id, action: 'error', reason: 'empty_result' });
            continue;
          }
          if (!result.allowed) {
            results.push({
              poolId: sibling.id,
              action: 'error',
              reason: result.reason,
              totalPayoutCents: 0,
              winnersCount: 0,
            });
            continue;
          }
          results.push({
            poolId: sibling.id,
            action: result.was_already_settled
              ? 'already_settled'
              : result.is_tie_refund
                ? 'h2h_tie_refund'
                : 'settled',
            reason: result.reason,
            totalPayoutCents: Number(result.total_payout_cents ?? 0),
            winnersCount: Number(result.winners_count ?? 0),
            isTieRefund: !!result.is_tie_refund,
          });
        } else if (sibling.action === 'auto_voided') {
          const { data, error } = await supabaseAdmin.rpc('void_contest_pool_atomic', {
            _pool_id: sibling.id,
            _admin_user_id: userId,
            _reason: 'Pool unfilled at settlement time',
          });
          if (error) {
            const requestId = logSecureError('contest-settle', error);
            results.push({
              poolId: sibling.id,
              action: 'error',
              reason: 'rpc_error',
              message: mapErrorToClient(error),
              requestId,
            });
            continue;
          }
          const result: any = Array.isArray(data) ? data[0] : data;
          if (!result) {
            results.push({ poolId: sibling.id, action: 'error', reason: 'empty_result' });
            continue;
          }
          if (!result.allowed) {
            results.push({
              poolId: sibling.id,
              action: 'error',
              reason: result.reason,
              totalRefundedCents: 0,
              refundedCount: 0,
            });
            continue;
          }
          results.push({
            poolId: sibling.id,
            action: result.was_already_voided ? 'already_voided' : 'auto_voided',
            reason: result.reason,
            totalRefundedCents: Number(result.total_refunded_cents ?? 0),
            refundedCount: Number(result.refunded_count ?? 0),
          });
        }
      } catch (err: any) {
        const requestId = logSecureError('contest-settle', err);
        results.push({
          poolId: sibling.id,
          action: 'error',
          reason: 'exception',
          message: 'Internal error',
          requestId,
        });
      }
    }

    // Append skipped pools
    for (const skipped of [...alreadyFinalized, ...notReady]) {
      results.push({
        poolId: skipped.id,
        action: skipped.action,
        reason: skipped.action,
      });
    }

    // Aggregate
    const summary = {
      poolsSettled: results.filter((r) => r.action === 'settled').length,
      poolsAutoVoided: results.filter((r) => r.action === 'auto_voided').length,
      poolsTieRefunded: results.filter((r) => r.action === 'h2h_tie_refund').length,
      poolsAlreadyFinalized: results.filter((r) =>
        ['already_settled', 'already_voided', 'already_finalized'].includes(r.action),
      ).length,
      poolsNotReady: results.filter((r) => r.action === 'pool_not_ready').length,
      poolsFailed: results.filter((r) => r.action === 'error').length,
      totalPayoutCents: results.reduce((s, r) => s + (r.totalPayoutCents || 0), 0),
      totalRefundedCents: results.reduce((s, r) => s + (r.totalRefundedCents || 0), 0),
      winnersCount: results.reduce((s, r) => s + (r.winnersCount || 0), 0),
      refundedCount: results.reduce((s, r) => s + (r.refundedCount || 0), 0),
    };

    // Best-effort compliance audit log
    try {
      await supabaseAdmin.from('compliance_audit_logs').insert({
        user_id: userId,
        event_type: 'contest_batch_settled',
        description: `Batch settlement: ${summary.poolsSettled} settled, ${summary.poolsAutoVoided} auto-voided, ${summary.poolsFailed} failed`,
        severity: summary.poolsFailed > 0 ? 'warning' : 'info',
        metadata: {
          contest_template_id: targetPool.contest_template_id,
          ...summary,
          results,
        },
      });
    } catch (logError) {
      logSecureError('contest-settle', logError);
    }

    const failCount = summary.poolsFailed;
    return new Response(
      JSON.stringify({
        success: failCount === 0,
        message:
          failCount === 0
            ? `Successfully processed ${summary.poolsSettled + summary.poolsAutoVoided} pool(s)`
            : `Batch settlement completed with ${failCount} failure(s)`,
        ...summary,
        details: results,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (error: any) {
    const requestId = logSecureError('contest-settle', error);
    return new Response(
      JSON.stringify({ error: mapErrorToClient(error), requestId }),
      { status: 500, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } },
    );
  }
});
