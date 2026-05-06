// Profile Username — thin JS wrapper over change_username_atomic SQL function
// (Wave 2 #3: atomic check-and-write, explicit reason mapping, sanitized errors)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.76.1';
import { z } from 'https://deno.land/x/zod@v3.22.4/mod.ts';
import { getCorsHeaders } from '../shared/cors.ts';
import { authenticateUser, checkRateLimit } from '../shared/auth-helpers.ts';
import { logSecureError, ERROR_MESSAGES } from '../shared/error-handler.ts';
import { validateUsernameContent } from '../shared/username-filter.ts';

const FUNCTION_NAME = 'profile-username';

const BodySchema = z.object({
  new_username: z.string().min(1).max(64),
});

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
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

    // 1. Authenticate
    const auth = await authenticateUser(req, SUPABASE_URL, ANON_KEY);
    if (!auth) {
      return new Response(JSON.stringify({ error: ERROR_MESSAGES.UNAUTHORIZED }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const userId: string = auth.user.id;

    // 2. Rate limit: 5/hour per user
    const allowed = await checkRateLimit(auth.supabase, userId, 'profile-username', 5, 60);
    if (!allowed) {
      return new Response(JSON.stringify({ error: 'Too many username change attempts. Try again later.' }), {
        status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // 3. Zod parse
    let bodyJson: unknown;
    try { bodyJson = await req.json(); } catch (e) {
      logSecureError(FUNCTION_NAME, e, { user_id: userId, error_class: 'invalid_json' });
      return new Response(JSON.stringify({ error: 'invalid request body' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const parsed = BodySchema.safeParse(bodyJson);
    if (!parsed.success) {
      logSecureError(FUNCTION_NAME, parsed.error, {
        user_id: userId, error_class: 'zod_validation_failed', zod: parsed.error.flatten(),
      });
      return new Response(JSON.stringify({ error: 'invalid request body' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const newUsername = parsed.data.new_username.trim().toLowerCase();

    // Content moderation pre-check (cheap, before SQL).
    const contentError = validateUsernameContent(newUsername);
    if (contentError) {
      return new Response(JSON.stringify({ error: contentError, reason: 'content_blocked' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // 4. RPC: change_username_atomic (service-role)
    const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_KEY);
    const { data, error: rpcError } = await supabaseAdmin.rpc('change_username_atomic', {
      _user_id: userId,
      _new_username: newUsername,
    });

    if (rpcError) {
      const requestId = logSecureError(FUNCTION_NAME, rpcError, {
        user_id: userId, error_class: 'rpc_failed',
      });
      return new Response(JSON.stringify({ error: ERROR_MESSAGES.INTERNAL_ERROR, requestId }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // RPC returns a single-row table; supabase-js gives an array.
    const row = Array.isArray(data) ? data[0] : data;
    const allowedResult: boolean = !!row?.allowed;
    const reason: string = row?.reason ?? 'unknown';
    const nextChangeAt: string | null = row?.next_change_at ?? null;

    // 5. Map reasons to status codes
    if (!allowedResult) {
      switch (reason) {
        case 'cooldown_active':
          return new Response(JSON.stringify({
            error: 'Username can only be changed once every 90 days',
            reason, next_change_at: nextChangeAt,
          }), { status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        case 'format_invalid':
          return new Response(JSON.stringify({
            error: 'Username must be 3-20 characters: lowercase letters, numbers, underscores',
            reason,
          }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        case 'duplicate':
          return new Response(JSON.stringify({
            error: 'Username is already taken', reason,
          }), { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        case 'unchanged':
          return new Response(JSON.stringify({
            error: 'New username is the same as current username', reason,
          }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        case 'profile_not_found':
          return new Response(JSON.stringify({
            error: ERROR_MESSAGES.NOT_FOUND, reason,
          }), { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        case 'invalid_user':
        default:
          return new Response(JSON.stringify({
            error: ERROR_MESSAGES.INTERNAL_ERROR, reason,
          }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
    }

    // 6. Audit log (best-effort)
    try {
      await supabaseAdmin.from('compliance_audit_logs').insert({
        user_id: userId,
        event_type: 'username_changed',
        severity: 'info',
        description: 'User changed username',
        metadata: { new_username: newUsername },
      });
    } catch (e) {
      logSecureError(FUNCTION_NAME, e, { user_id: userId, error_class: 'audit_log_failed' });
    }

    return new Response(JSON.stringify({
      success: true,
      username: newUsername,
      next_change_at: nextChangeAt,
    }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  } catch (error: any) {
    const requestId = logSecureError(FUNCTION_NAME, error, { error_class: 'unhandled' });
    return new Response(JSON.stringify({ error: ERROR_MESSAGES.INTERNAL_ERROR, requestId }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
