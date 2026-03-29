import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.76.1';
import { getCorsHeaders } from '../shared/cors.ts';

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseAdmin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );

  // Use the database function for atomic locking + audit logging
  const { data: lockedCount, error } = await supabaseAdmin
    .rpc('auto_lock_expired_contests');

  if (error) {
    console.error('[auto-lock-contests] Error:', error);
    return new Response(
      JSON.stringify({ error: 'Failed to auto-lock contests' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  console.log(`[auto-lock-contests] Locked ${lockedCount} contest(s)`);

  return new Response(
    JSON.stringify({ success: true, lockedCount }),
    { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  );
});
