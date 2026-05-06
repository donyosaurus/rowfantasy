// Race Results Import (Hardened — Wave 2 #4)
// - Atomic via import_race_results_atomic SQL function (full rollback)
// - Idempotency key (UUID) with 24h dedup via UNIQUE(race_results_imports.idempotency_key)
// - Optional external CSV/JSON URL fetch wrapped in AbortController(30s)
// - Scoring decoupled to scoring_jobs queue (consumed by separate worker)
// - Structured logging with import_run_id + step
// - Sanitized admin-facing responses (no raw exception messages)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.76.1';
import { z } from 'https://deno.land/x/zod@v3.22.4/mod.ts';
import { crypto } from 'https://deno.land/std@0.177.0/crypto/mod.ts';
import { getCorsHeaders } from '../shared/cors.ts';
import { requireAdmin } from '../shared/auth-helpers.ts';
import { logSecureError, ERROR_MESSAGES } from '../shared/error-handler.ts';

const FUNCTION_NAME = 'race-results-import';
const FETCH_TIMEOUT_MS = 30_000;

const ResultRowSchema = z.object({
  crewId: z.string(),
  crewName: z.string(),
  divisionId: z.string(),
  divisionName: z.string(),
  finishPosition: z.number().int().min(1),
  finishTime: z.string().optional(),
  marginSeconds: z.number().optional(),
});

const BodySchema = z.object({
  contestTemplateId: z.string().uuid(),
  regattaName: z.string().min(1).max(255),
  results: z.array(ResultRowSchema).optional(),
  // Optional external source — if results not supplied, fetch from URL.
  resultsUrl: z.string().url().optional(),
  // Required idempotency key (server fills if absent).
  idempotencyKey: z.string().uuid().optional(),
}).refine(
  (b) => Array.isArray(b.results) || typeof b.resultsUrl === 'string',
  { message: 'either results or resultsUrl is required' },
);

