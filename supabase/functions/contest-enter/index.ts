import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.76.1';
import { z } from 'https://deno.land/x/zod@v3.22.4/mod.ts';
import { checkLocationEligibility } from '../shared/geo-eligibility.ts';

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

    // Create service client for overflow pool operations
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Geolocation check - block restricted states
    checkLocationEligibility(req);

    // Validate input with Zod schema - picks now include per-crew predicted margins
    const pickSchema = z.object({
      crewId: z.string().min(1, 'Crew ID required'),
      predictedMargin: z.number().min(0, 'Predicted margin must be non-negative')
    });

    const entrySchema = z.object({
      contestPoolId: z.string().uuid('Invalid contest pool ID'),
      picks: z.array(pickSchema)
        .min(2, 'Minimum 2 picks required')
        .max(10, 'Maximum 10 picks allowed')
    });

    let body;
    try {
      const rawBody = await req.json();
      body = entrySchema.parse(rawBody);
    } catch (error) {
      console.error('[contest-enter] Validation error:', error);
      return new Response(
        JSON.stringify({ 
          error: 'Invalid input parameters',
          details: error instanceof z.ZodError ? error.errors : 'Validation failed'
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const { contestPoolId, picks } = body;
    let targetPoolId = contestPoolId;

    console.log('[contest-enter] Request:', { userId: user.id, contestPoolId, picksCount: picks.length });

    // Step A: Fetch pool data including overflow settings
    const { data: pool, error: poolError } = await supabaseAdmin
      .from('contest_pools')
      .select('id, contest_template_id, tier_id, current_entries, max_entries, allow_overflow, status, lock_time')
      .eq('id', contestPoolId)
      .single();

    if (poolError || !pool) {
      console.error('[contest-enter] Pool fetch error:', poolError);
      return new Response(
        JSON.stringify({ error: 'Contest pool not found' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Check if pool is open
    if (pool.status !== 'open') {
      return new Response(
        JSON.stringify({ error: 'Contest is not open for entries' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Check if lock time has passed
    if (new Date(pool.lock_time) < new Date()) {
      return new Response(
        JSON.stringify({ error: 'Entry period has ended' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Step B: Handle full pool with auto-pooling logic
    const isFull = pool.current_entries >= pool.max_entries;

    if (isFull) {
      console.log('[contest-enter] Pool is full:', { 
        poolId: contestPoolId, 
        current: pool.current_entries, 
        max: pool.max_entries,
        allowOverflow: pool.allow_overflow 
      });

      if (!pool.allow_overflow) {
        // No overflow allowed - return error
        return new Response(
          JSON.stringify({ error: 'Contest is full' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // Auto-pooling enabled - look for existing open sibling pool
      console.log('[contest-enter] Looking for open sibling pool...');
      
      const { data: siblingPools, error: siblingError } = await supabaseAdmin
        .from('contest_pools')
        .select('id, current_entries, max_entries')
        .eq('contest_template_id', pool.contest_template_id)
        .eq('tier_id', pool.tier_id)
        .eq('status', 'open')
        .neq('id', contestPoolId)
        .order('created_at', { ascending: true });

      if (siblingError) {
        console.error('[contest-enter] Sibling pool lookup error:', siblingError);
      }

      // Find a sibling pool that's not full
      const openSibling = siblingPools?.find(s => s.current_entries < s.max_entries);

      if (openSibling) {
        // Use existing open sibling pool
        console.log('[contest-enter] Found open sibling pool:', openSibling.id);
        targetPoolId = openSibling.id;
      } else {
        // No open sibling - clone the original pool
        console.log('[contest-enter] No open sibling found, cloning pool...');
        
        const { data: cloneResult, error: cloneError } = await supabaseAdmin
          .rpc('clone_contest_pool', { p_original_pool_id: contestPoolId });

        if (cloneError || !cloneResult) {
          console.error('[contest-enter] Pool clone error:', cloneError);
          return new Response(
            JSON.stringify({ error: 'Failed to create overflow pool' }),
            { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }

        console.log('[contest-enter] Created new overflow pool:', cloneResult);
        targetPoolId = cloneResult;
      }
    }

    // Step C: Security Check - Verify all picks are in the allowed crews list
    // Use original pool ID since crews are the same across clones
    const { data: allowedCrews, error: crewsError } = await supabase
      .from('contest_pool_crews')
      .select('crew_id, event_id')
      .eq('contest_pool_id', targetPoolId);

    if (crewsError) {
      console.error('[contest-enter] Error fetching allowed crews:', crewsError);
      return new Response(
        JSON.stringify({ error: 'Failed to validate crew selections' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (!allowedCrews || allowedCrews.length === 0) {
      console.error('[contest-enter] No allowed crews found for pool:', targetPoolId);
      return new Response(
        JSON.stringify({ error: 'Contest pool has no available crews' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Create a map of allowed crew_id -> event_id
    const crewToEventMap = new Map<string, string>();
    for (const crew of allowedCrews) {
      crewToEventMap.set(crew.crew_id, crew.event_id);
    }

    // Validate every pick exists in the allowed list (extract crewId from pick objects)
    const invalidPicks: string[] = [];
    const pickedEventIds = new Set<string>();

    for (const pick of picks) {
      const eventId = crewToEventMap.get(pick.crewId);
      if (!eventId) {
        invalidPicks.push(pick.crewId);
      } else {
        pickedEventIds.add(eventId);
      }
    }

    if (invalidPicks.length > 0) {
      console.error('[contest-enter] Invalid picks:', invalidPicks);
      return new Response(
        JSON.stringify({ error: 'Invalid crew selection - Crew not allowed in this contest' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Step D: Duplicate event check - only one crew per event
    const eventIdList = picks.map(p => crewToEventMap.get(p.crewId)!);
    if (new Set(eventIdList).size !== eventIdList.length) {
      console.error('[contest-enter] Duplicate event picks detected');
      return new Response(
        JSON.stringify({ error: 'You can only select one crew per event' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Step E: Diversity Rule - Must have at least 2 unique events
    if (pickedEventIds.size < 2) {
      console.error('[contest-enter] Diversity rule violation:', { uniqueEvents: pickedEventIds.size });
      return new Response(
        JSON.stringify({ error: 'You must select crews from at least two separate events' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Step E: Construct validated roster and call RPC
    const roster = {
      crews: picks // Array of { crewId, predictedMargin }
    };

    console.log('[contest-enter] Calling RPC with validated roster:', { 
      userId: user.id, 
      targetPoolId,
      originalPoolId: contestPoolId,
      wasRedirected: targetPoolId !== contestPoolId,
      picksCount: picks.length,
      uniqueEvents: pickedEventIds.size 
    });

    const { data, error } = await supabase.rpc('enter_contest_pool', {
      p_contest_pool_id: targetPoolId,
      p_picks: roster
    });

    if (error) {
      console.error('[contest-enter] RPC error:', error);
      
      const errorMessage = error.message || 'Failed to enter contest';
      
      return new Response(
        JSON.stringify({ error: errorMessage }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log('[contest-enter] Success:', { 
      ...data, 
      actualPoolId: targetPoolId,
      wasOverflow: targetPoolId !== contestPoolId
    });

    return new Response(
      JSON.stringify({
        success: true,
        message: targetPoolId !== contestPoolId 
          ? 'Original pool was full - you were placed in an overflow pool!'
          : 'Successfully entered the contest!',
        entryFeeCents: data?.entry_fee_cents,
        actualPoolId: targetPoolId,
        wasOverflow: targetPoolId !== contestPoolId
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('[contest-enter] Error:', error);
    return new Response(
      JSON.stringify({ error: 'An error occurred. Please try again.' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
