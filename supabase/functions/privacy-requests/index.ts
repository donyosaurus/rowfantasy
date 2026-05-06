import { createClient } from "https://esm.sh/@supabase/supabase-js@2.76.1";
import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import { getCorsHeaders } from '../shared/cors.ts';

const requestSchema = z.object({
  type: z.enum(['access', 'export', 'delete'])
});

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
      return new Response(
        JSON.stringify({ error: 'Unauthorized' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (req.method === 'POST') {
      let body;
      try {
        body = requestSchema.parse(await req.json());
      } catch (parseError) {
        console.error('Error parsing request body:', parseError);
        return new Response(
          JSON.stringify({ error: 'Invalid request body' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // Create privacy request — DELETE requests are queued for admin-mediated
      // soft-delete review (Wave 4 #1). We never call auth.admin.deleteUser:
      // GDPR/CCPA "right to erasure" is satisfied via PII redaction by
      // public.soft_delete_user_account, which preserves the AML/KYC trail.
      const { data: request, error: insertError } = await supabase
        .from('privacy_requests')
        .insert({
          user_id: user.id,
          type: body.type,
          metadata: body.type === 'delete'
            ? { handler: 'soft_delete_user_account', requires_admin_review: true }
            : {}
        })
        .select()
        .single();

      if (insertError) {
        console.error('Error creating privacy request:', insertError);
        return new Response(
          JSON.stringify({ error: 'Failed to create request' }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // Log to compliance audit (best-effort; do not fail the user request)
      try {
        await supabase.from('compliance_audit_logs').insert({
          user_id: user.id,
          event_type: body.type === 'delete'
            ? 'account_deletion_requested'
            : 'privacy_request_submitted',
          description: `User submitted ${body.type} request`,
          severity: body.type === 'delete' ? 'warning' : 'info',
          metadata: { request_id: request.id, type: body.type }
        });
      } catch (auditErr) {
        console.error('[privacy-requests] audit log insert failed (non-fatal):', auditErr);
      }

      return new Response(
        JSON.stringify({ request }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // GET - list user's privacy requests
    const { data: requests, error: fetchError } = await supabase
      .from('privacy_requests')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false });

    if (fetchError) {
      console.error('Error fetching privacy requests:', fetchError);
      return new Response(
        JSON.stringify({ error: 'Failed to fetch requests' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    return new Response(
      JSON.stringify({ requests }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('Error in privacy-requests:', error);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});