import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.76.1';
import { requireAdmin } from '../shared/auth-helpers.ts';
import { getCorsHeaders } from '../shared/cors.ts';

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

    const body: CreateContestRequest = await req.json();
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
});
