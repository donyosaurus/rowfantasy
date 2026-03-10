// Payment Webhook Handler - Process provider callbacks securely

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.76.1';
import { getPaymentProvider } from '../shared/payment-providers/factory.ts';
import { isTimestampValid } from '../shared/crypto-utils.ts';
import { getCorsHeaders } from '../shared/cors.ts';

// SECURITY: Rate limiting per IP
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const limit = rateLimitMap.get(ip);
  
  if (!limit || now > limit.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + 60000 }); // 1 minute window
    return true;
  }
  
  if (limit.count >= 100) { // Max 100 requests per minute per IP
    return false;
  }
  
  limit.count++;
  return true;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const clientIp = req.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'unknown';

  // SECURITY: Rate limit check
  if (!checkRateLimit(clientIp)) {
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
      
      const { data: session } = await supabase
        .from('payment_sessions')
        .select('*')
        .eq('provider_session_id', sessionId)
        .single();
        
      if (session) {
        // Update session status
        await supabase
          .from('payment_sessions')
          .update({ 
            status: 'succeeded', 
            completed_at: new Date().toISOString() 
          })
          .eq('id', session.id);
        
        // Get wallet
        const { data: wallet } = await supabase
          .from('wallets')
          .select('*')
          .eq('user_id', session.user_id)
          .single();
          
        if (wallet) {
          // Create deposit transaction
          await supabase.from('transactions').insert({ 
            user_id: session.user_id, 
            wallet_id: wallet.id, 
            type: 'deposit', 
            amount: session.amount_cents / 100, 
            status: 'completed', 
            reference_id: sessionId,
            reference_type: 'payment_session',
            description: 'Deposit via payment processor',
            completed_at: new Date().toISOString(),
            metadata: { provider: providerType, webhook_id: webhookId }
          });
          
          // Update wallet balance atomically
          await supabase.rpc('update_wallet_balance', { 
            _wallet_id: wallet.id, 
            _available_delta: session.amount_cents / 100, 
            _pending_delta: 0,
            _lifetime_deposits_delta: session.amount_cents / 100 
          });

          // Log to compliance
          await supabase.from('compliance_audit_logs').insert({
            user_id: session.user_id,
            event_type: 'deposit_completed',
            description: 'Deposit processed via webhook',
            severity: 'info',
            state_code: session.state_code,
            metadata: {
              amount_cents: session.amount_cents,
              provider: providerType,
              session_id: session.id,
            },
          });
          
          console.log('[webhook] Deposit processed:', session.amount_cents / 100, 'for user', session.user_id);
        }
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
