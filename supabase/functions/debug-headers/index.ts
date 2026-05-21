// =========================================================================
// TEMPORARY DIAGNOSTIC — header-logging endpoint for P0-C9 spoofability test.
// Deployed 2026-05-21. WILL BE REMOVED in an immediate follow-up prompt
// after the operator runs the test protocol. Do not leave deployed.
//
// Auth: required (any authenticated user). Mirrors the threat model of a
// direct-PostgREST attacker with a valid JWT.
//
// Geo skip-list: this function does NOT call performComplianceChecks. By
// construction it sees raw headers regardless of geo state — required for
// the spoofability test.
// =========================================================================
import { authenticateUser } from '../shared/auth-helpers.ts';
import { getCorsHeaders } from '../shared/cors.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

const GEO_RELEVANT_HEADERS = [
  'x-forwarded-for',
  'cf-connecting-ip',
  'cf-ipcountry',
  'cf-region-code',
  'cf-ipcity',
  'cf-iplongitude',
  'cf-iplatitude',
  'x-real-ip',
  'x-vercel-ip-country-region',
  'x-region',
  'x-geo-state',
  'x-supabase-region',
];

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  // Auth gate — any authenticated user. Mirrors threat model.
  const auth = await authenticateUser(req, SUPABASE_URL, ANON_KEY);
  if (!auth) {
    return new Response(
      JSON.stringify({ error: 'Unauthorized' }),
      { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
  const userId = auth.user.id;

  // Extract test label (optional query parameter).
  const url = new URL(req.url);
  const label = url.searchParams.get('label') ?? 'unlabeled';

  // Capture every header.
  const allHeaders: Record<string, string> = {};
  for (const [k, v] of req.headers.entries()) {
    allHeaders[k] = v;
  }

  // Pick out the geo-relevant ones for easy reading.
  const geoRelevant: Record<string, string | null> = {};
  for (const h of GEO_RELEVANT_HEADERS) {
    geoRelevant[h] = req.headers.get(h);
  }

  const payload = {
    label,
    user_id: userId,
    timestamp: new Date().toISOString(),
    geo_relevant: geoRelevant,
    all_headers: allHeaders,
  };

  console.log('[debug-headers]', JSON.stringify(payload));

  return new Response(JSON.stringify(payload, null, 2), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
