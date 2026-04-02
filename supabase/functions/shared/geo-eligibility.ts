// IP Geolocation & State Eligibility Check with Strict Blocking

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.76.1';

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ipbaseApiKey = Deno.env.get('IPBASE_API_KEY')!;

// Blocked states: 5 banned + 23 restricted = 28 total
export const BLOCKED_STATES = [
  // Banned states
  'HI', 'ID', 'MT', 'NV', 'WA',
  // Restricted states  
  'AL', 'AZ', 'AR', 'CO', 'CT', 'DE', 'IN', 'IA', 'LA', 'ME', 
  'MD', 'MI', 'MS', 'MO', 'NH', 'NJ', 'NY', 'OH', 'PA', 'TN', 
  'VT', 'VA'
] as const;

export interface GeoEligibilityResult {
  allowed: boolean;
  stateCode?: string;
  stateName?: string;
  reason?: string;
}

// In-memory cache for IP lookups (24-hour TTL)
const ipCache = new Map<string, { stateCode: string; timestamp: number }>();
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Extract user's state from request headers
 * Supports: Vercel, Cloudflare, and custom headers
 */
export function getUserState(req: Request): string | null {
  const stateCode = 
    req.headers.get('x-vercel-ip-country-region') ||
    req.headers.get('cf-region-code') ||
    req.headers.get('x-region') ||
    req.headers.get('x-geo-state');
  
  return stateCode?.toUpperCase() || null;
}

/**
 * Check if a state is blocked
 */
export function isStateBlocked(stateCode: string): boolean {
  return BLOCKED_STATES.includes(stateCode.toUpperCase() as typeof BLOCKED_STATES[number]);
}

/**
 * Strict location eligibility check - throws error if blocked
 * Checks feature flag and admin bypass before enforcing geo restrictions.
 * Call this at the top of protected endpoints (contest-enter, wallet-deposit)
 */
export async function checkLocationEligibility(
  req: Request,
  userId?: string
): Promise<{ allowed: true; stateCode: string | null }> {
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  // Check if geo restrictions are enabled via feature flag
  const { data: flag } = await supabase
    .from('feature_flags')
    .select('value')
    .eq('key', 'ipbase_enabled')
    .single();

  const geoEnabled = (flag?.value as any)?.enabled === true;

  if (!geoEnabled) {
    console.log('[geo-eligibility] Geofencing is disabled via feature flag');
    return { allowed: true, stateCode: null };
  }

  // Check if user is an admin — admins always bypass geo restrictions
  if (userId) {
    const { data: adminRole } = await supabase
      .from('user_roles')
      .select('role')
      .eq('user_id', userId)
      .eq('role', 'admin')
      .maybeSingle();

    if (adminRole) {
      console.log('[geo-eligibility] Admin user detected, bypassing geo check');
      return { allowed: true, stateCode: null };
    }
  }

  // Proceed with normal geo check
  const stateCode = getUserState(req);
  
  if (!stateCode) {
    console.log('[geo-eligibility] No location header detected - allowing access');
    return { allowed: true, stateCode: null };
  }
  
  if (isStateBlocked(stateCode)) {
    console.log('[geo-eligibility] Blocking access from restricted state:', stateCode);
    throw new Error(`Location Restricted: RowFantasy is not currently available in ${stateCode}.`);
  }
  
  console.log('[geo-eligibility] Access allowed from state:', stateCode);
  return { allowed: true, stateCode };
}

/**
 * Get location blocking info for UI display
 */
export function getLocationBlockingInfo(req: Request): {
  detectedState: string | null;
  isBlocked: boolean;
  message: string;
} {
  const stateCode = getUserState(req);
  
  if (!stateCode) {
    return {
      detectedState: null,
      isBlocked: false,
      message: 'Unable to detect your location. Please ensure location services are enabled.'
    };
  }
  
  const blocked = isStateBlocked(stateCode);
  
  return {
    detectedState: stateCode,
    isBlocked: blocked,
    message: blocked 
      ? `Daily Fantasy Sports is not yet available in your region (${stateCode}). We're working to expand our coverage.`
      : `RowFantasy is available in ${stateCode}. Enjoy the competition!`
  };
}

