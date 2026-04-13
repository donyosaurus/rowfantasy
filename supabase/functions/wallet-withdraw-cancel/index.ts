// Wallet Withdraw Cancel - Cancel pending withdrawal

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.76.1';
import { getCorsHeaders } from '../shared/cors.ts';

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
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const authHeader = req.headers.get('Authorization')!;
    const supabase = createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: 'Unauthorized' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const { request_id } = await req.json();

    if (!request_id) {
      return new Response(
        JSON.stringify({ error: 'Request ID is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const { data: transaction, error: txError } = await supabase
      .from('transactions')
      .select('*')
      .eq('id', request_id)
      .eq('user_id', user.id)
      .eq('type', 'withdrawal')
      .single();

    if (txError || !transaction) {
      return new Response(
        JSON.stringify({ error: 'Withdrawal request not found' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (transaction.status !== 'pending') {
      return new Response(
        JSON.stringify({ error: 'Only pending withdrawals can be cancelled' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const { error: updateError } = await supabase
      .from('transactions')
      .update({ status: 'failed', metadata: { ...transaction.metadata, cancelled_by_user: true } })
      .eq('id', request_id);

    if (updateError) {
      throw updateError;
    }

    await supabase
      .from('compliance_audit_logs')
      .insert({
        user_id: user.id,
        event_type: 'withdrawal_cancelled',
        description: 'User cancelled withdrawal request',
        severity: 'info',
        metadata: { transaction_id: request_id },
      });

    return new Response(
      JSON.stringify({ success: true }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error: any) {
    console.error('[wallet-withdraw-cancel] Error:', error);
    return new Response(
      JSON.stringify({ error: 'Failed to cancel withdrawal' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
