// Verify an email-OTP and mint a single-use step-up token (5 min TTL).
// The client attaches the returned token as `x-step-up-token` on the next sensitive call.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.76.1';
import { z } from 'https://deno.land/x/zod@v3.22.4/mod.ts';
import { getCorsHeaders } from '../shared/cors.ts';
import { authenticateUser, checkRateLimit } from '../shared/auth-helpers.ts';
import { sha256Hex } from '../shared/step-up.ts';
import { timingSafeEqual } from '../shared/crypto-utils.ts';

const bodySchema = z.object({
  purpose: z.enum(['withdraw', 'responsible_limits', 'password_change']),
  code: z.string().regex(/^\d{6}$/, 'Code must be 6 digits'),
});

const MAX_ATTEMPTS = 5;

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Allow': 'POST, OPTIONS' },
    });
  }

  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
    const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
    const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    const auth = await authenticateUser(req, SUPABASE_URL, ANON_KEY);
    if (!auth) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const userId = auth.user.id;

    const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return new Response(JSON.stringify({ error: 'Invalid input' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const { purpose, code } = parsed.data;

    const admin = createClient(SUPABASE_URL, SERVICE_KEY);

    // Rate limit verify attempts (20 per 15 min)
    const rateOk = await checkRateLimit(admin, userId, 'otp-verify', 20, 15);
    if (!rateOk) {
      return new Response(JSON.stringify({ error: 'Too many attempts. Please request a new code.' }), {
        status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Fetch newest unconsumed, unexpired code
    const { data: row, error: fetchError } = await admin
      .from('auth_otp_codes')
      .select('id, code_hash, attempts, expires_at')
      .eq('user_id', userId).eq('purpose', purpose)
      .is('consumed_at', null)
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (fetchError) {
      console.error('[otp-verify] fetch error', fetchError);
      return new Response(JSON.stringify({ error: 'Verification failed' }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    if (!row) {
      return new Response(JSON.stringify({ error: 'Code expired or not found. Request a new one.' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (row.attempts >= MAX_ATTEMPTS) {
      await admin.from('auth_otp_codes').update({ consumed_at: new Date().toISOString() }).eq('id', row.id);
      return new Response(JSON.stringify({ error: 'Too many attempts. Request a new code.' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const submittedHash = await sha256Hex(code);
    const match = await timingSafeEqual(submittedHash, row.code_hash);

    if (!match) {
      await admin.from('auth_otp_codes').update({ attempts: row.attempts + 1 }).eq('id', row.id);
      return new Response(JSON.stringify({ error: 'Invalid code' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Success — consume the code and mint a step-up token
    await admin.from('auth_otp_codes').update({ consumed_at: new Date().toISOString() }).eq('id', row.id);

    const rawBytes = new Uint8Array(32);
    crypto.getRandomValues(rawBytes);
    const rawToken = Array.from(rawBytes).map((b) => b.toString(16).padStart(2, '0')).join('');
    const tokenHash = await sha256Hex(rawToken);
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

    const { error: tokenError } = await admin.from('step_up_tokens').insert({
      user_id: userId, purpose, token_hash: tokenHash, expires_at: expiresAt,
    });
    if (tokenError) {
      console.error('[otp-verify] token insert error', tokenError);
      return new Response(JSON.stringify({ error: 'Failed to issue step-up token' }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({
      success: true,
      stepUpToken: rawToken,
      expiresAt,
    }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (err) {
    console.error('[otp-verify] error', err);
    return new Response(JSON.stringify({ error: 'Internal error' }), {
      status: 500, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
    });
  }
});
