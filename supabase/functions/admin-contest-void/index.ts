import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.76.1';
import { requireAdmin } from '../shared/auth-helpers.ts';
import { getCorsHeaders } from '../shared/cors.ts';

interface VoidRequest {
  contestPoolId: string;
}

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
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: req.headers.get('Authorization')! } } }
    );

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    await requireAdmin(supabase, user.id);

    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    const body: VoidRequest = await req.json();
    const { contestPoolId } = body;

    if (!contestPoolId) {
      return new Response(
        JSON.stringify({ error: 'contestPoolId is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log('Voiding pool:', { contestPoolId, admin: user.id });

    const { data, error } = await supabaseAdmin.rpc('void_contest_pool_atomic', {
      _pool_id: contestPoolId,
      _admin_user_id: user.id,
      _reason: 'Admin manual void',
    });

    if (error) {
      console.error('Error voiding contest:', error);
      return new Response(
        JSON.stringify({ error: 'Failed to void contest' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const result = Array.isArray(data) ? data[0] : data;
    if (!result || !result.allowed) {
      return new Response(
        JSON.stringify({ error: result?.reason || 'Failed to void contest' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const refundedCount = result.refunded_count || 0;

    await supabaseAdmin.from('compliance_audit_logs').insert({
      admin_id: user.id,
      event_type: 'pool_voided',
      description: `Admin voided pool ${contestPoolId}`,
      severity: 'warning',
      metadata: { pool_id: contestPoolId, refunded_count: refundedCount },
    });

    console.log(`Pool ${contestPoolId} voided. Refunded ${refundedCount} entries`);

    return new Response(
      JSON.stringify({ success: true, message: 'Pool voided and refunds processed', refundedCount }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Error in admin-contest-void:', error);
    return new Response(
      JSON.stringify({ error: 'An error occurred' }),
      { status: 500, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } }
    );
  }
});