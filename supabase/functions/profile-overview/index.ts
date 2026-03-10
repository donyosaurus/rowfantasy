// Profile Overview - Get user profile, wallet, and stats

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.76.1';
import { getCorsHeaders } from '../shared/cors.ts';

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
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

    // Fetch profile
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', user.id)
      .single();

    if (profileError) {
      throw profileError;
    }

    // Fetch wallet
    const { data: wallet, error: walletError } = await supabase
      .from('wallets')
      .select('*')
      .eq('user_id', user.id)
      .single();

    if (walletError) {
      throw walletError;
    }

    // Compute stats from contest_entries
    const { data: entries, error: entriesError } = await supabase
      .from('contest_entries')
      .select('entry_fee_cents, payout_cents, rank, status')
      .eq('user_id', user.id);

    if (entriesError) {
      throw entriesError;
    }

    const contestsPlayed = entries?.length || 0;
    const wins = entries?.filter(e => e.rank === 1).length || 0;
    const winRate = contestsPlayed > 0 ? ((wins / contestsPlayed) * 100).toFixed(1) : '0.0';
    const totalWinnings = entries?.reduce((sum, e) => sum + (Number(e.payout_cents) || 0), 0) || 0;
    const totalFees = entries?.reduce((sum, e) => sum + (Number(e.entry_fee_cents) || 0), 0) || 0;
    const netProfit = totalWinnings - totalFees;
    const bestFinish = entries && entries.length > 0 
      ? Math.min(...entries.filter(e => e.rank).map(e => e.rank!))
      : null;

    // Recent form (last 5 entries)
    const { data: recentEntries, error: recentError } = await supabase
      .from('contest_entries')
      .select('rank')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(5);

    const recentForm = recentEntries?.map(e => e.rank || '-').join(', ') || 'N/A';

    const stats = {
      contestsPlayed,
      winRate: parseFloat(winRate),
      totalWinnings: totalWinnings / 100, // convert to dollars
      netProfit: netProfit / 100,
      bestFinish,
      recentForm,
    };

    return new Response(
      JSON.stringify({
        profile: {
          id: profile.id,
          email: profile.email,
          username: profile.username,
          fullName: profile.full_name,
          dateOfBirth: profile.date_of_birth,
          state: profile.state,
          usernameLastChangedAt: profile.username_last_changed_at,
          kycStatus: profile.kyc_status,
          isActive: profile.is_active,
          selfExclusionUntil: profile.self_exclusion_until,
          depositLimitMonthly: Number(profile.deposit_limit_monthly),
        },
        wallet: {
          availableBalance: Number(wallet.available_balance) / 100, // convert cents to dollars
          pendingBalance: Number(wallet.pending_balance) / 100,
          lifetimeDeposits: Number(wallet.lifetime_deposits) / 100,
          lifetimeWithdrawals: Number(wallet.lifetime_withdrawals) / 100,
          lifetimeWinnings: Number(wallet.lifetime_winnings) / 100,
        },
        stats,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error: any) {
    console.error('[profile-overview] Error:', error);
    return new Response(
      JSON.stringify({ error: 'An unexpected error occurred' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
