// Profile Username - Update username with 3-month cooldown enforcement

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.76.1';
import { getCorsHeaders } from '../shared/cors.ts';
import { validateUsernameContent } from '../shared/username-filter.ts';

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Allow': 'POST, OPTIONS' },
    });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const authHeader = req.headers.get('Authorization')!;
    const supabase = createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: 'Unauthorized' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const { new_username } = await req.json();

    // Validate username format
    if (!new_username || typeof new_username !== 'string') {
      return new Response(
        JSON.stringify({ error: 'Username is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const username = new_username.trim().toLowerCase();

    // Validate length and characters
    if (username.length < 3 || username.length > 20) {
      return new Response(
        JSON.stringify({ error: 'Username must be 3-20 characters' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (!/^[a-z0-9_]+$/.test(username)) {
      return new Response(
        JSON.stringify({ error: 'Username can only contain lowercase letters, numbers, and underscores' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Check for inappropriate content
    const contentError = validateUsernameContent(username);
    if (contentError) {
      return new Response(
        JSON.stringify({ error: contentError }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Fetch current profile
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('username, username_last_changed_at')
      .eq('id', user.id)
      .single();

    if (profileError) {
      throw profileError;
    }

    const oldUsername = profile.username;

    // Check if username is the same
    if (username === oldUsername) {
      return new Response(
        JSON.stringify({ error: 'New username is the same as current username' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Enforce 90-day cooldown
    if (profile.username_last_changed_at) {
      const lastChanged = new Date(profile.username_last_changed_at);
      const now = new Date();
      const daysSinceChange = (now.getTime() - lastChanged.getTime()) / (1000 * 60 * 60 * 24);
      
      if (daysSinceChange < 90) {
        const nextChangeDate = new Date(lastChanged);
        nextChangeDate.setDate(nextChangeDate.getDate() + 90);
        return new Response(
          JSON.stringify({ 
            error: 'Username can only be changed once every 90 days',
            nextChangeAvailable: nextChangeDate.toISOString(),
          }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
    }

    // Update username
    const { error: updateError } = await supabase
      .from('profiles')
      .update({ 
        username,
        username_last_changed_at: new Date().toISOString(),
      })
      .eq('id', user.id);

    if (updateError) {
      // Check for unique constraint violation
      if (updateError.message.includes('unique') || updateError.code === '23505') {
        return new Response(
          JSON.stringify({ error: 'Username is already taken' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      throw updateError;
    }

    // Log to compliance audit
    await supabase
      .from('compliance_audit_logs')
      .insert({
        user_id: user.id,
        event_type: 'username_changed',
        description: 'User changed username',
        severity: 'info',
        metadata: { old_username: oldUsername, new_username: username },
      });

    return new Response(
      JSON.stringify({ 
        success: true,
        username,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error: any) {
    console.error('[profile-username] Error:', error);
    return new Response(
      JSON.stringify({ error: 'Failed to update username' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
