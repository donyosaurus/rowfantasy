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

    const { data: flags, error: flagsError } = await supabase.from('feature_flags').select('key, value');

    if (flagsError) {
      return new Response(
        JSON.stringify({ ok: false, db: dbStatus, flags: null, error: 'Failed to fetch flags', timestamp: new Date().toISOString() }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const flagsObj = (flags || []).reduce((acc: any, flag: any) => { acc[flag.key] = flag.value; return acc; }, {});

    return new Response(
      JSON.stringify({ ok: dbStatus === 'ok' || dbStatus === 'degraded', db: dbStatus, flags: flagsObj, timestamp: new Date().toISOString() }),
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