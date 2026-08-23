import { withFnVersion } from '../shared/fn-version.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.76.1';
import { requireAdmin } from '../shared/auth-helpers.ts';
import { z } from 'https://deno.land/x/zod@v3.22.4/mod.ts';
import { getCorsHeaders } from '../shared/cors.ts';

const ResultItemSchema = z.object({
  crew_id: z.string().min(1),
  finish_order: z.number().int().positive(),
  finish_time: z.string().nullable().optional(),
});

const RequestSchema = z.object({
  contestPoolId: z.string().uuid(),
  results: z.array(ResultItemSchema).min(1),
});

// v2 (multi-sport) shape — keyed by template + race_key/competitor_key
const ResultItemV2Schema = z.object({
  race_key: z.string().min(1),
  competitor_key: z.string().min(1),
  place: z.number().int().min(1).max(10000).optional(),
  time_ms: z.number().int().min(0).max(1000000000).optional(),
  finish_time: z.string().optional(),
  status: z.enum(['OK', 'DNF', 'DNS', 'DSQ', 'PENDING']).optional(),
}).strict();

const RequestV2Schema = z.object({
  contestTemplateId: z.string().uuid(),
  results: z.array(ResultItemV2Schema).min(1),
}).strict();


Deno.serve(withFnVersion('admin-contest-results', async (req) => {
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

    const body = await req.json();

    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    const hasPool = body && typeof body === 'object' && body.contestPoolId !== undefined;
    const hasTemplate = body && typeof body === 'object' && body.contestTemplateId !== undefined;

    if (hasPool && hasTemplate) {
      return new Response(
        JSON.stringify({ error: 'Provide either contestPoolId or contestTemplateId, not both' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ---- v2 path: template-scoped results ----
    if (hasTemplate) {
      const parsedV2 = RequestV2Schema.safeParse(body);
      if (!parsedV2.success) {
        return new Response(
          JSON.stringify({ error: 'Invalid input', details: parsedV2.error.flatten() }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      const { contestTemplateId, results: v2Results } = parsedV2.data;
      console.log('Admin submitting v2 race results:', { contestTemplateId, admin: user.id, resultCount: v2Results.length });

      const { data: v2Data, error: v2Error } = await supabaseAdmin.rpc('admin_update_race_results_v2', {
        p_template_id: contestTemplateId,
        p_results: v2Results,
        _admin_user_id: user.id,
      });

      if (v2Error) {
        console.error('RPC error (v2):', v2Error);
        return new Response(
          JSON.stringify({ error: 'Failed to update results' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      await supabaseAdmin.from('compliance_audit_logs').insert({
        admin_id: user.id,
        event_type: 'race_results_submitted',
        description: `Admin submitted race results for contest template ${contestTemplateId}`,
        severity: 'info',
        metadata: { contest_template_id: contestTemplateId, results_count: v2Results.length, results: v2Results },
      });

      return new Response(
        JSON.stringify(v2Data ?? { success: true }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const parseResult = RequestSchema.safeParse(body);
    if (!parseResult.success) {
      return new Response(
        JSON.stringify({ error: 'Invalid input', details: parseResult.error.flatten() }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const { contestPoolId, results } = parseResult.data;
    console.log('Admin submitting race results:', { contestPoolId, admin: user.id, resultCount: results.length });


    const { data: rpcResult, error: rpcError } = await supabaseAdmin.rpc('admin_update_race_results', {
      p_contest_pool_id: contestPoolId,
      p_results: results,
      _admin_user_id: user.id,
    });

    if (rpcError) {
      console.error('RPC error:', rpcError);
      return new Response(
        JSON.stringify({ error: 'Failed to update results' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    await supabaseAdmin.from('compliance_audit_logs').insert({
      admin_id: user.id,
      event_type: 'race_results_submitted',
      description: `Admin submitted race results for contest pool ${contestPoolId}`,
      severity: 'info',
      metadata: { contest_pool_id: contestPoolId, results_count: results.length, results },
    });

    return new Response(
      JSON.stringify({ success: true, message: 'Race results submitted successfully', contestPoolId, resultsCount: results.length }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Error in admin-contest-results:', error);
    return new Response(
      JSON.stringify({ error: 'An error occurred' }),
      { status: 500, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } }
    );
  }
}));