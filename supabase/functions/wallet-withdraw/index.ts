// Wallet Withdrawal - Process withdrawal using ledger system

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.76.1';
import { z } from 'https://deno.land/x/zod@v3.22.4/mod.ts';
import { getCorsHeaders } from '../shared/cors.ts';

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const authHeader = req.headers.get('Authorization')!;
    
    // User client for auth
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

    // Validate input
    const withdrawSchema = z.object({
      amount: z.number().int().positive().min(100).max(5000000), // $1 - $50k in cents
    });

    let body;
    try {
      const rawBody = await req.json();
      body = withdrawSchema.parse(rawBody);
    } catch (error) {
      return new Response(
        JSON.stringify({ error: 'Invalid input: amount must be a positive integer in cents' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const { amount } = body;

    // Use service role client for ledger operations
    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    // Check current balance first
    const { data: balanceData, error: balanceError } = await adminClient
      .rpc('get_user_balance', { target_user_id: user.id });

    if (balanceError) {
      console.error('[wallet-withdraw] Balance check error:', balanceError);
      return new Response(
        JSON.stringify({ error: 'Failed to check balance' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const currentBalance = Number(balanceData) || 0;

    if (currentBalance < amount) {
      return new Response(
        JSON.stringify({ error: 'Insufficient funds' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Insert withdrawal as negative amount
    const { error: ledgerError } = await adminClient
      .from('ledger_entries')
      .insert({
        user_id: user.id,
        amount: -amount, // Negative for withdrawal
        transaction_type: 'WITHDRAWAL',
        description: 'Withdrawal Request',
        reference_id: null,
      });

    if (ledgerError) {
      console.error('[wallet-withdraw] Ledger insert error:', ledgerError);
      return new Response(
        JSON.stringify({ error: 'Failed to process withdrawal' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Get new balance
    const { data: newBalanceData } = await adminClient
      .rpc('get_user_balance', { target_user_id: user.id });

    const newBalanceCents = Number(newBalanceData) || 0;
    const balanceDisplay = `$${(newBalanceCents / 100).toFixed(2)}`;

    console.log('[wallet-withdraw] Withdrawal successful:', { userId: user.id, amount });

    return new Response(
      JSON.stringify({
        success: true,
        withdrawnAmount: amount,
        balanceCents: newBalanceCents,
        balanceDisplay,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error: any) {
    console.error('[wallet-withdraw] Error:', error);
    return new Response(
      JSON.stringify({ error: 'An unexpected error occurred' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
