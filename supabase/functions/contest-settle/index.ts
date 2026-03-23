// Contest Settlement & Payout Engine - Admin-only
// Supports Auto-Pooling: Settles all sibling pools for a contest in one operation
// Each tier is its own pool — no tiered branching needed within a single pool.

import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.76.1';
import { z } from 'https://deno.land/x/zod@v3.22.4/mod.ts';
import { getCorsHeaders } from '../shared/cors.ts';

interface PayoutStructure {
  [rank: string]: number; // rank -> cents
}

interface ContestPool {
  id: string;
  status: string;
  prize_pool_cents: number;
  contest_template_id: string;
  payout_structure: PayoutStructure | null;
  entry_fee_cents: number;
  current_entries: number;
  tier_id: string;
}

interface ContestEntry {
  id: string;
  user_id: string;
  status: string;
  payout_cents: number | null;
  entry_fee_cents: number;
}

interface ContestScore {
  id: string;
  entry_id: string;
  user_id: string;
  rank: number | null;
  total_points: number;
  payout_cents: number | null;
}

interface PoolSettlementResult {
  poolId: string;
  success: boolean;
  collectedRevenueCents: number;
  totalPayoutCents: number;
  adminProfitCents: number;
  totalEntries: number;
  winnersCount: number;
  nonWinnersSettled: number;
  failedPayouts: number;
  error?: string;
  alreadySettled?: boolean;
}

// ============ CORE SETTLEMENT LOGIC (per-pool, no tier branching) ============

