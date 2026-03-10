// Profile Contests - Get user's contest history

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

    const url = new URL(req.url);
    const page = parseInt(url.searchParams.get('page') || '1');
    const limit = parseInt(url.searchParams.get('limit') || '20');
    const offset = (page - 1) * limit;

    // Fetch contest entries with related data
    const { data: entries, error: entriesError, count } = await supabase
      .from('contest_entries')
      .select(`
        *,
        contest_template:contest_templates(regatta_name, gender_category),
        pool:contest_pools(entry_fee_cents, tier_id, lock_time, status)
      `, { count: 'exact' })
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (entriesError) {
      throw entriesError;
    }

    const contests = entries?.map(entry => ({
      id: entry.id,
      contestTemplateId: entry.contest_template_id,
      regattaName: entry.contest_template?.regatta_name || 'Unknown',
      genderCategory: entry.contest_template?.gender_category || 'Unknown',
      tierId: entry.pool?.tier_id || 'Unknown',
      poolId: entry.pool_id,
      entryFeeCents: entry.entry_fee_cents,
      lockTime: entry.pool?.lock_time,
      status: entry.status,
      rank: entry.rank,
      totalPoints: entry.total_points,
      payoutCents: entry.payout_cents,
      createdAt: entry.created_at,
      poolStatus: entry.pool?.status,
    })) || [];

    return new Response(
      JSON.stringify({
        contests,
        total: count || 0,
        page,
        limit,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error: any) {
    console.error('[profile-contests] Error:', error);
    return new Response(
      JSON.stringify({ error: 'An unexpected error occurred' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