function slog(
  level: 'info' | 'warn' | 'error',
  importRunId: string,
  step: string,
  msg: string,
  extra: Record<string, unknown> = {},
) {
  const line = JSON.stringify({
    function: FUNCTION_NAME,
    import_run_id: importRunId,
    step,
    level,
    msg,
    ...extra,
  });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

async function fetchResultsWithTimeout(url: string, importRunId: string): Promise<unknown> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ac.signal });
    if (!res.ok) {
      throw Object.assign(new Error(`fetch_${res.status}`), { httpStatus: res.status });
    }
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) return await res.json();
    // Caller is responsible for parsing CSV; we just return text.
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  const importRunId = crypto.randomUUID();

  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
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

    // ---- Auth + admin
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: ERROR_MESSAGES.UNAUTHORIZED }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authError } = await userClient.auth.getUser();
    if (authError || !user) {
      return new Response(JSON.stringify({ error: ERROR_MESSAGES.UNAUTHORIZED }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    try {
      await requireAdmin(userClient, user.id);
    } catch {
      return new Response(JSON.stringify({ error: ERROR_MESSAGES.FORBIDDEN }), {
        status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ---- Parse body
    let bodyJson: unknown;
    try { bodyJson = await req.json(); } catch (e) {
      logSecureError(FUNCTION_NAME, e, { import_run_id: importRunId, step: 'parse_body', error_class: 'invalid_json' });
      return new Response(JSON.stringify({ error: 'invalid request body' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const parsed = BodySchema.safeParse(bodyJson);
    if (!parsed.success) {
      logSecureError(FUNCTION_NAME, parsed.error, {
        import_run_id: importRunId, step: 'validate_body',
        error_class: 'zod_validation_failed', zod: parsed.error.flatten(),
      });
      return new Response(JSON.stringify({ error: 'invalid request body' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const body = parsed.data;
    const idempotencyKey = body.idempotencyKey ?? crypto.randomUUID();

    slog('info', importRunId, 'start', 'import_start', {
      admin_id: user.id,
      contest_template_id: body.contestTemplateId,
      idempotency_key: idempotencyKey,
      has_inline_results: Array.isArray(body.results),
      has_results_url: !!body.resultsUrl,
    });

    // ---- Fetch external results if needed (with timeout)
    let results = body.results;
    if (!results && body.resultsUrl) {
      try {
        const fetched = await fetchResultsWithTimeout(body.resultsUrl, importRunId);
        // Expect an array; if vendor returns wrapped object, look for .results.
        const candidate: any = Array.isArray(fetched) ? fetched : (fetched as any)?.results;
        const fetchedParsed = z.array(ResultRowSchema).safeParse(candidate);
        if (!fetchedParsed.success) {
          logSecureError(FUNCTION_NAME, fetchedParsed.error, {
            import_run_id: importRunId, step: 'parse_external_results',
            error_class: 'external_format_invalid',
            zod: fetchedParsed.error.flatten(),
          });
          return new Response(JSON.stringify({ error: 'External results format invalid', importRunId }), {
            status: 422, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        results = fetchedParsed.data;
      } catch (e: any) {
        const isAbort = e?.name === 'AbortError';
        const requestId = logSecureError(FUNCTION_NAME, e, {
          import_run_id: importRunId, step: 'fetch_external_results',
          error_class: isAbort ? 'fetch_timeout' : 'fetch_failed',
        });
        return new Response(JSON.stringify({
          error: isAbort ? 'External results fetch timed out' : 'External results fetch failed',
          requestId, importRunId,
        }), {
          status: isAbort ? 504 : 502,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }

    if (!results || results.length === 0) {
      return new Response(JSON.stringify({ error: 'No results to import', importRunId }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ---- Compute file hash (kept for back-compat / observability)
    const enc = new TextEncoder().encode(JSON.stringify(results));
    const hashBuf = await crypto.subtle.digest('SHA-256', enc);
    const fileHash = Array.from(new Uint8Array(hashBuf))
      .map((b) => b.toString(16).padStart(2, '0')).join('');

    // ---- Crew/division ID validation against template (cheap pre-check)
    const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_KEY);
    const { data: template, error: templateError } = await supabaseAdmin
      .from('contest_templates')
      .select('id, crews, divisions')
      .eq('id', body.contestTemplateId)
      .single();

    if (templateError || !template) {
      slog('warn', importRunId, 'load_template', 'template_not_found', {
        contest_template_id: body.contestTemplateId,
      });
      return new Response(JSON.stringify({ error: 'Contest template not found', importRunId }), {
        status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const validCrews = new Set((template.crews as any[]).map((c: any) => c.id));
    const validDivisions = new Set((template.divisions as any[]).map((d: any) => d.id));
    const validationErrors: string[] = [];
    let invalidCrewCount = 0, invalidDivisionCount = 0;
    for (const r of results) {
      if (!validCrews.has(r.crewId)) {
        invalidCrewCount++;
        if (validationErrors.length < 20) validationErrors.push(`Invalid crew ID: ${r.crewId}`);
      }
      if (!validDivisions.has(r.divisionId)) {
        invalidDivisionCount++;
        if (validationErrors.length < 20) validationErrors.push(`Invalid division ID: ${r.divisionId}`);
      }
    }
    if (validationErrors.length > 0) {
      slog('warn', importRunId, 'validate_ids', 'validation_failed', {
        invalid_crew_count: invalidCrewCount,
        invalid_division_count: invalidDivisionCount,
      });
      return new Response(JSON.stringify({
        error: 'Validation failed',
        validationErrors,
        invalidCrewCount,
        invalidDivisionCount,
        importRunId,
      }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // ---- Atomic RPC
    const importPayload = {
      contestTemplateId: body.contestTemplateId,
      regattaName: body.regattaName,
      results,
      fileHash,
    };

    const { data: rpcData, error: rpcError } = await supabaseAdmin.rpc(
      'import_race_results_atomic',
      {
        _admin_user_id: user.id,
        _import_payload: importPayload,
        _idempotency_key: idempotencyKey,
      },
    );

    if (rpcError) {
      const message = String(rpcError.message || '');
      // Map known SQL EXCEPTION strings to client-safe codes.
      if (message.includes('admin_not_found')) {
        return new Response(JSON.stringify({ error: ERROR_MESSAGES.FORBIDDEN, importRunId }), {
          status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      if (message.includes('template_not_found')) {
        return new Response(JSON.stringify({ error: 'Contest template not found', importRunId }), {
          status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      if (message.includes('idempotency_key_required') || message.includes('invalid_payload')) {
        return new Response(JSON.stringify({ error: 'invalid request body', importRunId }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      const requestId = logSecureError(FUNCTION_NAME, rpcError, {
        import_run_id: importRunId, step: 'atomic_rpc', error_class: 'rpc_failed',
      });
      return new Response(JSON.stringify({
        error: ERROR_MESSAGES.INTERNAL_ERROR, requestId, importRunId,
      }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const result = (rpcData ?? {}) as {
      success?: boolean;
      replayed?: boolean;
      import_id?: string;
      import_run_id?: string;
      rows_processed?: number;
      pools_queued?: number;
      prior_status?: string;
    };

    slog('info', importRunId, 'complete', 'import_complete', {
      replayed: !!result.replayed,
      import_id: result.import_id,
      pools_queued: result.pools_queued ?? 0,
      rows_processed: result.rows_processed ?? results.length,
    });

    return new Response(JSON.stringify({
      success: true,
      replayed: !!result.replayed,
      importId: result.import_id,
      importRunId,
      rowsProcessed: result.rows_processed ?? results.length,
      poolsQueued: result.pools_queued ?? 0,
      idempotencyKey,
      message: result.replayed
        ? 'Idempotency key matched a previous import — no duplicate work performed.'
        : 'Import committed; scoring queued for asynchronous processing.',
    }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  } catch (error: any) {
    const requestId = logSecureError(FUNCTION_NAME, error, {
      import_run_id: importRunId, step: 'unhandled', error_class: 'unhandled',
    });
    return new Response(JSON.stringify({
      error: ERROR_MESSAGES.INTERNAL_ERROR, requestId, importRunId,
    }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});
