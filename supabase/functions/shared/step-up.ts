// Step-up verification helper.
// Sensitive edge functions call requireStepUp() to enforce that the caller has
// completed an email-OTP challenge within the last 5 minutes for the given purpose.

export type StepUpPurpose = 'withdraw' | 'responsible_limits' | 'password_change';

export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Verify a step-up token from the x-step-up-token header (or body).
 * The token is consumed on success (single-use).
 *
 * @returns { ok: true } on success, { ok: false, status, error } on failure.
 */
export async function requireStepUp(
  supabaseAdmin: any,
  userId: string,
  purpose: StepUpPurpose,
  token: string | null | undefined,
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  if (!token || typeof token !== 'string' || token.length < 16) {
    return { ok: false, status: 401, error: 'Step-up verification required' };
  }
  const tokenHash = await sha256Hex(token);
  const { data, error } = await supabaseAdmin.rpc('consume_step_up_token', {
    _user_id: userId,
    _token_hash: tokenHash,
    _purpose: purpose,
  });
  if (error) {
    console.error('[step-up] consume_step_up_token error', error);
    return { ok: false, status: 500, error: 'Step-up verification failed' };
  }
  if (data !== true) {
    return { ok: false, status: 401, error: 'Step-up token invalid or expired' };
  }
  return { ok: true };
}
