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
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized", detail: authError?.message }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: roles } = await supabase.from("user_roles").select("role").eq("user_id", user.id).eq("role", "admin");

    if (!roles || roles.length === 0) {
      return new Response(JSON.stringify({ error: "Admin access required" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabaseAdmin = createClient(supabaseUrl, serviceKey);

    const body = z
      .object({
        contestPoolId: z.string().uuid(),
        forceResettle: z.boolean().optional(),
      })
      .parse(await req.json());

    const poolId = body.contestPoolId;
    console.log("[settlement] Starting for pool:", poolId);

    // STEP A: fetch pool
    const { data: pool, error: poolError } = await supabaseAdmin
      .from("contest_pools")
      .select("*, contest_templates(*)")
      .eq("id", poolId)
      .single();

    if (poolError || !pool) {
      return new Response(JSON.stringify({ error: "Pool not found", detail: poolError?.message }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    console.log("[settlement] Pool found, status:", pool.status);

    if (pool.status === "settled" && !body.forceResettle) {
      return new Response(JSON.stringify({ error: "Already settled" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // STEP B: find siblings to settle
    const { data: siblingPools, error: siblingError } = await supabaseAdmin
      .from("contest_pools")
      .select("id, status")
      .eq("contest_template_id", pool.contest_template_id)
      .eq("status", "scoring_completed");

    console.log(
      "[settlement] Sibling pools with scoring_completed:",
      siblingPools?.length ?? 0,
      siblingError?.message ?? "",
    );

    const poolsToSettle = siblingPools?.map((p) => p.id) || [poolId];

    // STEP C: settle each pool
    let totalWinnersCount = 0;
    const settlementDetails: any[] = [];

    for (const currentPoolId of poolsToSettle) {
      const result = await settlePool(supabaseAdmin, currentPoolId);
      totalWinnersCount += result.winners;
      settlementDetails.push({ poolId: currentPoolId, ...result });
    }

    console.log("[settlement] Complete. Winners:", totalWinnersCount);

    // STEP D: compliance log (non-fatal if it fails)
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

    return new Response(
      JSON.stringify({
        success: true,
        poolsSettled: poolsToSettle.length,
        winnersCount: totalWinnersCount,
        details: settlementDetails,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error: any) {
    console.error("[settlement] FATAL:", error?.message, JSON.stringify(error));
    return new Response(JSON.stringify({ error: error?.message || "Unknown error", stack: error?.stack }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
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

  // Try pool_id first (new column), fall back to instance_id (legacy)
  let scores: any[] | null = null;
  let scoresError: any = null;

  const byPoolId = await supabaseAdmin
    .from("contest_scores")
    .select("*")
    .eq("pool_id", contestPoolId)
    .order("rank", { ascending: true });

  scores = byPoolId.data;
  scoresError = byPoolId.error;
  console.log("[settlePool] Scores by pool_id:", scores?.length ?? 0, scoresError?.message ?? "");

  // Fallback: some scores may have been written before migration with instance_id
  if (!scores || scores.length === 0) {
    const byInstanceId = await supabaseAdmin
      .from("contest_scores")
      .select("*")
      .eq("instance_id", contestPoolId)
      .order("rank", { ascending: true });
    scores = byInstanceId.data;
    scoresError = byInstanceId.error;
    console.log("[settlePool] Scores by instance_id (fallback):", scores?.length ?? 0, scoresError?.message ?? "");
  }

  if (scoresError) return { winners: 0, detail: `scores error: ${scoresError.message}` };
  if (!scores || scores.length === 0) return { winners: 0, detail: "no scores found" };

  const prizePoolCents = pool.prize_pool_cents || 0;
  let payoutStructure: Record<string, number> = pool.payout_structure || { "1": prizePoolCents };

  // Fix 6: H2H forced winner-takes-all in settlement
  const isH2H = pool.max_entries <= 2;
  if (isH2H) {
    payoutStructure = { "1": prizePoolCents };
    console.log("[settlePool] H2H pool detected — forcing winner-takes-all");
  }

  console.log("[settlePool] Prize pool cents:", prizePoolCents, "Payout structure:", JSON.stringify(payoutStructure));

  const winners: { userId: string; entryId: string; rank: number; payoutCents: number }[] = [];

  for (const score of scores) {
    const payoutCents = payoutStructure[String(score.rank)] || 0;
    const isWinner = payoutCents > 0;
    await supabaseAdmin
      .from("contest_scores")
      .update({ payout_cents: payoutCents, is_winner: isWinner })
      .eq("id", score.id);
    if (isWinner) {
      winners.push({ userId: score.user_id, entryId: score.entry_id, rank: score.rank, payoutCents });
    }
  }

  console.log("[settlePool] Winners to pay:", winners.length);

  for (const winner of winners) {
    const { data: wallet, error: walletError } = await supabaseAdmin
      .from("wallets")
      .select("id")
      .eq("user_id", winner.userId)
      .single();

    if (walletError || !wallet) {
      console.error("[settlePool] No wallet for user:", winner.userId, walletError?.message);
      continue;
    }

    const { error: txnError } = await supabaseAdmin.from("transactions").insert({
      user_id: winner.userId,
      wallet_id: wallet.id,
      type: "payout",
      amount: winner.payoutCents / 100,
      status: "completed",
      reference_id: winner.entryId,
      reference_type: "contest_entry",
      description: `Contest payout — Rank ${winner.rank} (${pool.contest_templates?.regatta_name || "Contest"})`,
      completed_at: new Date().toISOString(),
      metadata: { contest_pool_id: contestPoolId },
    });

    if (txnError) {
      console.error("[settlePool] Transaction error:", txnError.message, JSON.stringify(txnError));
      continue;
    }

    const { error: walletUpdateError } = await supabaseAdmin.rpc("update_wallet_balance", {
      _wallet_id: wallet.id,
      _available_delta: winner.payoutCents,
      _pending_delta: 0,
      _lifetime_winnings_delta: winner.payoutCents,
    });

    if (walletUpdateError) {
      console.error("[settlePool] Wallet RPC error:", walletUpdateError.message, JSON.stringify(walletUpdateError));
    } else {
      console.log("[settlePool] Paid", winner.payoutCents, "cents to", winner.userId);
    }
  }

  for (const score of scores) {
    await supabaseAdmin.from("contest_entries").update({ status: "settled" }).eq("id", score.entry_id);
  }

  await supabaseAdmin.from("contest_pools").update({ status: "settled" }).eq("id", contestPoolId);

  console.log("[settlePool] Done:", contestPoolId, "winners:", winners.length);
  return { winners: winners.length, detail: "ok" };
}
