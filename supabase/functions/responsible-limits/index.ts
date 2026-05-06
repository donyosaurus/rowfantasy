// Responsible Gaming Limits - Allow users to set deposit limits and self-exclusion
// Depends on Wave 1 #5: DB-trigger audit path on responsible_gaming captures
// row-level state changes. This JS-level audit is defense-in-depth and logs
// the *request* (with idempotency_key) rather than the row diff.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.76.1";
import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import { getCorsHeaders } from '../shared/cors.ts';
import { logSecureError, ERROR_MESSAGES } from '../shared/error-handler.ts';

const limitSchema = z.object({
  depositLimit: z.number().int().positive().optional(),
  exclusionDays: z.number().int().positive().optional(),
  idempotency_key: z.string().uuid().optional(),
});

const RPC_TIMEOUT_MS = 10_000;

function withTimeout<T>(p: PromiseLike<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout:${label}`)), ms);
    Promise.resolve(p).then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
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
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    const supabase = createClient(
      supabaseUrl,
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: req.headers.get('Authorization')! } } }
    );

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: 'Unauthorized' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    let body: z.infer<typeof limitSchema>;
    try {
      body = limitSchema.parse(await req.json());
    } catch (_error) {
      return new Response(
        JSON.stringify({ error: 'Invalid input' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const { depositLimit, exclusionDays } = body;
    const idempotencyKey = body.idempotency_key ?? crypto.randomUUID();

    const upsertData: {
      user_id: string;
      deposit_limit_monthly_cents?: number;
      self_exclusion_until?: string;
      updated_at: string;
    } = {
      user_id: user.id,
      updated_at: new Date().toISOString(),
    };

    let eventType = '';
    let description = '';

    if (depositLimit !== undefined) {
      upsertData.deposit_limit_monthly_cents = depositLimit;
      eventType = 'deposit_limit_set';
      description = `Deposit limit set to $${(depositLimit / 100).toFixed(2)}/month`;
    }

    if (exclusionDays !== undefined) {
      const exclusionUntil = new Date();
      exclusionUntil.setDate(exclusionUntil.getDate() + exclusionDays);
      upsertData.self_exclusion_until = exclusionUntil.toISOString();
      eventType = 'self_exclusion_enabled';
      description = `Self-exclusion enabled for ${exclusionDays} days until ${exclusionUntil.toLocaleDateString()}`;
    }

    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    // Upsert with timeout. The DB trigger (Wave 1 #5) captures the row change
    // for the immutable compliance trail.
    let upsertResult;
    try {
      upsertResult = await withTimeout(
        adminClient
          .from('responsible_gaming')
          .upsert(upsertData, { onConflict: 'user_id' }),
        RPC_TIMEOUT_MS,
        'upsert',
      );
    } catch (err: any) {
      if (String(err?.message ?? '').startsWith('timeout:')) {
        logSecureError('responsible-limits', err, { step: 'upsert', user_id: user.id, idempotency_key: idempotencyKey });
        return new Response(
          JSON.stringify({ error: 'Request timed out, please retry' }),
          { status: 504, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      throw err;
    }

    if (upsertResult.error) {
      logSecureError('responsible-limits', upsertResult.error, { step: 'upsert', user_id: user.id, idempotency_key: idempotencyKey });
      return new Response(
        JSON.stringify({ error: ERROR_MESSAGES.GENERIC ?? 'Failed to update limits' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Defense-in-depth audit log of the *request*. Failure must NOT roll back
    // the upsert — the DB trigger already captured the row state change.
    let auditWarning: string | undefined;
    if (eventType) {
      try {
        const auditResult = await withTimeout(
          adminClient.from('compliance_audit_logs').insert({
            user_id: user.id,
            event_type: eventType,
            description,
            severity: 'info',
            metadata: { ...body, idempotency_key: idempotencyKey, source: 'responsible-limits.request' },
          }),
          RPC_TIMEOUT_MS,
          'audit',
        );
        if (auditResult.error) throw auditResult.error;
      } catch (auditErr: any) {
        auditWarning = 'request_audit_log_failed';
        logSecureError('responsible-limits', auditErr, {
          step: 'audit_request',
          user_id: user.id,
          idempotency_key: idempotencyKey,
          event_type: eventType,
        });
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        idempotency_key: idempotencyKey,
        depositLimit: depositLimit ? `$${(depositLimit / 100).toFixed(2)}/month` : null,
        selfExclusionUntil: upsertData.self_exclusion_until || null,
        ...(auditWarning ? { warning: auditWarning } : {}),
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    const requestId = logSecureError('responsible-limits', error, { step: 'unhandled' });
    return new Response(
      JSON.stringify({ error: 'Internal server error', request_id: requestId }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
