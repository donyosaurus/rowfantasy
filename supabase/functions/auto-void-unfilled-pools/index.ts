// Auto-Void Unfilled Pools — scheduled sweep
//
// Selects contest pools whose lock_time has passed (with a 15-minute grace
// window) but never reached max_entries, and voids them via
// void_contest_pool_atomic. Refunds entrants automatically as part of voiding.
//
// Safety properties:
//   - Cron-secret guard (x-cron-secret header or ?secret= fallback; the
//     query-string fallback is a known Wave 5 finding, mirrored here for
//     parity with auto-lock-contests).
//   - Default mode is dry-run. Mutations only when ?dry_run=false.
//   - Per-invocation sweep_id (uuid) tagged on every audit log row.
//   - 60-second runtime budget; remaining work picked up next tick.
//   - Deterministic order (oldest lock_time first), LIMIT 200 per sweep.
//   - Re-entrancy safe: status filter excludes already-voided/settled pools;
//     void_contest_pool_atomic is itself idempotent on already-voided pools.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.76.1';
import { getCorsHeaders } from '../shared/cors.ts';

const SYSTEM_AUTO_VOID_EMAIL = 'system+auto-void@rowfantasy.internal';
const GRACE_INTERVAL = '15 minutes';
const CANDIDATE_LIMIT = 200;
const RUNTIME_BUDGET_MS = 60_000;

interface Candidate {
  id: string;
  contest_template_id: string;
  lock_time: string;
  status: string;
  current_entries: number;
  max_entries: number;
}

