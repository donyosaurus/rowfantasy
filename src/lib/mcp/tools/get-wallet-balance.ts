import { createClient } from "@supabase/supabase-js";
import { defineTool, type ToolContext } from "@lovable.dev/mcp-js";

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
  name: "get_wallet_balance",
  title: "Get wallet balance",
  description:
    "Return the signed-in RowFantasy user's wallet balances (available, pending, lifetime deposits/withdrawals/winnings) in integer cents.",
  inputSchema: {},
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  handler: async (_input, ctx) => {
    if (!ctx.isAuthenticated()) {
      return {
        content: [{ type: "text", text: "Not authenticated" }],
        isError: true,
      };
    }
    const supabase = supabaseForUser(ctx);
    const { data, error } = await supabase
      .from("wallets")
      .select(
        "available_balance, pending_balance, lifetime_deposits, lifetime_withdrawals, lifetime_winnings",
      )
      .eq("user_id", ctx.getUserId())
      .maybeSingle();

    if (error) {
      return {
        content: [{ type: "text", text: error.message }],
        isError: true,
      };
    }
    if (!data) {
      return {
        content: [{ type: "text", text: "No wallet found for this user." }],
        structuredContent: { wallet: null },
      };
    }
    return {
      content: [{ type: "text", text: JSON.stringify(data) }],
      structuredContent: { wallet: data },
    };
  },
});
