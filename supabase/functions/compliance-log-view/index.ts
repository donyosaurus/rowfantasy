// Compliance Log View — records legal_view audit events for authenticated users.
// Insert runs with the SERVICE-ROLE client because compliance_audit_logs is admin-only via RLS.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.76.1';
import { z } from 'https://deno.land/x/zod@v3.22.4/mod.ts';
import { getCorsHeaders } from '../shared/cors.ts';
import { authenticateUser, checkRateLimit } from '../shared/auth-helpers.ts';

const ALLOWED_SLUGS = ['terms', 'privacy', 'legal', 'responsible-play'] as const;

const bodySchema = z.object({
  doc_slug: z.enum(ALLOWED_SLUGS),
});

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }
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

    const auth = await authenticateUser(req, SUPABASE_URL, ANON_KEY);
    if (!auth) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const admin = createClient(SUPABASE_URL, SERVICE_KEY);

    // Rate-limit via service-role client; check_rate_limit_atomic EXECUTE is service_role only
    // and checkRateLimit fails closed — mirrors contest-matchmaking:41.
    const rateOk = await checkRateLimit(admin, auth.user.id, 'compliance-log-view', 30, 1);
    if (!rateOk) {
      return new Response(JSON.stringify({ error: 'Rate limit exceeded' }), {
        status: 429,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return new Response(JSON.stringify({ error: 'Invalid doc_slug' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const { doc_slug } = parsed.data;

    const { error: insertErr } = await admin.from('compliance_audit_logs').insert({
      user_id: auth.user.id,
      event_type: 'legal_view',
      severity: 'info',
      description: `Viewed ${doc_slug}`,
      metadata: { doc_slug },
      ip_address: req.headers.get('cf-connecting-ip'),
    });

    if (insertErr) {
      console.error('[compliance-log-view] insert failed', insertErr);
      return new Response(JSON.stringify({ error: 'Failed to log view' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    console.error('[compliance-log-view] unhandled', e);
    return new Response(JSON.stringify({ error: 'Internal error' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
