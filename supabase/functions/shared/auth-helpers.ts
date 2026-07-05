// Authentication and Authorization Helpers

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.76.1';

export interface AuthResult {
  user: any;
  supabase: any;
}

export interface AdminCheckResult {
  isAdmin: boolean;
  user: any;
}

/**
 * Authenticate user and return user + client
 */
export async function authenticateUser(
  req: Request,
  supabaseUrl: string,
  anonKey: string
): Promise<AuthResult | null> {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) {
    return null;
  }

  const supabase = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) {
    return null;
  }

  return { user, supabase };
}

/**
 * Verify user is admin
 */
export async function verifyAdmin(
  supabase: any,
  userId: string
): Promise<boolean> {
  const { data: roles } = await supabase
    .from('user_roles')
    .select('role')
    .eq('user_id', userId)
    .eq('role', 'admin');

  return roles && roles.length > 0;
}

/**
 * Authenticate and verify admin in one call
 */
export async function authenticateAdmin(
  req: Request,
  supabaseUrl: string,
  anonKey: string
): Promise<AdminCheckResult | null> {
  const auth = await authenticateUser(req, supabaseUrl, anonKey);
  if (!auth) {
    return null;
  }

  const isAdmin = await verifyAdmin(auth.supabase, auth.user.id);
  if (!isAdmin) {
    return null;
  }

  return { isAdmin: true, user: auth.user };
}

/**
 * Check rate limit for identifier (IP or user ID).
 *
 * SECURITY (batch 2): calls the atomic SECURITY DEFINER RPC
 * `check_rate_limit_atomic` which enforces the counter in ONE statement
 * (INSERT ... ON CONFLICT ... RETURNING). This eliminates the SELECT-then-write
 * race that previously allowed exceeding the limit under concurrency.
 *
 * The `supabase` client passed here MUST be a service-role client — the RPC's
 * EXECUTE is granted ONLY to service_role. If a JWT-scoped client is passed,
 * the RPC call fails and this function fails CLOSED (returns false).
 *
 * Fail-closed semantics: any RPC error → log + return false. These call sites
 * gate money/entry endpoints; a silent no-op is worse than a spurious 429.
 */
export async function checkRateLimit(
  supabase: any,
  identifier: string,
  endpoint: string,
  maxRequests: number = 100,
  windowMinutes: number = 1
): Promise<boolean> {
  try {
    const { data, error } = await supabase.rpc('check_rate_limit_atomic', {
      _identifier: identifier,
      _endpoint: endpoint,
      _max_requests: maxRequests,
      _window_minutes: windowMinutes,
    });

    if (error) {
      console.error('[checkRateLimit] RPC error (failing closed):', {
        endpoint,
        message: error.message,
        code: (error as any).code,
      });
      return false;
    }

    return data === true;
  } catch (err) {
    console.error('[checkRateLimit] Unexpected exception (failing closed):', {
      endpoint,
      message: (err as any)?.message,
    });
    return false;
  }
}

/**
 * Require admin role - throws if not admin
 */
export async function requireAdmin(supabase: any, userId: string): Promise<void> {
  const { data: roles, error } = await supabase
    .from('user_roles')
    .select('role')
    .eq('user_id', userId)
    .eq('role', 'admin');

  if (error || !roles || roles.length === 0) {
    throw new Error('Forbidden: Admin access required');
  }
}

/**
 * Check if real money transactions are enabled.
 *
 * Fail-safe semantics for gate callers (e.g. wallet-deposit mock-adapter block):
 *   - row absent (PostgREST PGRST116) → return false (flag genuinely unset)
 *   - any OTHER error → THROW so callers can fail closed and return a 503
 *     rather than silently opening the gate on a transient DB error.
 */
export async function isRealMoneyEnabled(supabase: any): Promise<boolean> {
  const { data: flag, error } = await supabase
    .from('feature_flags')
    .select('value')
    .eq('key', 'real_money_enabled')
    .single();

  if (error) {
    if ((error as any).code === 'PGRST116') {
      return false;
    }
    throw error;
  }

  return flag?.value?.enabled ?? false;
}

/**
 * Extract client IP from request
 */
export function getClientIp(req: Request): string {
  return req.headers.get('x-forwarded-for')?.split(',')[0].trim() 
    || req.headers.get('x-real-ip') 
    || req.headers.get('cf-connecting-ip')
    || 'unknown';
}
