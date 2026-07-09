// Health Check - System status and feature flags

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.76.1';
import { getCorsHeaders } from '../shared/cors.ts';

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);

  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== 'GET') {
    return new Response(
      JSON.stringify({ error: 'Method not allowed' }),
      { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    let dbStatus = 'ok';
    try {
      const { error: timeError } = await supabase.rpc('now' as any);
      if (timeError) { dbStatus = 'degraded'; }
      const { error: canaryError } = await supabase.from('state_regulation_rules').select('count', { count: 'exact', head: true });
      if (canaryError) { dbStatus = 'degraded'; }
    } catch { dbStatus = 'error'; }

    // SECURITY: Do NOT return feature flags to unauthenticated callers.
    // Flags may contain operational configuration; the RLS policy on
    // feature_flags is authenticated-only and this endpoint has no auth.
    return new Response(
      JSON.stringify({ ok: dbStatus === 'ok' || dbStatus === 'degraded', db: dbStatus, timestamp: new Date().toISOString() }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error: any) {
    console.error('Health check error:', error);
    return new Response(
      JSON.stringify({ ok: false, error: 'Health check failed', timestamp: new Date().toISOString() }),
      { status: 500, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } }
    );
  }
});