// Payment Webhook Handler - Process provider callbacks securely

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.76.1';
import { getPaymentProvider } from '../shared/payment-providers/factory.ts';
import { isTimestampValid } from '../shared/crypto-utils.ts';
import { checkRateLimit } from '../shared/auth-helpers.ts';
import { getCorsHeaders } from '../shared/cors.ts';

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

  const clientIp = req.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'unknown';

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
    const KNOWN_PROVIDERS = ['mock', 'highrisk', 'ach'] as const;
    if (!(KNOWN_PROVIDERS as readonly string[]).includes(providerType)) {
      console.warn('[webhook] Unknown provider rejected:', providerType, 'from', clientIp);
      return new Response(JSON.stringify({ error: 'invalid' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // SECURITY: Reject mock provider in production unless explicitly allowed.
    // MockProviderAdapter.verifyWebhook always returns true, so it must never
    // be reachable in prod environments.
    if (providerType === 'mock' && Deno.env.get('ALLOW_MOCK_WEBHOOKS') !== 'true') {
      console.warn('[webhook] Mock provider rejected (ALLOW_MOCK_WEBHOOKS not set) from', clientIp);
      return new Response(JSON.stringify({ error: 'invalid' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }


    // SECURITY: Validate timestamp (max 5 minutes old)
    if (!isTimestampValid(timestamp, 300)) {
      console.warn('[webhook] Invalid timestamp from', clientIp);
      return new Response(JSON.stringify({ error: 'invalid' }), { 
        status: 401, 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      });
    }

    // SECURITY: Check for replay attack
    const { data: existing } = await supabase
      .from('webhook_dedup')
      .select('id')
      .eq('id', webhookId)
      .maybeSingle();
      
    if (existing) {
      console.warn('[webhook] Replay attack detected:', webhookId, 'from', clientIp);
      return new Response(JSON.stringify({ error: 'invalid' }), { 
        status: 409, 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      });
    }

    // Store webhook for deduplication
    await supabase.from('webhook_dedup').insert({ 
      id: webhookId, 
      provider: providerType, 
      event_type: 'pending', 
      ip_address: clientIp 
    });

    const rawPayload = await req.text();
    const provider = getPaymentProvider(providerType as any);
    
    // SECURITY: Verify signature with constant-time comparison
    const isValid = await provider.verifyWebhook({ 
      signature, 
      payload: rawPayload, 
      timestamp 
    });
    
    if (!isValid) {
      console.warn('[webhook] Invalid signature from', clientIp);
      return new Response(JSON.stringify({ error: 'invalid' }), { 
        status: 401, 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      });
    }

    const webhookEvent = await provider.handleWebhook(rawPayload);
    
    // Update event type
    await supabase
      .from('webhook_dedup')
      .update({ event_type: webhookEvent.eventType })
      .eq('id', webhookId);

    console.log('[webhook] Processing event:', webhookEvent.eventType);

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

      // Helper: insert a deposit_webhook_rejected compliance row. For critical
      // reasons, an insert failure must NOT be silently 200'd — re-throw to 500
      // so the provider retries.
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
        // Audit missing session so a real signed success for an unknown session
        // is not silently dropped. Still return 200 (idempotent no-op).
        await logRejection('session_not_found', { provider_session_id: sessionId });
      } else {
        // Edge-side amount validation — fail-closed before invoking the RPC.
        if (
          !Number.isSafeInteger(webhookEvent.amountCents) ||
          (webhookEvent.amountCents as number) <= 0
        ) {
          console.warn('[webhook] Invalid event amount rejected:', webhookEvent.amountCents);
          await logRejection('invalid_amount', { session_id: session.id });
          return new Response(
            JSON.stringify({ success: true }),
            { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
          );
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

        // Log non-trivial failure reasons. already_processed is benign idempotent replay.
        if (result && result.credited === false && result.reason !== 'already_processed') {
          await logRejection(result.reason, { session_id: session.id });
        }
        // Idempotent no-op for already_processed / session_not_found / wallet_not_found:

        // still return 200 so the provider does not retry.
      }
    } else if (webhookEvent.eventType === 'payment.failed') {
      const sessionId = webhookEvent.providerSessionId || webhookEvent.providerTransactionId;
      
      await supabase
        .from('payment_sessions')
        .update({ status: 'failed' })
        .eq('provider_session_id', sessionId);
    }

    return new Response(
      JSON.stringify({ success: true }), 
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
    
  } catch (error: any) {
    console.error('[webhook] Error:', error);
    // Always return generic error for security
    return new Response(
      JSON.stringify({ error: 'invalid' }), 
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
