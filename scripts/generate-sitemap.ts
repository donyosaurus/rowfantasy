/**
 * Sitemap generator — runs at `prebuild` time.
 *
 * Emits `public/sitemap.xml` containing:
 *   - Static public marketing/legal/help routes from src/App.tsx
 *   - Dynamic published help_articles (slugs)
 *   - Dynamic open/locked contest_templates (ids)
 *
 * Auth-required routes (/profile, /admin, /my-entries, /wallet/*, /login, /signup)
 * are explicitly excluded.
 *
 * Supabase access uses the public anon key + RLS — published help_articles and
 * open/locked contest_templates are world-readable per their RLS policies, so
 * no service-role key is required.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = resolve(__dirname, '..', 'public', 'sitemap.xml');

const SITE_URL = (
  process.env.SITE_URL ||
  process.env.VITE_SITE_URL ||
  'https://rowfantasy.com'
).replace(/\/$/, '');

// Supabase config — prefer service role at build time if available, else anon.
const SUPABASE_URL =
  process.env.VITE_SUPABASE_URL ||
  process.env.SUPABASE_URL ||
  'https://nutshvnnrwrpieirvjbc.supabase.co';
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im51dHNodm5ucndycGllaXJ2amJjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjExNTE4NDEsImV4cCI6MjA3NjcyNzg0MX0.h_AZms2awfHcsFb5l_H0kTlW-Y_t9AaDexoOaWyvUkw';

// Static public routes (mirrors src/App.tsx, with auth routes filtered out).
const STATIC_ROUTES: { path: string; changefreq: string; priority: string }[] = [
  { path: '/', changefreq: 'weekly', priority: '1.0' },
  { path: '/lobby', changefreq: 'hourly', priority: '0.9' },
  { path: '/contests', changefreq: 'hourly', priority: '0.9' },
  { path: '/legal', changefreq: 'monthly', priority: '0.4' },
  { path: '/legal/terms', changefreq: 'monthly', priority: '0.4' },
  { path: '/legal/privacy', changefreq: 'monthly', priority: '0.4' },
  { path: '/legal/responsible-play', changefreq: 'monthly', priority: '0.4' },
  { path: '/support/help-center', changefreq: 'weekly', priority: '0.6' },
  { path: '/support/contact', changefreq: 'monthly', priority: '0.4' },
];

// Auth-required — never include.
const EXCLUDED = new Set([
  '/login',
  '/signup',
  '/profile',
  '/my-entries',
  '/admin',
]);

type UrlEntry = {
  loc: string;
  lastmod?: string;
  changefreq?: string;
  priority?: string;
};

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildXml(entries: UrlEntry[]): string {
  const urls = entries
    .map((e) => {
      const parts = [`    <loc>${escapeXml(e.loc)}</loc>`];
      if (e.lastmod) parts.push(`    <lastmod>${e.lastmod}</lastmod>`);
      if (e.changefreq) parts.push(`    <changefreq>${e.changefreq}</changefreq>`);
      if (e.priority) parts.push(`    <priority>${e.priority}</priority>`);
      return `  <url>\n${parts.join('\n')}\n  </url>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap-0.9">\n${urls}\n</urlset>\n`;
}

async function fetchHelpArticles(supabase: ReturnType<typeof createClient>) {
  try {
    const { data, error } = await supabase
      .from('help_articles')
      .select('slug, updated_at, published_at')
      .not('published_at', 'is', null);
    if (error) throw error;
    return (data || []).map((row: any) => ({
      loc: `${SITE_URL}/support/help-center/${row.slug}`,
      lastmod: (row.updated_at || row.published_at || new Date().toISOString()).slice(0, 10),
      changefreq: 'weekly',
      priority: '0.5',
    }));
  } catch (err) {
    console.warn('[sitemap] help_articles fetch failed:', (err as Error).message);
    return [];
  }
}

async function fetchContestTemplates(supabase: ReturnType<typeof createClient>) {
  try {
    const { data, error } = await supabase
      .from('contest_templates')
      .select('id, updated_at, status')
      .in('status', ['open', 'locked']);
    if (error) throw error;
    return (data || []).map((row: any) => ({
      loc: `${SITE_URL}/contest/${row.id}`,
      lastmod: (row.updated_at || new Date().toISOString()).slice(0, 10),
      changefreq: 'daily',
      priority: '0.7',
    }));
  } catch (err) {
    console.warn('[sitemap] contest_templates fetch failed:', (err as Error).message);
    return [];
  }
}

async function main() {
  const today = new Date().toISOString().slice(0, 10);

  const staticEntries: UrlEntry[] = STATIC_ROUTES.filter(
    (r) => !EXCLUDED.has(r.path)
  ).map((r) => ({
    loc: `${SITE_URL}${r.path}`,
    lastmod: today,
    changefreq: r.changefreq,
    priority: r.priority,
  }));

  let dynamicEntries: UrlEntry[] = [];

  if (SUPABASE_URL && SUPABASE_KEY) {
    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: false },
    });
    const [articles, contests] = await Promise.all([
      fetchHelpArticles(supabase),
      fetchContestTemplates(supabase),
    ]);
    dynamicEntries = [...articles, ...contests];
  } else {
    console.warn('[sitemap] No Supabase credentials — emitting static routes only.');
  }

  const all = [...staticEntries, ...dynamicEntries].filter(
    (e) => !EXCLUDED.has(e.loc.replace(SITE_URL, ''))
  );

  const xml = buildXml(all);
  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, xml, 'utf8');

  console.log(
    `[sitemap] Wrote ${all.length} urls (${staticEntries.length} static + ${dynamicEntries.length} dynamic) → ${OUTPUT_PATH}`
  );
}

main().catch((err) => {
  console.error('[sitemap] fatal:', err);
  // Do not fail the build — emit a minimal static sitemap so deploy succeeds.
  const today = new Date().toISOString().slice(0, 10);
  const fallback = buildXml(
    STATIC_ROUTES.map((r) => ({
      loc: `${SITE_URL}${r.path}`,
      lastmod: today,
      changefreq: r.changefreq,
      priority: r.priority,
    }))
  );
  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, fallback, 'utf8');
  console.warn('[sitemap] wrote fallback static sitemap');
});