async function processSinglePool(
  supabaseAdmin: SupabaseClient,
  poolId: string,
  adminId: string
): Promise<PoolSettlementResult> {
  console.log('[settle:single] Processing pool:', poolId);

  const { data: poolData, error: poolError } = await supabaseAdmin
    .from('contest_pools')
    .select('id, status, prize_pool_cents, contest_template_id, payout_structure, entry_fee_cents, current_entries')
    .eq('id', poolId)
    .single();

  if (poolError || !poolData) {
    return { poolId, success: false, collectedRevenueCents: 0, totalPayoutCents: 0, adminProfitCents: 0, totalEntries: 0, winnersCount: 0, nonWinnersSettled: 0, failedPayouts: 0, error: 'Contest pool not found' };
  }

  const pool = poolData as ContestPool;

  if (pool.status === 'settled') {
    return { poolId, success: true, collectedRevenueCents: pool.entry_fee_cents * pool.current_entries, totalPayoutCents: 0, adminProfitCents: 0, totalEntries: pool.current_entries, winnersCount: 0, nonWinnersSettled: 0, failedPayouts: 0, alreadySettled: true };
  }

  if (pool.status !== 'scoring_completed') {
    return { poolId, success: false, collectedRevenueCents: 0, totalPayoutCents: 0, adminProfitCents: 0, totalEntries: 0, winnersCount: 0, nonWinnersSettled: 0, failedPayouts: 0, error: `Cannot settle pool with status '${pool.status}'. Must be 'scoring_completed'.` };
  }

  const { data: entriesData, error: entriesError } = await supabaseAdmin
    .from('contest_entries')
    .select('id, user_id, status, payout_cents, entry_fee_cents')
    .eq('pool_id', poolId);

  if (entriesError) {
    return { poolId, success: false, collectedRevenueCents: 0, totalPayoutCents: 0, adminProfitCents: 0, totalEntries: 0, winnersCount: 0, nonWinnersSettled: 0, failedPayouts: 0, error: 'Failed to fetch contest entries' };
  }

  const allEntries = (entriesData || []) as ContestEntry[];

  if (allEntries.length === 0) {
    await supabaseAdmin.from('contest_pools').update({ status: 'settled', settled_at: new Date().toISOString() }).eq('id', poolId);
    return { poolId, success: true, collectedRevenueCents: 0, totalPayoutCents: 0, adminProfitCents: 0, totalEntries: 0, winnersCount: 0, nonWinnersSettled: 0, failedPayouts: 0 };
  }

  const { data: scoresData, error: scoresError } = await supabaseAdmin
    .from('contest_scores')
    .select('id, entry_id, user_id, rank, total_points, payout_cents')
    .eq('instance_id', poolId)
    .order('rank', { ascending: true });

  if (scoresError) {
    return { poolId, success: false, collectedRevenueCents: 0, totalPayoutCents: 0, adminProfitCents: 0, totalEntries: allEntries.length, winnersCount: 0, nonWinnersSettled: 0, failedPayouts: 0, error: 'Failed to fetch contest scores' };
  }

  const allScores = (scoresData || []) as ContestScore[];
  const payoutStructure = pool.payout_structure;
  const collectedRevenue = pool.entry_fee_cents * pool.current_entries;
  let totalPayoutCents = 0;
  const processedEntryIds = new Set<string>();
  const payoutResults: Array<{ userId: string; entryId: string; rank: number; payoutCents: number; success: boolean; error?: string }> = [];

  // Use payout_structure if available
  if (payoutStructure && Object.keys(payoutStructure).length > 0) {
    console.log('[settle:single] Using payout structure:', payoutStructure);

    const scoresByRank: Record<number, ContestScore[]> = {};
    for (const score of allScores) {
      const rank = score.rank || 999;
      if (!scoresByRank[rank]) scoresByRank[rank] = [];
      scoresByRank[rank].push(score);
    }

    for (const [rankStr, payoutAmountCents] of Object.entries(payoutStructure)) {
      const rank = parseInt(rankStr);
      const scoresAtRank = scoresByRank[rank] || [];
      if (scoresAtRank.length === 0) continue;

      const payoutPerEntry = Math.floor(payoutAmountCents / scoresAtRank.length);

      for (const winner of scoresAtRank) {
        try {
          const { data: wallet } = await supabaseAdmin.from('wallets').select('id').eq('user_id', winner.user_id).single();
          if (!wallet) throw new Error(`Wallet not found for user ${winner.user_id}`);

          await supabaseAdmin.rpc('update_wallet_balance', {
            _wallet_id: (wallet as { id: string }).id,
            _available_delta: payoutPerEntry,
            _pending_delta: 0,
            _lifetime_winnings_delta: payoutPerEntry,
            _lifetime_deposits_delta: 0,
            _lifetime_withdrawals_delta: 0,
          });

          await supabaseAdmin.from('ledger_entries').insert({
            user_id: winner.user_id,
            transaction_type: 'PRIZE_PAYOUT',
            amount: payoutPerEntry,
            description: `Contest payout - Rank ${rank} - Pool ${poolId}`,
            reference_id: poolId,
          });

          await supabaseAdmin.from('transactions').insert({
            user_id: winner.user_id,
            wallet_id: (wallet as { id: string }).id,
            type: 'payout',
            amount: payoutPerEntry,
            status: 'completed',
            completed_at: new Date().toISOString(),
            description: `Contest winnings - Rank ${rank}`,
            reference_id: winner.entry_id,
            reference_type: 'contest_entry',
            is_taxable: true,
            tax_year: new Date().getFullYear(),
            metadata: { contest_pool_id: poolId, rank, total_points: winner.total_points },
          });

          await supabaseAdmin.from('contest_scores').update({ payout_cents: payoutPerEntry }).eq('id', winner.id);
          await supabaseAdmin.from('contest_entries').update({ payout_cents: payoutPerEntry, status: 'settled' }).eq('id', winner.entry_id);

          processedEntryIds.add(winner.entry_id);
          totalPayoutCents += payoutPerEntry;
          payoutResults.push({ userId: winner.user_id, entryId: winner.entry_id, rank, payoutCents: payoutPerEntry, success: true });
        } catch (error: unknown) {
          const errMsg = error instanceof Error ? error.message : 'Unknown error';
          payoutResults.push({ userId: winner.user_id, entryId: winner.entry_id, rank, payoutCents: 0, success: false, error: errMsg });
          processedEntryIds.add(winner.entry_id);
        }
      }
    }
  } else {
    // Legacy: split entire prize pool among rank 1 winners
    const prizePoolCents = pool.prize_pool_cents || 0;
    const winners = allScores.filter(s => s.rank === 1);

    if (winners.length > 0) {
      const payoutPerWinner = Math.floor(prizePoolCents / winners.length);

      for (const winner of winners) {
        try {
          const { data: wallet } = await supabaseAdmin.from('wallets').select('id').eq('user_id', winner.user_id).single();
          if (!wallet) throw new Error('Wallet not found');

          await supabaseAdmin.rpc('update_wallet_balance', {
            _wallet_id: (wallet as { id: string }).id,
            _available_delta: payoutPerWinner,
            _pending_delta: 0,
            _lifetime_winnings_delta: payoutPerWinner,
            _lifetime_deposits_delta: 0,
            _lifetime_withdrawals_delta: 0,
          });

          await supabaseAdmin.from('ledger_entries').insert({
            user_id: winner.user_id,
            transaction_type: 'PRIZE_PAYOUT',
            amount: payoutPerWinner,
            description: `Contest payout - Pool ${poolId}`,
            reference_id: poolId,
          });

          await supabaseAdmin.from('transactions').insert({
            user_id: winner.user_id,
            wallet_id: (wallet as { id: string }).id,
            type: 'payout',
            amount: payoutPerWinner,
            status: 'completed',
            completed_at: new Date().toISOString(),
            description: `Contest winnings`,
            reference_id: winner.entry_id,
            reference_type: 'contest_entry',
            is_taxable: true,
            tax_year: new Date().getFullYear(),
          });

          await supabaseAdmin.from('contest_scores').update({ payout_cents: payoutPerWinner }).eq('id', winner.id);
          await supabaseAdmin.from('contest_entries').update({ payout_cents: payoutPerWinner, status: 'settled' }).eq('id', winner.entry_id);

          processedEntryIds.add(winner.entry_id);
          totalPayoutCents += payoutPerWinner;
          payoutResults.push({ userId: winner.user_id, entryId: winner.entry_id, rank: 1, payoutCents: payoutPerWinner, success: true });
        } catch (error: unknown) {
          const errMsg = error instanceof Error ? error.message : 'Unknown error';
          payoutResults.push({ userId: winner.user_id, entryId: winner.entry_id, rank: 1, payoutCents: 0, success: false, error: errMsg });
          processedEntryIds.add(winner.entry_id);
        }
      }
    }
  }

  // Settle non-winners
  const nonWinnerEntries = allEntries.filter(entry => !processedEntryIds.has(entry.id));
  if (nonWinnerEntries.length > 0) {
    const nonWinnerIds = nonWinnerEntries.map(e => e.id);
    await supabaseAdmin.from('contest_entries').update({ status: 'settled', payout_cents: 0 }).in('id', nonWinnerIds);
  }

  // Finalize pool
  await supabaseAdmin.from('contest_pools').update({ status: 'settled', settled_at: new Date().toISOString() }).eq('id', poolId);

  const adminProfit = collectedRevenue - totalPayoutCents;

  await supabaseAdmin.from('compliance_audit_logs').insert({
    admin_id: adminId,
    event_type: 'pool_settled',
    severity: 'info',
    description: `Admin settled contest pool ${poolId}`,
    metadata: {
      contest_pool_id: poolId,
      payout_structure: payoutStructure,
      collected_revenue_cents: collectedRevenue,
      total_payout_cents: totalPayoutCents,
      admin_profit_cents: adminProfit,
      total_entries: allEntries.length,
      winners_paid: payoutResults.filter(p => p.success).length,
      non_winners_settled: nonWinnerEntries.length,
      failed_payouts: payoutResults.filter(p => !p.success).length,
    },
  });

  return {
    poolId,
    success: true,
    collectedRevenueCents: collectedRevenue,
    totalPayoutCents,
    adminProfitCents: adminProfit,
    totalEntries: allEntries.length,
    winnersCount: payoutResults.filter(p => p.success).length,
    nonWinnersSettled: nonWinnerEntries.length,
    failedPayouts: payoutResults.filter(p => !p.success).length,
  };
}

