import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.76.1';
import { getCorsHeaders } from '../shared/cors.ts';

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);

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

    const url = new URL(req.url);
    const poolId = url.pathname.split('/').pop();

    if (!poolId) {
      return new Response(
        JSON.stringify({ error: 'Pool ID required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const { data: pool, error: poolError } = await supabase
      .from('contest_pools')
      .select('*')
      .eq('id', poolId)
      .single();

    if (poolError || !pool) {
      return new Response(
        JSON.stringify({ error: 'Pool not found' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const { data: entries, error: entriesError } = await supabase
      .from('contest_entries')
      .select(`
        id,
        user_id,
        picks,
        total_points,
        rank,
        status,
        created_at,
        profiles:user_id (
          username,
          full_name
        )
      `)
      .eq('pool_id', poolId)
      .order('rank', { ascending: true, nullsFirst: false });

    if (entriesError) {
      console.error('Error fetching entries:', entriesError);
      return new Response(
        JSON.stringify({ error: 'Failed to fetch entries' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    return new Response(
      JSON.stringify({
        pool: {
          id: pool.id,
          status: pool.status,
          current_entries: pool.current_entries,
          max_entries: pool.max_entries,
          entry_fee: pool.entry_fee_cents / 100,
          prize_pool: pool.prize_pool_cents / 100,
          lock_time: pool.lock_time,
        },
        entries: entries || [],
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Error in contest-entrants:', error);
    return new Response(
      JSON.stringify({ error: 'An error occurred' }),
      { status: 500, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } }
    );
  }
});