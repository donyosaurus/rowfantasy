// Wallet Deposit Init - Create deposit session with rate limiting

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.76.1';
import { z } from 'https://deno.land/x/zod@v3.22.4/mod.ts';
import { authenticateUser, checkRateLimit } from '../shared/auth-helpers.ts';
import { mapErrorToClient, logSecureError } from '../shared/error-handler.ts';
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

  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
    const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

    // SECURITY: Authenticate user
    const auth = await authenticateUser(req, SUPABASE_URL, ANON_KEY);
    if (!auth) {
      return new Response(
        JSON.stringify({ error: mapErrorToClient({ message: 'not authenticated' }) }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const userId = auth.user.id;

    // SECURITY: Rate limit (10 requests per hour per user)
    const rateLimitOk = await checkRateLimit(auth.supabase, userId, 'wallet-deposit-init', 10, 60);
    if (!rateLimitOk) {
      return new Response(
        JSON.stringify({ error: mapErrorToClient({ message: 'rate limit' }) }),
        { status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Validate input
    const depositSchema = z.object({
      amount_cents: z.number().int().min(500).max(500000), // $5 to $5000
    });

    const body = depositSchema.parse(await req.json());

    // Check for invalid amount
    if (!body.amount_cents || body.amount_cents <= 0) {
      return new Response(
        JSON.stringify({ error: 'Invalid amount' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Check profile for self-exclusion
    const { data: profile } = await auth.supabase
      .from('profiles')
      .select('self_exclusion_until, is_active, state')
      .eq('id', userId)
      .single();

    if (!profile?.is_active) {
      return new Response(
        JSON.stringify({ error: 'Account is inactive' }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (profile.self_exclusion_until && new Date(profile.self_exclusion_until) > new Date()) {
      return new Response(
        JSON.stringify({ error: mapErrorToClient({ message: 'self excluded' }) }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Create mock payment session
    const { data: session, error: sessionError } = await auth.supabase
      .from('payment_sessions')
      .insert({
        user_id: userId,
        amount_cents: body.amount_cents,
        provider: 'mock',
        status: 'pending',
        state_code: profile.state,
        checkout_url: 'https://mock-checkout.example.com',
        client_token: 'mock_token_' + crypto.randomUUID(),
      })
      .select()
      .single();

    if (sessionError) {
      throw sessionError;
    }

    // Log compliance event
    await auth.supabase
      .from('compliance_audit_logs')
      .insert({
        user_id: userId,
        event_type: 'deposit_initiated',
        description: 'User initiated deposit',
        severity: 'info',
        state_code: profile.state,
        metadata: { amount_cents: body.amount_cents, session_id: session.id },
      });

    return new Response(
      JSON.stringify({
        sessionId: session.id,
        checkoutUrl: session.checkout_url,
        clientToken: session.client_token,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error: any) {
    const requestId = logSecureError('wallet-deposit-init', error);
    const clientMessage = mapErrorToClient(error);
    
    return new Response(
      JSON.stringify({ error: clientMessage, requestId }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