// Legacy function - keeping for backward compatibility with existing geo checks
export async function checkGeoEligibility(
  ipAddress: string,
  userId?: string
): Promise<GeoEligibilityResult> {
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    // Check feature flag first
    const { data: flag } = await supabase
      .from('feature_flags')
      .select('value')
      .eq('key', 'ipbase_enabled')
      .single();

    const geoEnabled = (flag?.value as any)?.enabled === true;

    if (!geoEnabled) {
      console.log('[geo-eligibility] Geofencing is disabled via feature flag (legacy check)');
      return { allowed: true, reason: 'Geofencing disabled' };
    }

    // Check admin bypass
    if (userId) {
      const { data: adminRole } = await supabase
        .from('user_roles')
        .select('role')
        .eq('user_id', userId)
        .eq('role', 'admin')
        .maybeSingle();

      if (adminRole) {
        console.log('[geo-eligibility] Admin user detected, bypassing geo check (legacy)');
        return { allowed: true, reason: 'Admin bypass' };
      }
    }

    // Clean IP address
    const cleanIp = ipAddress.split(',')[0].trim();
    
    // Check cache first
    const cached = ipCache.get(cleanIp);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      console.log('[geo-eligibility] Using cached state for IP:', cleanIp, cached.stateCode);
      return await checkStateEligibility(supabase, cached.stateCode, userId);
    }

    // Call IPBase API
    console.log('[geo-eligibility] Fetching geolocation for IP:', cleanIp);
    const response = await fetch(
      `https://api.ipbase.com/v2/info?apikey=${ipbaseApiKey}&ip=${cleanIp}`
    );

    if (!response.ok) {
      console.error('[geo-eligibility] IPBase API error:', response.status);
      await logGeoEvent(supabase, {
        userId,
        ipAddress: cleanIp,
        isAllowed: true,
        actionType: 'api_failure',
        metadata: { error: 'IPBase API unavailable', status: response.status },
      });
      return { allowed: true, reason: 'Geolocation service unavailable' };
    }

    const data = await response.json();
    const stateCode = data?.data?.location?.region?.code || null;

    if (!stateCode) {
      console.warn('[geo-eligibility] No state code found for IP:', cleanIp);
      return { allowed: true, reason: 'Unable to determine state' };
    }

    // Cache the result
    ipCache.set(cleanIp, { stateCode, timestamp: Date.now() });
    console.log('[geo-eligibility] State detected:', stateCode);

    return await checkStateEligibility(supabase, stateCode, userId, cleanIp);

  } catch (error: any) {
    console.error('[geo-eligibility] Error:', error);
    await logGeoEvent(supabase, {
      userId,
      ipAddress,
      isAllowed: true,
      actionType: 'error',
      metadata: { error: error.message },
    });
    return { allowed: true, reason: 'Geolocation check failed' };
  }
}

async function checkStateEligibility(
  supabase: any,
  stateCode: string,
  userId?: string,
  ipAddress?: string
): Promise<GeoEligibilityResult> {
  if (isStateBlocked(stateCode)) {
    console.log('[geo-eligibility] State in blocked list:', stateCode);
    await logGeoEvent(supabase, {
      userId,
      ipAddress,
      stateDetected: stateCode,
      isAllowed: false,
      blockedReason: 'State is in blocked list',
      actionType: 'state_blocked',
    });
    return {
      allowed: false,
      stateCode,
      reason: `RowFantasy is not currently available in ${stateCode}`,
    };
  }

  const { data: stateRule, error: stateError } = await supabase
    .from('state_regulation_rules')
    .select('*')
    .eq('state_code', stateCode)
    .single();

  if (stateError || !stateRule) {
    console.error('[geo-eligibility] State rule not found:', stateCode);
    await logGeoEvent(supabase, {
      userId,
      ipAddress,
      stateDetected: stateCode,
      isAllowed: false,
      blockedReason: 'State not in database',
      actionType: 'state_check',
    });
    return {
      allowed: false,
      stateCode,
      reason: 'State regulations unavailable',
    };
  }

  if (stateRule.status === 'restricted' || stateRule.status === 'prohibited') {
    console.log('[geo-eligibility] State blocked:', stateCode, stateRule.status);
    await logGeoEvent(supabase, {
      userId,
      ipAddress,
      stateDetected: stateCode,
      isAllowed: false,
      blockedReason: `State is ${stateRule.status}`,
      actionType: 'state_blocked',
    });
    return {
      allowed: false,
      stateCode,
      stateName: stateRule.state_name,
      reason: `Service not available in ${stateRule.state_name}`,
    };
  }

  console.log('[geo-eligibility] State allowed:', stateCode, stateRule.status);
  await logGeoEvent(supabase, {
    userId,
    ipAddress,
    stateDetected: stateCode,
    isAllowed: true,
    actionType: 'state_allowed',
  });

  return {
    allowed: true,
    stateCode,
    stateName: stateRule.state_name,
  };
}

async function logGeoEvent(
  supabase: any,
  event: {
    userId?: string;
    ipAddress?: string;
    stateDetected?: string;
    isAllowed: boolean;
    blockedReason?: string;
    actionType: string;
    metadata?: Record<string, any>;
  }
) {
  try {
    await supabase.from('geofence_logs').insert({
      user_id: event.userId,
      ip_address: event.ipAddress,
      state_detected: event.stateDetected,
      is_allowed: event.isAllowed,
      blocked_reason: event.blockedReason,
      action_type: event.actionType,
      metadata: event.metadata,
    });
  } catch (error) {
    console.error('[geo-eligibility] Error logging geo event:', error);
  }
}