interface Failure {
  pool_id: string;
  reason: string;
}

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  // Cron-secret guard (mirrors auto-lock-contests)
  const cronSecret = Deno.env.get('CRON_SECRET');
  const url = new URL(req.url);
  const providedSecret = req.headers.get('x-cron-secret') || url.searchParams.get('secret');
  if (!cronSecret || providedSecret !== cronSecret) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // Default to dry-run unless explicitly disabled.
  const dryRun = url.searchParams.get('dry_run') !== 'false';
  const sweepId = crypto.randomUUID();
  const startedAt = Date.now();

  const supabaseAdmin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  // Resolve system admin user id (required by void_contest_pool_atomic).
  const { data: systemUserRow, error: systemUserErr } = await supabaseAdmin
    .schema('auth' as never)
    // PostgREST cannot reach auth schema; fall through to RPC-style lookup.
    .from('users')
    .select('id')
    .eq('email', SYSTEM_AUTO_VOID_EMAIL)
    .maybeSingle()
    .then(
      (r) => r,
      (err) => ({ data: null, error: err }),
    );

  let systemUserId: string | null = systemUserRow?.id ?? null;

  if (!systemUserId) {
    // Fallback: query via service-role rpc-style join through profiles or user_roles.
    // The system account always has a profiles row (handle_new_user trigger).
    const { data: profileRow } = await supabaseAdmin
      .from('profiles')
      .select('id')
      .eq('email', SYSTEM_AUTO_VOID_EMAIL)
      .maybeSingle();
    systemUserId = profileRow?.id ?? null;
  }

  if (!systemUserId) {
    console.error('[auto-void-unfilled-pools] system user not found', systemUserErr);
    return new Response(
      JSON.stringify({
        sweep_id: sweepId,
        error: 'system_user_not_provisioned',
        hint: `Expected auth.users row with email ${SYSTEM_AUTO_VOID_EMAIL}`,
      }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }

  // ── Candidate selection ──────────────────────────────────────────────
  // Schema note: this project does not have a `contests` table — contests are
  // modeled as `contest_templates` and pools join via contest_template_id.
  // We exclude templates whose status indicates the contest is already done
  // ('settled', 'voided', 'cancelled') so this sweep doesn't fight upstream.
  const graceCutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString();

  const { data: candidates, error: selectErr } = await supabaseAdmin
    .from('contest_pools')
    .select('id, contest_template_id, lock_time, status, current_entries, max_entries')
    .in('status', ['open', 'locked'])
    .not('lock_time', 'is', null)
    .lt('lock_time', graceCutoff)
    .order('lock_time', { ascending: true })
    .limit(CANDIDATE_LIMIT);

  if (selectErr) {
    console.error('[auto-void-unfilled-pools] candidate query failed', selectErr);
    return new Response(
      JSON.stringify({ sweep_id: sweepId, error: 'candidate_query_failed' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }

  // Filter: unfilled pools only, and template not in terminal contest state.
  const eligible: Candidate[] = [];
  if (candidates && candidates.length > 0) {
    const templateIds = Array.from(new Set(candidates.map((c) => c.contest_template_id)));
    const { data: templates } = await supabaseAdmin
      .from('contest_templates')
      .select('id, status')
      .in('id', templateIds);
    const templateStatus = new Map<string, string>(
      (templates ?? []).map((t) => [t.id as string, t.status as string]),
    );

    for (const c of candidates as Candidate[]) {
      if (c.current_entries >= c.max_entries) continue; // filled — settle path handles this
      const tStatus = templateStatus.get(c.contest_template_id);
      if (tStatus && ['cancelled', 'settled', 'voided', 'completed'].includes(tStatus)) continue;
      eligible.push(c);
    }
  }

  // ── Per-pool dispatch ────────────────────────────────────────────────
  const failures: Failure[] = [];
  let voidedOk = 0;
  let voidedFailed = 0;
  let skippedAlreadySettled = 0;
  let processed = 0;

  if (!dryRun) {
    for (const pool of eligible) {
      if (Date.now() - startedAt > RUNTIME_BUDGET_MS) {
        console.warn(`[auto-void-unfilled-pools] runtime budget exceeded at pool ${processed}/${eligible.length}`);
        break;
      }
      processed += 1;

      const { data: result, error: rpcErr } = await supabaseAdmin.rpc(
        'void_contest_pool_atomic',
        {
          _pool_id: pool.id,
          _admin_user_id: systemUserId,
          _reason: `auto-void: unfilled at lock_time + ${GRACE_INTERVAL}`,
        },
      );

      if (rpcErr) {
        voidedFailed += 1;
        failures.push({ pool_id: pool.id, reason: rpcErr.message ?? 'rpc_error' });
        continue;
      }

      const row = Array.isArray(result) ? result[0] : result;
      if (!row?.allowed) {
        // 'cannot_void_settled' means the pool got settled between selection
        // and dispatch — benign race, count separately.
        if (row?.reason === 'cannot_void_settled') {
          skippedAlreadySettled += 1;
        } else {
          voidedFailed += 1;
          failures.push({ pool_id: pool.id, reason: row?.reason ?? 'unknown' });
        }
        continue;
      }

      voidedOk += 1;
    }
  }

  const runtimeMs = Date.now() - startedAt;
  const summary = {
    sweep_id: sweepId,
    dry_run: dryRun,
    candidates_total: eligible.length,
    voided_ok: voidedOk,
    voided_failed: voidedFailed,
    skipped_already_settled: skippedAlreadySettled,
    runtime_ms: runtimeMs,
    failures,
    ...(dryRun ? { candidate_pool_ids: eligible.map((p) => p.id) } : {}),
  };

  // ── Sweep audit log (best-effort) ────────────────────────────────────
  try {
    await supabaseAdmin.from('compliance_audit_logs').insert({
      event_type: 'auto_void_sweep',
      severity: voidedFailed > 0 ? 'warning' : 'info',
      description: dryRun
        ? `Auto-void dry-run: ${eligible.length} candidate pool(s) identified`
        : `Auto-void sweep: ${voidedOk} voided, ${voidedFailed} failed, ${skippedAlreadySettled} skipped`,
      metadata: summary,
    });
  } catch (logErr) {
    console.error('[auto-void-unfilled-pools] audit log insert failed', logErr);
  }

  console.log(`[auto-void-unfilled-pools] sweep ${sweepId}`, summary);

  return new Response(JSON.stringify(summary), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