// ============ MAIN HTTP HANDLER ============

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);

  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
    const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
    const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    const supabase = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: req.headers.get('Authorization')! } },
    });

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const { data: roleData } = await supabase.from('user_roles').select('role').eq('user_id', user.id).eq('role', 'admin').single();
    if (!roleData) {
      return new Response(JSON.stringify({ error: 'Admin access required' }), { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const settleSchema = z.object({ contestPoolId: z.string().uuid() });
    const body = settleSchema.parse(await req.json());
    const { contestPoolId } = body;

    console.log('[settle] Admin', user.id, 'settling pool:', contestPoolId);

    const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_KEY);

    // Fetch the requested pool to get template info
    const { data: requestedPoolData, error: poolFetchError } = await supabaseAdmin
      .from('contest_pools')
      .select('id, contest_template_id, tier_id')
      .eq('id', contestPoolId)
      .single();

    if (poolFetchError || !requestedPoolData) {
      return new Response(JSON.stringify({ error: 'Contest pool not found' }), { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const requestedPool = requestedPoolData as { id: string; contest_template_id: string; tier_id: string };

    // Fetch ALL sibling pools (same template, ALL tiers — settle everything at once)
    const { data: siblingPoolsData, error: siblingsError } = await supabaseAdmin
      .from('contest_pools')
      .select('id, status')
      .eq('contest_template_id', requestedPool.contest_template_id);

    if (siblingsError) {
      return new Response(JSON.stringify({ error: 'Failed to fetch sibling pools' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const siblingPools = (siblingPoolsData || []) as Array<{ id: string; status: string }>;
    const settleablePools = siblingPools.filter(p => p.status === 'scoring_completed' || p.status === 'settled');

    if (settleablePools.length === 0) {
      return new Response(
        JSON.stringify({ error: 'No pools ready for settlement.', siblingPoolStatuses: siblingPools.map(p => ({ id: p.id, status: p.status })) }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const results: PoolSettlementResult[] = [];
    let totalRevenue = 0, totalPayouts = 0, totalProfit = 0, successCount = 0, alreadySettledCount = 0, failCount = 0;

    for (const pool of settleablePools) {
      const result = await processSinglePool(supabaseAdmin, pool.id, user.id);
      results.push(result);
      if (result.success) {
        if (result.alreadySettled) alreadySettledCount++;
        else { successCount++; totalRevenue += result.collectedRevenueCents; totalPayouts += result.totalPayoutCents; totalProfit += result.adminProfitCents; }
      } else { failCount++; }
    }

    await supabaseAdmin.from('compliance_audit_logs').insert({
      admin_id: user.id,
      event_type: 'batch_pool_settlement',
      severity: 'info',
      description: `Admin batch-settled ${successCount} pools for template ${requestedPool.contest_template_id}`,
      metadata: {
        contest_template_id: requestedPool.contest_template_id,
        triggered_by_pool_id: contestPoolId,
        pools_settled: successCount,
        pools_already_settled: alreadySettledCount,
        pools_failed: failCount,
        total_revenue_cents: totalRevenue,
        total_payout_cents: totalPayouts,
        total_profit_cents: totalProfit,
      },
    });

    return new Response(
      JSON.stringify({
        success: failCount === 0,
        poolsSettled: successCount,
        poolsAlreadySettled: alreadySettledCount,
        poolsFailed: failCount,
        totalRevenueCents: totalRevenue,
        totalPayoutCents: totalPayouts,
        totalProfitCents: totalProfit,
        winnersCount: results.reduce((s, r) => s + r.winnersCount, 0),
        poolResults: results,
        message: failCount > 0
          ? `Batch settlement completed with ${failCount} failure(s)`
          : `Successfully settled ${successCount} pool(s)${alreadySettledCount > 0 ? ` (${alreadySettledCount} already settled)` : ''}`,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error: unknown) {
    console.error('[settle] Error:', error);
    if (error instanceof z.ZodError) {
      return new Response(JSON.stringify({ error: 'Invalid input', details: error.flatten() }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ error: 'An internal error occurred during settlement' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});
