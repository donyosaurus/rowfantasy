// Contest Scoring Engine - Admin-only pool scoring with batch sibling support

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.76.1';
import { z } from 'https://deno.land/x/zod@v3.22.4/mod.ts';
import { 
  scoreContestPool, 
  calculateOfficialMargin,
  parseRaceTime,
  type RaceResult 
} from '../shared/scoring-logic.ts';
import { getCorsHeaders } from '../shared/cors.ts';

// Define crew type for type safety
type PoolCrew = {
  crew_id: string;
  event_id: string;
  crew_name: string;
  manual_finish_order: number | null;
  manual_result_time: string | null;
};

// Score a single pool - extracted for batch processing
async function scoreSinglePool(
  supabaseAdmin: any,
  contestPoolId: string,
  forceRescore: boolean
): Promise<{
  success: boolean;
  poolId: string;
  eventsProcessed?: number;
  resultsCount?: number;
  entriesScored?: number;
  winnerId?: string;
  isTieRefund?: boolean;
  skipped?: boolean;
  skipReason?: string;
  error?: string;
}> {
  try {
    const { data: pool, error: poolError } = await supabaseAdmin
      .from('contest_pools')
      .select('status')
      .eq('id', contestPoolId)
      .single();

    if (poolError || !pool) {
      return { success: false, poolId: contestPoolId, error: 'Pool not found' };
    }

    if (pool.status === 'scoring_completed' && !forceRescore) {
      return { success: true, poolId: contestPoolId, skipped: true, skipReason: 'Already scored' };
    }

    const validScoringStatuses = ['results_entered', 'locked', 'settling'];
    if (!validScoringStatuses.includes(pool.status) && !forceRescore) {
      return { success: true, poolId: contestPoolId, skipped: true, skipReason: `Status '${pool.status}' not ready` };
    }

    // Fetch crew results
    const { data: crews, error: crewsError } = await supabaseAdmin
      .from('contest_pool_crews')
      .select('crew_id, event_id, crew_name, manual_finish_order, manual_result_time')
      .eq('contest_pool_id', contestPoolId);

    if (crewsError || !crews || crews.length === 0) {
      return { success: false, poolId: contestPoolId, error: 'No crew results found' };
    }

    // Group crews by event_id
    const eventGroups = new Map<string, PoolCrew[]>();
    for (const crew of crews as PoolCrew[]) {
      const eventId = crew.event_id;
      if (!eventGroups.has(eventId)) eventGroups.set(eventId, []);
      eventGroups.get(eventId)!.push(crew);
    }

    // Build race results with per-crew actual margins
    const results: RaceResult[] = [];

    for (const [eventId, eventCrews] of eventGroups) {
      const sorted = eventCrews
        .filter(c => c.manual_finish_order !== null)
        .sort((a, b) => (a.manual_finish_order || 0) - (b.manual_finish_order || 0));

      if (sorted.length === 0) continue;

      // Calculate the event's official margin (time gap between 1st and 2nd)
      const officialMargin = calculateOfficialMargin(sorted);

      // For each crew in this event, pass the event's margin
      // The scoring logic will apply sign based on finish order
      for (const crew of sorted) {
        results.push({
          crewId: crew.crew_id,
          eventId: eventId,
          finishOrder: crew.manual_finish_order!,
          actualMargin: officialMargin, // always positive; sign applied in scoring-logic
        });
      }
    }

    console.log('[scoring] Built', results.length, 'results across', eventGroups.size, 'events for pool', contestPoolId);

    const scoringResult = await scoreContestPool(supabaseAdmin, contestPoolId, results);

    return {
      success: true,
      poolId: contestPoolId,
      eventsProcessed: eventGroups.size,
      resultsCount: results.length,
      entriesScored: scoringResult.entriesScored,
      winnerId: scoringResult.winnerId,
      isTieRefund: scoringResult.isTieRefund,
    };
  } catch (error: any) {
    console.error('[scoring] Error scoring pool', contestPoolId, error);
    return { success: false, poolId: contestPoolId, error: error.message };
  }
}

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);

  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
    const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
    const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    const supabase = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: req.headers.get('Authorization')! } },
    });

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { data: roleData } = await supabase
      .from('user_roles').select('role').eq('user_id', user.id).eq('role', 'admin').single();

    if (!roleData) {
      return new Response(JSON.stringify({ error: 'Admin access required' }), {
        status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const body = z.object({
      contestPoolId: z.string().uuid(),
      forceRescore: z.boolean().optional().default(false),
    }).parse(await req.json());

    const { contestPoolId, forceRescore } = body;
    console.log('[scoring] Admin', user.id, 'scoring pool:', contestPoolId);

    const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_KEY);

    // Fetch requested pool
    const { data: requestedPool, error: requestedPoolError } = await supabaseAdmin
      .from('contest_pools')
      .select('contest_template_id, tier_id, status')
      .eq('id', contestPoolId)
      .single();

    if (requestedPoolError || !requestedPool) {
      return new Response(JSON.stringify({ error: 'Contest pool not found' }), {
        status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Find ALL sibling pools
    const { data: siblingPools, error: siblingsError } = await supabaseAdmin
      .from('contest_pools')
      .select('id, status')
      .eq('contest_template_id', requestedPool.contest_template_id);

    if (siblingsError) {
      return new Response(JSON.stringify({ error: 'Failed to fetch sibling pools' }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Copy crew results to siblings missing them
    const { data: sourceCrews } = await supabaseAdmin
      .from('contest_pool_crews')
      .select('crew_id, event_id, crew_name, manual_finish_order, manual_result_time')
      .eq('contest_pool_id', contestPoolId);

    if (sourceCrews && sourceCrews.length > 0) {
      const hasResults = sourceCrews.some((c: any) => c.manual_finish_order !== null);
      if (hasResults) {
        for (const sib of siblingPools || []) {
          if (sib.id === contestPoolId) continue;
          const { data: sibCrews } = await supabaseAdmin
            .from('contest_pool_crews')
            .select('crew_id, manual_finish_order')
            .eq('contest_pool_id', sib.id);
          const sibHasResults = sibCrews?.some((c: any) => c.manual_finish_order !== null);
          if (!sibHasResults && sibCrews && sibCrews.length > 0) {
            console.log('[scoring] Copying results to sibling', sib.id);
            for (const src of sourceCrews) {
              await supabaseAdmin
                .from('contest_pool_crews')
                .update({ manual_finish_order: src.manual_finish_order, manual_result_time: src.manual_result_time })
                .eq('contest_pool_id', sib.id)
                .eq('crew_id', src.crew_id);
            }
            if (sib.status === 'locked' || sib.status === 'open') {
              await supabaseAdmin.from('contest_pools').update({ status: 'results_entered' }).eq('id', sib.id);
              sib.status = 'results_entered';
            }
          }
        }
      }
    }

    // Filter to scorable pools
    const scorableStatuses = ['results_entered', 'locked', 'settling', 'scoring_completed'];
    const poolsToScore = siblingPools?.filter(p => scorableStatuses.includes(p.status)) || [];

    console.log('[scoring] Scorable pools:', poolsToScore.length);

    const scoringResults = [];
    let totalEntriesScored = 0;
    let poolsSuccessfullyScored = 0;
    let poolsSkipped = 0;

    for (const pool of poolsToScore) {
      const result = await scoreSinglePool(supabaseAdmin, pool.id, forceRescore);
      scoringResults.push(result);
      if (result.success && !result.skipped) {
        poolsSuccessfullyScored++;
        totalEntriesScored += result.entriesScored || 0;
      } else if (result.skipped) {
        poolsSkipped++;
      }
    }

    await supabaseAdmin.from('compliance_audit_logs').insert({
      admin_id: user.id,
      event_type: 'batch_pool_scoring',
      severity: 'info',
      description: `Admin batch-scored ${poolsSuccessfullyScored} sibling pools for template ${requestedPool.contest_template_id}`,
      metadata: {
        requested_pool_id: contestPoolId,
        contest_template_id: requestedPool.contest_template_id,
        pools_scored: poolsSuccessfullyScored,
        pools_skipped: poolsSkipped,
        total_entries_scored: totalEntriesScored,
        force_rescore: forceRescore,
        results: scoringResults,
      },
    });

    return new Response(JSON.stringify({
      success: true,
      poolsScored: poolsSuccessfullyScored,
      poolsSkipped,
      totalEntriesScored,
      message: `Batch scoring completed: ${poolsSuccessfullyScored} pool(s) scored, ${poolsSkipped} skipped`,
      details: scoringResults,
    }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  } catch (error: any) {
    console.error('[scoring] Error:', error);
    if (error instanceof z.ZodError) {
      return new Response(JSON.stringify({ error: 'Invalid input', details: error.flatten() }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ error: 'An internal error occurred during scoring' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
