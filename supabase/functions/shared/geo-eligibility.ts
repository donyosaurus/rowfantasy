// IP Geolocation & State Eligibility Check with Strict Blocking


// Blocked states: 5 banned + 22 restricted = 27 total
export const BLOCKED_STATES = [
  // Banned states
  'HI', 'ID', 'MT', 'NV', 'WA',
  // Restricted states  
  'AL', 'AZ', 'AR', 'CO', 'CT', 'DE', 'IN', 'IA', 'LA', 'ME', 
  'MD', 'MI', 'MS', 'MO', 'NH', 'NJ', 'NY', 'OH', 'PA', 'TN', 
  'VT', 'VA'
] as const;


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
 * P0-W4 Step 1: Verify the Cloudflare Worker's HMAC-signed state header.
 *
 * Returns { stateCode, verified: true } only if ALL of these hold:
 *   - All 4 headers present: x-verified-geo-state, x-verified-geo-country, x-verified-geo-ts, x-worker-verified
 *   - WORKER_SHARED_SECRET env var set (read at runtime, not module load)
 *   - Timestamp drift |now - ts| <= 60 seconds (replay protection)
 *   - HMAC-SHA256(WORKER_SHARED_SECRET, `${fnName}|${state}|${country}|${ts}`) matches x-worker-verified header
 *     (using constant-time comparison to prevent timing-side-channel oracles)
 *   - fnName extracted from the request URL pathname (last segment after /functions/v1/)
 *
 * Returns null on any failure. NEVER throws. NEVER logs the expected vs actual signature
 * (avoid leaking secret-validation oracle to attackers).
 *
 * IMPORTANT: This function is consumed by performComplianceChecks. On null return,
 * performComplianceChecks fails closed — no fallback geolocation source exists.
 */
export async function getVerifiedWorkerState(
  req: Request
): Promise<{ stateCode: string; verified: true } | null> {
  const stateHeader = req.headers.get('x-verified-geo-state');
  const countryHeader = req.headers.get('x-verified-geo-country');
  const tsHeader = req.headers.get('x-verified-geo-ts');
  const sigHeader = req.headers.get('x-worker-verified');
  const secret = Deno.env.get('WORKER_SHARED_SECRET');

  if (!stateHeader || !countryHeader || !tsHeader || !sigHeader || !secret) {
    return null;
  }

  // Replay protection: reject signatures older than 60 seconds
  const ts = parseInt(tsHeader, 10);
  if (!Number.isFinite(ts)) return null;
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - ts) > 60) return null;

  // Extract function name from URL: last path segment
  let fnName: string;
  try {
    const segments = new URL(req.url).pathname.split('/').filter(Boolean);
    fnName = segments[segments.length - 1] || '';
    if (!fnName) return null;
  } catch {
    return null;
  }


  const payload = `${fnName}|${stateHeader}|${countryHeader}|${tsHeader}`;
  const enc = new TextEncoder();

  try {
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      enc.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const sigBytes = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(payload));
    const expectedHex = Array.from(new Uint8Array(sigBytes))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');

    // Constant-time string comparison
    if (expectedHex.length !== sigHeader.length) return null;
    let mismatch = 0;
    for (let i = 0; i < expectedHex.length; i++) {
      mismatch |= expectedHex.charCodeAt(i) ^ sigHeader.charCodeAt(i);
    }
    if (mismatch !== 0) return null;
  } catch {
    return null;
  }

  return { stateCode: stateHeader.toUpperCase(), verified: true };
}

/**
 * Check if a state is blocked
 */
export function isStateBlocked(stateCode: string): boolean {
  return BLOCKED_STATES.includes(stateCode.toUpperCase() as typeof BLOCKED_STATES[number]);
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
