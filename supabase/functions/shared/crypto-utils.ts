// Cryptographic Utilities

/**
 * Constant-time string comparison to prevent timing attacks.
 * Hashes both inputs to fixed-length digests to eliminate length leakage.
 */
export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);

  // Hash both inputs to fixed-length digests — eliminates length leakage
  const aHash = new Uint8Array(await crypto.subtle.digest('SHA-256', aBytes));
  const bHash = new Uint8Array(await crypto.subtle.digest('SHA-256', bBytes));

  // Constant-time comparison of fixed-length hashes
  if (aHash.length !== bHash.length) return false; // always 32, but defensive
  let result = 0;
  for (let i = 0; i < aHash.length; i++) {
    result |= aHash[i] ^ bHash[i];
  }

  // Only equal if both hashes match AND original lengths match
  // Length check is after the constant-time comparison to avoid early exit
  const lengthMatch = a.length === b.length ? 0 : 1;
  return (result | lengthMatch) === 0;
}

/**
 * Validate webhook timestamp is recent (within maxAgeSeconds)
 */
export function isTimestampValid(
  timestamp: string | number,
  maxAgeSeconds: number = 300
): boolean {
  try {
    const webhookTime = typeof timestamp === 'string' 
      ? new Date(timestamp).getTime() 
      : timestamp * 1000; // Assume Unix timestamp
    
    const now = Date.now();
    const age = (now - webhookTime) / 1000;

    return age >= 0 && age <= maxAgeSeconds;
  } catch {
    return false;
  }
}
