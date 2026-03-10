import { createClient } from "https://esm.sh/@supabase/supabase-js@2.76.1";
import { getLocationBlockingInfo, getUserState, isStateBlocked, BLOCKED_STATES } from '../shared/geo-eligibility.ts';
import { getCorsHeaders } from '../shared/cors.ts';

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? ''
    );

    // Get location info from request headers
    const locationInfo = getLocationBlockingInfo(req);
    
    // Handle explicit state code from query/body (for manual lookups)
    let explicitStateCode: string | null = null;
    
    if (req.method === 'GET') {
      const url = new URL(req.url);
      explicitStateCode = url.searchParams.get('state');
    } else if (req.method === 'POST') {
      try {
        const body = await req.json();
        explicitStateCode = body.state || null;
      } catch {
        // No body or invalid JSON, use header-based detection
      }
    }

    // Use explicit state if provided, otherwise use detected state
    const stateCode = explicitStateCode?.toUpperCase() || locationInfo.detectedState;
    
    if (!stateCode) {
      return new Response(
        JSON.stringify({
          detectedState: null,
          isBlocked: false,
          message: 'Unable to detect your location. Please ensure location services are enabled.',
          state: null,
          license: null
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const isBlocked = isStateBlocked(stateCode);

    // Get state regulation rules
    const { data: stateRule, error: stateError } = await supabase
      .from('state_regulation_rules')
      .select('*')
      .eq('state_code', stateCode)
      .maybeSingle();

    if (stateError) {
      console.error('[legal-state-banner] Error fetching state rules:', stateError);
    }

    // Get license info if applicable
    let license = null;
    if (stateRule && (stateRule.status === 'regulated' || stateRule.license_required)) {
      const { data: licenseData } = await supabase
        .from('license_registry')
        .select('*')
        .eq('state_code', stateCode)
        .eq('status', 'active')
        .order('issued_date', { ascending: false })
        .limit(1)
        .maybeSingle();
      
      license = licenseData;
    }

    // Build response message
    let message: string;
    if (isBlocked) {
      message = `Daily Fantasy Sports is not yet available in your region (${stateCode}). We're working to expand our coverage.`;
    } else if (stateRule) {
      message = `RowFantasy is available in ${stateRule.state_name || stateCode}. Enjoy the competition!`;
    } else {
      message = `RowFantasy is available in ${stateCode}. Enjoy the competition!`;
    }

    console.log('[legal-state-banner] State check:', { stateCode, isBlocked, hasRule: !!stateRule });

    return new Response(
      JSON.stringify({ 
        detectedState: stateCode,
        isBlocked,
        message,
        state: stateRule,
        license,
        blockedStates: BLOCKED_STATES
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('[legal-state-banner] Error:', error);
    return new Response(
      JSON.stringify({ 
        error: 'Internal server error',
        detectedState: null,
        isBlocked: false,
        message: 'Unable to determine location status'
      }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
