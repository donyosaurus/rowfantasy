// Wallet Withdraw Request - Create pending withdrawal with limits and rate limiting

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.76.1';
import { z } from 'https://deno.land/x/zod@v3.22.4/mod.ts';
import { authenticateUser, checkRateLimit } from '../shared/auth-helpers.ts';
import { mapErrorToClient, logSecureError, ERROR_MESSAGES } from '../shared/error-handler.ts';
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
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
    const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
    const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    // SECURITY: Authenticate user
    const auth = await authenticateUser(req, SUPABASE_URL, ANON_KEY);
    if (!auth) {
      return new Response(
        JSON.stringify({ error: ERROR_MESSAGES.UNAUTHORIZED }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const userId = auth.user.id;

    // SECURITY: Rate limit (5 requests per hour per user)
    const rateLimitOk = await checkRateLimit(auth.supabase, userId, 'wallet-withdraw-request', 5, 60);
    if (!rateLimitOk) {
      return new Response(
        JSON.stringify({ error: ERROR_MESSAGES.RATE_LIMIT }),
        { status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Validate input
    const withdrawSchema = z.object({
      amount_cents: z.number().int().min(500).max(20000), // $5 to $200
    });

    const body = withdrawSchema.parse(await req.json());

    // Use service client for atomic operations
    const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_KEY);

    // Fetch wallet
    const { data: wallet } = await auth.supabase
      .from('wallets')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (!wallet) {
      return new Response(
        JSON.stringify({ error: ERROR_MESSAGES.NOT_FOUND }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Check per-transaction limit ($200 = 20000 cents)
    if (body.amount_cents > 20000) {
      return new Response(
        JSON.stringify({ error: 'Per-transaction withdrawal limit is $200' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Check available balance
    if (Number(wallet.available_balance) < body.amount_cents) {
      return new Response(
        JSON.stringify({ error: ERROR_MESSAGES.INSUFFICIENT_FUNDS }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Check for pending withdrawals
    const { data: pendingWithdrawals } = await auth.supabase
      .from('transactions')
      .select('id')
      .eq('user_id', userId)
      .eq('type', 'withdrawal')
      .eq('status', 'pending');

    if (pendingWithdrawals && pendingWithdrawals.length > 0) {
      return new Response(
        JSON.stringify({ error: 'You have a pending withdrawal. Please wait for it to complete.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Check 10-minute cooldown
    const { data: lastWithdrawal } = await auth.supabase
      .from('transactions')
      .select('created_at')
      .eq('user_id', userId)
      .eq('type', 'withdrawal')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (lastWithdrawal) {
      const timeSince = Date.now() - new Date(lastWithdrawal.created_at).getTime();
      const minutesSince = timeSince / (1000 * 60);
      if (minutesSince < 10) {
        return new Response(
          JSON.stringify({ error: ERROR_MESSAGES.WITHDRAWAL_COOLDOWN }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
    }

    // Check daily limit ($500) - Use UTC
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);

    const { data: todayWithdrawals } = await auth.supabase
      .from('transactions')
      .select('amount')
      .eq('user_id', userId)
      .eq('type', 'withdrawal')
      .in('status', ['completed', 'pending'])
      .gte('created_at', todayStart.toISOString());

    const todayTotal = (todayWithdrawals || []).reduce((sum: number, tx: any) => sum + Math.abs(Number(tx.amount)), 0);

    if ((todayTotal * 100) + body.amount_cents > 50000) {
      return new Response(
        JSON.stringify({ error: ERROR_MESSAGES.DAILY_LIMIT }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Check 24-hour deposit hold
    const { data: recentDeposits } = await auth.supabase
      .from('transactions')
      .select('created_at')
      .eq('user_id', userId)
      .eq('type', 'deposit')
      .eq('status', 'completed')
      .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
      .limit(1);

    if (recentDeposits && recentDeposits.length > 0) {
      return new Response(
        JSON.stringify({ error: 'Please wait 24 hours after your last deposit before withdrawing' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Create pending withdrawal transaction
    const { data: transaction, error: txError } = await supabaseAdmin
      .from('transactions')
      .insert({
        user_id: userId,
        wallet_id: wallet.id,
        type: 'withdrawal',
        amount: -(body.amount_cents / 100),
        status: 'pending',
        description: 'Withdrawal request',
      })
      .select()
      .single();

    if (txError) throw txError;

    // Move funds to pending (update_wallet_balance expects cents)
    await supabaseAdmin.rpc('update_wallet_balance', {
      _wallet_id: wallet.id,
      _available_delta: -body.amount_cents,
      _pending_delta: body.amount_cents,
    });

    // Log compliance event
    await supabaseAdmin.from('compliance_audit_logs').insert({
      user_id: userId,
      event_type: 'withdrawal_requested',
      description: 'User requested withdrawal',
      severity: 'info',
      metadata: {
        amount_cents: body.amount_cents,
        transaction_id: transaction.id,
        today_total_cents: body.amount_cents,
      },
    });

    return new Response(
      JSON.stringify({
        requestId: transaction.id,
        amount: body.amount_cents / 100,
        amountCents: body.amount_cents,
        status: 'pending',
        message: 'Withdrawal request submitted successfully',
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error: any) {
    const requestId = logSecureError('wallet-withdraw-request', error);
    const clientMessage = mapErrorToClient(error);
    
    return new Response(
      JSON.stringify({ error: clientMessage, requestId }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
