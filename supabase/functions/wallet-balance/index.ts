// Wallet Balance - Get user's current balance from double-entry ledger

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.76.1';
import { authenticateUser } from '../shared/auth-helpers.ts';
import { mapErrorToClient, logSecureError, ERROR_MESSAGES } from '../shared/error-handler.ts';
import { getCorsHeaders } from '../shared/cors.ts';

const handler = async (req: Request) => {
  const corsHeaders = getCorsHeaders(req);

  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json', Allow: 'POST, OPTIONS' },
    });
  }

  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
    const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

    const auth = await authenticateUser(req, SUPABASE_URL, ANON_KEY);
    if (!auth) {
      return new Response(
        JSON.stringify({ error: ERROR_MESSAGES.UNAUTHORIZED }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Call the get_user_balance RPC (no args; uses auth.uid() internally)
    const { data: balanceCents, error: rpcError } = await auth.supabase.rpc('get_user_balance');

    if (rpcError) {
      const requestId = logSecureError('wallet-balance', rpcError);
      return new Response(
        JSON.stringify({ error: mapErrorToClient(rpcError), requestId }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const cents = Number(balanceCents ?? 0);

    return new Response(
      JSON.stringify({
        balanceCents: cents,
        balanceDisplay: `$${(cents / 100).toFixed(2)}`,
        lastUpdated: new Date().toISOString(),
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error: any) {
    const requestId = logSecureError('wallet-balance', error);
    return new Response(
      JSON.stringify({ error: mapErrorToClient(error), requestId }),
      { status: 500, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } }
    );
  }
};

Deno.serve(handler);
