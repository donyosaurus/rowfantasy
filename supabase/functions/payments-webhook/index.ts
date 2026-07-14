import { withFnVersion } from '../shared/fn-version.ts';
// Payment Webhook Handler - Process provider callbacks securely

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.76.1';
import { getPaymentProvider } from '../shared/payment-providers/factory.ts';
import { isTimestampValid } from '../shared/crypto-utils.ts';
import { checkRateLimit } from '../shared/auth-helpers.ts';
import { getCorsHeaders } from '../shared/cors.ts';

Deno.serve(withFnVersion('payments-webhook', async (req) => {
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

  // SECURITY (P0-C9): Only trust the platform-set cf-connecting-ip header.
  // x-forwarded-for's first hop is client-spoofable. See wallet-deposit:144.
  // Deliberate fail-open to 'unknown' bucket: failing closed would hard-drop
  // all provider webhooks if the header assumption ever broke, and an
  // attacker cannot reach the 'unknown' bucket through the platform edge.
  const clientIp = req.headers.get('cf-connecting-ip') || 'unknown';

  // SECURITY: Database-backed rate limit check
  const supabaseForRateLimit = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  );
  const rateLimitOk = await checkRateLimit(supabaseForRateLimit, clientIp, 'payments-webhook', 100, 1);
  if (!rateLimitOk) {
    console.warn('[webhook] Rate limit exceeded:', clientIp);
    return new Response(JSON.stringify({ error: 'invalid' }), { status: 429, headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    const signature = req.headers.get('webhook-signature') || req.headers.get('x-webhook-signature') || '';
    const timestamp = req.headers.get('webhook-timestamp') || req.headers.get('x-webhook-timestamp') || '';
    const webhookId = req.headers.get('webhook-id') || `${Date.now()}-${crypto.randomUUID()}`;
    const providerType = new URL(req.url).searchParams.get('provider') || 'mock';

    // SECURITY: Reject unknown providers (fail-closed). Never fall back to mock.
    const KNOWN_PROVIDERS = ['mock'] as const;
    if (!(KNOWN_PROVIDERS as readonly string[]).includes(providerType)) {
      console.warn('[webhook] Unknown provider rejected:', providerType, 'from', clientIp);
      return new Response(JSON.stringify({ error: 'invalid' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // SECURITY: Reject mock provider in production unless explicitly allowed.
    if (providerType === 'mock' && Deno.env.get('ALLOW_MOCK_WEBHOOKS') !== 'true') {
      console.warn('[webhook] Mock provider rejected (ALLOW_MOCK_WEBHOOKS not set) from', clientIp);
      return new Response(JSON.stringify({ error: 'invalid' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // SECURITY: Validate timestamp (max 5 minutes old) — MUST stay before signature check.
    if (!isTimestampValid(timestamp, 300)) {
      console.warn('[webhook] Invalid timestamp from', clientIp);
      return new Response(JSON.stringify({ error: 'invalid' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // SECURITY: Verify signature BEFORE any webhook_dedup read/write.
    // Failed deliveries must not leave dedup rows that would 409-block legitimate retries.
    const rawPayload = await req.text();
    const provider = getPaymentProvider(providerType as any);
    const isValid = await provider.verifyWebhook({
      signature,
      payload: rawPayload,
      timestamp,
    });

    if (!isValid) {
      console.warn('[webhook] Invalid signature from', clientIp);
      return new Response(JSON.stringify({ error: 'invalid' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Replay check AFTER signature verification.
    const { data: existing } = await supabase
      .from('webhook_dedup')
      .select('id')
      .eq('id', webhookId)
      .maybeSingle();

    if (existing) {
      console.warn('[webhook] Replay attack detected:', webhookId, 'from', clientIp);
      return new Response(JSON.stringify({ error: 'invalid' }), {
        status: 409,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const webhookEvent = await provider.handleWebhook(rawPayload);

    console.log('[webhook] Processing event:', webhookEvent.eventType);

    // Insert the dedup row only on 200 exit paths (immediately before returning).
    // webhook_dedup.ip_address is Postgres inet — 'unknown' is not a valid inet,
    // so pass NULL. Treat unique-violation (23505) as benign concurrent duplicate.
    // Any other insert error is logged but does NOT flip a credited deposit into
    // a retry loop — the RPC's session-status idempotency makes a missing dedup
    // row safe.
    const recordDedup = async (finalEventType: string) => {
      const { error: dedupErr } = await supabase.from('webhook_dedup').insert({
        id: webhookId,
        provider: providerType,
        event_type: finalEventType,
        ip_address: clientIp === 'unknown' ? null : clientIp,
      });
      if (dedupErr) {
        const code = (dedupErr as any).code;
        if (code === '23505') {
          console.warn('[webhook] Concurrent duplicate delivery for', webhookId);
        } else {
          console.error('[webhook] webhook_dedup insert failed (non-fatal):', {
            code,
            message: (dedupErr as any).message,
            webhook_id: webhookId,
          });
        }
      }
    };

    const ok200 = async (finalEventType: string) => {
      await recordDedup(finalEventType);
      return new Response(
        JSON.stringify({ success: true }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    };

    // Handle different event types
    if (webhookEvent.eventType === 'payment.succeeded') {
      const sessionId = webhookEvent.providerSessionId || webhookEvent.providerTransactionId;

      const { data: session, error: sessionLookupError } = await supabase
        .from('payment_sessions')
        .select('id')
        .eq('provider_session_id', sessionId)
        .maybeSingle();

      if (sessionLookupError) {
        console.error('[webhook] payment_sessions lookup error:', sessionLookupError);
        throw sessionLookupError;
      }

      const CRITICAL_REASONS = new Set([
        'provider_mismatch',
        'amount_mismatch',
        'wallet_not_found',
        'invalid_amount',
      ]);

      const logRejection = async (
        reason: string,
        extraMetadata: Record<string, unknown> = {},
      ) => {
        const severity = CRITICAL_REASONS.has(reason) ? 'critical' : 'warning';
        const { error: auditError } = await supabase.from('compliance_audit_logs').insert({
          event_type: 'deposit_webhook_rejected',
          severity,
          description: `Webhook deposit not credited: ${reason}`,
          metadata: {
            provider: providerType,
            webhook_id: webhookId,
            event_amount_cents: webhookEvent.amountCents,
            reason,
            ...extraMetadata,
          },
        });
        if (auditError) {
          console.error('[webhook] compliance_audit_logs insert failed:', {
            reason,
            severity,
            code: (auditError as any).code,
            message: (auditError as any).message,
          });
          if (CRITICAL_REASONS.has(reason)) {
            throw auditError;
          }
        }
      };

      if (!session) {
        // Unknown session — audit but treat as idempotent no-op (200).
        await logRejection('session_not_found', { provider_session_id: sessionId });
        return await ok200(webhookEvent.eventType);
      }

      // Edge-side amount validation — fail-closed before invoking the RPC.
      if (
        !Number.isSafeInteger(webhookEvent.amountCents) ||
        (webhookEvent.amountCents as number) <= 0
      ) {
        console.warn('[webhook] Invalid event amount rejected:', webhookEvent.amountCents);
        await logRejection('invalid_amount', { session_id: session.id });
        return await ok200(webhookEvent.eventType);
      }

      const { data: rpcData, error: rpcError } = await supabase.rpc(
        'process_webhook_deposit_atomic',
        {
          _session_id: session.id,
          _webhook_id: webhookId,
          _provider: providerType,
          _event_amount_cents: webhookEvent.amountCents,
        },
      );

      if (rpcError) {
        console.error('[webhook] process_webhook_deposit_atomic error:', rpcError);
        throw rpcError;
      }

      const result = Array.isArray(rpcData) ? rpcData[0] : rpcData;
      console.log('[webhook] deposit credit result:', result);

      if (result && result.credited === false && result.reason !== 'already_processed') {
        await logRejection(result.reason, { session_id: session.id });
      }

      return await ok200(webhookEvent.eventType);
    } else if (webhookEvent.eventType === 'payment.failed') {
      const sessionId = webhookEvent.providerSessionId || webhookEvent.providerTransactionId;

      // Only flip pending sessions. A 'failed' after a 'succeeded' must NOT
      // clobber the credited status.
      const { error: failUpdateErr } = await supabase
        .from('payment_sessions')
        .update({ status: 'failed', completed_at: new Date().toISOString() })
        .eq('provider_session_id', sessionId)
        .eq('status', 'pending');

      if (failUpdateErr) {
        console.error('[webhook] payment.failed update error:', failUpdateErr);
        // Non-200 so provider retries — do not write dedup row.
        return new Response(
          JSON.stringify({ error: 'invalid' }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      return await ok200(webhookEvent.eventType);
    }

    // Unhandled event type — record dedup so provider does not retry forever.
    return await ok200(webhookEvent.eventType);

  } catch (error: any) {
    console.error('[webhook] Error:', error);
    // Always return generic error for security
    return new Response(
      JSON.stringify({ error: 'invalid' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
}));
