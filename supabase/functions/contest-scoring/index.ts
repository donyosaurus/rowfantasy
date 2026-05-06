// Contest Scoring Engine - Admin-only pool scoring with batch sibling support
// Hardened (Wave 2 #1): idempotency key, per-pool isolation, per-pool timeout,
// sanitized Zod errors, structured logging.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.76.1';
import { z } from 'https://deno.land/x/zod@v3.22.4/mod.ts';
import {
  scoreContestPool,
  calculateOfficialMargin,
  type RaceResult,
} from '../shared/scoring-logic.ts';
import { getCorsHeaders } from '../shared/cors.ts';
import { logSecureError } from '../shared/error-handler.ts';

const FUNCTION_NAME = 'contest-scoring';
const PER_POOL_TIMEOUT_MS = 30_000;
const IDEMPOTENCY_WINDOW_HOURS = 24;

type PoolCrew = {
  crew_id: string;
  event_id: string;
  crew_name: string;
  manual_finish_order: number | null;
  manual_result_time: string | null;
};

type PoolFailure = {
  pool_id: string;
  reason:
    | 'scoring_failed'
    | 'scoring_timeout'
    | 'pool_not_found'
    | 'no_results'
    | 'race_fetch_failed';
};

type PoolSuccess = {
  pool_id: string;
  events_processed?: number;
  results_count?: number;
  entries_scored: number;
  winner_id?: string;
  is_tie_refund?: boolean;
  skipped?: boolean;
  skip_reason?: string;
};

function slog(
  level: 'info' | 'warn' | 'error',
  scoringRunId: string,
  msg: string,
  extra: Record<string, unknown> = {},
) {
  const line = {
    function: FUNCTION_NAME,
    scoring_run_id: scoringRunId,
    level,
    msg,
    ...extra,
  };
  if (level === 'error') console.error(JSON.stringify(line));
  else if (level === 'warn') console.warn(JSON.stringify(line));
  else console.log(JSON.stringify(line));
}

