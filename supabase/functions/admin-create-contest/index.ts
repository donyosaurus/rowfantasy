import { withFnVersion } from '../shared/fn-version.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.76.1';
import { requireAdmin } from '../shared/auth-helpers.ts';
import { getCorsHeaders } from '../shared/cors.ts';
import { z } from 'https://deno.land/x/zod@v3.22.4/mod.ts';
import { ScoringConfigSchema } from '../shared/scoring-logic.ts';

// ---- v2 (multi-sport) request shape ----
const RaceSchema = z.object({
  race_key: z.string().min(1),
  name: z.string().optional(),
  race_order: z.number().int().optional(),
  event_class: z.string().nullable().optional(),
  division: z.string().nullable().optional(),
  round: z.string().nullable().optional(),
  distance: z.string().nullable().optional(),
  scheduled_at: z.string().nullable().optional(),
  round_no: z.number().int().min(1).optional(),
}).strict();

// Survivor only: the elimination ladder. Round 1's lock_at must equal lockTime
// (enforced by admin_create_contest_v2).
const RoundSchema = z.object({
  round_no: z.number().int().min(1),
  lock_at: z.string().datetime({ offset: true }),
  advance_count: z.number().int().min(1),
}).strict();

const CompetitorSchema = z.object({
  competitor_key: z.string().min(1),
  name: z.string().optional(),
  logo_url: z.string().nullable().optional(),
  competitor_type: z.string().optional(),
}).strict();

const RaceEntrySchema = z.object({
  race_key: z.string().min(1),
  competitor_key: z.string().min(1),
  seed_time_ms: z.number().int().nullable().optional(),
}).strict();

const CreateContestV2Schema = z.object({
  name: z.string().min(1),
  sport: z.string().min(1),
  genderCategory: z.enum(["Men's", "Women's", "Mixed", "Open"]),
  lockTime: z.string().min(1),
  races: z.array(RaceSchema).min(1),
  competitors: z.array(CompetitorSchema).min(2),
  raceEntries: z.array(RaceEntrySchema).min(2),
  entryFeeCents: z.number().int().nonnegative(),
  maxEntries: z.number().int().min(2),
  payouts: z.record(z.string(), z.number().int().positive()).optional(),
  entryTiers: z.array(z.any()).nullable().optional(),
  allowOverflow: z.boolean().optional(),
  voidUnfilledOnSettle: z.boolean().optional(),
  cardBannerUrl: z.string().nullable().optional(),
  draftBannerUrl: z.string().nullable().optional(),
  contestGroupId: z.string().uuid().nullable().optional(),
  primitive: z.enum(["placement", "time_vs_ref", "survivor", "prediction"]).optional(),
  rounds: z.array(RoundSchema).min(2).optional(),
  rosterMode: z.enum(["per_race", "per_competitor"]).optional(),
  scoringConfig: ScoringConfigSchema.optional(),
  minPicks: z.number().int().optional(),
  maxPicks: z.number().int().optional(),
}).strict();


interface CrewInput {
  crew_name: string;
  crew_id: string;
  event_id: string;
  logo_url?: string | null;
}

interface EntryTierInput {
  name: string;
  entry_fee_cents: number;
  payout_structure: Record<string, number>;
}

interface CreateContestRequest {
  regattaName: string;
  genderCategory: string;
  entryFeeCents: number;
  maxEntries: number;
  lockTime: string;
  crews: CrewInput[];
  payouts: Record<string, number>;
  allowOverflow?: boolean;
  entryTiers?: EntryTierInput[] | null;
  cardBannerUrl?: string | null;
  draftBannerUrl?: string | null;
  contestGroupId?: string | null;
  voidUnfilledOnSettle?: boolean;
}

const VALID_GENDER_CATEGORIES = ["Men's", "Women's", "Mixed"];

