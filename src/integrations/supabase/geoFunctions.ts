// P0-W4 Step 3: Geo-proxy wrapper for geo-gated edge function calls.
//
// When the app is served from rowfantasy.com, route calls through the Cloudflare
// Worker proxy so the worker can inject HMAC-signed geo headers (consumed by
// supabase/functions/shared/geo-eligibility.ts#getVerifiedWorkerState).
// On localhost, Lovable preview, or any other host, fall back to the normal
// supabase client invoke path so nothing breaks.

import { supabase } from '@/integrations/supabase/client';

type InvokeResult = { data: any; error: { message: string } | null };

export async function invokeGeoFunction(
  functionName: string,
  options: { body: Record<string, unknown> }
): Promise<InvokeResult> {
  const GEO_PROXY_HOSTS = ['rowfantasy.com', 'www.rowfantasy.com'];
  const isProxiedHost = typeof window !== 'undefined' && GEO_PROXY_HOSTS.includes(window.location.hostname);
  const proxyBase = isProxiedHost ? 'https://rowfantasy.com/api/edge' : null;

  if (!proxyBase) {
    return supabase.functions.invoke(functionName, options) as Promise<InvokeResult>;
  }

  try {
    const { data: sessionData } = await supabase.auth.getSession();
    const accessToken = sessionData.session?.access_token ?? '';
    const apikey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string;

    const response = await fetch(`${proxyBase}/${functionName}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        apikey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(options.body),
    });

    if (response.ok) {
      const data = await response.json();
      return { data, error: null };
    }

    let body: any = null;
    try {
      body = await response.json();
    } catch {
      // ignore parse failure
    }
    return {
      data: null,
      error: {
        message:
          body?.error ||
          body?.message ||
          `Edge function returned status ${response.status}`,
      },
    };
  } catch {
    return {
      data: null,
      error: { message: `Network error calling ${functionName}` },
    };
  }
}
