declare const process: { env: Record<string, string | undefined> };

import { createClient } from "@supabase/supabase-js";
import { defineTool, type ToolContext } from "@lovable.dev/mcp-js";
import { z } from "zod";

function supabaseForUser(ctx: ToolContext) {
  return createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_PUBLISHABLE_KEY!,
    {
      global: { headers: { Authorization: `Bearer ${ctx.getToken()}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    },
  );
}

export default defineTool({
  name: "list_my_entries",
  title: "List my contest entries",
  description:
    "Return the signed-in RowFantasy user's contest entries with status, entry fee, payout, and rank.",
  inputSchema: {
    status: z
      .enum(["active", "settled", "scored", "withdrawn", "refunded", "voided"])
      .optional()
      .describe("Filter by entry status."),
    limit: z
      .number()
      .int()
      .positive()
      .max(100)
      .optional()
      .describe("Maximum entries to return. Defaults to 25."),
  },
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  handler: async ({ status, limit }, ctx) => {
    if (!ctx.isAuthenticated()) {
      return {
        content: [{ type: "text", text: "Not authenticated" }],
        isError: true,
      };
    }
    const supabase = supabaseForUser(ctx);
    let query = supabase
      .from("contest_entries")
      .select(
        "id, pool_id, contest_template_id, status, entry_fee_cents, payout_cents, rank, total_points, tier_name, created_at",
      )
      .eq("user_id", ctx.getUserId())
      .order("created_at", { ascending: false })
      .limit(limit ?? 25);
    if (status) query = query.eq("status", status);

    const { data, error } = await query;
    if (error) {
      return {
        content: [{ type: "text", text: error.message }],
        isError: true,
      };
    }
    return {
      content: [{ type: "text", text: JSON.stringify(data ?? []) }],
      structuredContent: { entries: data ?? [] },
    };
  },
});