function validateRequest(body: CreateContestRequest): string | null {
  if (!body.regattaName || body.regattaName.trim() === '') return 'Regatta name is required';
  if (!body.genderCategory || !VALID_GENDER_CATEGORIES.includes(body.genderCategory)) return `Gender category must be one of: ${VALID_GENDER_CATEGORIES.join(', ')}`;
  if (!body.lockTime) return 'Lock time is required';
  const lockDate = new Date(body.lockTime);
  if (isNaN(lockDate.getTime())) return 'Invalid lock time format';
  if (lockDate <= new Date()) return 'Lock time must be in the future';
  if (!Array.isArray(body.crews) || body.crews.length < 2) return 'At least 2 crews are required';
  for (let i = 0; i < body.crews.length; i++) {
    const crew = body.crews[i];
    if (!crew.crew_name || !crew.crew_id || !crew.event_id) return `Crew at index ${i} is missing required fields`;
  }
  if (typeof body.entryFeeCents !== 'number' || body.entryFeeCents < 0) return 'Entry fee must be a non-negative number';
  if (typeof body.maxEntries !== 'number' || body.maxEntries < 2) return 'Max entries must be at least 2';
  if (!body.payouts || typeof body.payouts !== 'object') return 'Payouts structure is required';
  if (!body.payouts['1'] || body.payouts['1'] <= 0) return 'At least a 1st place prize is required';
  for (const [rank, amount] of Object.entries(body.payouts)) {
    const rankNum = parseInt(rank);
    if (isNaN(rankNum) || rankNum < 1) return `Invalid rank '${rank}' in payouts`;
    if (typeof amount !== 'number' || amount <= 0 || !Number.isInteger(amount)) return `Invalid payout amount for rank ${rank}`;
  }
  return null;
}

