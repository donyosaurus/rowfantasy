import { withFnVersion } from '../shared/fn-version.ts';
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.76.1";
import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import { authenticateUser, checkRateLimit } from "../shared/auth-helpers.ts";
import { performComplianceChecks } from "../shared/compliance-checks.ts";
import { mapErrorToClient, logSecureError, ERROR_MESSAGES } from "../shared/error-handler.ts";
import { getCorsHeaders } from "../shared/cors.ts";

Deno.serve(withFnVersion('contest-matchmaking', async (req) => {
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
    const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_KEY);

    // Rate limit MUST use the service-role client — check_rate_limit_atomic is
    // granted to service_role only. Passing auth.supabase silently fails-open.
    const rateLimitOk = await checkRateLimit(supabaseAdmin, userId, "contest-matchmaking", 20, 1);
    if (!rateLimitOk) {
      return new Response(JSON.stringify({ error: mapErrorToClient({ message: "rate limit" }) }), {
        status: 429,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Frontend sends camelCase. Keep this contract — do not regress to snake_case.
    const enterSchema = z.object({
      contestTemplateId: z.string().uuid(),
      tierId: z.string().optional().nullable(),
      tierName: z.string().min(1).max(100).optional().nullable(),
      entryFeeCents: z.number().int().nonnegative().optional().nullable(),
      stateCode: z.string().length(2).optional().nullable(),
      picks: z
        .array(
          z.object({
            crewId: z.string(),
            event_id: z.string().optional(),
            predictedMargin: z.number().optional(),
            position: z.number().int().min(1).max(10).optional(),
            weight: z.number().int().min(1).max(50).optional(),
          }),
        )
        .min(1)
        .max(50),

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
      .select("regatta_name, scoring_config, roster_mode, max_picks")
      .eq("id", body.contestTemplateId)
      .single();

    if (templateError || !template) {
      return new Response(JSON.stringify({ error: "Contest template not found." }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Early, clear bound on roster size for every mode. The RPC re-checks.
    if (body.picks.length > ((template as any).max_picks ?? 4)) {
      return new Response(
        JSON.stringify({ error: "You have selected more picks than this contest allows." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Podium Predictor: every pick is an ordered podium slot. The RPC re-checks
    // the full 1..N permutation; this is the fast, human-readable rejection.
    if ((template as any).scoring_config?.primitive === "prediction") {
      if (body.picks.some((p) => typeof p.position !== "number")) {
        return new Response(
          JSON.stringify({ error: "Each podium pick needs a position." }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
    }

    // Confidence Pick'em: every pick carries a rank. The RPC re-checks the full
    // 1..k permutation; this is the fast, human-readable rejection.
    if ((template as any).scoring_config?.confidence === true) {
      if (body.picks.some((p) => typeof p.weight !== "number")) {
        return new Response(
          JSON.stringify({ error: "Each pick needs a confidence rank." }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
    }



    const rosterMode = (template as any).roster_mode ?? "per_race";
    const isPerCompetitor = (template as any).scoring_config !== null && rosterMode === "per_competitor";

    // per_competitor (GC) rosters carry only crewId; every other mode keeps
    // today's contract where each pick MUST name its race/event.
    if (!isPerCompetitor && body.picks.some((p) => !p.event_id || p.event_id.trim() === "")) {
      return new Response(
        JSON.stringify({ error: "Each pick must include an event." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }


    // Legacy templates (scoring_config NULL) keep today's required-margin contract.
    // New-path templates require a margin only when the tiebreak is margin_error.
    const scoringConfig = (template as any).scoring_config ?? null;
    const needsMargin = scoringConfig === null ||
      (typeof scoringConfig === "object" && (scoringConfig as any)?.tiebreak === "margin_error");

    if (needsMargin && body.picks.some((p) => !Number.isFinite(p.predictedMargin as number))) {
      return new Response(
        JSON.stringify({ error: "Predicted margin is required for this contest." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }


    const stateCode = body.stateCode || req.headers.get("x-user-state") || "";
    // P0-C9 (2026-05-21): cf-connecting-ip is the trusted client IP source at Supabase Edge Functions.
    // Cloudflare WAF actively blocks spoofing attempts (verified empirically via debug-headers test).
    // Fail-closed if cf-connecting-ip is absent (unexpected at production Edge Functions but possible).
    const ipAddress = req.headers.get("cf-connecting-ip");
    if (!ipAddress) {
      return new Response(
        JSON.stringify({ error: "Geolocation verification required" }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Application-layer compliance gates (P0-C1 / P0-C7): geo, state-reg, age, inactive, SX, employee.
    // amountCents=0 — actual entry fee is determined inside enter_contest_pool_atomic.
    const compliance = await performComplianceChecks({
      userId,
      stateCode,
      amountCents: 0,
      actionType: "entry",
      ipAddress,
    }, req);
    if (!compliance.allowed) {
      return new Response(
        JSON.stringify({ error: compliance.reason ?? "Compliance check failed" }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Record-integrity: persist the compliance-resolved state, NOT the spoofable caller value.
    const resolvedStateCode = compliance.resolvedStateCode;

    const { data: result, error: rpcError } = await supabaseAdmin.rpc("enter_contest_pool_atomic", {
      _user_id: userId,
      _wallet_id: wallet.id,
      _contest_template_id: body.contestTemplateId,
      _tier_name: body.tierName ?? null,
      _picks: body.picks,
      _state_code: resolvedStateCode,
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
        duplicate_competitor: { status: 400, message: "You can only pick each competitor once." },
        duplicate_event: { status: 400, message: "You can only select one crew per event." },
        insufficient_events: { status: 400, message: "You must pick crews from at least 2 different events." },
        insufficient_picks: { status: 400, message: "You must make at least the minimum number of picks for this contest." },
        too_many_picks: { status: 400, message: "You have selected more picks than this contest allows." },
        insufficient_competitors: { status: 400, message: "Your picks must include at least 2 different competitors." },
        invalid_pick: { status: 400, message: "One or more picks are not valid for this contest." },
        entry_limit_reached: { status: 400, message: "You have already entered this contest the maximum number of times." },
        template_not_found: { status: 404, message: "Contest template not found." },
        wallet_not_found: { status: 404, message: "Wallet not found. Please contact support." },
        no_pool_for_tier: { status: 404, message: "No pool found for this tier." },
        all_pools_full: { status: 409, message: "This contest is full." },
        invalid_pool_fee: { status: 500, message: "Invalid contest configuration." },
        insufficient_balance: { status: 402, message: "Insufficient balance." },
        roster_mode_unsupported: { status: 400, message: "This contest type is not yet supported." },
        tier_rule_violation: { status: 400, message: "Pick exactly one competitor from each tier." },
        invalid_scoring_config: { status: 500, message: "Invalid contest configuration." },
        prediction_not_free: { status: 500, message: "Invalid contest configuration." },

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
          contest_template_id: body.contestTemplateId,
          tier_id: body.tierId ?? null,
          tier_name: body.tierName ?? null,
          entry_fee_cents: body.entryFeeCents ?? null,
          state_code: resolvedStateCode,
          state_code_source: compliance.stateCodeSource,
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
}));
