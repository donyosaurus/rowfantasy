// Responsible Gaming Limits - Allow users to set deposit limits and self-exclusion

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.76.1";
import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import { getCorsHeaders } from '../shared/cors.ts';
const limitSchema = z.object({
  depositLimit: z.number().int().positive().optional(), // Monthly limit in cents
  exclusionDays: z.number().int().positive().optional(), // Days to self-exclude
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
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    
    const supabase = createClient(
      supabaseUrl,
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: req.headers.get('Authorization')! } } }
    );

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: 'Unauthorized' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    let body;
    try {
      body = limitSchema.parse(await req.json());
    } catch (error) {
      return new Response(
        JSON.stringify({ error: 'Invalid input' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const { depositLimit, exclusionDays } = body;

    // Build upsert data
    const upsertData: {
      user_id: string;
      deposit_limit_monthly_cents?: number;
      self_exclusion_until?: string;
      updated_at: string;
    } = {
      user_id: user.id,
      updated_at: new Date().toISOString(),
    };

    let eventType = '';
    let description = '';

    if (depositLimit !== undefined) {
      upsertData.deposit_limit_monthly_cents = depositLimit;
      eventType = 'deposit_limit_set';
      description = `Deposit limit set to $${(depositLimit / 100).toFixed(2)}/month`;
    }

    if (exclusionDays !== undefined) {
      const exclusionUntil = new Date();
      exclusionUntil.setDate(exclusionUntil.getDate() + exclusionDays);
      upsertData.self_exclusion_until = exclusionUntil.toISOString();
      eventType = 'self_exclusion_enabled';
      description = `Self-exclusion enabled for ${exclusionDays} days until ${exclusionUntil.toLocaleDateString()}`;
    }

    // Use service role for upsert
    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    // Upsert into responsible_gaming table
    const { error: upsertError } = await adminClient
      .from('responsible_gaming')
      .upsert(upsertData, { onConflict: 'user_id' });

    if (upsertError) {
      console.error('[responsible-limits] Upsert error:', upsertError);
      return new Response(
        JSON.stringify({ error: 'Failed to update limits' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Log to compliance audit
    if (eventType) {
      await adminClient.from('compliance_audit_logs').insert({
        user_id: user.id,
        event_type: eventType,
        description: description,
        severity: 'info',
        metadata: body
      });
    }

    console.log('[responsible-limits] Updated:', { userId: user.id, depositLimit, exclusionDays });

    return new Response(
      JSON.stringify({ 
        success: true,
        depositLimit: depositLimit ? `$${(depositLimit / 100).toFixed(2)}/month` : null,
        selfExclusionUntil: upsertData.self_exclusion_until || null,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('[responsible-limits] Error:', error);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
