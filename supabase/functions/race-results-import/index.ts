// Race Results Import - Admin function to import race results and trigger scoring

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.76.1';
import { z } from 'https://deno.land/x/zod@v3.22.4/mod.ts';
import { crypto } from "https://deno.land/std@0.177.0/crypto/mod.ts";
import { scoreContestPool, calculateOfficialMargin, type RaceResult } from '../shared/scoring-logic.ts';
import { createErrorResponse } from '../shared/error-handler.ts';
import { requireAdmin } from '../shared/auth-helpers.ts';
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
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const authHeader = req.headers.get('Authorization')!;
    const supabase = createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: authHeader } },
    });

    // Authenticate user
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: 'Unauthorized' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Require admin role - throws if not admin
    await requireAdmin(supabase, user.id);

    // Create service client after admin verification
    const supabaseAdmin = createClient(supabaseUrl, serviceKey);

    // Validate input
    const importSchema = z.object({
      contestTemplateId: z.string().uuid(),
      regattaName: z.string(),
      results: z.array(z.object({
        crewId: z.string(),
        crewName: z.string(),
        divisionId: z.string(),
        divisionName: z.string(),
        finishPosition: z.number().int().min(1),
        finishTime: z.string().optional(),
        marginSeconds: z.number().optional(),
      })),
    });

    const body = importSchema.parse(await req.json());

    console.log('[race-results-import] Processing', body.results.length, 'results for', body.regattaName);

    // Validate contest template exists
    const { data: template, error: templateError } = await supabaseAdmin
      .from('contest_templates')
      .select('*')
      .eq('id', body.contestTemplateId)
      .single();

    if (templateError || !template) {
      return new Response(
        JSON.stringify({ error: 'Contest template not found' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Calculate hash for deduplication
    const encoder = new TextEncoder();
    const data = encoder.encode(JSON.stringify(body.results));
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const fileHash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

    // Check for duplicate import
    const { data: existingImport } = await supabaseAdmin
      .from('race_results_imports')
      .select('id')
      .eq('file_hash', fileHash)
      .maybeSingle();

    if (existingImport) {
      return new Response(
        JSON.stringify({ 
          error: 'These results have already been imported',
          importId: existingImport.id,
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Validation checks
    const errors = [];
    const validCrews = new Set(template.crews.map((c: any) => c.id));
    const validDivisions = new Set(template.divisions.map((d: any) => d.id));

    for (const result of body.results) {
      if (!validCrews.has(result.crewId)) {
        errors.push(`Invalid crew ID: ${result.crewId} (${result.crewName})`);
      }
      if (!validDivisions.has(result.divisionId)) {
        errors.push(`Invalid division ID: ${result.divisionId} (${result.divisionName})`);
      }
    }

    if (errors.length > 0) {
      return new Response(
        JSON.stringify({ 
          error: 'Validation failed',
          validationErrors: errors,
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Store import record
    const { data: importRecord, error: importError } = await supabaseAdmin
      .from('race_results_imports')
      .insert({
        contest_template_id: body.contestTemplateId,
        admin_id: user.id,
        regatta_name: body.regattaName,
        results_data: body.results,
        rows_processed: body.results.length,
        status: 'completed',
        file_hash: fileHash,
        errors: [],
      })
      .select()
      .single();

    if (importError) {
      console.error('[race-results-import] Error creating import record:', importError);
      return new Response(
        JSON.stringify({ error: 'Failed to save import record' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Update contest template with results
    await supabaseAdmin
      .from('contest_templates')
      .update({ 
        results: body.results,
        status: 'locked', // Lock contest when results are posted
      })
      .eq('id', body.contestTemplateId);

    // Get all pools for this template that are locked (ready for scoring)
    const { data: pools } = await supabaseAdmin
      .from('contest_pools')
      .select('id')
      .eq('contest_template_id', body.contestTemplateId)
      .in('status', ['locked', 'live']);

    // Convert imported results to RaceResult format for scoring
    // Group by division to calculate margins per event
    const divisionGroups = new Map<string, typeof body.results>();
    for (const result of body.results) {
      if (!divisionGroups.has(result.divisionId)) {
        divisionGroups.set(result.divisionId, []);
      }
      divisionGroups.get(result.divisionId)!.push(result);
    }

    // Build race results with margin calculation
    const raceResults: RaceResult[] = [];
    for (const [divisionId, divisionResults] of divisionGroups) {
      // Sort by finish position
      const sorted = [...divisionResults].sort((a, b) => a.finishPosition - b.finishPosition);
      
      // Calculate margin (time between 1st and 2nd)
      let officialMargin = 0;
      if (sorted.length >= 2 && sorted[0].marginSeconds !== undefined) {
        officialMargin = sorted[0].marginSeconds;
      }

      for (const result of sorted) {
        const raceResult: RaceResult = {
          crewId: result.crewId,
          eventId: result.divisionId, // Using divisionId as eventId
          finishOrder: result.finishPosition,
        };

        // Only 1st place gets actualMargin for margin bonus
        if (result.finishPosition === 1) {
          raceResult.actualMargin = officialMargin;
        }

        raceResults.push(raceResult);
      }
    }

    // Trigger scoring for all locked pools
    console.log('[race-results] Triggering scoring for', pools?.length || 0, 'pools');
    
    const scoringResults = [];
    if (pools) {
      for (const pool of pools) {
        try {
          const result = await scoreContestPool(
            supabaseAdmin,
            pool.id,
            raceResults
          );
          
          scoringResults.push({
            poolId: pool.id,
            success: true,
            entriesScored: result.entriesScored,
          });
          
          console.log('[race-results] Scoring completed for pool:', pool.id);
        } catch (error: any) {
          console.error('[race-results] Scoring failed for pool:', pool.id, error);
          scoringResults.push({
            poolId: pool.id,
            success: false,
            error: error.message,
          });
        }
      }
    }

    // Log to compliance
    await supabaseAdmin.from('compliance_audit_logs').insert({
      user_id: user.id,
      admin_id: user.id,
      event_type: 'race_results_imported',
      severity: 'info',
      description: `Race results imported for ${body.regattaName}`,
      metadata: {
        import_id: importRecord.id,
        contest_template_id: body.contestTemplateId,
        results_count: body.results.length,
        pools_scored: scoringResults.length,
      },
    });

    console.log('[race-results-import] Import complete:', importRecord.id);

    return new Response(
      JSON.stringify({
        success: true,
        importId: importRecord.id,
        rowsProcessed: body.results.length,
        poolsScored: pools?.length || 0,
        scoringResults,
        message: 'Results imported and scoring completed successfully',
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error: any) {
    return createErrorResponse(error, 'race-results-import', corsHeaders);
  }
});
