// Contest Settlement & Payout Engine - Admin-only
// Supports Auto-Pooling: Settles all sibling pools for a contest in one operation

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
  entry_tiers: Array<{ name: string; entry_fee_cents: number; payout_structure: PayoutStructure }> | null;
}

interface ContestEntry {
  id: string;
  user_id: string;
  status: string;
  payout_cents: number | null;
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

// ============ EXTRACTED CORE SETTLEMENT LOGIC ============

async function processSinglePool(
  supabaseAdmin: SupabaseClient,
  poolId: string,
  adminId: string
): Promise<PoolSettlementResult> {
  console.log('[settle:single] Processing pool:', poolId);

  // 1. Fetch pool details
  const { data: poolData, error: poolError } = await supabaseAdmin
    .from('contest_pools')
    .select('id, status, prize_pool_cents, contest_template_id, payout_structure, entry_fee_cents, current_entries, entry_tiers')
    .eq('id', poolId)
    .single();

  if (poolError || !poolData) {
    console.error('[settle:single] Pool not found:', poolError);
    return {
      poolId,
      success: false,
      collectedRevenueCents: 0,
      totalPayoutCents: 0,
      adminProfitCents: 0,
      totalEntries: 0,
      winnersCount: 0,
      nonWinnersSettled: 0,
      failedPayouts: 0,
      error: 'Contest pool not found',
    };
  }

  const pool = poolData as ContestPool;

  // Idempotency: Already settled
  if (pool.status === 'settled') {
    console.log('[settle:single] Pool already settled:', poolId);
    return {
      poolId,
      success: true,
      collectedRevenueCents: pool.entry_fee_cents * pool.current_entries,
      totalPayoutCents: 0,
      adminProfitCents: 0,
      totalEntries: pool.current_entries,
      winnersCount: 0,
      nonWinnersSettled: 0,
      failedPayouts: 0,
      alreadySettled: true,
    };
  }

  // Verify status is scoring_completed
  if (pool.status !== 'scoring_completed') {
    console.log('[settle:single] Pool status not ready:', pool.status);
    return {
      poolId,
      success: false,
      collectedRevenueCents: 0,
      totalPayoutCents: 0,
      adminProfitCents: 0,
      totalEntries: 0,
      winnersCount: 0,
      nonWinnersSettled: 0,
      failedPayouts: 0,
      error: `Cannot settle pool with status '${pool.status}'. Must be 'scoring_completed'.`,
    };
  }

  // 2. Fetch ALL contest_entries for this pool
  const { data: entriesData, error: entriesError } = await supabaseAdmin
    .from('contest_entries')
    .select('id, user_id, status, payout_cents')
    .eq('pool_id', poolId);

  if (entriesError) {
    console.error('[settle:single] Error fetching entries:', entriesError);
    return {
      poolId,
      success: false,
      collectedRevenueCents: 0,
      totalPayoutCents: 0,
      adminProfitCents: 0,
      totalEntries: 0,
      winnersCount: 0,
      nonWinnersSettled: 0,
      failedPayouts: 0,
      error: 'Failed to fetch contest entries',
    };
  }

  const allEntries = (entriesData || []) as ContestEntry[];

  if (allEntries.length === 0) {
    console.log('[settle:single] No entries in pool:', poolId);
    // Still mark as settled even with no entries
    await supabaseAdmin
      .from('contest_pools')
      .update({ status: 'settled', settled_at: new Date().toISOString() })
      .eq('id', poolId);

    return {
      poolId,
      success: true,
      collectedRevenueCents: 0,
      totalPayoutCents: 0,
      adminProfitCents: 0,
      totalEntries: 0,
      winnersCount: 0,
      nonWinnersSettled: 0,
      failedPayouts: 0,
    };
  }

  console.log('[settle:single] Found', allEntries.length, 'entries');

  // 3. Fetch ALL contest_scores for this pool
  const { data: scoresData, error: scoresError } = await supabaseAdmin
    .from('contest_scores')
    .select('id, entry_id, user_id, rank, total_points, payout_cents')
    .eq('instance_id', poolId)
    .order('rank', { ascending: true });

  if (scoresError) {
    console.error('[settle:single] Error fetching scores:', scoresError);
    return {
      poolId,
      success: false,
      collectedRevenueCents: 0,
      totalPayoutCents: 0,
      adminProfitCents: 0,
      totalEntries: allEntries.length,
      winnersCount: 0,
      nonWinnersSettled: 0,
      failedPayouts: 0,
      error: 'Failed to fetch contest scores',
    };
  }

  const allScores = (scoresData || []) as ContestScore[];
  console.log('[settle:single] Found', allScores.length, 'scored entries');

  // ========== PROCESS WINNERS ==========
  const payoutStructure = pool.payout_structure;
  const collectedRevenue = pool.entry_fee_cents * pool.current_entries;
  const processedEntryIds = new Set<string>();

  const payoutResults: Array<{
    userId: string;
    entryId: string;
    rank: number;
    payoutCents: number;
    success: boolean;
    error?: string;
  }> = [];

  let totalPayoutCents = 0;

  if (payoutStructure && Object.keys(payoutStructure).length > 0) {
    console.log('[settle:single] Using payout structure:', payoutStructure);

    // Group scores by rank to handle ties
    const scoresByRank: Record<number, ContestScore[]> = {};
    for (const score of allScores) {
      const rank = score.rank || 999;
      if (!scoresByRank[rank]) {
        scoresByRank[rank] = [];
      }
      scoresByRank[rank].push(score);
    }

    // Process each rank that has a payout defined
    for (const [rankStr, payoutAmountCents] of Object.entries(payoutStructure)) {
      const rank = parseInt(rankStr);
      const scoresAtRank = scoresByRank[rank] || [];

      if (scoresAtRank.length === 0) {
        console.log(`[settle:single] No entries at rank ${rank}, skipping payout of ${payoutAmountCents} cents`);
        continue;
      }

      // Split this rank's prize among tied entries
      const payoutPerEntry = Math.floor(payoutAmountCents / scoresAtRank.length);
      console.log(`[settle:single] Rank ${rank}: ${scoresAtRank.length} entries split ${payoutAmountCents} cents (${payoutPerEntry} each)`);

      for (const winner of scoresAtRank) {
        try {
          // Get user's wallet
          const { data: wallet, error: walletError } = await supabaseAdmin
            .from('wallets')
            .select('id')
            .eq('user_id', winner.user_id)
            .single();

          if (walletError || !wallet) {
            throw new Error(`Wallet not found for user ${winner.user_id}`);
          }

          // 1. Update wallet balance via RPC
          const { error: balanceError } = await supabaseAdmin.rpc('update_wallet_balance', {
            _wallet_id: (wallet as { id: string }).id,
            _available_delta: payoutPerEntry,
            _pending_delta: 0,
            _lifetime_winnings_delta: payoutPerEntry,
            _lifetime_deposits_delta: 0,
            _lifetime_withdrawals_delta: 0,
          });

          if (balanceError) {
            throw new Error(`Failed to update wallet balance: ${balanceError.message}`);
          }

          // 2. Insert ledger entry
          await supabaseAdmin.from('ledger_entries').insert({
            user_id: winner.user_id,
            transaction_type: 'PRIZE_PAYOUT',
            amount: payoutPerEntry,
            description: `Contest payout - Rank ${rank} - Pool ${poolId}`,
            reference_id: poolId,
          });

          // 3. Insert transaction record
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
            metadata: {
              contest_pool_id: poolId,
              rank: rank,
              total_points: winner.total_points,
            },
          });

          // 4. Update contest_scores
          await supabaseAdmin
            .from('contest_scores')
            .update({ payout_cents: payoutPerEntry })
            .eq('id', winner.id);

          // 5. Update contest_entries - mark as settled with payout
          await supabaseAdmin
            .from('contest_entries')
            .update({
              payout_cents: payoutPerEntry,
              status: 'settled'
            })
            .eq('id', winner.entry_id);

          processedEntryIds.add(winner.entry_id);
          totalPayoutCents += payoutPerEntry;

          payoutResults.push({
            userId: winner.user_id,
            entryId: winner.entry_id,
            rank: rank,
            payoutCents: payoutPerEntry,
            success: true,
          });

          console.log(`[settle:single] Paid ${payoutPerEntry} cents to user ${winner.user_id} (rank ${rank})`);

        } catch (error: unknown) {
          const errMsg = error instanceof Error ? error.message : 'Unknown error';
          console.error(`[settle:single] Payout failed for user ${winner.user_id}:`, error);
          payoutResults.push({
            userId: winner.user_id,
            entryId: winner.entry_id,
            rank: rank,
            payoutCents: 0,
            success: false,
            error: errMsg,
          });
          processedEntryIds.add(winner.entry_id);
        }
      }
    }
  } else {
    // Legacy: split entire prize pool among rank 1 winners
    console.log('[settle:single] No payout structure, using legacy winner-takes-all');
    const prizePoolCents = pool.prize_pool_cents || 0;
    const winners = allScores.filter(s => s.rank === 1);

    if (winners.length > 0) {
      const payoutPerWinner = Math.floor(prizePoolCents / winners.length);

      for (const winner of winners) {
        try {
          const { data: wallet } = await supabaseAdmin
            .from('wallets')
            .select('id')
            .eq('user_id', winner.user_id)
            .single();

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

  // ========== PROCESS NON-WINNERS ==========
  const nonWinnerEntries = allEntries.filter(entry => !processedEntryIds.has(entry.id));

  console.log(`[settle:single] Processing ${nonWinnerEntries.length} non-winning entries`);

  if (nonWinnerEntries.length > 0) {
    const nonWinnerIds = nonWinnerEntries.map(e => e.id);

    const { error: nonWinnerUpdateError } = await supabaseAdmin
      .from('contest_entries')
      .update({
        status: 'settled',
        payout_cents: 0
      })
      .in('id', nonWinnerIds);

    if (nonWinnerUpdateError) {
      console.error('[settle:single] Error updating non-winners:', nonWinnerUpdateError);
    } else {
      console.log(`[settle:single] Settled ${nonWinnerIds.length} non-winning entries`);
    }
  }

  // ========== FINALIZE POOL ==========
  const { error: poolUpdateError } = await supabaseAdmin
    .from('contest_pools')
    .update({
      status: 'settled',
      settled_at: new Date().toISOString(),
    })
    .eq('id', poolId);

  if (poolUpdateError) {
    console.error('[settle:single] Error updating pool status:', poolUpdateError);
  }

  // ========== LOG TO COMPLIANCE ==========
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

  console.log('[settle:single] ===== POOL SETTLED =====');
  console.log('[settle:single] Pool:', poolId);
  console.log('[settle:single] Revenue:', collectedRevenue, 'Payouts:', totalPayoutCents, 'Profit:', adminProfit);

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

    // Authenticate user first
    const supabase = createClient(SUPABASE_URL, ANON_KEY, {
      global: {
        headers: { Authorization: req.headers.get('Authorization')! },
      },
    });

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: 'Unauthorized' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // SECURITY: Check if user is admin
    const { data: roleData } = await supabase
      .from('user_roles')
      .select('role')
      .eq('user_id', user.id)
      .eq('role', 'admin')
      .single();

    if (!roleData) {
      return new Response(
        JSON.stringify({ error: 'Admin access required' }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Validate input
    const settleSchema = z.object({
      contestPoolId: z.string().uuid(),
    });

    const body = settleSchema.parse(await req.json());
    const { contestPoolId } = body;

    console.log('[settle] Admin', user.id, 'settling pool:', contestPoolId);

    // Create service client after admin verification
    const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_KEY);

    // ========== STEP 1: FETCH THE REQUESTED POOL TO GET TEMPLATE/TIER ==========
    const { data: requestedPoolData, error: poolFetchError } = await supabaseAdmin
      .from('contest_pools')
      .select('id, contest_template_id, tier_id')
      .eq('id', contestPoolId)
      .single();

    if (poolFetchError || !requestedPoolData) {
      return new Response(
        JSON.stringify({ error: 'Contest pool not found' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const requestedPool = requestedPoolData as { id: string; contest_template_id: string; tier_id: string };

    // ========== STEP 2: FETCH ALL SIBLING POOLS (same template + tier) ==========
    const { data: siblingPoolsData, error: siblingsError } = await supabaseAdmin
      .from('contest_pools')
      .select('id, status')
      .eq('contest_template_id', requestedPool.contest_template_id)
      .eq('tier_id', requestedPool.tier_id);

    if (siblingsError) {
      console.error('[settle] Error fetching sibling pools:', siblingsError);
      return new Response(
        JSON.stringify({ error: 'Failed to fetch sibling pools' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const siblingPools = (siblingPoolsData || []) as Array<{ id: string; status: string }>;
    console.log('[settle] Found', siblingPools.length, 'sibling pools for template:', requestedPool.contest_template_id);

    // ========== STEP 3: FILTER TO ONLY SETTLEABLE POOLS ==========
    const settleablePools = siblingPools.filter(
      p => p.status === 'scoring_completed' || p.status === 'settled'
    );

    console.log('[settle] Pools ready for settlement:', settleablePools.length);

    if (settleablePools.length === 0) {
      return new Response(
        JSON.stringify({
          error: 'No pools ready for settlement. All sibling pools must have status "scoring_completed".',
          siblingPoolStatuses: siblingPools.map(p => ({ id: p.id, status: p.status })),
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ========== STEP 4: BATCH EXECUTE SETTLEMENT FOR ALL SIBLING POOLS ==========
    const results: PoolSettlementResult[] = [];
    let totalRevenue = 0;
    let totalPayouts = 0;
    let totalProfit = 0;
    let successCount = 0;
    let alreadySettledCount = 0;
    let failCount = 0;

    for (const pool of settleablePools) {
      const result = await processSinglePool(supabaseAdmin, pool.id, user.id);
      results.push(result);

      if (result.success) {
        if (result.alreadySettled) {
          alreadySettledCount++;
        } else {
          successCount++;
          totalRevenue += result.collectedRevenueCents;
          totalPayouts += result.totalPayoutCents;
          totalProfit += result.adminProfitCents;
        }
      } else {
        failCount++;
      }
    }

    // ========== STEP 5: LOG BATCH SETTLEMENT TO COMPLIANCE ==========
    await supabaseAdmin.from('compliance_audit_logs').insert({
      admin_id: user.id,
      event_type: 'batch_pool_settlement',
      severity: 'info',
      description: `Admin batch-settled ${successCount} sibling pools for template ${requestedPool.contest_template_id}`,
      metadata: {
        contest_template_id: requestedPool.contest_template_id,
        tier_id: requestedPool.tier_id,
        triggered_by_pool_id: contestPoolId,
        pools_settled: successCount,
        pools_already_settled: alreadySettledCount,
        pools_failed: failCount,
        total_revenue_cents: totalRevenue,
        total_payout_cents: totalPayouts,
        total_profit_cents: totalProfit,
        pool_results: results.map(r => ({
          poolId: r.poolId,
          success: r.success,
          alreadySettled: r.alreadySettled,
          revenue: r.collectedRevenueCents,
          payouts: r.totalPayoutCents,
          profit: r.adminProfitCents,
          error: r.error,
        })),
      },
    });

    console.log('[settle] ===== BATCH SETTLEMENT COMPLETE =====');
    console.log('[settle] Pools Settled:', successCount);
    console.log('[settle] Already Settled:', alreadySettledCount);
    console.log('[settle] Failed:', failCount);
    console.log('[settle] Total Revenue:', totalRevenue, 'Total Payouts:', totalPayouts, 'Total Profit:', totalProfit);

    return new Response(
      JSON.stringify({
        success: failCount === 0,
        poolsSettled: successCount,
        poolsAlreadySettled: alreadySettledCount,
        poolsFailed: failCount,
        totalRevenueCents: totalRevenue,
        totalPayoutCents: totalPayouts,
        totalProfitCents: totalProfit,
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
      return new Response(
        JSON.stringify({ error: 'Invalid input', details: error.flatten() }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    return new Response(
      JSON.stringify({ error: 'An internal error occurred during settlement' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