/** Run a promise with an AbortController-style timeout. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout:${label}`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

async function scoreSinglePool(
  supabaseAdmin: any,
  contestPoolId: string,
  forceRescore: boolean,
  scoringRunId: string,
): Promise<
  | { ok: true; result: PoolSuccess }
  | { ok: false; failure: PoolFailure }
> {
  const baseCtx = { pool_id: contestPoolId };

  // ---- Pool lookup
  let pool: { status: string } | null = null;
  try {
    const { data, error } = await supabaseAdmin
      .from('contest_pools')
      .select('status')
      .eq('id', contestPoolId)
      .single();
    if (error || !data) {
      slog('warn', scoringRunId, 'pool_not_found', { ...baseCtx, error_class: 'pool_not_found' });
      return { ok: false, failure: { pool_id: contestPoolId, reason: 'pool_not_found' } };
    }
    pool = data;
  } catch (e: any) {
    logSecureError(FUNCTION_NAME, e, { ...baseCtx, scoring_run_id: scoringRunId, error_class: 'pool_fetch_failed' });
    return { ok: false, failure: { pool_id: contestPoolId, reason: 'scoring_failed' } };
  }

  if (pool!.status === 'scoring_completed' && !forceRescore) {
    slog('info', scoringRunId, 'pool_skipped_already_scored', baseCtx);
    return {
      ok: true,
      result: { pool_id: contestPoolId, entries_scored: 0, skipped: true, skip_reason: 'already_scored' },
    };
  }

  const validScoringStatuses = ['results_entered', 'locked', 'settling'];
  if (!validScoringStatuses.includes(pool!.status) && !forceRescore) {
    slog('info', scoringRunId, 'pool_skipped_status', { ...baseCtx, status: pool!.status });
    return {
      ok: true,
      result: {
        pool_id: contestPoolId,
        entries_scored: 0,
        skipped: true,
        skip_reason: `status_${pool!.status}_not_ready`,
      },
    };
  }

  // ---- Fetch crew results (with timeout)
  let crews: PoolCrew[] | null = null;
  try {
    const { data, error } = await withTimeout(
      supabaseAdmin
        .from('contest_pool_crews')
        .select('crew_id, event_id, crew_name, manual_finish_order, manual_result_time')
        .eq('contest_pool_id', contestPoolId),
      PER_POOL_TIMEOUT_MS,
      'race_fetch',
    );
    if (error) {
      logSecureError(FUNCTION_NAME, error, { ...baseCtx, scoring_run_id: scoringRunId, error_class: 'race_fetch_failed' });
      return { ok: false, failure: { pool_id: contestPoolId, reason: 'race_fetch_failed' } };
    }
    crews = data as PoolCrew[];
  } catch (e: any) {
    const isTimeout = String(e?.message || '').startsWith('timeout:');
    logSecureError(FUNCTION_NAME, e, {
      ...baseCtx,
      scoring_run_id: scoringRunId,
      error_class: isTimeout ? 'race_fetch_timeout' : 'race_fetch_failed',
    });
    return {
      ok: false,
      failure: { pool_id: contestPoolId, reason: isTimeout ? 'scoring_timeout' : 'race_fetch_failed' },
    };
  }

  if (!crews || crews.length === 0) {
    slog('warn', scoringRunId, 'no_crew_results', { ...baseCtx, error_class: 'no_results' });
    return { ok: false, failure: { pool_id: contestPoolId, reason: 'no_results' } };
  }

  // ---- Build race results
  const eventGroups = new Map<string, PoolCrew[]>();
  for (const crew of crews) {
    if (!eventGroups.has(crew.event_id)) eventGroups.set(crew.event_id, []);
    eventGroups.get(crew.event_id)!.push(crew);
  }

  const results: RaceResult[] = [];
  for (const [eventId, eventCrews] of eventGroups) {
    const sorted = eventCrews
      .filter((c) => c.manual_finish_order !== null)
      .sort((a, b) => (a.manual_finish_order || 0) - (b.manual_finish_order || 0));
    if (sorted.length === 0) continue;
    const officialMargin = calculateOfficialMargin(sorted);
    for (const crew of sorted) {
      results.push({
        crewId: crew.crew_id,
        eventId,
        finishOrder: crew.manual_finish_order!,
        actualMargin: officialMargin,
      });
    }
  }

  slog('info', scoringRunId, 'scoring_pool_start', {
    ...baseCtx,
    events: eventGroups.size,
    results_count: results.length,
  });

  // ---- Score with timeout
  try {
    const scoringResult = await withTimeout(
      scoreContestPool(supabaseAdmin, contestPoolId, results),
      PER_POOL_TIMEOUT_MS,
      'score_pool',
    );
    slog('info', scoringRunId, 'scoring_pool_done', {
      ...baseCtx,
      entries_scored: scoringResult.entriesScored,
    });
    return {
      ok: true,
      result: {
        pool_id: contestPoolId,
        events_processed: eventGroups.size,
        results_count: results.length,
        entries_scored: scoringResult.entriesScored,
        winner_id: scoringResult.winnerId,
        is_tie_refund: scoringResult.isTieRefund,
      },
    };
  } catch (e: any) {
    const isTimeout = String(e?.message || '').startsWith('timeout:');
    logSecureError(FUNCTION_NAME, e, {
      ...baseCtx,
      scoring_run_id: scoringRunId,
      error_class: isTimeout ? 'scoring_timeout' : 'scoring_failed',
    });
    return {
      ok: false,
      failure: {
        pool_id: contestPoolId,
        reason: isTimeout ? 'scoring_timeout' : 'scoring_failed',
      },
    };
  }
}

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json', Allow: 'POST, OPTIONS' },
    });
  }

  // Pre-parse so we have a run id for all log lines below.
  let scoringRunId = crypto.randomUUID();

  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
    const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
    const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    const supabase = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: req.headers.get('Authorization')! } },
    });

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { data: roleData } = await supabase
      .from('user_roles')
      .select('role')
      .eq('user_id', user.id)
      .eq('role', 'admin')
      .single();
    if (!roleData) {
      return new Response(JSON.stringify({ error: 'Admin access required' }), {
        status: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ---- Sanitized input parsing
    const Schema = z.object({
      contestPoolId: z.string().uuid(),
      forceRescore: z.boolean().optional().default(false),
      _idempotency_key: z.string().uuid().optional(),
    });

    let bodyJson: unknown;
    try {
      bodyJson = await req.json();
    } catch (e) {
      logSecureError(FUNCTION_NAME, e, { scoring_run_id: scoringRunId, error_class: 'invalid_json' });
      return new Response(JSON.stringify({ error: 'invalid request body' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const parsed = Schema.safeParse(bodyJson);
    if (!parsed.success) {
      logSecureError(FUNCTION_NAME, parsed.error, {
        scoring_run_id: scoringRunId,
        error_class: 'zod_validation_failed',
        zod: parsed.error.flatten(),
      });
      return new Response(JSON.stringify({ error: 'invalid request body' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { contestPoolId, forceRescore, _idempotency_key } = parsed.data;
    scoringRunId = _idempotency_key ?? scoringRunId;

    const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_KEY);

    // ---- Idempotency replay check (24h window)
    {
      const since = new Date(Date.now() - IDEMPOTENCY_WINDOW_HOURS * 3600_000).toISOString();
      const { data: prior } = await supabaseAdmin
        .from('compliance_audit_logs')
        .select('metadata, created_at')
        .eq('event_type', 'batch_pool_scoring')
        .gte('created_at', since)
        .contains('metadata', { scoring_run_id: scoringRunId })
        .limit(1)
        .maybeSingle();

      if (prior?.metadata) {
        slog('info', scoringRunId, 'idempotent_replay_returning_prior', {
          contest_pool_id: contestPoolId,
        });
        const md: any = prior.metadata;
        return new Response(
          JSON.stringify({
            scoring_run_id: scoringRunId,
            success: (md.pools_failed ?? 0) === 0,
            pools_scored: md.pools_scored ?? 0,
            pools_failed: md.pools_failed ?? 0,
            pools_skipped: md.pools_skipped ?? 0,
            total_entries_scored: md.total_entries_scored ?? 0,
            failures: md.failures ?? [],
            replayed: true,
          }),
          { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }
    }

    slog('info', scoringRunId, 'scoring_run_start', {
      admin_id: user.id,
      contest_pool_id: contestPoolId,
      force_rescore: forceRescore,
    });

    // ---- Resolve template & sibling pools
    const { data: requestedPool, error: requestedPoolError } = await supabaseAdmin
      .from('contest_pools')
      .select('contest_template_id, tier_id, status')
      .eq('id', contestPoolId)
      .single();

    if (requestedPoolError || !requestedPool) {
      slog('warn', scoringRunId, 'requested_pool_not_found', { contest_pool_id: contestPoolId });
      return new Response(JSON.stringify({ error: 'Contest pool not found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { data: siblingPools, error: siblingsError } = await supabaseAdmin
      .from('contest_pools')
      .select('id, status')
      .eq('contest_template_id', requestedPool.contest_template_id);

    if (siblingsError) {
      logSecureError(FUNCTION_NAME, siblingsError, { scoring_run_id: scoringRunId, error_class: 'siblings_fetch_failed' });
      return new Response(JSON.stringify({ error: 'Failed to fetch sibling pools' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ---- Copy crew results to siblings missing them (best-effort)
    const { data: sourceCrews } = await supabaseAdmin
      .from('contest_pool_crews')
      .select('crew_id, event_id, crew_name, manual_finish_order, manual_result_time')
      .eq('contest_pool_id', contestPoolId);

    if (sourceCrews && sourceCrews.length > 0) {
      const hasResults = sourceCrews.some((c: any) => c.manual_finish_order !== null);
      if (hasResults) {
        for (const sib of siblingPools || []) {
          if (sib.id === contestPoolId) continue;
          try {
            const { data: sibCrews } = await supabaseAdmin
              .from('contest_pool_crews')
              .select('crew_id, manual_finish_order')
              .eq('contest_pool_id', sib.id);
            const sibHasResults = sibCrews?.some((c: any) => c.manual_finish_order !== null);
            if (!sibHasResults && sibCrews && sibCrews.length > 0) {
              for (const src of sourceCrews) {
                await supabaseAdmin
                  .from('contest_pool_crews')
                  .update({
                    manual_finish_order: src.manual_finish_order,
                    manual_result_time: src.manual_result_time,
                  })
                  .eq('contest_pool_id', sib.id)
                  .eq('crew_id', src.crew_id);
              }
              if (sib.status === 'locked' || sib.status === 'open') {
                await supabaseAdmin
                  .from('contest_pools')
                  .update({ status: 'results_entered' })
                  .eq('id', sib.id);
                sib.status = 'results_entered';
              }
            }
          } catch (e: any) {
            logSecureError(FUNCTION_NAME, e, {
              scoring_run_id: scoringRunId,
              pool_id: sib.id,
              error_class: 'sibling_copy_failed',
            });
            // Continue — copy failure should not block scoring of other siblings.
          }
        }
      }
    }

    const scorableStatuses = ['results_entered', 'locked', 'settling', 'scoring_completed'];
    const poolsToScore = siblingPools?.filter((p) => scorableStatuses.includes(p.status)) || [];
    slog('info', scoringRunId, 'pools_resolved', { scorable_count: poolsToScore.length });

    // ---- Per-pool isolated scoring loop
    const succeeded: PoolSuccess[] = [];
    const failures: PoolFailure[] = [];
    let poolsSkipped = 0;
    let totalEntriesScored = 0;

    for (const pool of poolsToScore) {
      try {
        const r = await scoreSinglePool(supabaseAdmin, pool.id, forceRescore, scoringRunId);
        if (r.ok) {
          succeeded.push(r.result);
          if (r.result.skipped) poolsSkipped++;
          else totalEntriesScored += r.result.entries_scored || 0;
        } else {
          failures.push(r.failure);
        }
      } catch (e: any) {
        // Defense-in-depth: nothing inside scoreSinglePool should throw, but
        // if it does, isolate it so subsequent pools still run.
        logSecureError(FUNCTION_NAME, e, {
          scoring_run_id: scoringRunId,
          pool_id: pool.id,
          error_class: 'scoring_unhandled',
        });
        failures.push({ pool_id: pool.id, reason: 'scoring_failed' });
      }
    }

    const poolsSuccessfullyScored = succeeded.filter((s) => !s.skipped).length;

    // ---- Audit log (also serves as idempotency record)
    try {
      await supabaseAdmin.from('compliance_audit_logs').insert({
        admin_id: user.id,
        event_type: 'batch_pool_scoring',
        severity: failures.length === 0 ? 'info' : 'warning',
        description: `Scored ${poolsSuccessfullyScored} pool(s), ${failures.length} failure(s) for template ${requestedPool.contest_template_id}`,
        metadata: {
          scoring_run_id: scoringRunId,
          requested_pool_id: contestPoolId,
          contest_template_id: requestedPool.contest_template_id,
          pools_scored: poolsSuccessfullyScored,
          pools_skipped: poolsSkipped,
          pools_failed: failures.length,
          total_entries_scored: totalEntriesScored,
          force_rescore: forceRescore,
          failures,
        },
      });
    } catch (e: any) {
      logSecureError(FUNCTION_NAME, e, { scoring_run_id: scoringRunId, error_class: 'audit_log_failed' });
    }

    const status = failures.length === 0 ? 200 : 207;
    slog('info', scoringRunId, 'scoring_run_complete', {
      pools_scored: poolsSuccessfullyScored,
      pools_failed: failures.length,
      pools_skipped: poolsSkipped,
      http_status: status,
    });

    return new Response(
      JSON.stringify({
        scoring_run_id: scoringRunId,
        success: failures.length === 0,
        pools_scored: poolsSuccessfullyScored,
        pools_failed: failures.length,
        pools_skipped: poolsSkipped,
        total_entries_scored: totalEntriesScored,
        failures, // already sanitized: { pool_id, reason }
      }),
      { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (error: any) {
    const requestId = logSecureError(FUNCTION_NAME, error, {
      scoring_run_id: scoringRunId,
      error_class: 'unhandled',
    });
    return new Response(
      JSON.stringify({ error: 'An internal error occurred during scoring', requestId, scoring_run_id: scoringRunId }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
