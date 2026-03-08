import { createClient } from "https://esm.sh/@supabase/supabase-js@2.76.1";
import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import { authenticateUser, checkRateLimit } from "../shared/auth-helpers.ts";
import { mapErrorToClient, logSecureError } from "../shared/error-handler.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const auth = await authenticateUser(req, SUPABASE_URL, ANON_KEY);
    if (!auth) {
      return new Response(JSON.stringify({ error: mapErrorToClient({ message: "not authenticated" }) }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const userId = auth.user.id;

    const rateLimitOk = await checkRateLimit(auth.supabase, userId, "contest-matchmaking", 20, 1);
    if (!rateLimitOk) {
      return new Response(JSON.stringify({ error: mapErrorToClient({ message: "rate limit" }) }), {
        status: 429,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const entrySchema = z.object({
      contestTemplateId: z.string().uuid(),
      tierId: z.string().min(1).max(100),
      picks: z
        .array(
          z.object({
            crewId: z.string(),
            event_id: z.string(),
            predictedMargin: z.number(),
          }),
        )
        .min(1)
        .max(10),
      entryFeeCents: z.number().int().positive().max(1000000),
      stateCode: z.string().length(2).optional().nullable(),
    });

    const body = entrySchema.parse(await req.json());

    const uniqueEvents = new Set(body.picks.map((p) => p.event_id));
    if (uniqueEvents.size < 2) {
      return new Response(JSON.stringify({ error: "You must pick crews from at least 2 different events." }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log("[matchmaking] User", userId, "entering template:", body.contestTemplateId);

    const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_KEY);

    // Get contest template
    const { data: template, error: templateError } = await supabaseAdmin
      .from("contest_templates")
      .select("*")
      .eq("id", body.contestTemplateId)
      .single();

    if (templateError || !template) {
      return new Response(JSON.stringify({ error: "Contest template not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Check for duplicate entry
    const { data: existingEntry } = await auth.supabase
      .from("contest_entries")
      .select("id")
      .eq("user_id", userId)
      .eq("contest_template_id", body.contestTemplateId)
      .eq("status", "active")
      .maybeSingle();

    if (existingEntry) {
      return new Response(JSON.stringify({ error: "You have already entered this contest." }), {
        status: 409,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // -----------------------------------------------------------------------
    // WALLET: check and deduct entry fee BEFORE creating entry
    // -----------------------------------------------------------------------
    const { data: wallet, error: walletError } = await supabaseAdmin
      .from("wallets")
      .select("id, available_balance")
      .eq("user_id", userId)
      .single();

    if (walletError || !wallet) {
      return new Response(JSON.stringify({ error: "Wallet not found. Please contact support." }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // wallet.available_balance is stored in CENTS; body.entryFeeCents is also cents
    const balanceCents = Number(wallet.available_balance);
    const entryFeeCents = body.entryFeeCents;
    const entryFeeDollars = entryFeeCents / 100;
    const balanceDollars = balanceCents / 100;

    if (balanceCents < entryFeeCents) {
      return new Response(
        JSON.stringify({
          error: `Insufficient balance. You need $${entryFeeDollars.toFixed(2)} but have $${balanceDollars.toFixed(2)}.`,
        }),
        {
          status: 402,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // -----------------------------------------------------------------------
    // POOL: find the contest_pool for this tierId (tierId IS the contest_pools.id)
    // If full, clone it for overflow
    // -----------------------------------------------------------------------
    // tierId passed from ContestDetail is the contest_pools.id
    const contestPoolId = body.tierId;

    const { data: contestPool, error: poolError } = await supabaseAdmin
      .from("contest_pools")
      .select("*")
      .eq("id", contestPoolId)
      .single();

    if (poolError || !contestPool) {
      return new Response(JSON.stringify({ error: "Contest pool not found." }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Determine which pool to actually place the entry in
    let targetPoolId = contestPoolId;
    let targetPool = contestPool;

    if (contestPool.current_entries >= contestPool.max_entries) {
      // Pool is full — try to find an overflow pool or clone one
      const { data: overflowPools } = await supabaseAdmin
        .from("contest_pools")
        .select("*")
        .eq("contest_template_id", contestPool.contest_template_id)
        .eq("tier_id", contestPool.tier_id)
        .eq("status", "open")
        .order("created_at", { ascending: true });

      const available = (overflowPools || []).find(
        (p: any) => p.id !== contestPoolId && p.current_entries < p.max_entries,
      );

      if (available) {
        targetPoolId = available.id;
        targetPool = available;
        console.log("[matchmaking] Using overflow pool:", targetPoolId);
      } else {
        // Clone the original pool for a new overflow slot
        const { data: newPoolId, error: cloneError } = await supabaseAdmin.rpc("clone_contest_pool", {
          p_original_pool_id: contestPoolId,
        });

        if (cloneError || !newPoolId) {
          console.error("[matchmaking] Clone error:", cloneError);
          return new Response(JSON.stringify({ error: "Unable to allocate to a contest pool. Please try again." }), {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        const { data: newPool } = await supabaseAdmin.from("contest_pools").select("*").eq("id", newPoolId).single();

        targetPoolId = newPoolId;
        targetPool = newPool;
        console.log("[matchmaking] Cloned new overflow pool:", newPoolId);
      }
    }

    // -----------------------------------------------------------------------
    // DEDUCT wallet BEFORE creating entry (atomic-ish — if entry fails, refund below)
    // -----------------------------------------------------------------------
    const { error: deductError } = await supabaseAdmin.rpc("update_wallet_balance", {
      _wallet_id: wallet.id,
      _available_delta: -body.entryFeeCents, // negative = deduct (cents)
      _pending_delta: 0,
      _lifetime_winnings_delta: 0,
    });

    if (deductError) {
      console.error("[matchmaking] Wallet deduction failed:", deductError.message);
      return new Response(JSON.stringify({ error: "Payment failed. Please try again." }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Record the fee transaction
    await supabaseAdmin.from("transactions").insert({
      user_id: userId,
      wallet_id: wallet.id,
      type: "entry_fee",
      amount: entryFeeDollars,
      status: "completed",
      reference_type: "contest_entry",
      description: `Entry fee — ${template.regatta_name}`,
      completed_at: new Date().toISOString(),
      metadata: { contest_pool_id: targetPoolId, contest_template_id: body.contestTemplateId },
    });

    // -----------------------------------------------------------------------
    // CREATE ENTRY — pool_id now correctly points to contest_pools.id
    // -----------------------------------------------------------------------
    const { data: entry, error: entryError } = await supabaseAdmin
      .from("contest_entries")
      .insert({
        user_id: userId,
        pool_id: targetPoolId, // ← contest_pools.id (correct)
        contest_template_id: body.contestTemplateId,
        picks: body.picks,
        entry_fee_cents: body.entryFeeCents,
        state_code: body.stateCode ?? null,
        status: "active",
      })
      .select()
      .single();

    if (entryError) {
      // Refund wallet if entry creation failed
      console.error("[matchmaking] Entry insert failed:", entryError.message, "— refunding wallet");
      await supabaseAdmin.rpc("update_wallet_balance", {
        _wallet_id: wallet.id,
        _available_delta: body.entryFeeCents, // refund
        _pending_delta: 0,
        _lifetime_winnings_delta: 0,
      });
      return new Response(JSON.stringify({ error: "Failed to create entry. Your payment has been refunded." }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Update pool entry count
    await supabaseAdmin
      .from("contest_pools")
      .update({ current_entries: targetPool.current_entries + 1 })
      .eq("id", targetPoolId);

    // Compliance log
    await supabaseAdmin.from("compliance_audit_logs").insert({
      user_id: userId,
      event_type: "contest_entry_created",
      severity: "info",
      description: `User entered ${template.regatta_name}`,
      state_code: body.stateCode ?? null,
      metadata: {
        entry_id: entry.id,
        pool_id: targetPoolId,
        entry_fee_cents: body.entryFeeCents,
        picks_count: body.picks.length,
        unique_events: uniqueEvents.size,
        wallet_deducted: body.entryFeeCents,
      },
    });

    console.log("[matchmaking] Entry created:", entry.id, "pool:", targetPoolId);

    return new Response(
      JSON.stringify({
        entryId: entry.id,
        poolId: targetPoolId,
        currentEntries: targetPool.current_entries + 1,
        maxEntries: targetPool.max_entries,
        message: `Successfully entered ${template.regatta_name}`,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error: any) {
    const requestId = logSecureError("contest-matchmaking", error);
    const clientMessage = mapErrorToClient(error);
    return new Response(JSON.stringify({ error: clientMessage, requestId }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
