import { createClient } from "https://esm.sh/@supabase/supabase-js@2.76.1";
import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import { authenticateUser, checkRateLimit } from "../shared/auth-helpers.ts";
import { mapErrorToClient, logSecureError } from "../shared/error-handler.ts";
import { getCorsHeaders } from '../shared/cors.ts';

// ---------------------------------------------------------------------------
// H2H Self-Match Prevention Helper
// ---------------------------------------------------------------------------
async function resolveH2HSelfMatch(
  supabaseAdmin: any,
  targetPoolId: string,
  targetPool: any,
  userId: string,
  tierName: string | null,
  corsHeaders: Record<string, string>,
): Promise<{ targetPoolId: string; targetPool: any; error?: Response }> {
  // Only applies to H2H (max 2) with overflow
  if (targetPool.max_entries !== 2 || !targetPool.allow_overflow) {
    return { targetPoolId, targetPool };
  }

  // Check if user already has an active entry in this pool
  const { data: existingEntry } = await supabaseAdmin
    .from("contest_entries")
    .select("id")
    .eq("pool_id", targetPoolId)
    .eq("user_id", userId)
    .eq("status", "active")
    .limit(1)
    .single();

  if (!existingEntry) {
    return { targetPoolId, targetPool };
  }

  // User is already in this pool — find another open pool they are NOT in
  let siblingQuery = supabaseAdmin
    .from("contest_pools")
    .select("id, current_entries, max_entries")
    .eq("contest_template_id", targetPool.contest_template_id)
    .eq("tier_id", targetPool.tier_id)
    .eq("status", "open")
    .lt("current_entries", 2)
    .order("created_at", { ascending: true });

  if (tierName) {
    siblingQuery = siblingQuery.eq("tier_name", tierName);
  }

  const { data: siblingPools } = await siblingQuery;

  for (const sp of (siblingPools || [])) {
    const { data: userInSibling } = await supabaseAdmin
      .from("contest_entries")
      .select("id")
      .eq("pool_id", sp.id)
      .eq("user_id", userId)
      .eq("status", "active")
      .limit(1)
      .single();

    if (!userInSibling) {
      const { data: freshPool } = await supabaseAdmin
        .from("contest_pools")
        .select("*")
        .eq("id", sp.id)
        .single();
      console.log("[matchmaking] H2H self-match prevention: redirected to pool:", sp.id);
      return { targetPoolId: sp.id, targetPool: freshPool };
    }
  }

  // All sibling pools contain this user — clone a fresh one
  const { data: newPoolId, error: cloneError } = await supabaseAdmin.rpc("clone_contest_pool", {
    p_original_pool_id: targetPoolId,
  });
  if (cloneError || !newPoolId) {
    console.error("[matchmaking] H2H clone error:", cloneError);
    return {
      targetPoolId,
      targetPool,
      error: new Response(JSON.stringify({ error: "Unable to allocate contest pool." }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }),
    };
  }
  const { data: newPool } = await supabaseAdmin
    .from("contest_pools")
    .select("*")
    .eq("id", newPoolId)
    .single();
  console.log("[matchmaking] H2H self-match prevention: cloned new pool:", newPoolId);
  return { targetPoolId: newPoolId, targetPool: newPool };
}

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);

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
      tierName: z.string().max(100).optional().nullable(),
    });

    const body = entrySchema.parse(await req.json());

    const eventIdList = body.picks.map((p) => p.event_id);
    const uniqueEvents = new Set(eventIdList);

    if (uniqueEvents.size !== eventIdList.length) {
      return new Response(JSON.stringify({ error: "You can only select one crew per event." }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (uniqueEvents.size < 2) {
      return new Response(JSON.stringify({ error: "You must pick crews from at least 2 different events." }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log("[matchmaking] User", userId, "entering template:", body.contestTemplateId);

    const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_KEY);

    // Self-exclusion check
    const { data: responsibleGaming } = await supabaseAdmin
      .from('responsible_gaming')
      .select('self_exclusion_until')
      .eq('user_id', userId)
      .maybeSingle();

    if (responsibleGaming?.self_exclusion_until) {
      const exclusionEnd = new Date(responsibleGaming.self_exclusion_until);
      if (exclusionEnd > new Date()) {
        return new Response(
          JSON.stringify({
            error: `Your account is self-excluded until ${exclusionEnd.toLocaleDateString()}. You cannot enter contests during this period.`
          }),
          { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

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

    // --- Duplicate entry check REMOVED: multi-entry is now allowed ---

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

    const balanceCents = Number(wallet.available_balance);
    const entryFeeCents = body.entryFeeCents;
    const entryFeeDollars = entryFeeCents / 100;
    const balanceDollars = balanceCents / 100;

    if (balanceCents < entryFeeCents) {
      return new Response(
        JSON.stringify({
          error: `Insufficient balance. You need $${entryFeeDollars.toFixed(2)} but have $${balanceDollars.toFixed(2)}.`,
        }),
        { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // -----------------------------------------------------------------------
    // POOL SELECTION
    // -----------------------------------------------------------------------
    let targetPoolId: string;
    let targetPool: any;

    if (body.tierName) {
      // ---- TIERED CONTEST ----
      const { data: tierPools } = await supabaseAdmin
        .from("contest_pools")
        .select("*")
        .eq("contest_template_id", body.contestTemplateId)
        .eq("tier_name", body.tierName)
        .eq("status", "open")
        .order("created_at", { ascending: true });

      const available = (tierPools || []).find((p: any) => p.current_entries < p.max_entries);

      if (available) {
        targetPoolId = available.id;
        targetPool = available;
        console.log("[matchmaking] Found tier pool:", targetPoolId, "tier:", body.tierName);
      } else {
        const { data: anyTierPool } = await supabaseAdmin
          .from("contest_pools")
          .select("*")
          .eq("contest_template_id", body.contestTemplateId)
          .eq("tier_name", body.tierName)
          .order("created_at", { ascending: true })
          .limit(1)
          .single();

        if (!anyTierPool) {
          return new Response(JSON.stringify({ error: "No pool found for this tier." }), {
            status: 404,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        if (!anyTierPool.allow_overflow) {
          return new Response(JSON.stringify({ error: "This tier is full." }), {
            status: 409,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        const { data: newPoolId, error: cloneError } = await supabaseAdmin.rpc("clone_contest_pool", {
          p_original_pool_id: anyTierPool.id,
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
        console.log("[matchmaking] Cloned overflow tier pool:", newPoolId, "tier:", body.tierName);
      }

      // H2H self-match prevention for tiered contests
      const h2hResult = await resolveH2HSelfMatch(
        supabaseAdmin, targetPoolId, targetPool, userId, body.tierName, corsHeaders
      );
      if (h2hResult.error) return h2hResult.error;
      targetPoolId = h2hResult.targetPoolId;
      targetPool = h2hResult.targetPool;

    } else {
      // ---- NON-TIERED CONTEST ----
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

      targetPoolId = contestPoolId;
      targetPool = contestPool;

      if (contestPool.current_entries >= contestPool.max_entries) {
        // Pool is full — try overflow
        const { data: overflowPools } = await supabaseAdmin
          .from("contest_pools")
          .select("*")
          .eq("contest_template_id", contestPool.contest_template_id)
          .eq("tier_id", contestPool.tier_id)
          .eq("status", "open")
          .order("created_at", { ascending: true });

        // H2H-aware overflow search
        let available: any = null;
        if (contestPool.max_entries === 2) {
          for (const p of (overflowPools || [])) {
            if (p.id === contestPoolId || p.current_entries >= p.max_entries) continue;
            const { data: userInPool } = await supabaseAdmin
              .from("contest_entries")
              .select("id")
              .eq("pool_id", p.id)
              .eq("user_id", userId)
              .eq("status", "active")
              .limit(1)
              .single();
            if (!userInPool) {
              available = p;
              break;
            }
          }
        } else {
          available = (overflowPools || []).find(
            (p: any) => p.id !== contestPoolId && p.current_entries < p.max_entries,
          );
        }

        if (available) {
          targetPoolId = available.id;
          targetPool = available;
          console.log("[matchmaking] Using overflow pool:", targetPoolId);
        } else {
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

      // H2H self-match prevention for non-tiered contests
      const h2hResult = await resolveH2HSelfMatch(
        supabaseAdmin, targetPoolId, targetPool, userId, null, corsHeaders
      );
      if (h2hResult.error) return h2hResult.error;
      targetPoolId = h2hResult.targetPoolId;
      targetPool = h2hResult.targetPool;
    }

    // -----------------------------------------------------------------------
    // DEDUCT wallet BEFORE creating entry
    // -----------------------------------------------------------------------
    const { error: deductError } = await supabaseAdmin.rpc("update_wallet_balance", {
      _wallet_id: wallet.id,
      _available_delta: -body.entryFeeCents,
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
    const { error: txnError } = await supabaseAdmin.from("transactions").insert({
      user_id: userId,
      wallet_id: wallet.id,
      type: "entry_fee" as const,
      amount: entryFeeDollars,
      status: "completed" as const,
      reference_type: "contest_entry",
      description: `Entry fee — ${template.regatta_name}`,
      completed_at: new Date().toISOString(),
      metadata: { contest_pool_id: targetPoolId, contest_template_id: body.contestTemplateId },
    });

    if (txnError) {
      console.error("[matchmaking] Transaction insert failed:", txnError.message);
    }

    // Record in ledger_entries
    const { error: ledgerError } = await supabaseAdmin.from("ledger_entries").insert({
      user_id: userId,
      amount: -entryFeeCents,
      transaction_type: "ENTRY_FEE",
      description: `Contest Entry Fee`,
      reference_id: targetPoolId,
    });

    if (ledgerError) {
      console.error("[matchmaking] Ledger insert failed:", ledgerError.message);
    }

    // -----------------------------------------------------------------------
    // CREATE ENTRY
    // -----------------------------------------------------------------------
    const { data: entry, error: entryError } = await supabaseAdmin
      .from("contest_entries")
      .insert({
        user_id: userId,
        pool_id: targetPoolId,
        contest_template_id: body.contestTemplateId,
        picks: body.picks,
        entry_fee_cents: body.entryFeeCents,
        state_code: body.stateCode ?? null,
        tier_name: body.tierName ?? null,
        status: "active",
      })
      .select()
      .single();

    if (entryError) {
      console.error("[matchmaking] Entry insert failed:", entryError.message, "— refunding wallet");
      await supabaseAdmin.rpc("update_wallet_balance", {
        _wallet_id: wallet.id,
        _available_delta: body.entryFeeCents,
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
