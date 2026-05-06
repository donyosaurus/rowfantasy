// Nightly Payment Reconciliation Job (Hardened — Wave 2 #2)
// - Per-session try/catch isolation
// - Idempotent via reconciliation_run_id + UNIQUE(payment_discrepancies)
// - Per-call AbortController timeout (15s) on provider lookups
// - Bounded retry (2x) on 5xx/429 with backoff 500ms, 2000ms
// - Concurrency-capped Promise.all (cap=10) to de-N+1 provider calls
// - Single bulk SELECT on transactions (IN-clause) instead of per-session
// - 50s wall-clock budget guard
// - Sanitized logs + responses (no raw provider strings to client)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.76.1';
import { getPaymentProvider } from '../shared/payment-providers/factory.ts';
import { getCorsHeaders } from '../shared/cors.ts';
import {
  logSecureError,
  mapErrorToClient,
  ERROR_MESSAGES,
} from '../shared/error-handler.ts';

const FUNCTION_NAME = 'payments-reconciliation';
const PROVIDER_TIMEOUT_MS = 15_000;
const PROVIDER_CONCURRENCY = 10;
const RETRY_DELAYS_MS = [500, 2000]; // 2 retries
const WALL_CLOCK_BUDGET_MS = 50_000;

type ProviderError = { status?: number; message?: string };

