import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.76.1';
import { z } from 'https://deno.land/x/zod@v3.22.4/mod.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      {
        global: {
          headers: { Authorization: req.headers.get('Authorization')! },
        },
      }
    );

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Validate input
    const withdrawSchema = z.object({
      contestPoolId: z.string().uuid('Invalid contest pool ID'),
    });

    let body;
    try {
      const rawBody = await req.json();
      body = withdrawSchema.parse(rawBody);
    } catch (error) {
      console.error('[contest-withdraw] Validation error:', error);
      return new Response(
        JSON.stringify({ 
          error: 'Invalid input parameters',
          details: error instanceof z.ZodError ? error.errors : 'Validation failed'
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const { contestPoolId } = body;

    console.log('[contest-withdraw] Request:', { userId: user.id, contestPoolId });

    // Call the atomic withdraw RPC
    const { data, error } = await supabase.rpc('withdraw_contest_entry', {
      p_contest_pool_id: contestPoolId
    });

    if (error) {
      console.error('[contest-withdraw] RPC error:', error);
      
      return new Response(
        JSON.stringify({ error: 'Failed to withdraw from contest' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log('[contest-withdraw] Success:', data);

    return new Response(
      JSON.stringify({
        success: true,
        message: 'Entry withdrawn and funds refunded',
        refundedAmountCents: data?.refunded_amount,
        entryId: data?.entry_id
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('[contest-withdraw] Error:', error);
    return new Response(
      JSON.stringify({ error: 'An unexpected error occurred' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
