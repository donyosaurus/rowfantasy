import { createClient } from "https://esm.sh/@supabase/supabase-js@2.76.1";
import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import { authenticateUser, checkRateLimit } from "../shared/auth-helpers.ts";
import { mapErrorToClient, logSecureError, ERROR_MESSAGES } from "../shared/error-handler.ts";
import { getCorsHeaders } from "../shared/cors.ts";

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);

  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json", Allow: "POST, OPTIONS" },
    });
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

    const enterSchema = z.object({
      contest_template_id: z.string().uuid(),
      tier_name: z.string().min(1).max(100).optional().nullable(),
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
      state_code: z.string().length(2).optional().nullable(),
    });

    const body = enterSchema.parse(await req.json());

    // Fetch wallet via auth-scoped client (RLS enforced)
    const { data: wallet, error: walletError } = await auth.supabase
      .from("wallets")
      .select("id")
      .eq("user_id", userId)
      .single();

    if (walletError || !wallet) {
      return new Response(JSON.stringify({ error: "Wallet not found. Please contact support." }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Fetch template name for success message (and pre-RPC sanity check)
    const { data: template, error: templateError } = await auth.supabase
      .from("contest_templates")
      .select("regatta_name")
      .eq("id", body.contest_template_id)
      .single();

    if (templateError || !template) {
      return new Response(JSON.stringify({ error: "Contest template not found." }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_KEY);

    const stateCode = body.state_code || req.headers.get("x-user-state") || "";

    const { data: result, error: rpcError } = await supabaseAdmin.rpc("enter_contest_pool_atomic", {
      _user_id: userId,
      _wallet_id: wallet.id,
      _contest_template_id: body.contest_template_id,
      _tier_name: body.tier_name ?? null,
      _picks: body.picks,
      _state_code: stateCode,
    });

    if (rpcError) {
      const requestId = logSecureError("contest-matchmaking", rpcError);
      return new Response(
        JSON.stringify({ error: mapErrorToClient(rpcError), requestId }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const entry = Array.isArray(result) ? result[0] : result;

    if (!entry) {
      const requestId = logSecureError(
        "contest-matchmaking",
        new Error("Empty result from enter_contest_pool_atomic"),
      );
      return new Response(
        JSON.stringify({ error: ERROR_MESSAGES.INTERNAL_ERROR, requestId }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (!entry.allowed) {
      const errorMap: Record<string, { status: number; message: string }> = {
        self_excluded: { status: 403, message: "Your account is self-excluded from contest entry." },
        duplicate_event: { status: 400, message: "You can only select one crew per event." },
        insufficient_events: { status: 400, message: "You must pick crews from at least 2 different events." },
        template_not_found: { status: 404, message: "Contest template not found." },
        wallet_not_found: { status: 404, message: "Wallet not found. Please contact support." },
        no_pool_for_tier: { status: 404, message: "No pool found for this tier." },
        all_pools_full: { status: 409, message: "This contest is full." },
        invalid_pool_fee: { status: 500, message: "Invalid contest configuration." },
        insufficient_balance: { status: 402, message: "Insufficient balance." },
      };

      const mapped = errorMap[entry.reason] ?? { status: 400, message: ERROR_MESSAGES.INTERNAL_ERROR };

      if (!errorMap[entry.reason]) {
        logSecureError("contest-matchmaking", new Error(`Unknown matchmaking reason: ${entry.reason}`));
      }

      return new Response(JSON.stringify({ error: mapped.message }), {
        status: mapped.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Best-effort compliance audit log
    try {
      await supabaseAdmin.from("compliance_audit_logs").insert({
        user_id: userId,
        event_type: "contest_entry_submitted",
        description: "User entered contest pool",
        severity: "info",
        metadata: {
          entry_id: entry.entry_id,
          pool_id: entry.pool_id,
          contest_template_id: body.contest_template_id,
          tier_name: body.tier_name,
          state_code: stateCode,
          balance_after_cents: entry.available_balance_cents,
          current_entries: entry.current_entries,
          max_entries: entry.max_entries,
        },
      });
    } catch (logError) {
      logSecureError("contest-matchmaking", logError);
    }

    return new Response(
      JSON.stringify({
        entryId: entry.entry_id,
        poolId: entry.pool_id,
        currentEntries: entry.current_entries,
        maxEntries: entry.max_entries,
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
