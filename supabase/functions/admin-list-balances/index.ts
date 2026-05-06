// admin-list-balances — admin-only bulk wallet balance read.
// Replaces direct `.from('wallets').select(...)` on the admin page.
//
// Flow:
//  1. authenticateUser via JWT (anon-key client).
//  2. requireAdmin gate (raises 403 internally if not admin).
//  3. Service-role client invokes admin_list_wallet_balances RPC, passing
//     auth.user.id as _admin_user_id. The RPC re-verifies admin and the
//     session_user (service_role) guard is the second-layer defense.
//
// Pattern mirrors admin-create-contest.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.76.1';
import { requireAdmin } from '../shared/auth-helpers.ts';
import { getCorsHeaders } from '../shared/cors.ts';

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);

  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== 'POST' && req.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Allow': 'GET, POST, OPTIONS' },
    });
  }

  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
    const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
    const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

    const supabase = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: req.headers.get('Authorization')! } },
    });

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    await requireAdmin(supabase, user.id);

    const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_KEY);

    const { data, error } = await supabaseAdmin.rpc('admin_list_wallet_balances', {
      _admin_user_id: user.id,
    });

    if (error) {
      console.error('[admin-list-balances] RPC error:', error);
      return new Response(JSON.stringify({ error: 'Failed to fetch balances' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response(
      JSON.stringify({ balances: data ?? [] }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (err: any) {
    console.error('[admin-list-balances] Error:', err);
    return new Response(JSON.stringify({ error: 'An error occurred' }), {
      status: 500,
      headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
    });
  }
});