Deno.serve(withFnVersion('admin-create-contest', async (req) => {
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
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: req.headers.get('Authorization')! } } }
    );

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    await requireAdmin(supabase, user.id);

    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    const rawBody: any = await req.json();

    const hasCrews = rawBody && typeof rawBody === 'object' && rawBody.crews !== undefined;
    const hasRaces = rawBody && typeof rawBody === 'object' && rawBody.races !== undefined;

    if (hasCrews && hasRaces) {
      return new Response(JSON.stringify({ error: 'Provide either crews (v1) or races (v2), not both' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ---- v2 path ----
    if (hasRaces) {
      const parsed = CreateContestV2Schema.safeParse(rawBody);
      if (!parsed.success) {
        return new Response(JSON.stringify({ error: 'Invalid input', details: parsed.error.flatten() }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      const v2 = parsed.data;

      const bad = (msg: string) => new Response(JSON.stringify({ error: msg }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });

      const primitive = v2.primitive ?? v2.scoringConfig?.primitive ?? 'placement';
      const rosterMode = v2.rosterMode ?? (primitive === 'time_vs_ref' ? 'per_race' : 'per_race');

      if (rosterMode === 'per_competitor' && primitive !== 'time_vs_ref' && primitive !== 'placement') {
        return bad("rosterMode 'per_competitor' requires primitive 'time_vs_ref' or 'placement'");
      }
      if (rosterMode === 'per_competitor' && primitive === 'placement' && !v2.scoringConfig) {
        return bad('per-competitor placement requires an explicit scoringConfig');
      }
      if (
        rosterMode === 'per_competitor' && primitive === 'placement' &&
        v2.scoringConfig && v2.scoringConfig.tiebreak !== 'none'
      ) {
        return bad("per-competitor placement requires tiebreak 'none'");
      }
      if ((primitive === 'time_vs_ref' || rosterMode === 'per_competitor') && !v2.scoringConfig) {
        return bad('time contests require an explicit scoringConfig');
      }
      if (v2.primitive && v2.scoringConfig && v2.primitive !== v2.scoringConfig.primitive) {
        return bad('primitive does not match scoringConfig.primitive');
      }

      // ---- Phase 4c-2: prediction (Podium Predictor) — mirrors admin_create_contest_v2 ----
      if (primitive === 'prediction') {
        if (v2.entryFeeCents !== 0 || (v2.entryTiers !== undefined && v2.entryTiers !== null)) {
          return bad('prediction contests must be free');
        }
        if (v2.rounds) {
          return bad('prediction contests do not use rounds');
        }
        if (!v2.scoringConfig || v2.scoringConfig.primitive !== 'prediction') {
          return bad('prediction contests require an explicit scoringConfig');
        }
        if (v2.races.length !== 1) {
          return bad('prediction contests take exactly one race');
        }
        if (
          typeof v2.minPicks !== 'number' || typeof v2.maxPicks !== 'number' ||
          v2.minPicks !== v2.maxPicks || v2.minPicks !== v2.scoringConfig.podium_size
        ) {
          return bad('prediction pick count must equal podium_size');
        }
      }

      if (primitive === 'survivor') {
        if (!v2.scoringConfig) {
          return bad('survivor contests require an explicit scoringConfig');
        }
        if (!v2.rounds) {
          return bad('survivor contests require rounds');
        }
        if (
          typeof v2.minPicks !== 'number' || typeof v2.maxPicks !== 'number' ||
          v2.minPicks !== v2.maxPicks || v2.minPicks < 2
        ) {
          return bad('survivor contests require a fixed pick count of at least 2');
        }
      } else if (v2.rounds) {
        return bad('rounds is only valid for survivor contests');
      }

      const lockDate = new Date(v2.lockTime);
      if (isNaN(lockDate.getTime())) {
        return new Response(JSON.stringify({ error: 'Invalid lock time format' }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      if (lockDate <= new Date()) {
        return new Response(JSON.stringify({ error: 'Lock time must be in the future' }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      if (v2.entryFeeCents > 0 && v2.races.length < 2) {
        return new Response(JSON.stringify({ error: 'Paid contests require at least 2 races' }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const cfg = v2.scoringConfig;
      if (cfg) {
        const fixedRosterRequired = cfg.primitive === 'time_vs_ref' || cfg.primitive === 'prediction' ||
          (cfg.primitive === 'placement' && (cfg.direction === 'low' || cfg.tiebreak === 'aggregate_time'));
        if (fixedRosterRequired) {
          if (
            typeof v2.minPicks !== 'number' || typeof v2.maxPicks !== 'number' ||
            v2.minPicks !== v2.maxPicks
          ) {
            return new Response(
              JSON.stringify({ error: 'fixed roster size required for low-score / aggregate-time contests' }),
              { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
            );
          }
        }

        if (cfg.tiebreak === 'aggregate_time' || (cfg.primitive === 'time_vs_ref' && cfg.time_ref === 'none')) {
          const classes = v2.races.map((r) => (typeof r.event_class === 'string' ? r.event_class.trim() : ''));
          const allPresent = classes.every((c) => c.length > 0);
          const allSame = new Set(classes).size === 1;
          if (!allPresent || !allSame) {
            return new Response(
              JSON.stringify({ error: 'total-time tiebreak requires all races to share event_class' }),
              { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
            );
          }
        }
      }

      if (rosterMode === 'per_competitor') {
        const entriesByCompetitor = new Map<string, Set<string>>();
        for (const re of v2.raceEntries) {
          if (!entriesByCompetitor.has(re.competitor_key)) entriesByCompetitor.set(re.competitor_key, new Set());
          entriesByCompetitor.get(re.competitor_key)!.add(re.race_key);
        }
        const raceKeys = v2.races.map((r) => r.race_key);
        const everywhere = v2.competitors.every((c) => {
          const set = entriesByCompetitor.get(c.competitor_key);
          return !!set && raceKeys.every((rk) => set.has(rk));
        });
        if (!everywhere) {
          return bad('GC contests require every competitor entered in every race/stage');
        }
        if (typeof v2.maxPicks === 'number' && v2.maxPicks > v2.competitors.length) {
          return bad('maxPicks exceeds competitor count');
        }
      }

      console.log('Creating contest (v2):', { name: v2.name, sport: v2.sport, admin: user.id });

      const { data: v2Data, error: v2Error } = await supabaseAdmin.rpc('admin_create_contest_v2', {
        p_name: v2.name,
        p_sport: v2.sport,
        p_gender_category: v2.genderCategory,
        p_lock_time: v2.lockTime,
        p_races: v2.races,
        p_competitors: v2.competitors,
        p_race_entries: v2.raceEntries,
        p_entry_fee_cents: v2.entryFeeCents,
        p_max_entries: v2.maxEntries,
        p_payout_structure: v2.payouts ?? null,
        p_entry_tiers: v2.entryTiers ?? null,
        p_allow_overflow: v2.allowOverflow ?? false,
        p_void_unfilled_on_settle: v2.voidUnfilledOnSettle ?? false,
        p_card_banner_url: v2.cardBannerUrl ?? null,
        p_draft_banner_url: v2.draftBannerUrl ?? null,
        p_contest_group_id: v2.contestGroupId ?? null,
        p_primitive: primitive,
        p_roster_mode: rosterMode,
        p_scoring_config: v2.scoringConfig ?? null,
        p_min_picks: v2.minPicks ?? 2,
        p_max_picks: v2.maxPicks ?? 4,
        _admin_user_id: user.id,
        p_rounds: v2.rounds ?? null,
      });

      if (v2Error) {
        console.error('Error creating contest (v2):', v2Error);
        return new Response(JSON.stringify({ error: 'Failed to create contest' }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      await supabaseAdmin.from('compliance_audit_logs').insert({
        admin_id: user.id,
        event_type: 'contest_created',
        description: `Admin created contest: ${v2.name}`,
        severity: 'info',
        metadata: { contest: v2Data, sport: v2.sport },
      });

      return new Response(JSON.stringify(v2Data ?? { success: true }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const body: CreateContestRequest = rawBody as CreateContestRequest;
    const validationError = validateRequest(body);

    if (validationError) {
      return new Response(JSON.stringify({ error: validationError }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log('Creating contest:', { regattaName: body.regattaName, admin: user.id });

    const rpcParams: any = {
      p_regatta_name: body.regattaName,
      p_gender_category: body.genderCategory,
      p_entry_fee_cents: body.entryFeeCents,
      p_max_entries: body.maxEntries,
      p_lock_time: body.lockTime,
      p_crews: body.crews,
      p_payout_structure: body.payouts,
      p_allow_overflow: body.allowOverflow ?? false,
      p_entry_tiers: body.entryTiers ?? null,
      p_card_banner_url: body.cardBannerUrl ?? null,
      p_draft_banner_url: body.draftBannerUrl ?? null,
      p_contest_group_id: body.contestGroupId ?? null,
      p_void_unfilled_on_settle: body.voidUnfilledOnSettle ?? false,
      _admin_user_id: user.id,
    };

    const { data, error } = await supabaseAdmin.rpc('admin_create_contest', rpcParams);

    if (error) {
      console.error('Error creating contest:', error);
      return new Response(JSON.stringify({ error: 'Failed to create contest' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    await supabaseAdmin.from('compliance_audit_logs').insert({
      admin_id: user.id,
      event_type: 'contest_created',
      description: `Admin created contest: ${body.regattaName}`,
      severity: 'info',
      metadata: {
        contest_template_id: data?.contest_template_id,
        contest_pool_id: data?.contest_pool_id,
      },
    });

    return new Response(
      JSON.stringify({
        success: true,
        contestTemplateId: data?.contest_template_id,
        contestPoolId: data?.contest_pool_id,
        crewsAdded: data?.crews_added,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Error in admin-create-contest:', error);
    return new Response(
      JSON.stringify({ error: 'An error occurred' }),
      { status: 500, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } }
    );
  }
}));
