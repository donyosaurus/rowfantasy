// Nightly Payment Reconciliation Job
// Compares provider settlement reports with internal ledger
// Admin-only: requires authenticated admin user

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.76.1';
import { getPaymentProvider } from '../shared/payment-providers/factory.ts';
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
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    // Authenticate the caller
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user }, error: authError } = await userClient.auth.getUser();
    if (authError || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Verify admin role
    const { data: roleData } = await userClient
      .from('user_roles')
      .select('role')
      .eq('user_id', user.id)
      .eq('role', 'admin')
      .single();

    if (!roleData) {
      return new Response(JSON.stringify({ error: 'Admin access required' }), {
        status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Now use service role for admin operations
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    console.log('[reconciliation] Starting payment reconciliation job, triggered by admin:', user.id);

    // Get yesterday's date range
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(0, 0, 0, 0);
    
    const endDate = new Date(yesterday);
    endDate.setHours(23, 59, 59, 999);

    // Get all completed payment sessions from yesterday
    const { data: sessions, error: sessionsError } = await supabase
      .from('payment_sessions')
      .select('*')
      .eq('status', 'succeeded')
      .gte('completed_at', yesterday.toISOString())
      .lte('completed_at', endDate.toISOString());

    if (sessionsError) {
      throw sessionsError;
    }

    console.log(`[reconciliation] Found ${sessions?.length || 0} completed sessions to reconcile`);

    const discrepancies: Array<{
      session_id: string;
      provider: string;
      issue: string;
      [key: string]: unknown;
    }>  = [];

    // Group by provider
    const sessionsByProvider = (sessions || []).reduce((acc, session) => {
      if (!acc[session.provider]) {
        acc[session.provider] = [];
      }
      acc[session.provider].push(session);
      return acc;
    }, {} as Record<string, any[]>);

    // Reconcile each provider
    for (const [providerName, providerSessions] of Object.entries(sessionsByProvider)) {
      const typedSessions = providerSessions as any[];
      console.log(`[reconciliation] Reconciling ${providerName}: ${typedSessions.length} sessions`);

      const provider = getPaymentProvider(providerName as any);

      for (const session of typedSessions) {
        try {
          // Get provider transaction status
          const providerStatus = await provider.getTransactionStatus({
            providerTransactionId: session.provider_session_id,
          });

          // Get our internal transaction
          const { data: internalTxn } = await supabase
            .from('transactions')
            .select('*')
            .eq('reference_id', session.id)
            .eq('type', 'deposit')
            .single();

          // Compare amounts and status
          const expectedAmountCents = session.amount_cents;
          const providerAmountCents = providerStatus.amountCents;

          if (expectedAmountCents !== providerAmountCents) {
            discrepancies.push({
              session_id: session.id,
              provider: providerName,
              issue: 'amount_mismatch',
              expected_cents: expectedAmountCents,
              actual_cents: providerAmountCents,
              difference_cents: providerAmountCents - expectedAmountCents,
            });
          }

          if (!internalTxn) {
            discrepancies.push({
              session_id: session.id,
              provider: providerName,
              issue: 'missing_internal_transaction',
              provider_amount_cents: providerAmountCents,
            });
          }

          if (providerStatus.status !== 'succeeded' && session.status === 'succeeded') {
            discrepancies.push({
              session_id: session.id,
              provider: providerName,
              issue: 'status_mismatch',
              our_status: session.status,
              provider_status: providerStatus.status,
            });
          }

        } catch (error: unknown) {
          console.error(`[reconciliation] Error reconciling session ${session.id}:`, error);
          discrepancies.push({
            session_id: session.id,
            provider: providerName,
            issue: 'provider_lookup_failed',
          });
        }
      }
    }

    // Log all discrepancies
    if (discrepancies.length > 0) {
      console.error('[reconciliation] Found discrepancies:', discrepancies.length);

      for (const discrepancy of discrepancies) {
        await supabase.from('compliance_audit_logs').insert({
          admin_id: user.id,
          event_type: 'reconciliation_discrepancy',
          severity: 'error',
          description: `Payment reconciliation discrepancy: ${discrepancy.issue}`,
          metadata: discrepancy,
        });
      }
    } else {
      console.log('[reconciliation] No discrepancies found');
    }

    // Log successful reconciliation
    await supabase.from('compliance_audit_logs').insert({
      admin_id: user.id,
      event_type: 'reconciliation_completed',
      severity: 'info',
      description: `Reconciliation completed: ${sessions?.length || 0} sessions, ${discrepancies.length} discrepancies`,
      metadata: {
        date: yesterday.toISOString(),
        total_sessions: sessions?.length || 0,
        discrepancies_count: discrepancies.length,
      },
    });

    return new Response(
      JSON.stringify({
        success: true,
        date: yesterday.toISOString(),
        sessions_reconciled: sessions?.length || 0,
        discrepancies_found: discrepancies.length,
        discrepancies,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error: unknown) {
    console.error('[reconciliation] Error:', error);
    return new Response(
      JSON.stringify({ error: 'An internal error occurred during reconciliation' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
