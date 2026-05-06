// Compliance Export - Daily summary for regulatory reporting
// Requires Admin access - generates financial and activity summaries

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.76.1';
import { z } from 'https://deno.land/x/zod@v3.22.4/mod.ts';
import { getCorsHeaders } from '../shared/cors.ts';

// Helper to check admin role
async function requireAdmin(supabase: any, userId: string): Promise<boolean> {
  const { data, error } = await supabase
    .rpc('has_role', { _user_id: userId, _role: 'admin' });
  
  if (error || !data) {
    return false;
  }
  return true;
}

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
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const authHeader = req.headers.get('Authorization')!;

    // User client for auth
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

    // Strict admin check
    const isAdmin = await requireAdmin(supabase, user.id);
    if (!isAdmin) {
      return new Response(
        JSON.stringify({ error: 'Admin access required' }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Validate input
    const exportSchema = z.object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    });

    let body: { date?: string } = {};
    try {
      if (req.method === 'POST') {
        const rawBody = await req.json();
        body = exportSchema.parse(rawBody);
      }
    } catch {
      return new Response(
        JSON.stringify({ error: 'Invalid date format. Use YYYY-MM-DD' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Deterministic UTC report_date and per-invocation run_id
    const _run_id = crypto.randomUUID();
    const reportDate = body.date || new Date().toISOString().slice(0, 10);
    const targetDate = reportDate;
    const startOfDay = `${targetDate}T00:00:00.000Z`;
    const endOfDay = `${targetDate}T23:59:59.999Z`;

    console.log('[compliance-export] Generating report for:', targetDate, 'run_id:', _run_id);

    // Use service role for full data access
    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    // Query ledger entries for the day
    const { data: ledgerEntries, error: ledgerError } = await adminClient
      .from('ledger_entries')
      .select('amount, transaction_type, user_id')
      .gte('created_at', startOfDay)
      .lte('created_at', endOfDay);

    if (ledgerError) {
      console.error('[compliance-export] Ledger query error:', ledgerError);
      return new Response(
        JSON.stringify({ error: 'Failed to fetch ledger data' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Query settled contest pools
    const { data: settledPools, error: poolsError } = await adminClient
      .from('contest_pools')
      .select('id, entry_fee_cents, current_entries, prize_pool_cents, status')
      .eq('status', 'settled')
      .gte('settled_at', startOfDay)
      .lte('settled_at', endOfDay);

    if (poolsError) {
      console.error('[compliance-export] Pools query error:', poolsError);
    }

    // Query compliance audit logs
    const { data: auditLogs, error: auditError } = await adminClient
      .from('compliance_audit_logs')
      .select('id, event_type, severity, state_code')
      .gte('created_at', startOfDay)
      .lte('created_at', endOfDay);

    if (auditError) {
      console.error('[compliance-export] Audit logs query error:', auditError);
    }

    // Aggregate ledger data
    let totalDepositsCents = 0;
    let totalWithdrawalsCents = 0;
    let totalEntryFeesCents = 0;
    let totalPrizesAwardedCents = 0;
    const uniqueUsers = new Set<string>();

    for (const entry of ledgerEntries || []) {
      uniqueUsers.add(entry.user_id);
      const amount = Math.abs(Number(entry.amount) || 0);

      switch (entry.transaction_type) {
        case 'DEPOSIT':
          totalDepositsCents += amount;
          break;
        case 'WITHDRAWAL':
          totalWithdrawalsCents += amount;
          break;
        case 'ENTRY_FEE':
          totalEntryFeesCents += amount;
          break;
        case 'PRIZE_PAYOUT':
          totalPrizesAwardedCents += amount;
          break;
      }
    }

    // Calculate net revenue (Entry Fees - Prizes = Platform Rake)
    const netPlatformRevenueCents = totalEntryFeesCents - totalPrizesAwardedCents;

    // Aggregate pool data
    const poolsSummary = {
      total_pools_settled: (settledPools || []).length,
      total_entries: (settledPools || []).reduce((sum, p) => sum + (p.current_entries || 0), 0),
      total_prize_pool: (settledPools || []).reduce((sum, p) => sum + (p.prize_pool_cents || 0), 0),
    };

    // Aggregate audit events by type and severity
    const auditByType: Record<string, number> = {};
    const auditBySeverity: Record<string, number> = {};
    const auditByState: Record<string, number> = {};
    
    for (const log of auditLogs || []) {
      auditByType[log.event_type] = (auditByType[log.event_type] || 0) + 1;
      auditBySeverity[log.severity] = (auditBySeverity[log.severity] || 0) + 1;
      if (log.state_code) {
        auditByState[log.state_code] = (auditByState[log.state_code] || 0) + 1;
      }
    }

    // Generate file hash for integrity verification
    const reportContent = JSON.stringify({
      date: targetDate,
      deposits: totalDepositsCents,
      withdrawals: totalWithdrawalsCents,
      entryFees: totalEntryFeesCents,
      prizes: totalPrizesAwardedCents,
      users: uniqueUsers.size,
    });
    const encoder = new TextEncoder();
    const data = encoder.encode(reportContent);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const fileHash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

    // Build compliance report
    const report = {
      report_date: targetDate,
      generated_at: new Date().toISOString(),
      generated_by: user.id,
      file_hash: fileHash,
      
      financial_summary: {
        total_deposits_cents: totalDepositsCents,
        total_deposits_display: `$${(totalDepositsCents / 100).toFixed(2)}`,
        total_withdrawals_cents: totalWithdrawalsCents,
        total_withdrawals_display: `$${(totalWithdrawalsCents / 100).toFixed(2)}`,
        total_entry_fees_cents: totalEntryFeesCents,
        total_entry_fees_display: `$${(totalEntryFeesCents / 100).toFixed(2)}`,
        total_prizes_awarded_cents: totalPrizesAwardedCents,
        total_prizes_awarded_display: `$${(totalPrizesAwardedCents / 100).toFixed(2)}`,
        net_platform_revenue_cents: netPlatformRevenueCents,
        net_platform_revenue_display: `$${(netPlatformRevenueCents / 100).toFixed(2)}`,
      },
      
      activity_summary: {
        unique_active_users: uniqueUsers.size,
        total_transactions: (ledgerEntries || []).length,
      },
      
      contest_summary: poolsSummary,
      
      audit_events: {
        total_events: (auditLogs || []).length,
        by_type: auditByType,
        by_severity: auditBySeverity,
        by_state: auditByState,
      },
    };

    // Idempotent completion audit row (UNIQUE on metadata->>report_date for event_type='compliance_export_completed')
    const description = `Daily compliance export generated for ${targetDate}`;
    const completionMetadata = {
      unique_users: uniqueUsers.size,
      total_transactions: (ledgerEntries || []).length,
      file_hash: fileHash,
      admin_id: user.id,
    };

    const { data: rpcResult, error: rpcError } = await adminClient.rpc(
      'record_compliance_export_completed',
      {
        _report_date: reportDate,
        _run_id: _run_id,
        _metadata: completionMetadata,
        _description: description,
      }
    );

    if (rpcError) {
      console.error('[compliance-export] RPC failure', { run_id: _run_id, report_date: reportDate, error: rpcError });
      return new Response(
        JSON.stringify({ error: 'Failed to record export completion' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const row = Array.isArray(rpcResult) ? rpcResult[0] : rpcResult;
    const wasInserted: boolean = !!row?.inserted;
    let exportedAt = new Date().toISOString();
    let priorRunId: string | undefined;

    if (!wasInserted) {
      const { data: prior } = await adminClient
        .from('compliance_audit_logs')
        .select('id, created_at, metadata')
        .eq('event_type', 'compliance_export_completed')
        .filter('metadata->>report_date', 'eq', reportDate)
        .single();
      if (prior) {
        exportedAt = prior.created_at;
        priorRunId = (prior.metadata as any)?.run_id;
      }
    }

    console.log('[compliance-export] Completion recorded', {
      run_id: _run_id,
      report_date: reportDate,
      was_duplicate: !wasInserted,
      hash: fileHash,
    });

    return new Response(
      JSON.stringify({
        success: true,
        was_duplicate: !wasInserted,
        run_id: _run_id,
        report_date: reportDate,
        exported_at: exportedAt,
        ...(priorRunId ? { prior_run_id: priorRunId } : {}),
        report,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error: any) {
    // SECURITY: Never expose internal error details to client
    console.error('[compliance-export] Error:', error);
    return new Response(
      JSON.stringify({ error: 'An error occurred generating the report' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});

function getYesterday(): string {
  const date = new Date();
  date.setDate(date.getDate() - 1);
  return date.toISOString().split('T')[0];
}
