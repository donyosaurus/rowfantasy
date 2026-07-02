// admin-contest-resize
// Admin-only: lower a contest pool's max_entries, rescale prizes, repair current_entries.
// All logic lives in admin_resize_contest_pool_atomic (SECURITY DEFINER, service_role only).

import { withFnVersion } from '../shared/fn-version.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.76.1';
import { z } from 'https://esm.sh/zod@3.23.8';
import { getCorsHeaders } from '../shared/cors.ts';
import { authenticateUser } from '../shared/auth-helpers.ts';
import { mapErrorToClient, logSecureError, ERROR_MESSAGES } from '../shared/error-handler.ts';

const bodySchema = z.object({
  contestPoolId: z.string().uuid(),
  newMaxEntries: z.number().int().positive(),
});

const REASON_MESSAGES: Record<string, string> = {
  pool_not_found: 'Contest pool not found',
  pool_not_resizable: 'Pool is not in a resizable state (must be open or locked)',
  new_max_below_minimum: 'New max entries must be at least 2',
  up_resize_forbidden: 'Increasing pool size is not allowed',
  below_active_count: 'New max entries is below the number of existing active entries',
  locked_requires_exact_active: 'Locked pools must be resized to exactly the active entry count',
  overflow_must_be_disabled: 'Disable auto-pooling (allow_overflow) before resizing an open pool',
  single_user_would_dominate: 'A single user would fill the entire resized pool',
  invalid_payout_structure: 'Pool has an invalid payout structure',
  invalid_payout_rank_key: 'Payout structure has an invalid rank key',
  invalid_payout_value: 'Payout structure has an invalid cent value',
  new_max_below_paid_ranks: 'New max entries is below the highest paid rank',
  prize_scales_to_zero: 'A prize would round down to zero at the new pool size',
};

Deno.serve(withFnVersion('admin-contest-resize', async (req) => {
  const corsHeaders = getCorsHeaders(req);

  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json', Allow: 'POST, OPTIONS' },
    });
  }

  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
    const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
    const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    const auth = await authenticateUser(req, SUPABASE_URL, ANON_KEY);
    if (!auth) {
      return new Response(JSON.stringify({ error: ERROR_MESSAGES.UNAUTHORIZED }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const userId = auth.user.id;

    const { data: roleRow } = await auth.supabase
      .from('user_roles')
      .select('role')
      .eq('user_id', userId)
      .eq('role', 'admin')
      .maybeSingle();

    if (!roleRow) {
      return new Response(JSON.stringify({ error: 'Admin access required' }), {
        status: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    let rawBody: unknown;
    try {
      rawBody = await req.json();
    } catch {
      return new Response(JSON.stringify({ error: ERROR_MESSAGES.INVALID_INPUT }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const parsed = bodySchema.safeParse(rawBody);
    if (!parsed.success) {
      return new Response(
        JSON.stringify({
          error: ERROR_MESSAGES.INVALID_INPUT,
          details: parsed.error.flatten().fieldErrors,
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }
    const { contestPoolId, newMaxEntries } = parsed.data;

    const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_KEY);

    const { data, error } = await supabaseAdmin.rpc('admin_resize_contest_pool_atomic', {
      _pool_id: contestPoolId,
      _admin_user_id: userId,
      _new_max_entries: newMaxEntries,
    });

    if (error) {
      const requestId = logSecureError('admin-contest-resize', error, {
        contestPoolId,
        newMaxEntries,
      });
      return new Response(
        JSON.stringify({ error: mapErrorToClient(error), requestId }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const row = Array.isArray(data) ? data[0] : data;
    if (!row) {
      return new Response(
        JSON.stringify({ error: 'Resize returned no result' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    if (row.allowed === false) {
      const message = REASON_MESSAGES[row.reason] ?? `Resize refused: ${row.reason}`;
      return new Response(
        JSON.stringify({
          error: message,
          reason: row.reason,
          oldMaxEntries: row.old_max_entries,
          newMaxEntries: row.new_max_entries,
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    return new Response(
      JSON.stringify({
        success: true,
        allowed: row.allowed,
        reason: row.reason,
        oldMaxEntries: row.old_max_entries,
        newMaxEntries: row.new_max_entries,
        newPayoutStructure: row.new_payout_structure,
        newPrizePoolCents: row.new_prize_pool_cents,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (err: any) {
    const requestId = logSecureError('admin-contest-resize', err);
    return new Response(
      JSON.stringify({ error: mapErrorToClient(err), requestId }),
      { status: 500, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } },
    );
  }
}));
