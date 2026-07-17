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
  name: "list_open_contest_pools",
  title: "List open contest pools",
  description:
    "Return RowFantasy contest pools that are currently open for entry, with entry fee, prize pool, and lock time.",
  inputSchema: {
    limit: z
      .number()
      .int()
      .positive()
      .max(50)
      .optional()
      .describe("Maximum pools to return. Defaults to 20."),
  },
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  handler: async ({ limit }, ctx) => {
    if (!ctx.isAuthenticated()) {
      return {
        content: [{ type: "text", text: "Not authenticated" }],
        isError: true,
      };
    }
    const supabase = supabaseForUser(ctx);
    const { data, error } = await supabase
      .from("contest_pools")
      .select(
        "id, tier_name, entry_fee_cents, prize_pool_cents, current_entries, max_entries, lock_time, status",
      )
      .eq("status", "open")
      .order("lock_time", { ascending: true })
      .limit(limit ?? 20);

    if (error) {
      return {
        content: [{ type: "text", text: error.message }],
        isError: true,
      };
    }
    return {
      content: [{ type: "text", text: JSON.stringify(data ?? []) }],
      structuredContent: { pools: data ?? [] },
    };
  },
});
