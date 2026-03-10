// Nightly Payment Reconciliation Job
// Compares provider settlement reports with internal ledger

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.76.1';
import { getPaymentProvider } from '../shared/payment-providers/factory.ts';
import { getCorsHeaders } from '../shared/cors.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    console.log('[reconciliation] Starting payment reconciliation job');

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

    const discrepancies: any[] = [];

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
              expected: expectedAmountCents / 100,
              actual: providerAmountCents / 100,
              difference: (providerAmountCents - expectedAmountCents) / 100,
            });
          }

          if (!internalTxn) {
            discrepancies.push({
              session_id: session.id,
              provider: providerName,
              issue: 'missing_internal_transaction',
              provider_amount: providerAmountCents / 100,
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

        } catch (error: any) {
          console.error(`[reconciliation] Error reconciling session ${session.id}:`, error);
          discrepancies.push({
            session_id: session.id,
            provider: providerName,
            issue: 'provider_lookup_failed',
            error: error?.message || 'Unknown error',
          });
        }
      }
    }

    // Log all discrepancies
    if (discrepancies.length > 0) {
      console.error('[reconciliation] Found discrepancies:', discrepancies);

      for (const discrepancy of discrepancies) {
        await supabase.from('compliance_audit_logs').insert({
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

  } catch (error: any) {
    console.error('[reconciliation] Error:', error);
    return new Response(
      JSON.stringify({ error: 'An unexpected error occurred' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
