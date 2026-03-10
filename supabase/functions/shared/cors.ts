// Centralized CORS configuration for all edge functions

const ALLOWED_ORIGINS = [
  'https://rowfantasy.com',
  'https://www.rowfantasy.com',
  'https://rowfantasy.lovable.app',
  'https://id-preview--2b69429d-ad5f-4e48-8f93-e8587ead9e3c.lovable.app',
];

export function getCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('origin') || '';
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
    'Access-Control-Allow-Credentials': 'true',
    'Vary': 'Origin',
  };
}
