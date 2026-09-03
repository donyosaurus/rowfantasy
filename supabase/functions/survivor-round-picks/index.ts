import { withFnVersion } from '../shared/fn-version.ts';
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.76.1";
import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import { authenticateUser, checkRateLimit } from "../shared/auth-helpers.ts";
import { performComplianceChecks } from "../shared/compliance-checks.ts";
import { mapErrorToClient, logSecureError, ERROR_MESSAGES } from "../shared/error-handler.ts";
import { getCorsHeaders } from "../shared/cors.ts";

Deno.serve(withFnVersion('survivor-round-picks', async (req) => {
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
    const rateLimitOk = await checkRateLimit(supabaseAdmin, userId, "survivor-round-picks", 20, 1);
    if (!rateLimitOk) {
      return new Response(JSON.stringify({ error: mapErrorToClient({ message: "rate limit" }) }), {
        status: 429,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Round 1 picks are set at entry time and are immutable here, hence roundNo >= 2.
    const bodySchema = z.object({
      entryId: z.string().uuid(),
      roundNo: z.number().int().min(2),
      picks: z
        .array(
          z.object({
            crewId: z.string().min(1).max(200),
            event_id: z.string().min(1).max(200),
          }),
        )
        .min(2)
        .max(50),
    });

    const body = bodySchema.parse(await req.json());

    const stateCode = req.headers.get("x-user-state") || "";
    // P0-C9 (2026-05-21): cf-connecting-ip is the trusted client IP source at Supabase Edge Functions.
    // Cloudflare WAF actively blocks spoofing attempts (verified empirically via debug-headers test).
    // Fail-closed if cf-connecting-ip is absent (unexpected at production Edge Functions but possible).
    const ipAddress = req.headers.get("cf-connecting-ip");
    if (!ipAddress) {
      return new Response(
        JSON.stringify({ error: "Geolocation verification required" }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Round participation is geo/RG-gated exactly like contest entry, even though
    // no money moves here — an excluded or out-of-state user must not keep playing.
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
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const resolvedStateCode = compliance.resolvedStateCode;

    const { data: result, error: rpcError } = await supabaseAdmin.rpc("submit_survivor_round_picks", {
      _user_id: userId,
      _entry_id: body.entryId,
      _round_no: body.roundNo,
      _picks: body.picks,
    });

    if (rpcError) {
      const requestId = logSecureError("survivor-round-picks", rpcError);
      return new Response(
        JSON.stringify({ error: mapErrorToClient(rpcError), requestId }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const outcome = Array.isArray(result) ? result[0] : result;

    if (!outcome) {
      const requestId = logSecureError(
        "survivor-round-picks",
        new Error("Empty result from submit_survivor_round_picks"),
      );
      return new Response(
        JSON.stringify({ error: ERROR_MESSAGES.INTERNAL_ERROR, requestId }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (!outcome.allowed) {
      const errorMap: Record<string, { status: number; message: string }> = {
        self_excluded: { status: 403, message: "Your account is self-excluded from contest participation." },
        entry_not_found: { status: 404, message: "Entry not found." },
        entry_not_active: { status: 400, message: "This entry is no longer active in the contest." },
        not_survivor: { status: 400, message: "This contest does not use elimination rounds." },
        round_one_fixed: { status: 400, message: "Round 1 picks are set when you enter and cannot be changed here." },
        round_not_found: { status: 400, message: "That round does not exist for this contest." },
        round_locked: { status: 400, message: "This round is locked — picks can no longer be submitted." },
        eliminated: { status: 400, message: "You have been eliminated and can no longer submit picks." },
        duplicate_event: { status: 400, message: "You can only select one crew per event." },
        duplicate_competitor: { status: 400, message: "You can only pick each competitor once per round." },
        insufficient_events: { status: 400, message: "You must pick crews from at least 2 different events." },
        insufficient_picks: { status: 400, message: "You must make at least the minimum number of picks for this round." },
        too_many_picks: { status: 400, message: "You have selected more picks than this round allows." },
        insufficient_competitors: { status: 400, message: "Your picks must include at least 2 different competitors." },
        invalid_pick: { status: 400, message: "One or more picks are not valid for this round." },
      };

      const mapped = errorMap[outcome.reason] ?? { status: 400, message: ERROR_MESSAGES.INTERNAL_ERROR };

      if (!errorMap[outcome.reason]) {
        logSecureError("survivor-round-picks", new Error(`Unknown survivor pick reason: ${outcome.reason}`));
      }

      return new Response(
        JSON.stringify({ error: mapped.message, reason: outcome.reason }),
        { status: mapped.status, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Best-effort compliance audit log
    try {
      await supabaseAdmin.from("compliance_audit_logs").insert({
        user_id: userId,
        event_type: "survivor_round_picks_submitted",
        description: `User submitted survivor round ${body.roundNo} picks`,
        severity: "info",
        metadata: {
          entry_id: body.entryId,
          round_no: body.roundNo,
          state_code: resolvedStateCode,
          state_code_source: compliance.stateCodeSource,
        },
      });
    } catch (logError) {
      logSecureError("survivor-round-picks", logError);
    }

    return new Response(
      JSON.stringify({
        success: true,
        entryId: body.entryId,
        roundNo: body.roundNo,
        message: `Picks saved for round ${body.roundNo}`,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error: any) {
    const requestId = logSecureError("survivor-round-picks", error);
    if (error instanceof z.ZodError) {
      return new Response(JSON.stringify({ error: "Invalid input", details: error.flatten(), requestId }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const clientMessage = mapErrorToClient(error);
    return new Response(JSON.stringify({ error: clientMessage, requestId }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
}));
