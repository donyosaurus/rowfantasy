// Wallet Deposit - Process deposit using wallet system with responsible gaming checks

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.76.1';
import { z } from 'https://deno.land/x/zod@v3.22.4/mod.ts';
import { MockPaymentAdapter } from '../shared/payment-providers/mock-adapter.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
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

    // Validate input (amount in cents)
    const depositSchema = z.object({
      amount: z.number().int().positive().min(500).max(50000), // $5 - $500 in cents
    });

    let body;
    try {
      const rawBody = await req.json();
      body = depositSchema.parse(rawBody);
    } catch (error) {
      return new Response(
        JSON.stringify({ error: 'Invalid input: amount must be between 500 and 50000 cents ($5-$500)' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const { amount } = body;

    // Use service role client for admin operations
    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    // Check responsible gaming limits before processing payment
    const { data: limitCheck, error: limitError } = await adminClient
      .rpc('check_deposit_limit', { p_user_id: user.id, p_amount: amount });

    if (limitError) {
      console.error('[wallet-deposit] Responsible gaming check failed:', limitError);
      return new Response(
        JSON.stringify({ error: 'Deposit not allowed by responsible gaming limits' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Get or create user's wallet
    let { data: wallet, error: walletError } = await adminClient
      .from('wallets')
      .select('id')
      .eq('user_id', user.id)
      .single();

    if (walletError || !wallet) {
      // Create wallet if it doesn't exist
      const { data: newWallet, error: createError } = await adminClient
        .from('wallets')
        .insert({ user_id: user.id })
        .select('id')
        .single();

      if (createError) {
        console.error('[wallet-deposit] Failed to create wallet:', createError);
        return new Response(
          JSON.stringify({ error: 'Failed to create wallet' }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      wallet = newWallet;
    }

    // Process payment with mock adapter
    const paymentAdapter = new MockPaymentAdapter();
    const paymentResult = await paymentAdapter.processPayment(amount, 'USD');

    if (!paymentResult.success) {
      return new Response(
        JSON.stringify({ error: 'Payment processing failed' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Update wallet balance using RPC
    const { data: balanceResult, error: balanceUpdateError } = await adminClient.rpc('update_wallet_balance', {
      _wallet_id: wallet.id,
      _available_delta: amount,
      _pending_delta: 0,
      _lifetime_deposits_delta: amount,
      _lifetime_winnings_delta: 0,
      _lifetime_withdrawals_delta: 0,
    });

    if (balanceUpdateError) {
      console.error('[wallet-deposit] Wallet update error:', balanceUpdateError);
      return new Response(
        JSON.stringify({ error: 'Failed to update wallet balance' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Create transaction record
    const { error: txError } = await adminClient
      .from('transactions')
      .insert({
        user_id: user.id,
        wallet_id: wallet.id,
        type: 'deposit',
        amount: amount,
        status: 'completed',
        completed_at: new Date().toISOString(),
        deposit_timestamp: new Date().toISOString(),
        description: 'Deposit via Mock Payment',
        reference_id: paymentResult.transactionId,
        reference_type: 'payment_provider',
        metadata: {
          provider: 'mock',
          transaction_id: paymentResult.transactionId,
        },
      });

    if (txError) {
      console.error('[wallet-deposit] Transaction record error:', txError);
      // Non-fatal - wallet was already updated
    }

    // Also create ledger entry for audit trail
    await adminClient
      .from('ledger_entries')
      .insert({
        user_id: user.id,
        amount: amount,
        transaction_type: 'DEPOSIT',
        description: 'Deposit via Mock Payment',
        reference_id: paymentResult.transactionId,
      });

    // Get new balance
    const { data: updatedWallet } = await adminClient
      .from('wallets')
      .select('available_balance')
      .eq('id', wallet.id)
      .single();

    const balanceCents = updatedWallet?.available_balance || 0;
    const balanceDisplay = `$${(balanceCents / 100).toFixed(2)}`;

    console.log('[wallet-deposit] Deposit successful:', { userId: user.id, amount, transactionId: paymentResult.transactionId });

    return new Response(
      JSON.stringify({
        success: true,
        transactionId: paymentResult.transactionId,
        depositedAmount: amount,
        depositedDisplay: `$${(amount / 100).toFixed(2)}`,
        balanceCents,
        balanceDisplay,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error: any) {
    console.error('[wallet-deposit] Error:', error);
    return new Response(
      JSON.stringify({ error: 'An unexpected error occurred' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
