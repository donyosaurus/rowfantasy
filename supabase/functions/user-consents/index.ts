import { createClient } from "https://esm.sh/@supabase/supabase-js@2.76.1";
import { getCorsHeaders } from '../shared/cors.ts';

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);

  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const headers = {
    "Content-Type": "application/json",
    ...corsHeaders,
  } as const;

  try {
    if (req.method !== "POST") {
      return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers });
    }

    // Parse and validate body (doc_slug, version as string)
    const body = await req.json().catch(() => ({} as any));
    const doc_slug = typeof body.doc_slug === 'string' ? body.doc_slug.trim() : '';
    const version = typeof body.version === 'string' ? body.version.trim() : '';
    const consented_at = typeof body.consented_at === 'string' ? body.consented_at : new Date().toISOString();

    // Verbose logging (no PII):
    console.log('[user-consents] request', { method: req.method, doc_slug, version_present: !!version });

    if (!doc_slug || !version) {
      console.warn('[user-consents] 400 invalid body', { doc_slug_present: !!doc_slug, version_present: !!version });
      return new Response(JSON.stringify({ error: "Bad request" }), { status: 400, headers });
    }

    // Auth with end-user JWT
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } }
    );

    const { data: { user }, error: userErr } = await supabase.auth.getUser();
    if (userErr || !user) {
      console.warn('[user-consents] 401 unauthorized', { userErr });
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
    }

    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
    const user_agent = req.headers.get("user-agent") ?? null;

    // Idempotent upsert: ignore duplicates
    const { error: upsertErr } = await supabase
      .from('user_consents')
      .upsert({
        user_id: user.id,
        doc_slug,
        version,
        consented_at,
        ip,
        user_agent,
      }, { onConflict: 'user_id,doc_slug,version', ignoreDuplicates: true });

    if (upsertErr) {
      console.error('[user-consents] upsert error', upsertErr);
      const status = upsertErr.code === '23505' ? 409 : 500;
      return new Response(JSON.stringify({ error: upsertErr.message }), { status, headers });
    }

    console.log('[user-consents] success', { user_id: user.id, doc_slug, version });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
  } catch (e) {
    console.error('[user-consents] unhandled error', e);
    return new Response(JSON.stringify({ error: 'Internal error' }), { status: 500, headers });
  }
});