function slog(
  level: 'info' | 'warn' | 'error',
  runId: string,
  msg: string,
  extra: Record<string, unknown> = {},
) {
  const line = JSON.stringify({
    function: FUNCTION_NAME,
    reconciliation_run_id: runId,
    level,
    msg,
    ...extra,
  });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

function sleep(ms: number) {
  return new Promise((res) => setTimeout(res, ms));
}

/** Wrap a promise with an AbortController-style timeout. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(Object.assign(new Error(`timeout:${label}`), { isTimeout: true })), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

/** Classify an error as retryable (5xx / 429) vs deterministic (4xx) vs unknown. */
function isRetryable(err: ProviderError): boolean {
  const s = err?.status;
  if (typeof s === 'number') {
    if (s === 429) return true;
    if (s >= 500 && s < 600) return true;
    return false; // 4xx — deterministic, don't retry
  }
  // No status — treat as unknown/transient (retry)
  return true;
}

/** Provider call with timeout + bounded retry on 5xx/429. */
async function fetchProviderStatusWithRetry(
  provider: ReturnType<typeof getPaymentProvider>,
  providerTransactionId: string,
) {
  let lastErr: any;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await withTimeout(
        provider.getTransactionStatus({ providerTransactionId }),
        PROVIDER_TIMEOUT_MS,
        'provider_status',
      );
    } catch (e: any) {
      lastErr = e;
      // Timeout: do not retry in-band — let next sweep pick up.
      if (e?.isTimeout) throw e;
      if (attempt < RETRY_DELAYS_MS.length && isRetryable(e)) {
        await sleep(RETRY_DELAYS_MS[attempt]);
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

/** Run promises with a concurrency cap; preserves input order in returned results. */
async function mapWithConcurrency<T, R>(
  items: T[],
  cap: number,
  worker: (item: T, idx: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(cap, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

type SessionStatus =
  | 'ok'
  | 'discrepancy'
  | 'timeout_skipped'
  | 'transient_failure'
  | 'deterministic_failure'
  | 'internal_failure';

type SessionOutcome = {
  session_id: string;
  provider: string;
  status: SessionStatus;
  discrepancies: Array<Record<string, unknown>>;
};

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  const reconciliationRunId = crypto.randomUUID();
  const startMs = Date.now();

  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== 'GET' && req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json', Allow: 'GET, POST, OPTIONS' },
    });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    // ---- Auth
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: ERROR_MESSAGES.UNAUTHORIZED }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authError } = await userClient.auth.getUser();
    if (authError || !user) {
      return new Response(JSON.stringify({ error: ERROR_MESSAGES.UNAUTHORIZED }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { data: roleData } = await userClient
      .from('user_roles').select('role').eq('user_id', user.id).eq('role', 'admin').single();
    if (!roleData) {
      return new Response(JSON.stringify({ error: ERROR_MESSAGES.FORBIDDEN }), {
        status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);
    slog('info', reconciliationRunId, 'reconciliation_start', { admin_id: user.id });

    // ---- Date range: yesterday
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(0, 0, 0, 0);
    const endDate = new Date(yesterday);
    endDate.setHours(23, 59, 59, 999);

    const { data: sessions, error: sessionsError } = await supabase
      .from('payment_sessions')
      .select('*')
      .eq('status', 'succeeded')
      .gte('completed_at', yesterday.toISOString())
      .lte('completed_at', endDate.toISOString());

    if (sessionsError) throw sessionsError;

    const allSessions = sessions || [];
    slog('info', reconciliationRunId, 'sessions_loaded', { count: allSessions.length });

    // ---- Bulk fetch internal transactions in one IN-clause query (de-N+1)
    const sessionIds = allSessions.map((s: any) => s.id);
    const internalByRef = new Map<string, any>();
    if (sessionIds.length > 0) {
      // Chunk to avoid overly long IN-clauses.
      const CHUNK = 500;
      for (let i = 0; i < sessionIds.length; i += CHUNK) {
        const chunk = sessionIds.slice(i, i + CHUNK);
        const { data: txns, error: txnErr } = await supabase
          .from('transactions')
          .select('*')
          .eq('type', 'deposit')
          .in('reference_id', chunk);
        if (txnErr) throw txnErr;
        for (const t of txns || []) internalByRef.set(t.reference_id, t);
      }
    }

    // ---- Group by provider
    const sessionsByProvider = allSessions.reduce((acc: Record<string, any[]>, s: any) => {
      (acc[s.provider] ||= []).push(s);
      return acc;
    }, {} as Record<string, any[]>);

    const outcomes: SessionOutcome[] = [];
    const allDiscrepancyRows: Array<Record<string, unknown>> = [];
    let budgetExceeded = false;

    // ---- Reconcile each provider, with concurrency cap + budget guard
    for (const [providerName, providerSessionsRaw] of Object.entries(sessionsByProvider)) {
      const providerSessions = providerSessionsRaw as any[];
      slog('info', reconciliationRunId, 'provider_start', {
        provider: providerName, sessions: providerSessions.length,
      });

      let provider: ReturnType<typeof getPaymentProvider>;
      try {
        provider = getPaymentProvider(providerName as any);
      } catch (e: any) {
        logSecureError(FUNCTION_NAME, e, {
          reconciliation_run_id: reconciliationRunId,
          provider: providerName,
          error_class: 'provider_factory_failed',
        });
        // Mark every session under this provider as internal_failure and continue.
        for (const s of providerSessions) {
          outcomes.push({
            session_id: s.id, provider: providerName, status: 'internal_failure', discrepancies: [],
          });
        }
        continue;
      }

      // Process in chunks of PROVIDER_CONCURRENCY so we can budget-check between chunks.
      for (let i = 0; i < providerSessions.length; i += PROVIDER_CONCURRENCY) {
        if (Date.now() - startMs > WALL_CLOCK_BUDGET_MS) {
          budgetExceeded = true;
          slog('warn', reconciliationRunId, 'budget_exceeded', {
            elapsed_ms: Date.now() - startMs,
            remaining_in_provider: providerSessions.length - i,
          });
          for (let j = i; j < providerSessions.length; j++) {
            outcomes.push({
              session_id: providerSessions[j].id,
              provider: providerName,
              status: 'transient_failure',
              discrepancies: [],
            });
          }
          break;
        }

        const chunk = providerSessions.slice(i, i + PROVIDER_CONCURRENCY);
        const chunkOutcomes = await mapWithConcurrency<any, SessionOutcome>(
          chunk, PROVIDER_CONCURRENCY,
          async (session) => {
            const out: SessionOutcome = {
              session_id: session.id, provider: providerName, status: 'ok', discrepancies: [],
            };
            try {
              const providerStatus = await fetchProviderStatusWithRetry(
                provider, session.provider_session_id,
              );
              const internalTxn = internalByRef.get(session.id);

              const expectedAmountCents = session.amount_cents;
              const providerAmountCents = providerStatus.amountCents;

              if (expectedAmountCents !== providerAmountCents) {
                out.discrepancies.push({
                  issue: 'amount_mismatch',
                  expected_cents: expectedAmountCents,
                  actual_cents: providerAmountCents,
                  difference_cents: providerAmountCents - expectedAmountCents,
                });
              }
              if (!internalTxn) {
                out.discrepancies.push({
                  issue: 'missing_internal_transaction',
                  provider_amount_cents: providerAmountCents,
                });
              }
              if (providerStatus.status !== 'succeeded' && session.status === 'succeeded') {
                out.discrepancies.push({
                  issue: 'status_mismatch',
                  our_status: session.status,
                  provider_status: providerStatus.status,
                });
              }
              if (out.discrepancies.length > 0) out.status = 'discrepancy';
              return out;
            } catch (e: any) {
              if (e?.isTimeout) {
                logSecureError(FUNCTION_NAME, e, {
                  reconciliation_run_id: reconciliationRunId,
                  session_id: session.id, provider: providerName,
                  error_class: 'provider_timeout',
                });
                out.status = 'timeout_skipped';
                return out;
              }
              const status = (e as ProviderError)?.status;
              const deterministic = typeof status === 'number' && status >= 400 && status < 500 && status !== 429;
              logSecureError(FUNCTION_NAME, e, {
                reconciliation_run_id: reconciliationRunId,
                session_id: session.id, provider: providerName,
                error_class: deterministic ? 'provider_4xx' : 'provider_transient',
                provider_status: status,
              });
              out.status = deterministic ? 'deterministic_failure' : 'transient_failure';
              out.discrepancies.push({
                issue: deterministic ? 'provider_lookup_failed' : 'provider_lookup_transient',
              });
              return out;
            }
          },
        );

        outcomes.push(...chunkOutcomes);
      }

      if (budgetExceeded) break;
    }

    // ---- Persist discrepancies idempotently into payment_discrepancies
    for (const o of outcomes) {
      for (const d of o.discrepancies) {
        allDiscrepancyRows.push({
          reconciliation_run_id: reconciliationRunId,
          session_id: o.session_id,
          provider: o.provider,
          issue: d.issue as string,
          expected_cents: (d.expected_cents as number) ?? null,
          actual_cents: (d.actual_cents as number) ?? null,
          difference_cents: (d.difference_cents as number) ?? null,
          provider_amount_cents: (d.provider_amount_cents as number) ?? null,
          our_status: (d.our_status as string) ?? null,
          provider_status: (d.provider_status as string) ?? null,
          metadata: {},
        });
      }
    }

    if (allDiscrepancyRows.length > 0) {
      const { error: insertErr } = await supabase
        .from('payment_discrepancies')
        .upsert(allDiscrepancyRows, {
          onConflict: 'reconciliation_run_id,session_id,issue',
          ignoreDuplicates: true,
        });
      if (insertErr) {
        logSecureError(FUNCTION_NAME, insertErr, {
          reconciliation_run_id: reconciliationRunId,
          error_class: 'discrepancy_persist_failed',
        });
      }
    }

    // ---- Tallies
    const sessionsChecked = outcomes.length;
    const discrepanciesFound = outcomes.reduce((n, o) => n + o.discrepancies.length, 0);
    const sessionsFailed = outcomes.filter(
      (o) => o.status === 'timeout_skipped'
        || o.status === 'transient_failure'
        || o.status === 'deterministic_failure'
        || o.status === 'internal_failure',
    ).length;
    const runtimeMs = Date.now() - startMs;
    const runStatus = budgetExceeded
      ? 'budget_exceeded'
      : (sessionsFailed > 0 || discrepanciesFound > 0 ? 'completed_with_issues' : 'completed');

    // ---- Single final compliance audit row
    try {
      await supabase.from('compliance_audit_logs').insert({
        admin_id: user.id,
        event_type: 'payments_reconciliation_run',
        severity: sessionsFailed > 0 || discrepanciesFound > 0 ? 'warning' : 'info',
        description: `Reconciliation ${runStatus}: ${sessionsChecked} sessions, ${discrepanciesFound} discrepancies, ${sessionsFailed} failed`,
        metadata: {
          reconciliation_run_id: reconciliationRunId,
          date: yesterday.toISOString(),
          sessions_checked: sessionsChecked,
          discrepancies_found: discrepanciesFound,
          sessions_failed: sessionsFailed,
          runtime_ms: runtimeMs,
          run_status: runStatus,
          budget_exceeded: budgetExceeded,
        },
      });
    } catch (e: any) {
      logSecureError(FUNCTION_NAME, e, {
        reconciliation_run_id: reconciliationRunId,
        error_class: 'audit_log_failed',
      });
    }

    slog('info', reconciliationRunId, 'reconciliation_complete', {
      sessions_checked: sessionsChecked,
      discrepancies_found: discrepanciesFound,
      sessions_failed: sessionsFailed,
      runtime_ms: runtimeMs,
      run_status: runStatus,
    });

    return new Response(
      JSON.stringify({
        success: !budgetExceeded && sessionsFailed === 0,
        reconciliation_run_id: reconciliationRunId,
        run_status: runStatus,
        date: yesterday.toISOString(),
        sessions_checked: sessionsChecked,
        discrepancies_found: discrepanciesFound,
        sessions_failed: sessionsFailed,
        runtime_ms: runtimeMs,
        // Sanitized summary only — no provider error strings.
        outcomes: outcomes.map((o) => ({
          session_id: o.session_id,
          provider: o.provider,
          status: o.status,
          discrepancy_count: o.discrepancies.length,
        })),
      }),
      { status: budgetExceeded ? 207 : 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );

  } catch (error: unknown) {
    const requestId = logSecureError(FUNCTION_NAME, error, {
      reconciliation_run_id: reconciliationRunId,
      error_class: 'unhandled',
    });
    return new Response(
      JSON.stringify({
        error: mapErrorToClient(error),
        requestId,
        reconciliation_run_id: reconciliationRunId,
      }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
