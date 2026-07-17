import { auth, defineMcp } from "@lovable.dev/mcp-js";
import listOpenContestPools from "./tools/list-open-contest-pools";
import getWalletBalance from "./tools/get-wallet-balance";
import listMyEntries from "./tools/list-my-entries";
import getMyProfile from "./tools/get-my-profile";

// The OAuth issuer MUST be the direct Supabase host, built from the project ref.
// See knowledge (app-mcp-server-authoring) — mcp-js rejects any token whose
// configured issuer doesn't match the discovery document's issuer.
const projectRef =
  import.meta.env.VITE_SUPABASE_PROJECT_ID ?? "project-ref-unset";

export default defineMcp({
  name: "rowfantasy-mcp",
  title: "RowFantasy",
  version: "0.1.0",
  instructions:
    "Tools for RowFantasy, a fantasy rowing platform. Read-only access to the signed-in user's wallet balance, contest entries, and profile, plus a list of currently open contest pools. All monetary values are integer cents.",
  auth: auth.oauth.issuer({
    issuer: `https://${projectRef}.supabase.co/auth/v1`,
    acceptedAudiences: "authenticated",
  }),
  tools: [
    listOpenContestPools,
    getWalletBalance,
    listMyEntries,
    getMyProfile,
  ],
});
