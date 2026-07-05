import { createClient } from "https://esm.sh/@supabase/supabase-js@2.76.1";
import { getCorsHeaders } from '../shared/cors.ts';

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== 'GET' && req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Allow': 'GET, POST, OPTIONS' },
    });
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? ''
    );

    // Handle both GET and POST requests
    let slug: string | null = null;
    let query: string | null = null;
    let category: string | null = null;

    if (req.method === 'GET') {
      const url = new URL(req.url);
      slug = url.searchParams.get('slug');
      query = url.searchParams.get('query');
      category = url.searchParams.get('category');
    } else {
      const body = await req.json();
      slug = body.slug;
      query = body.query;
      category = body.category;
    }

    // Get specific article
    if (slug) {
      const { data: article, error } = await supabase
        .from('help_articles')
        .select('*')
        .eq('slug', slug)
        .not('published_at', 'is', null)
        .maybeSingle();

      if (error) {
        console.error('Error fetching help article:', error);
        return new Response(
          JSON.stringify({ error: 'Article not found' }),
          { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      return new Response(
        JSON.stringify({ article }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Search or list articles
    let queryBuilder = supabase
      .from('help_articles')
      .select('id, slug, title, category, tags, published_at, updated_at')
      .not('published_at', 'is', null)
      .order('updated_at', { ascending: false });

    if (category) {
      queryBuilder = queryBuilder.eq('category', category);
    }

    if (query) {
      if (query.length > 100) {
        return new Response(
          JSON.stringify({ error: 'Search query too long (max 100 characters)' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      // Strip LIKE wildcards so users can't run arbitrary wildcard scans,
      // then escape backslashes and double-quotes per PostgREST quoting rules
      // and wrap the pattern in double quotes so commas/parens/dots in the
      // input aren't parsed as PostgREST filter DSL.
      const stripped = query.replace(/[%_]/g, '');
      const escaped = stripped.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      queryBuilder = queryBuilder.or(
        `title.ilike."%${escaped}%",body_md.ilike."%${escaped}%"`
      );
    }

    const { data: articles, error } = await queryBuilder;

    if (error) {
      console.error('Error fetching help articles:', error);
      return new Response(
        JSON.stringify({ error: 'Failed to fetch articles' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    return new Response(
      JSON.stringify({ articles }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('Error in help-articles:', error);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});