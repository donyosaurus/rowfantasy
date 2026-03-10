import { createClient } from "https://esm.sh/@supabase/supabase-js@2.76.1";
import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized", detail: authError?.message }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: roles } = await supabase.from("user_roles").select("role").eq("user_id", user.id).eq("role", "admin");
    if (!roles || roles.length === 0) {
      return new Response(JSON.stringify({ error: "Admin access required" }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabaseAdmin = createClient(supabaseUrl, serviceKey);

    const body = z.object({
      contestPoolId: z.string().uuid(),
      forceResettle: z.boolean().optional(),
    }).parse(await req.json());

    const poolId = body.contestPoolId;
    console.log("[settlement] Starting for pool:", poolId);

    const { data: pool, error: poolError } = await supabaseAdmin
      .from("contest_pools")
      .select("*, contest_templates(*)")
      .eq("id", poolId)
      .single();

    if (poolError || !pool) {
      return new Response(JSON.stringify({ error: "Pool not found", detail: poolError?.message }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (pool.status === "settled" && !body.forceResettle) {
      return new Response(JSON.stringify({ error: "Already settled" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Find siblings to settle
    const { data: siblingPools } = await supabaseAdmin
      .from("contest_pools")
      .select("id, status")
      .eq("contest_template_id", pool.contest_template_id)
      .eq("status", "scoring_completed");

    const poolsToSettle = siblingPools?.map((p) => p.id) || [poolId];

    let totalWinnersCount = 0;
    const settlementDetails: any[] = [];

    for (const currentPoolId of poolsToSettle) {
      const result = await settlePool(supabaseAdmin, currentPoolId);
      totalWinnersCount += result.winners;
      settlementDetails.push({ poolId: currentPoolId, ...result });
    }

    console.log("[settlement] Complete. Winners:", totalWinnersCount);

    try {
      await supabaseAdmin.from("compliance_audit_logs").insert({
        user_id: user.id,
        event_type: "contest_batch_settled",
        severity: "info",
        description: `Settlement: ${pool.contest_templates?.regatta_name} — ${poolsToSettle.length} pool(s)`,
        metadata: { pools_settled: poolsToSettle.length, winners: totalWinnersCount },
      });
    } catch (logErr: any) {
      console.warn("[settlement] Compliance log failed (non-fatal):", logErr?.message);
    }

    return new Response(JSON.stringify({
      success: true,
      poolsSettled: poolsToSettle.length,
      winnersCount: totalWinnersCount,
      details: settlementDetails,
    }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (error: any) {
    console.error("[settlement] FATAL:", error?.message, JSON.stringify(error));
    console.error("[settlement] Stack:", error?.stack);
    return new Response(JSON.stringify({ error: "An internal error occurred during settlement" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

async function settlePool(supabaseAdmin: any, contestPoolId: string): Promise<{ winners: number; detail: string }> {
  console.log("[settlePool] Starting:", contestPoolId);

  const { data: pool } = await supabaseAdmin
    .from("contest_pools")
    .select("*, contest_templates(*)")
    .eq("id", contestPoolId)
    .single();

  if (!pool) return { winners: 0, detail: "pool not found" };

  // Fetch scores
  let scores: any[] | null = null;
  let scoresError: any = null;

  const byPoolId = await supabaseAdmin
    .from("contest_scores")
    .select("*")
    .eq("pool_id", contestPoolId)
    .order("rank", { ascending: true });

  scores = byPoolId.data;
  scoresError = byPoolId.error;

  if (!scores || scores.length === 0) {
    const byInstanceId = await supabaseAdmin
      .from("contest_scores")
      .select("*")
      .eq("instance_id", contestPoolId)
      .order("rank", { ascending: true });
    scores = byInstanceId.data;
    scoresError = byInstanceId.error;
  }

  if (scoresError) return { winners: 0, detail: `scores error: ${scoresError.message}` };
  if (!scores || scores.length === 0) return { winners: 0, detail: "no scores found" };

  const prizePoolCents = pool.prize_pool_cents || 0;
  const isH2H = pool.max_entries <= 2;

  // Detect H2H true tie: both entries have same points AND same margin error
  let isTieRefund = false;
  if (isH2H && scores.length === 2) {
    const a = scores[0];
    const b = scores[1];
    // margin_bonus field stores the margin_error from scoring
    const marginA = a.margin_bonus ?? 0;
    const marginB = b.margin_bonus ?? 0;
    isTieRefund = a.total_points === b.total_points && Math.abs(marginA - marginB) < 0.01;
    if (isTieRefund) {
      console.log("[settlePool] H2H TRUE TIE detected — refunding entry fees instead of paying out");
    }
  }

  let payoutStructure: Record<string, number> = pool.payout_structure || { "1": prizePoolCents };
  if (isH2H && !isTieRefund) {
    payoutStructure = { "1": prizePoolCents };
  }

  const winners: { userId: string; entryId: string; rank: number; payoutCents: number; isTieRefund: boolean }[] = [];

  if (isTieRefund) {
    // Tie refund: each user gets their entry fee back
    const entryFeeCents = pool.entry_fee_cents || 0;
    for (const score of scores) {
      await supabaseAdmin
        .from("contest_scores")
        .update({ payout_cents: entryFeeCents, is_winner: false })
        .eq("id", score.id);
      winners.push({ userId: score.user_id, entryId: score.entry_id, rank: score.rank, payoutCents: entryFeeCents, isTieRefund: true });
    }
  } else {
    for (const score of scores) {
      const payoutCents = payoutStructure[String(score.rank)] || 0;
      const isWinner = payoutCents > 0;
      await supabaseAdmin
        .from("contest_scores")
        .update({ payout_cents: payoutCents, is_winner: isWinner })
        .eq("id", score.id);
      if (isWinner) {
        winners.push({ userId: score.user_id, entryId: score.entry_id, rank: score.rank, payoutCents, isTieRefund: false });
      }
    }
  }

  console.log("[settlePool] Payments to process:", winners.length, isTieRefund ? "(tie refunds)" : "(winners)");

  for (const winner of winners) {
    const { data: wallet, error: walletError } = await supabaseAdmin
      .from("wallets")
      .select("id")
      .eq("user_id", winner.userId)
      .single();

    if (walletError || !wallet) {
      console.error("[settlePool] No wallet for user:", winner.userId);
      continue;
    }

    const txnType = winner.isTieRefund ? "refund" : "payout";
    const description = winner.isTieRefund
      ? `Contest tie — entry fee refund (${pool.contest_templates?.regatta_name || "Contest"})`
      : `Contest payout — Rank ${winner.rank} (${pool.contest_templates?.regatta_name || "Contest"})`;

    const { error: txnError } = await supabaseAdmin.from("transactions").insert({
      user_id: winner.userId,
      wallet_id: wallet.id,
      type: txnType,
      amount: winner.payoutCents / 100,
      status: "completed",
      reference_id: winner.entryId,
      reference_type: "contest_entry",
      description,
      completed_at: new Date().toISOString(),
      metadata: { contest_pool_id: contestPoolId, is_tie_refund: winner.isTieRefund },
    });

    if (txnError) {
      console.error("[settlePool] Transaction error:", txnError.message);
      continue;
    }

    const lifetimeDelta = winner.isTieRefund
      ? { _lifetime_deposits_delta: 0, _lifetime_winnings_delta: 0 }
      : { _lifetime_winnings_delta: winner.payoutCents };

    const { error: walletUpdateError } = await supabaseAdmin.rpc("update_wallet_balance", {
      _wallet_id: wallet.id,
      _available_delta: winner.payoutCents,
      _pending_delta: 0,
      ...lifetimeDelta,
    });

    if (walletUpdateError) {
      console.error("[settlePool] Wallet RPC error:", walletUpdateError.message);
    } else {
      console.log("[settlePool] Paid", winner.payoutCents, "cents to", winner.userId, winner.isTieRefund ? "(tie refund)" : "(payout)");
    }
  }

  // Mark all entries as settled
  for (const score of scores) {
    await supabaseAdmin.from("contest_entries").update({ status: "settled" }).eq("id", score.entry_id);
  }

  await supabaseAdmin.from("contest_pools").update({ status: "settled" }).eq("id", contestPoolId);

  console.log("[settlePool] Done:", contestPoolId, "payments:", winners.length);
  return { winners: winners.length, detail: isTieRefund ? "tie_refund" : "ok" };
}
