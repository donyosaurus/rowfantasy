import { createClient } from "https://esm.sh/@supabase/supabase-js@2.76.1";
import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import { getCorsHeaders } from '../shared/cors.ts';

const ticketSchema = z.object({
  topic: z.enum(['account', 'payments', 'contest', 'technical', 'compliance', 'dsar']),
  subject: z.string().min(1).max(200),
  message: z.string().min(10).max(5000),
  email: z.string().email().optional()
});

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
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: req.headers.get('Authorization')! } } }
    );

    // Try to get user, but allow anonymous tickets
    const { data: { user } } = await supabase.auth.getUser();

    if (req.method === 'POST') {
      const body = ticketSchema.parse(await req.json());

      // Get email from user profile or request body
      let email = body.email;
      if (user && !email) {
        const { data: profile } = await supabase
          .from('profiles')
          .select('email')
          .eq('id', user.id)
          .single();
        email = profile?.email;
      }

      if (!email) {
        return new Response(
          JSON.stringify({ error: 'Email required' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // Create support ticket
      const { data: ticket, error: insertError } = await supabase
        .from('support_tickets')
        .insert({
          user_id: user?.id || null,
          email: email,
          topic: body.topic,
          subject: body.subject,
          message: body.message
        })
        .select()
        .single();

      if (insertError) {
        console.error('Error creating support ticket:', insertError);
        return new Response(
          JSON.stringify({ error: 'Failed to create ticket' }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      console.log(`Support ticket created: ${ticket.id} for ${email}`);

      return new Response(
        JSON.stringify({ ticket }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // GET - list user's tickets
    if (!user) {
      return new Response(
        JSON.stringify({ error: 'Unauthorized' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const { data: tickets, error: fetchError } = await supabase
      .from('support_tickets')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false });

    if (fetchError) {
      console.error('Error fetching support tickets:', fetchError);
      return new Response(
        JSON.stringify({ error: 'Failed to fetch tickets' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    return new Response(
      JSON.stringify({ tickets }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('Error in support-tickets:', error);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});