import { useEffect, useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Users, DollarSign, Trophy, Shield, Download, Settings, Loader2, Plus, X, Upload, ImageIcon, Layers } from "lucide-react";
import { ContestGroupsManager } from "@/components/admin/ContestGroupsManager";
import AdminSupportInbox from "@/components/admin/AdminSupportInbox";
import { LogoPicker } from "@/components/LogoPicker";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "sonner";
// All money values must route through src/lib/formatCurrency.ts. Direct division by 100 in JSX is a bug.
import { getCircleFlagUrl } from "@/data/countryFlags";
import { getCollegeLogoUrl } from "@/data/collegeLogos";
import { formatCents, formatDollars } from "@/lib/formatCurrency";
import {
  CONTEST_TYPES,
  SPORT_OPTIONS,
  getScoringPreset,
  parseRaceTimeToMs,
  formatMsAsRaceTime,
  type ContestTypeKey,
} from "@/lib/contest-config";

interface CrewResult {
  crew_id: string;
  crew_name: string;
  finish_order: string;
  finish_time: string;
  /** v2 (engine) fields — present only for multi-sport contests. */
  race_key?: string;
  competitor_key?: string;
  status?: string;
}

interface PoolCrew {
  id: string;
  crew_id: string;
  crew_name: string;
  manual_finish_order: number | null;
  manual_result_time: string | null;
}

interface NewCrew {
  crew_name: string;
  crew_id: string;
  event_id: string;
  logo_url: string | null;
}

interface PrizeTier {
  places: number;
  amount: string;
}

interface EntryTierForm {
  name: string;
  entryFee: string;
  prizes: PrizeTier[];
}

interface CreateContestForm {
  regattaName: string;
  genderCategory: string;
  entryFee: string;
  maxEntries: string;
  lockTime: string;
  crews: NewCrew[];
  prizes: PrizeTier[];
  allowOverflow: boolean;
  voidUnfilledOnSettle: boolean;
  multiTier: boolean;
  entryTiers: EntryTierForm[];
  cardBannerUrl: string;
  draftBannerUrl: string;
  contestGroupId: string;
  contestType: ContestTypeKey;
  sport: string;
  eventClass: string;
  minPicks: string;
  maxPicks: string;
  /** Podium Predictor only: podium size (2..10). Never emitted for other types. */
  podiumSize: string;

  /** GC / stage-race only: ordered stage names. Ignored by every other type. */
  stages: string[];
  /** Tiers only: ordered roster tiers. Ignored by every other type. */
  rosterTiers: { name: string; competitors: string[] }[];
  /** Survivor only: ordered rounds. Array index + 1 is the round_no. */
  rounds: { lockTime: string; advanceCount: string }[];
  /** Survivor only: race key (event_id) -> round number as a string. */
  raceRounds: Record<string, string>;




}


const CARD_GRADIENTS = [
  'linear-gradient(135deg, #0f172a 0%, #1e3a5f 100%)',
  'linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)',
  'linear-gradient(135deg, #0c1222 0%, #1b3a4b 100%)',
  'linear-gradient(135deg, #1a0e2e 0%, #2d1b69 100%)',
  'linear-gradient(135deg, #1e1e1e 0%, #2d3436 100%)',
  'linear-gradient(135deg, #0a1628 0%, #1a3c34 100%)',
];

function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}


/**
 * Exact maximum-cardinality bipartite matching (Kuhn's augmenting paths).
 * left = races, right = competitors; adj[i] = competitor indices racing in race i.
 */
function maxBipartiteMatching(adj: number[][], rightCount: number): number {
  const matchRight = new Array<number>(rightCount).fill(-1);
  let result = 0;
  const tryKuhn = (u: number, seen: boolean[]): boolean => {
    for (const v of adj[u]) {
      if (seen[v]) continue;
      seen[v] = true;
      if (matchRight[v] === -1 || tryKuhn(matchRight[v], seen)) {
        matchRight[v] = u;
        return true;
      }
    }
    return false;
  };
  for (let u = 0; u < adj.length; u++) {
    if (tryKuhn(u, new Array<boolean>(rightCount).fill(false))) result++;
  }
  return result;
}

const Admin = () => {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [isAdmin, setIsAdmin] = useState(false);
  const [loading, setLoading] = useState(true);
  const [users, setUsers] = useState<any[]>([]);
  const [transactions, setTransactions] = useState<any[]>([]);
  const [contests, setContests] = useState<any[]>([]);
  const [complianceLogs, setComplianceLogs] = useState<any[]>([]);
  const [featureFlags, setFeatureFlags] = useState<any>({});
  const [contestGroups, setContestGroups] = useState<{ id: string; name: string }[]>([]);
  
  const [selectedContest, setSelectedContest] = useState<any | null>(null);
  const [resultsModalOpen, setResultsModalOpen] = useState(false);
  const [poolCrews, setPoolCrews] = useState<PoolCrew[]>([]);
  const [resultsForm, setResultsForm] = useState<CrewResult[]>([]);
  const [loadingCrews, setLoadingCrews] = useState(false);
  const [resultsV2, setResultsV2] = useState(false);

  const [submittingResults, setSubmittingResults] = useState(false);
  const [settlingPoolId, setSettlingPoolId] = useState<string | null>(null);
  const [scoringPoolId, setScoringPoolId] = useState<string | null>(null);
  const [voidingPoolId, setVoidingPoolId] = useState<string | null>(null);
  const [resizeTarget, setResizeTarget] = useState<any | null>(null);
  const [resizeMaxInput, setResizeMaxInput] = useState("");
  const [resizing, setResizing] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [creatingContest, setCreatingContest] = useState(false);
  const [uploadingBanner, setUploadingBanner] = useState(false);
  const [uploadingDraftBanner, setUploadingDraftBanner] = useState(false);
  const [createForm, setCreateForm] = useState<CreateContestForm>({
    regattaName: "",
    genderCategory: "Men's",
    entryFee: "",
    maxEntries: "",
    lockTime: "",
    crews: [],
    prizes: [{ places: 1, amount: "" }],
    allowOverflow: false,
    voidUnfilledOnSettle: false,
    multiTier: false,
    entryTiers: [
      { name: "Bronze", entryFee: "", prizes: [{ places: 1, amount: "" }] },
      { name: "Silver", entryFee: "", prizes: [{ places: 1, amount: "" }] },
    ],
    cardBannerUrl: "",
    draftBannerUrl: "",
    contestGroupId: "",
    contestType: "classic",
    sport: "rowing",
    eventClass: "",
    minPicks: "2",
    maxPicks: "4",
    podiumSize: "3",

    stages: ["Stage 1", "Stage 2"],
    rosterTiers: [],

    rounds: [{ lockTime: "", advanceCount: "2" }, { lockTime: "", advanceCount: "1" }],
    raceRounds: {},



  });
  const [newCrewInput, setNewCrewInput] = useState<NewCrew>({
    crew_name: "",
    crew_id: "",
    event_id: "",
    logo_url: null,
  });

  useEffect(() => {
    const checkAdminStatus = async () => {
      if (!user) { navigate("/login"); return; }
      const { data: roleData, error: roleError } = await supabase
        .from("user_roles").select("role").eq("user_id", user.id).eq("role", "admin").maybeSingle();
      if (roleError || !roleData) { toast.error("Access denied - Admin privileges required"); navigate("/"); return; }
      setIsAdmin(true);
      loadDashboardData();
    };
    checkAdminStatus();
  }, [user, navigate]);

  const loadDashboardData = async () => {
    try {
      const { data: flagsData } = await supabase.from("feature_flags").select("key, value");
      const flags = (flagsData || []).reduce((acc: any, flag: any) => { acc[flag.key] = flag.value; return acc; }, {});
      setFeatureFlags(flags);
      const { data: usersData } = await supabase.from("profiles").select("id, username, email, state, date_of_birth, age_confirmed_at, created_at").order("created_at", { ascending: false }).limit(100);
      const { data: walletsData } = await supabase.from("wallets").select("user_id, available_balance");
      const usersWithBalance = usersData?.map(u => ({ ...u, balance: walletsData?.find(w => w.user_id === u.id)?.available_balance || 0 })) || [];
      setUsers(usersWithBalance);
      // transactions.user_id and profiles.id both reference auth.users, so there is no
      // direct transactions→profiles FK for PostgREST to embed (PGRST200). Join client-side.
      const { data: txData } = await supabase.from("transactions").select("*").order("created_at", { ascending: false }).limit(100);
      const txUserIds = Array.from(new Set((txData || []).map((t: any) => t.user_id).filter(Boolean)));
      const usernameById = new Map<string, string>((usersData || []).map((u: any) => [u.id, u.username]));
      const missingIds = txUserIds.filter((id) => !usernameById.has(id));
      if (missingIds.length > 0) {
        const { data: extraProfiles } = await supabase.from("profiles").select("id, username").in("id", missingIds);
        for (const p of extraProfiles || []) usernameById.set(p.id, p.username);
      }
      const txWithUser = (txData || []).map((t: any) => ({ ...t, profiles: { username: usernameById.get(t.user_id) || null } }));
      setTransactions(txWithUser);
      const { data: poolsData } = await supabase.from("contest_pools").select("id, contest_template_id, created_at, current_entries, entry_fee_cents, entry_tiers, lock_time, max_entries, payout_structure, prize_pool_cents, prize_structure, settled_at, status, tier_id, tier_name, allow_overflow, void_unfilled_on_settle, contest_templates!inner(regatta_name, sport, scoring_config)").order("created_at", { ascending: false }).limit(50);
      setContests(poolsData || []);
      const { data: logsData } = await supabase.from("compliance_audit_logs").select("*").order("created_at", { ascending: false }).limit(100);
      setComplianceLogs(logsData || []);
      const { data: groupsData } = await supabase.from("contest_groups").select("id, name").order("display_order");
      setContestGroups(groupsData || []);
      setLoading(false);
    } catch (error) {
      console.error("Error loading dashboard data:", error);
      toast.error("Failed to load dashboard data");
      setLoading(false);
    }
  };

  const openResultsModal = async (contest: any) => {
    setSelectedContest(contest);
    setResultsModalOpen(true);
    setLoadingCrews(true);
    const isV2 = !!contest?.contest_templates?.scoring_config;
    setResultsV2(isV2);
    try {
      if (isV2) {
        const templateId = contest.contest_template_id;
        const [racesRes, compsRes] = await Promise.all([
          supabase.from("contest_races").select("id, race_key, race_order").eq("template_id", templateId).order("race_order", { ascending: true }),
          supabase.from("contest_competitors").select("id, competitor_key, name").eq("template_id", templateId),
        ]);
        if (racesRes.error) throw racesRes.error;
        if (compsRes.error) throw compsRes.error;
        const races = racesRes.data || [];
        const comps = compsRes.data || [];
        const raceIds = races.map((r) => r.id);
        const [entriesRes, resultsRes] = await Promise.all([
          supabase.from("contest_race_entries").select("race_id, competitor_id").in("race_id", raceIds),
          supabase.from("contest_race_results").select("race_id, competitor_id, place, time_ms, status").in("race_id", raceIds),
        ]);
        if (entriesRes.error) throw entriesRes.error;
        if (resultsRes.error) throw resultsRes.error;
        const raceById = new Map(races.map((r) => [r.id, r]));
        const compById = new Map(comps.map((c) => [c.id, c]));
        const orderIdx = new Map(races.map((r, i) => [r.id, i]));
        const existing = new Map(
          (resultsRes.data || []).map((r: any) => [`${r.race_id}::${r.competitor_id}`, r])
        );
        const rows: CrewResult[] = (entriesRes.data || [])
          .slice()
          .sort((a: any, b: any) => (orderIdx.get(a.race_id) ?? 0) - (orderIdx.get(b.race_id) ?? 0))
          .map((e: any) => {
            const race = raceById.get(e.race_id);
            const comp = compById.get(e.competitor_id);
            const prev: any = existing.get(`${e.race_id}::${e.competitor_id}`);
            return {
              crew_id: `${race?.race_key ?? ""}::${comp?.competitor_key ?? ""}`,
              crew_name: comp?.name ?? comp?.competitor_key ?? "",
              race_key: race?.race_key ?? "",
              competitor_key: comp?.competitor_key ?? "",
              finish_order: prev?.place != null ? String(prev.place) : "",
              finish_time: prev?.time_ms != null ? formatMsAsRaceTime(prev.time_ms) : "",
              status: prev?.status ?? "OK",
            };
          });
        setPoolCrews([]);
        setResultsForm(rows);
        return;
      }
      const { data: crews, error } = await supabase.from("contest_pool_crews").select("id, crew_id, crew_name, manual_finish_order, manual_result_time").eq("contest_pool_id", contest.id);
      if (error) throw error;
      setPoolCrews(crews || []);
      setResultsForm((crews || []).map(crew => ({ crew_id: crew.crew_id, crew_name: crew.crew_name, finish_order: crew.manual_finish_order?.toString() || "", finish_time: crew.manual_result_time || "" })));
    } catch (error) { console.error("Error loading crews:", error); toast.error("Failed to load contest lineup"); } finally { setLoadingCrews(false); }
  };

  const updateResultForm = (crewId: string, field: "finish_order" | "finish_time" | "status", value: string) => {
    setResultsForm(prev => prev.map(r => {
      if (r.crew_id !== crewId) return r;
      const next: CrewResult = { ...r, [field]: value };
      if (field === "status" && value !== "OK") {
        next.finish_time = "";
      }
      return next;
    }));
  };


  const parseTemplateScoringConfig = (raw: any): any => {
    if (typeof raw === "string") { try { return JSON.parse(raw); } catch { return null; } }
    return raw ?? null;
  };

  const submitResults = async () => {
    if (!selectedContest) return;
    const templateScoringConfig = parseTemplateScoringConfig(selectedContest?.contest_templates?.scoring_config);
    // Time contests are scored purely from times — finish place is optional there.
    const isTimeVsRef = templateScoringConfig?.primitive === "time_vs_ref";
    const finished = resultsForm.filter(r => (r.status ?? "OK") === "OK");
    if (!isTimeVsRef && finished.some(r => !r.finish_order)) { toast.error("Please enter a finish place for every finisher"); return; }
    setSubmittingResults(true);
    try {
      if (resultsV2) {
        if (!isTimeVsRef) {
          const badPlace = resultsForm.find(r => (r.status ?? "OK") === "OK" && (isNaN(parseInt(r.finish_order, 10)) || parseInt(r.finish_order, 10) < 1));
          if (badPlace) { throw new Error("Finish place must be 1 or higher for every OK competitor"); }
        }
        const scoringConfig = templateScoringConfig;
        if (scoringConfig?.tiebreak === "aggregate_time" || isTimeVsRef) {
          const missingTime = resultsForm.filter(r => (r.status ?? "OK") === "OK" && parseRaceTimeToMs(r.finish_time || "") == null);
          if (missingTime.length > 0) {
            throw new Error(
              isTimeVsRef
                ? "Time contests require a valid finish time for every OK competitor"
                : "Total Time contests require a valid finish time for every OK competitor"
            );
          }
        }
        const v2Results = resultsForm.map(r => {
          const status = r.status || "OK";
          const ms = parseRaceTimeToMs(r.finish_time || "");
          const row: any = { race_key: r.race_key, competitor_key: r.competitor_key, status };
          if (status === "OK" && (r.finish_order ?? "").trim() !== "") row.place = parseInt(r.finish_order, 10);
          if (status === "OK" && ms != null) row.time_ms = ms;
          return row;
        });

        if (resultsForm.some(r => r.finish_time && parseRaceTimeToMs(r.finish_time) == null)) {
          throw new Error("Invalid time format — use M:SS.cc");
        }
        const { error: v2Error } = await supabase.functions.invoke("admin-contest-results", {
          body: { contestTemplateId: selectedContest.contest_template_id, results: v2Results },
        });
        if (v2Error) throw new Error(`Saving results failed: ${v2Error.message}`);
        toast.success("Results saved.");
        setResultsModalOpen(false);
        loadDashboardData();
        return;
      } else {
        const results = resultsForm.map(r => ({ crew_id: r.crew_id, finish_order: parseInt(r.finish_order), finish_time: r.finish_time || null }));
        const { error: resultsError } = await supabase.functions.invoke("admin-contest-results", { body: { contestPoolId: selectedContest.id, results } });
        if (resultsError) throw new Error(`Saving results failed: ${resultsError.message}`);
      }

      toast.success("Results saved. Calculating scores...");
      const { data: scoringData, error: scoringError } = await supabase.functions.invoke("contest-scoring", { body: { contestPoolId: selectedContest.id } });
      if (scoringError) throw new Error(`Scoring failed: ${scoringError.message}`);
      toast.success(`Scored ${scoringData?.poolsScored || 1} pool(s). Settling payouts...`);
      const { data: settleData, error: settleError } = await supabase.functions.invoke("contest-settle", { body: { contestPoolId: selectedContest.id } });
      if (settleError) throw new Error(`Settlement failed: ${settleError.message}`);
      if (settleData && settleData.success === false) {
        const failed = (settleData.details || []).filter((d: any) => d.action === 'error');
        const f = failed[0];
        throw new Error(`Settlement did not complete: ${settleData.poolsFailed ?? failed.length} pool(s) failed${f ? ` — ${f.reason || 'error'}${f.requestId ? ` (req ${f.requestId})` : ''}` : ''}.`);
      }
      let settleMsg = `Done! ${settleData?.winnersCount || 0} winner(s) paid out.`;
      if (settleData?.poolsAutoVoided > 0) {
        settleMsg += ` ${settleData.poolsAutoVoided} unfilled pool(s) auto-voided, ${settleData.refundedCount || 0} entry fee(s) refunded.`;
      }
      toast.success(settleMsg);
      setResultsModalOpen(false);
      setSelectedContest(null);
      loadDashboardData();
    } catch (error: any) { console.error("Error in results/scoring/settlement:", error); toast.error(error.message || "Failed to complete results entry"); } finally { setSubmittingResults(false); }
  };

  const settlePayouts = async (contestPoolId: string) => {
    setSettlingPoolId(contestPoolId);
    try {
      const { data, error } = await supabase.functions.invoke("contest-settle", { body: { contestPoolId } });
      if (error) throw error;

      const details = data?.details || [];
      const failedPools = details.filter((d: any) => d.action === 'error');
      if (failedPools.length > 0) {
        const f = failedPools[0];
        throw new Error(`${failedPools.length} pool(s) failed to settle — ${f.reason || 'error'}${f.requestId ? ` (req ${f.requestId})` : ''}.`);
      }
      const settledCount = details.filter((d: any) => d.action === 'settled').length;
      const voidedCount = details.filter((d: any) => d.action === 'auto_voided').length;
      const refundedEntries = details
        .filter((d: any) => d.action === 'auto_voided')
        .reduce((sum: number, d: any) => sum + (d.refundedCount || 0), 0);

      let msg = `${settledCount} pool(s) settled.`;
      if (voidedCount > 0) {
        msg += ` ${voidedCount} unfilled pool(s) auto-voided, ${refundedEntries} entry fee(s) refunded.`;
      }
      toast.success(msg);

      // Log detailed per-tier breakdown to console for debugging
      if (details.length > 0) {
        const byTier: Record<string, any[]> = {};
        for (const d of details) {
          const tierKey = d.tierName || 'Default';
          if (!byTier[tierKey]) byTier[tierKey] = [];
          byTier[tierKey].push(d);
        }
        console.log("[Settlement Report]");
        for (const [tier, pools] of Object.entries(byTier)) {
          const fee = (pools as any[])[0]?.entryFeeCents;
          console.log(`  ${tier}${fee ? ` (${formatCents(fee)})` : ''}:`);
          (pools as any[]).forEach((p: any, i: number) => {
            if (p.action === 'settled') {
              console.log(`    Pool ${i + 1}: Settled — ${p.winners || 0} winner(s)`);
            } else {
              console.log(`    Pool ${i + 1}: Auto-voided — ${p.entriesRefunded || 0} entry(s) refunded`);
            }
          });
        }
      }

      loadDashboardData();
    } catch (error: any) { console.error("Error settling payouts:", error); toast.error(error.message || "Failed to settle payouts"); } finally { setSettlingPoolId(null); }
  };

  const calculateScores = async (contestPoolId: string) => {
    setScoringPoolId(contestPoolId);
    try {
      const { data: scoringData, error: scoringError } = await supabase.functions.invoke("contest-scoring", { body: { contestPoolId } });
      if (scoringError) throw scoringError;
      toast.success(`Scores recalculated for ${scoringData?.poolsScored || 1} pool(s)`);
      loadDashboardData();
    } catch (error: any) { console.error("Error calculating scores:", error); toast.error(error.message || "Failed to calculate scores"); } finally { setScoringPoolId(null); }
  };

  // voidContest removed — use voidAllPoolsForTemplate instead.

  const voidTier = async (templateId: string, tierName: string) => {
    if (!confirm(`Void all ${tierName} tier pools? Entry fees will be refunded for ${tierName} entrants only.`)) return;
    setVoidingPoolId(templateId);
    try {
      const tierPools = contests.filter((p: any) => p.contest_template_id === templateId && p.tier_name === tierName && p.status !== 'voided' && p.status !== 'settled');
      for (const pool of tierPools) {
        const { data, error } = await supabase.functions.invoke("admin-contest-void", { body: { contestPoolId: pool.id } });
        if (error || data?.error) throw new Error(error?.message || data?.error || `Failed to void pool ${pool.id}`);
      }
      toast.success(`${tierName} tier voided and refunds issued`);
      loadDashboardData();
    } catch (error: any) { console.error("Error voiding tier:", error); toast.error(error.message || "Failed to void tier"); } finally { setVoidingPoolId(null); }
  };

  const voidAllPoolsForTemplate = async (templateId: string) => {
    const allPools = contests.filter((p: any) => p.contest_template_id === templateId && p.status !== 'voided' && p.status !== 'settled');
    if (allPools.length === 0) {
      toast.info("No active pools to void for this contest.");
      return;
    }
    const msg = allPools.length === 1
      ? "Are you sure you want to void this contest? All entry fees will be refunded."
      : `Void ALL ${allPools.length} pools for this contest? All entry fees will be refunded.`;
    if (!confirm(msg)) return;
    setVoidingPoolId(templateId);
    try {
      for (const pool of allPools) {
        const { data, error } = await supabase.functions.invoke("admin-contest-void", { body: { contestPoolId: pool.id } });
        if (error || data?.error) throw new Error(error?.message || data?.error || `Failed to void pool ${pool.id}`);
      }
      toast.success(allPools.length === 1 ? "Contest voided and refunds issued" : "All pools voided and refunds issued");
      loadDashboardData();
    } catch (error: any) { console.error("Error voiding contest:", error); toast.error(error.message || "Failed to void contest"); } finally { setVoidingPoolId(null); }
  };

  const isContestPastLockTime = (contest: any) => new Date() > new Date(contest.lock_time);

  // Resize is restricted to configurations where overflow clones can't inherit
  // the shrunken economics: locked pools never clone; open pools only when
  // the contest has overflow disabled.
  const canResizePool = (pool: any) => {
    if (pool.status === "locked") return pool.current_entries >= 2 && pool.current_entries < pool.max_entries;
    if (pool.status === "open") return !pool.allow_overflow && pool.max_entries > 2;
    return false;
  };

  const maxPrizeRank = (payoutStructure: Record<string, number> | null) =>
    Math.max(1, ...Object.keys(payoutStructure || {}).map((k) => parseInt(k, 10)).filter(Number.isInteger));

  const scalePayoutStructure = (payoutStructure: Record<string, number> | null, oldMax: number, newMax: number): Record<string, number> =>
    Object.fromEntries(
      Object.entries(payoutStructure || {}).map(([place, cents]) => [place, Math.floor((Number(cents) * newMax) / oldMax)])
    );

  const openResizeModal = (pool: any) => {
    setResizeTarget(pool);
    // Locked pools may only be resized to exactly their active entry count.
    setResizeMaxInput(pool.status === "locked" ? String(pool.current_entries) : "");
  };

  const resizeContestPool = async () => {
    if (!resizeTarget) return;
    const newMax = parseInt(resizeMaxInput, 10);
    if (!Number.isInteger(newMax)) { toast.error("Enter a valid number of entries"); return; }
    setResizing(true);
    try {
      const { data, error } = await supabase.functions.invoke("admin-contest-resize", {
        body: { contestPoolId: resizeTarget.id, newMaxEntries: newMax },
      });
      if (error) {
        // Surface the edge function's response body (message + reason code),
        // not the generic FunctionsHttpError text.
        let msg = "Failed to resize pool";
        if (error.context && typeof error.context.json === "function") {
          try {
            const body = await error.context.json();
            if (body?.error) msg = body.reason ? `${body.error} [${body.reason}]` : body.error;
            if (body?.requestId) msg += ` (req ${body.requestId})`;
          } catch { msg = error.message || msg; }
        } else if (error.message) msg = error.message;
        throw new Error(msg);
      }
      if (data?.error) throw new Error(data.reason ? `${data.error} [${data.reason}]` : data.error);
      toast.success(`Pool resized to ${newMax} entries; prizes scaled proportionally`);
      setResizeTarget(null);
      loadDashboardData();
    } catch (error: any) { console.error("Error resizing pool:", error); toast.error(error.message || "Failed to resize pool"); } finally { setResizing(false); }
  };

  const groupedContests = useMemo(() => {
    const groups = new Map<string, any[]>();
    for (const pool of contests) {
      const key = pool.contest_template_id;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(pool);
    }
    return Array.from(groups.values()).map(pools => {
      pools.sort((a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      const primary = pools[0];
      const totalEntries = pools.reduce((sum: number, p: any) => sum + p.current_entries, 0);
      const totalMaxEntries = pools.reduce((sum: number, p: any) => sum + p.max_entries, 0);
      const totalPrize = pools.reduce((sum: number, p: any) => sum + p.prize_pool_cents, 0);
      const statusPriority = ['open', 'locked', 'results_entered', 'scoring_completed', 'settling', 'settled', 'voided'];
      let overallStatus = 'settled';
      for (const s of statusPriority) { if (pools.some((p: any) => p.status === s)) { overallStatus = s; break; } }

      const hasTiers = pools.some((p: any) => p.tier_name);

      // Sub-group by tier_name
      const tierMap = new Map<string, any[]>();
      for (const pool of pools) {
        const tierKey = pool.tier_name || '__default__';
        if (!tierMap.has(tierKey)) tierMap.set(tierKey, []);
        tierMap.get(tierKey)!.push(pool);
      }
      const tierGroups = Array.from(tierMap.entries()).map(([tierName, tierPools]) => ({
        tierName: tierName === '__default__' ? null : tierName,
        pools: tierPools,
        entryFeeCents: tierPools[0].entry_fee_cents,
        totalEntries: tierPools.reduce((sum: number, p: any) => sum + p.current_entries, 0),
        totalMaxEntries: tierPools.reduce((sum: number, p: any) => sum + p.max_entries, 0),
        overallStatus: tierPools.some((p: any) => p.status === 'open') ? 'open' : tierPools[0].status,
      }));

      return {
        primary,
        pools,
        poolCount: pools.length,
        totalEntries,
        totalMaxEntries,
        totalPrize,
        overallStatus,
        regattaName: primary.contest_templates?.regatta_name || 'Unknown',
        hasTiers,
        tierGroups,
      };
    });
  }, [contests]);

  const resetCreateForm = () => {
    setCreateForm({
      regattaName: "", genderCategory: "Men's", entryFee: "", maxEntries: "", lockTime: "",
      crews: [], prizes: [{ places: 1, amount: "" }], allowOverflow: false, voidUnfilledOnSettle: false,
      multiTier: false,
      entryTiers: [
        { name: "Bronze", entryFee: "", prizes: [{ places: 1, amount: "" }] },
        { name: "Silver", entryFee: "", prizes: [{ places: 1, amount: "" }] },
      ],
      cardBannerUrl: "",
      draftBannerUrl: "",
      contestGroupId: "",
      contestType: "classic",
      sport: "rowing",
      eventClass: "",
      minPicks: "2",
      maxPicks: "4",
      podiumSize: "3",

      stages: ["Stage 1", "Stage 2"],
      rosterTiers: [],

      rounds: [{ lockTime: "", advanceCount: "2" }, { lockTime: "", advanceCount: "1" }],
      raceRounds: {},



    });
    setNewCrewInput({ crew_name: "", crew_id: "", event_id: "", logo_url: null });
  };

  const addCrewToForm = () => {
    // Per-competitor types carry no per-row race: competitors are entered in every stage.
    const gcMode = !!CONTEST_TYPES.find(t => t.key === createForm.contestType)?.perCompetitor;

    if (!newCrewInput.crew_name || !newCrewInput.crew_id || (!gcMode && !newCrewInput.event_id)) { toast.error("Please fill in all crew fields"); return; }
    const eventId = gcMode ? "" : newCrewInput.event_id;
    if (createForm.contestType === "podium_predictor") {
      // Exactly one nominated race: every row must reuse the first race key.
      const firstKey = createForm.crews.map(c => c.event_id).find(k => !!k);
      if (firstKey && eventId !== firstKey) { toast.error("prediction contests take exactly one race"); return; }
    }
    if (createForm.crews.some(c => c.crew_id === newCrewInput.crew_id && c.event_id === eventId)) { toast.error(gcMode ? "This competitor is already added" : "This competitor is already in that race"); return; }

    setCreateForm(prev => ({ ...prev, crews: [...prev.crews, { ...newCrewInput, event_id: eventId }] }));
    setNewCrewInput({ crew_name: "", crew_id: "", event_id: "", logo_url: null });
  };


  const removeCrewFromForm = (crewId: string, eventId: string) => {
    setCreateForm(prev => {
      const nextCrews = prev.crews.filter(c => !(c.crew_id === crewId && c.event_id === eventId));
      const nextRaceRounds = { ...prev.raceRounds };
      if (!nextCrews.some(c => c.event_id === eventId)) {
        delete nextRaceRounds[eventId];
      }
      const nextRosterTiers = prev.rosterTiers.length === 0
        ? prev.rosterTiers
        : prev.rosterTiers.map(t => ({ ...t, competitors: t.competitors.filter(k => k !== crewId) }));
      return { ...prev, crews: nextCrews, raceRounds: nextRaceRounds, rosterTiers: nextRosterTiers };

    });
  };

  const ordinal = (n: number) => {
    const s = ["th", "st", "nd", "rd"];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  };

  const getPrizeRankRange = (
    prizes: Array<{ places: number; amount: string }>,
    idx: number
  ) => {
    let from = 1;
    for (let i = 0; i < idx; i++) from += Math.max(1, prizes[i].places || 1);
    const places = Math.max(1, prizes[idx].places || 1);
    const to = from + places - 1;
    return { from, to, places, label: from === to ? ordinal(from) : `${ordinal(from)}–${ordinal(to)}` };
  };

  const addPrizeTier = () => {
    setCreateForm(prev => ({ ...prev, prizes: [...prev.prizes, { places: 1, amount: "" }] }));
  };
  const removePrizeTier = (idx: number) => {
    setCreateForm(prev => ({ ...prev, prizes: prev.prizes.filter((_, i) => i !== idx) }));
  };
  const updatePrizeAmount = (idx: number, amount: string) => {
    setCreateForm(prev => ({ ...prev, prizes: prev.prizes.map((p, i) => i === idx ? { ...p, amount } : p) }));
  };
  const updatePrizePlaces = (idx: number, placesStr: string) => {
    const n = parseInt(placesStr);
    const places = isNaN(n) || n < 1 ? 1 : n;
    setCreateForm(prev => ({ ...prev, prizes: prev.prizes.map((p, i) => i === idx ? { ...p, places } : p) }));
  };

  // Entry Tier helpers
  const addEntryTier = () => {
    if (createForm.entryTiers.length >= 5) { toast.error("Maximum 5 tiers allowed"); return; }
    const names = ["Bronze", "Silver", "Gold", "Platinum", "Diamond"];
    const nextName = names[createForm.entryTiers.length] || `Tier ${createForm.entryTiers.length + 1}`;
    setCreateForm(prev => ({
      ...prev,
      entryTiers: [...prev.entryTiers, { name: nextName, entryFee: "", prizes: [{ places: 1, amount: "" }] }],
    }));
  };

  const removeEntryTier = (idx: number) => {
    if (createForm.entryTiers.length <= 2) { toast.error("Minimum 2 tiers required"); return; }
    setCreateForm(prev => ({
      ...prev,
      entryTiers: prev.entryTiers.filter((_, i) => i !== idx),
    }));
  };

  const updateEntryTier = (idx: number, field: string, value: string) => {
    setCreateForm(prev => ({
      ...prev,
      entryTiers: prev.entryTiers.map((t, i) => i === idx ? { ...t, [field]: value } : t),
    }));
  };

  const addTierPrize = (tierIdx: number) => {
    setCreateForm(prev => ({
      ...prev,
      entryTiers: prev.entryTiers.map((t, i) => i === tierIdx
        ? { ...t, prizes: [...t.prizes, { places: 1, amount: "" }] } : t),
    }));
  };
  const removeTierPrize = (tierIdx: number, prizeIdx: number) => {
    setCreateForm(prev => ({
      ...prev,
      entryTiers: prev.entryTiers.map((t, i) => i === tierIdx
        ? { ...t, prizes: t.prizes.filter((_, j) => j !== prizeIdx) } : t),
    }));
  };
  const updateTierPrizeAmount = (tierIdx: number, prizeIdx: number, amount: string) => {
    setCreateForm(prev => ({
      ...prev,
      entryTiers: prev.entryTiers.map((t, i) => i === tierIdx
        ? { ...t, prizes: t.prizes.map((p, j) => j === prizeIdx ? { ...p, amount } : p) } : t),
    }));
  };
  const updateTierPrizePlaces = (tierIdx: number, prizeIdx: number, placesStr: string) => {
    const n = parseInt(placesStr);
    const places = isNaN(n) || n < 1 ? 1 : n;
    setCreateForm(prev => ({
      ...prev,
      entryTiers: prev.entryTiers.map((t, i) => i === tierIdx
        ? { ...t, prizes: t.prizes.map((p, j) => j === prizeIdx ? { ...p, places } : p) } : t),
    }));
  };

  const calculateProfitMetrics = () => {
    const sumRowTotal = (rows: Array<{ places: number; amount: string }>) =>
      rows.reduce((sum, p) => {
        const amt = parseFloat(p.amount) || 0;
        const places = Math.max(1, p.places || 1);
        return sum + amt * places;
      }, 0);

    if (createForm.multiTier) {
      const maxEntries = parseInt(createForm.maxEntries) || 0;
      const totalFeePerRound = createForm.entryTiers.reduce((s, t) => s + (parseFloat(t.entryFee) || 0), 0);
      const maxRevenue = totalFeePerRound * maxEntries;
      const totalPayout = createForm.entryTiers.reduce((s, t) => s + sumRowTotal(t.prizes), 0);
      return { maxRevenue, totalPayout, projectedProfit: maxRevenue - totalPayout };
    }
    const entryFeeDollars = parseFloat(createForm.entryFee) || 0;
    const maxEntries = parseInt(createForm.maxEntries) || 0;
    const maxRevenue = entryFeeDollars * maxEntries;
    const totalPayout = sumRowTotal(createForm.prizes);
    return { maxRevenue, totalPayout, projectedProfit: maxRevenue - totalPayout };
  };

  const selectedTypeDef = CONTEST_TYPES.find(t => t.key === createForm.contestType);
  const isRoundsTypeUI = selectedTypeDef?.rounds === true;
  const isAccumulateUI =
    (getScoringPreset(createForm.contestType) as any)?.round_mode === "accumulate";

  const submitCreateContest = async () => {
    const isSurvivor = createForm.contestType === "survivor";
    const submitTypeDef = CONTEST_TYPES.find(t => t.key === createForm.contestType);
    const isRoundsType = submitTypeDef?.rounds === true;
    const isAccumulate =
      (getScoringPreset(createForm.contestType) as any)?.round_mode === "accumulate";
    if (isRoundsType && createForm.multiTier) { toast.error("Survivor contests don't support entry tiers"); return; }
    if (!createForm.regattaName.trim()) { toast.error("Regatta name is required"); return; }
    if (!createForm.genderCategory) { toast.error("Gender category is required"); return; }
    const effectiveLockTime = isRoundsType ? (createForm.rounds[0]?.lockTime || "") : createForm.lockTime;
    if (!effectiveLockTime) { toast.error("Lock time is required"); return; }
    const lockDate = new Date(effectiveLockTime);
    if (isRoundsType && isNaN(lockDate.getTime())) { toast.error("Lock time is required"); return; }
    if (lockDate <= new Date()) { toast.error("Lock time must be in the future"); return; }
    if (createForm.crews.length < 2) { toast.error("At least 2 crews are required"); return; }
    const maxEntries = parseInt(createForm.maxEntries);
    if (isNaN(maxEntries) || maxEntries < 2) { toast.error("Max entries must be at least 2"); return; }

    // Podium Predictor is always free with no tiers — derived, never read from stale UI state.
    const isPrediction = createForm.contestType === "podium_predictor";

    let entryFeeCents: number;
    let payouts: Record<string, number> = {};
    let entryTiersPayload: any[] | null = null;

    if (isPrediction) {
      entryFeeCents = 0;
      entryTiersPayload = null;
    } else if (createForm.multiTier) {

      // Validate tiers
      for (let i = 0; i < createForm.entryTiers.length; i++) {
        const tier = createForm.entryTiers[i];
        if (!tier.name.trim()) { toast.error(`Tier ${i + 1} needs a name`); return; }
        const fee = parseFloat(tier.entryFee);
        if (isNaN(fee) || fee <= 0) { toast.error(`Tier "${tier.name}" needs a valid entry fee`); return; }
        const firstPrize = tier.prizes[0];
        if (!firstPrize?.amount || parseFloat(firstPrize.amount) <= 0) {
          toast.error(`Tier "${tier.name}" needs a 1st place prize`); return;
        }
      }

      // Build entry_tiers payload — expand ranges
      entryTiersPayload = createForm.entryTiers.map(t => {
        const ps: Record<string, number> = {};
        let r = 1;
        for (const p of t.prizes) {
          const amt = parseFloat(p.amount);
          const places = Math.max(1, p.places || 1);
          if (isNaN(amt) || amt <= 0) { r += places; continue; }
          const amtCents = Math.round(amt * 100);
          for (let i = 0; i < places; i++) { ps[String(r)] = amtCents; r++; }
        }
        return {
          name: t.name.trim(),
          entry_fee_cents: Math.round(parseFloat(t.entryFee) * 100),
          payout_structure: ps,
        };
      });

      // Set pool-level fields: lowest entry fee, highest tier's payout for display
      const fees = entryTiersPayload.map(t => t.entry_fee_cents);
      entryFeeCents = Math.min(...fees);

      // Use the highest tier's payout for the pool-level payout_structure
      const highestTier = entryTiersPayload.reduce((a, b) => a.entry_fee_cents > b.entry_fee_cents ? a : b);
      payouts = highestTier.payout_structure;
    } else {
      const entryFeeDollars = parseFloat(createForm.entryFee);
      if (isNaN(entryFeeDollars) || entryFeeDollars < 0) { toast.error("Entry fee must be valid"); return; }
      entryFeeCents = Math.round(entryFeeDollars * 100);

      const firstPlacePrize = createForm.prizes[0];
      if (!firstPlacePrize?.amount || parseFloat(firstPlacePrize.amount) <= 0) {
        toast.error("1st place prize is required"); return;
      }

      let rank = 1;
      for (const prize of createForm.prizes) {
        const amt = parseFloat(prize.amount);
        const places = Math.max(1, prize.places || 1);
        if (isNaN(amt) || amt <= 0) { rank += places; continue; }
        const amtCents = Math.round(amt * 100);
        for (let i = 0; i < places; i++) { payouts[String(rank)] = amtCents; rank++; }
      }
    }

    const maxRanks = createForm.multiTier
      ? Math.max(...(entryTiersPayload || []).map(t => Object.keys(t.payout_structure).length))
      : Object.keys(payouts).length;
    if (maxEntries > 0 && maxRanks > maxEntries) {
      const ok = confirm(
        `Your payout structure covers ${maxRanks} places but max entries is ${maxEntries}. Ranks beyond ${maxEntries} will never be paid out. Continue anyway?`
      );
      if (!ok) return;
    }

    // ---- v2 (multi-sport engine) body ----
    const useV1 = false;
    const isV2 = !useV1;
    if (!isV2 && createForm.genderCategory === "Open") { toast.error("'Open' is only available for multi-sport contests"); return; }
    let v2Body: any = null;

    if (isV2) {
      const typeDef = CONTEST_TYPES.find(t => t.key === createForm.contestType)!;
      const scoringConfig: any = getScoringPreset(createForm.contestType);
      const isGc = !!typeDef.perCompetitor;
      const isTierPick = !!typeDef.rosterTiers;
      const stageNames = createForm.stages.map(s => s.trim()).filter(Boolean);
      const raceKeys = isGc
        ? Array.from(new Set(stageNames))
        : Array.from(new Set(createForm.crews.map(c => c.event_id)));
      if (isGc && raceKeys.length < 2) {
        toast.error(isTierPick ? "Tier contests need at least 2 distinct stages" : "GC / Stage Race contests need at least 2 distinct stages");
        return;
      }

      if (raceKeys.length < 2 && entryFeeCents > 0) { toast.error("Paid contests require at least 2 races"); return; }
      const eventClass = createForm.eventClass.trim();
      if (typeDef.requiresEventClass && !eventClass) {
        toast.error("GC / Team Time Trial / Total Time contests require one event class for all races"); return;
      }
      const competitors = Array.from(
        new Map(createForm.crews.map(c => [c.crew_id, {
          competitor_key: c.crew_id,
          name: c.crew_name,
          logo_url: c.logo_url ?? null,
        }])).values()
      );
      // GC rosters are bounded by competitor count; every other mode by race count.
      const rosterSize = isGc ? competitors.length : raceKeys.length;
      const minPicks = parseInt(createForm.minPicks, 10);
      const maxPicks = parseInt(createForm.maxPicks, 10);
      const effectiveMax = typeDef.fixedRoster ? minPicks : maxPicks;
      if (isPrediction) {
        // Podium Predictor: exactly one race, picks == podium size, bounded by entered competitors.
        const podiumSize = parseInt(createForm.podiumSize, 10);
        if (raceKeys.filter(k => !!k).length !== 1) { toast.error("prediction contests take exactly one race"); return; }
        const raceKey = raceKeys.find(k => !!k)!;
        const distinctCompetitors = new Set(
          createForm.crews.filter(c => c.event_id === raceKey).map(c => c.crew_id)
        ).size;
        if (distinctCompetitors < podiumSize) { toast.error("not enough distinct entered competitors for the podium"); return; }
        if (!Number.isInteger(podiumSize) || minPicks !== podiumSize || effectiveMax !== podiumSize) {
          toast.error("prediction pick count must equal podium_size"); return;
        }
        scoringConfig.podium_size = podiumSize;
      } else if (isNaN(minPicks) || isNaN(effectiveMax) || minPicks < 2 || effectiveMax < minPicks || effectiveMax > rosterSize) {
        toast.error(
          isGc
            ? `Picks must satisfy 2 ≤ picks per entry ≤ number of competitors (${rosterSize})`
            : `Picks must satisfy 2 ≤ Min picks ≤ Max picks ≤ number of races (${rosterSize})`
        ); return;
      }

      // ---- Tiers-only validation (mirrors the backend, plus client-only strictness) ----
      let rosterTiersPayload: { name: string; competitors: string[] }[] = [];
      if (isTierPick) {
        const tiers = createForm.rosterTiers;
        if (tiers.length < 2 || tiers.length > 10) { toast.error("Tier contests need between 2 and 10 tiers"); return; }
        if (tiers.some(t => !t.name.trim())) { toast.error("Every tier needs a name"); return; }
        if (tiers.some(t => t.competitors.length < 2)) { toast.error("each roster tier needs at least 2 competitors"); return; }
        const assigned = new Set<string>();
        for (const tier of tiers) {
          for (const key of tier.competitors) {
            if (assigned.has(key)) { toast.error("every competitor must be assigned to a tier"); return; }
            assigned.add(key);
          }
        }
        if (competitors.some(c => !assigned.has(c.competitor_key))) {
          toast.error("every competitor must be assigned to a tier"); return;
        }
        if (minPicks !== tiers.length || effectiveMax !== tiers.length) {
          toast.error("tier contests require one pick per tier"); return;
        }
        rosterTiersPayload = tiers.map(t => ({ name: t.name.trim(), competitors: [...t.competitors] }));
      }


      // ---- Rounds-type validation (mirrors the backend) ----
      let survivorRounds: { round_no: number; lock_at: string; advance_count: number }[] = [];
      if (isRoundsType) {
        const rounds = createForm.rounds;
        if (rounds.length < 2) { toast.error("Survivor contests need at least 2 rounds"); return; }
        if (minPicks < 2) { toast.error("Survivor contests need at least 2 picks per entry"); return; }
        let prevLock: number | null = null;
        let prevAdvance: number | null = null;
        for (let i = 0; i < rounds.length; i++) {
          const r = rounds[i];
          if (!r.lockTime) { toast.error(`Round ${i + 1} needs a lock time`); return; }
          const t = new Date(r.lockTime).getTime();
          if (isNaN(t)) { toast.error(`Round ${i + 1} needs a valid lock time`); return; }
          if (prevLock !== null && t <= prevLock) { toast.error("Each round must lock after the previous one"); return; }
          prevLock = t;
          const adv = isAccumulate ? 1 : Number(r.advanceCount);
          if (!isAccumulate) {
            if (!Number.isInteger(adv) || adv < 1 || adv > 2147483647) {
              toast.error(`Round ${i + 1} advances must be a whole number between 1 and 2147483647`); return;
            }
            if (prevAdvance !== null && adv >= prevAdvance) {
              toast.error("Each Survivor round must advance fewer entries than the round before it"); return;
            }
          }
          prevAdvance = adv;
        }
        if (!isAccumulate && Number(rounds[rounds.length - 1].advanceCount) !== 1) {
          toast.error("The final Survivor round must advance exactly 1"); return;
        }
        for (const key of raceKeys) {
          const assigned = Number(createForm.raceRounds[key]);
          if (!Number.isInteger(assigned) || assigned < 1 || assigned > rounds.length) {
            toast.error("Every race must be assigned to a round"); return;
          }
        }
        for (let i = 0; i < rounds.length; i++) {
          const roundNo = i + 1;
          const roundRaces = raceKeys.filter(k => Number(createForm.raceRounds[k]) === roundNo);
          if (roundRaces.length < minPicks) { toast.error(`Round ${roundNo} needs at least ${minPicks} races`); return; }
          const competitorsInRound = new Set(
            createForm.crews.filter(c => roundRaces.includes(c.event_id)).map(c => c.crew_id)
          );
          if (competitorsInRound.size < 2) { toast.error(`Round ${roundNo} needs at least 2 different competitors`); return; }
          // Exact race<->competitor matching: a distinct competitor must be available per pick.
          const compIndex = new Map<string, number>();
          for (const key of competitorsInRound) compIndex.set(key, compIndex.size);
          const adjacency = roundRaces.map(rk =>
            Array.from(new Set(
              createForm.crews.filter(c => c.event_id === rk).map(c => compIndex.get(c.crew_id)!)
            ))
          );
          if (maxBipartiteMatching(adjacency, compIndex.size) < minPicks) {
            toast.error(`Round ${roundNo} doesn't have enough distinct competitors for the pick count`); return;
          }
        }
        survivorRounds = rounds.map((r, i) => ({
          round_no: i + 1,
          lock_at: i === 0 ? lockDate.toISOString() : new Date(r.lockTime).toISOString(),
          advance_count: isAccumulate ? 1 : Number(r.advanceCount),
        }));
      }

      v2Body = {
        name: createForm.regattaName.trim(),
        sport: createForm.sport,
        genderCategory: createForm.genderCategory,
        lockTime: lockDate.toISOString(),
        races: isRoundsType
          ? raceKeys.map((key, i) => ({
              race_key: key,
              name: key,
              race_order: i + 1,
              event_class: null,
              round_no: Number(createForm.raceRounds[key]),
            }))
          : raceKeys.map((key, i) => ({
              race_key: key,
              name: key,
              race_order: i + 1,
              event_class: eventClass || null,
            })),
        competitors,
        // GC: every competitor is entered in every stage (backend requires the full cross-product).
        raceEntries: isGc
          ? competitors.flatMap(c => raceKeys.map(rk => ({ race_key: rk, competitor_key: c.competitor_key })))
          : createForm.crews.map(c => ({ race_key: c.event_id, competitor_key: c.crew_id })),
        entryFeeCents,
        maxEntries,
        ...(isPrediction ? {} : { payouts }),
        entryTiers: (isRoundsType || isPrediction) ? null : entryTiersPayload,
        allowOverflow: createForm.allowOverflow,
        voidUnfilledOnSettle: isRoundsType ? true : createForm.voidUnfilledOnSettle,
        cardBannerUrl: createForm.cardBannerUrl.trim() || null,
        draftBannerUrl: createForm.draftBannerUrl.trim() || null,
        contestGroupId: (createForm.contestGroupId && createForm.contestGroupId !== "none") ? createForm.contestGroupId : null,
        primitive: scoringConfig.primitive,
        rosterMode: isGc ? "per_competitor" : "per_race",
        scoringConfig,
        minPicks,
        maxPicks: effectiveMax,

        ...(isRoundsType ? { rounds: survivorRounds } : {}),
        ...(isTierPick ? { rosterTiers: rosterTiersPayload } : {}),


      };
    }

    setCreatingContest(true);
    try {
      const { data, error } = await supabase.functions.invoke("admin-create-contest", {
        body: v2Body ?? {
          regattaName: createForm.regattaName.trim(),
          genderCategory: createForm.genderCategory,
          entryFeeCents,
          maxEntries,
          lockTime: lockDate.toISOString(),
          crews: createForm.crews,
          payouts,
          allowOverflow: createForm.allowOverflow,
          entryTiers: entryTiersPayload,
          cardBannerUrl: createForm.cardBannerUrl.trim() || null,
          draftBannerUrl: createForm.draftBannerUrl.trim() || null,
          contestGroupId: (createForm.contestGroupId && createForm.contestGroupId !== "none") ? createForm.contestGroupId : null,
          voidUnfilledOnSettle: createForm.voidUnfilledOnSettle,
        }
      });

      if (error) throw error;
      toast.success(`Contest created successfully!`);
      setCreateModalOpen(false);
      resetCreateForm();
      loadDashboardData();
    } catch (error: any) {
      console.error("Error creating contest:", error);
      let msg = "Failed to create contest";
      if (error.context?.json) {
        try { const ctx = typeof error.context.json === 'string' ? JSON.parse(error.context.json) : error.context.json; msg = ctx.error || msg; } catch {}
      } else if (error.message) msg = error.message;
      toast.error(msg);
    } finally { setCreatingContest(false); }
  };

  const exportComplianceLogs = async () => {
    setExporting(true);
    try {
      const { data, error } = await supabase.functions.invoke("compliance-export-daily");
      if (error) throw error;
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `compliance-report-${new Date().toISOString().split("T")[0]}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success("Compliance report exported successfully");
    } catch (error: any) { console.error("Error exporting logs:", error); toast.error(error.message || "Failed to export compliance report"); } finally { setExporting(false); }
  };

  if (loading) {
    return (
      <div className="flex flex-col min-h-screen">
        <Header />
        <main className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto" />
            <p className="mt-4 text-muted-foreground">Loading admin dashboard...</p>
          </div>
        </main>
        <Footer />
      </div>
    );
  }

  if (!isAdmin) return null;

  return (
    <div className="flex flex-col min-h-screen">
      <Header />
      <main className="flex-1 gradient-subtle py-8">
        <div className="container mx-auto px-4">
          <div className="mb-8">
            <h1 className="text-3xl font-bold mb-2">Admin Dashboard</h1>
            <p className="text-muted-foreground">Manage users, transactions, contests, and compliance</p>
          </div>

          {/* Feature Flags */}
          <Card className="mb-8">
            <CardHeader>
              <div className="flex items-center gap-2"><Settings className="h-5 w-5" /><CardTitle>System Configuration</CardTitle></div>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-4 items-center">
                <div className="flex items-center gap-2"><span className="text-sm font-medium">Real Money:</span><Badge variant={featureFlags.real_money_enabled?.enabled ? "default" : "secondary"}>{featureFlags.real_money_enabled?.enabled ? "ON" : "OFF"}</Badge></div>
                <div className="flex items-center gap-2"><span className="text-sm font-medium">Regulated Mode:</span><Badge variant={featureFlags.regulated_mode?.enabled ? "default" : "secondary"}>{featureFlags.regulated_mode?.enabled ? "ON" : "OFF"}</Badge></div>
                <div className="flex items-center gap-2"><span className="text-sm font-medium">Payment Provider:</span><Badge variant="outline">{featureFlags.payments_provider?.name || "mock"}</Badge></div>
              </div>
            </CardContent>
          </Card>

          {/* Stats */}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
            <Card><CardHeader className="flex flex-row items-center justify-between pb-2"><CardTitle className="text-sm font-medium">Total Users</CardTitle><Users className="h-4 w-4 text-muted-foreground" /></CardHeader><CardContent><div className="text-2xl font-bold">{users.length}</div></CardContent></Card>
            <Card><CardHeader className="flex flex-row items-center justify-between pb-2"><CardTitle className="text-sm font-medium">Transactions</CardTitle><DollarSign className="h-4 w-4 text-muted-foreground" /></CardHeader><CardContent><div className="text-2xl font-bold">{transactions.length}</div></CardContent></Card>
            <Card><CardHeader className="flex flex-row items-center justify-between pb-2"><CardTitle className="text-sm font-medium">Active Contests</CardTitle><Trophy className="h-4 w-4 text-muted-foreground" /></CardHeader><CardContent><div className="text-2xl font-bold">{groupedContests.filter(g => g.overallStatus === "open" || g.overallStatus === "locked").length}</div></CardContent></Card>
            <Card><CardHeader className="flex flex-row items-center justify-between pb-2"><CardTitle className="text-sm font-medium">Compliance Events</CardTitle><Shield className="h-4 w-4 text-muted-foreground" /></CardHeader><CardContent><div className="text-2xl font-bold">{complianceLogs.length}</div></CardContent></Card>
          </div>

          <Tabs defaultValue="users" className="space-y-4">
            <TabsList>
              <TabsTrigger value="users">Users</TabsTrigger>
              <TabsTrigger value="transactions">Transactions</TabsTrigger>
              <TabsTrigger value="contests">Contests</TabsTrigger>
              <TabsTrigger value="groups">Groups</TabsTrigger>
              <TabsTrigger value="compliance">Compliance Logs</TabsTrigger>
              <TabsTrigger value="support">Support</TabsTrigger>
            </TabsList>

            {/* Users Tab */}
            <TabsContent value="users" className="space-y-4">
              <Card>
                <CardHeader><CardTitle>User Management</CardTitle><CardDescription>View and manage user accounts</CardDescription></CardHeader>
                <CardContent>
                  <div className="overflow-x-auto">
                    <table className="w-full">
                      <thead><tr className="border-b"><th className="text-left p-2">Username</th><th className="text-left p-2">Email</th><th className="text-left p-2">State</th><th className="text-left p-2">Age Verified</th><th className="text-right p-2">Balance</th></tr></thead>
                      <tbody>{users.map((u) => (<tr key={u.id} className="border-b hover:bg-muted/50"><td className="p-2">{u.username || "N/A"}</td><td className="p-2">{u.email}</td><td className="p-2">{u.state || "Unknown"}</td><td className="p-2">{u.age_confirmed_at ? <span className="text-green-600">✓ Verified</span> : <span className="text-yellow-600">Pending</span>}</td><td className="text-right p-2">{formatCents(Number(u.balance))}</td></tr>))}</tbody>
                    </table>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            {/* Transactions Tab */}
            <TabsContent value="transactions" className="space-y-4">
              <Card>
                <CardHeader><CardTitle>Recent Transactions</CardTitle><CardDescription>View all platform transactions</CardDescription></CardHeader>
                <CardContent>
                  <div className="overflow-x-auto">
                    <table className="w-full">
                      <thead><tr className="border-b"><th className="text-left p-2">Date</th><th className="text-left p-2">User</th><th className="text-left p-2">Type</th><th className="text-right p-2">Amount</th><th className="text-left p-2">Status</th></tr></thead>
                      <tbody>{transactions.map((tx) => (<tr key={tx.id} className="border-b hover:bg-muted/50"><td className="p-2">{new Date(tx.created_at).toLocaleDateString()}</td><td className="p-2">{tx.profiles?.username || "N/A"}</td><td className="p-2 capitalize">{tx.type.replace("_", " ")}</td><td className="text-right p-2">{formatCents(Math.abs(Number(tx.amount)))}</td><td className="p-2 capitalize">{tx.status}</td></tr>))}</tbody>
                    </table>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            {/* Contests Tab */}
            <TabsContent value="contests" className="space-y-4">
              <Card>
                <CardHeader className="flex flex-row items-center justify-between">
                  <div><CardTitle>Contest Management</CardTitle><CardDescription>Manage contest pools, enter results, and settle payouts</CardDescription></div>
                  <Button onClick={() => setCreateModalOpen(true)}><Plus className="mr-2 h-4 w-4" />Create Contest</Button>
                </CardHeader>
                <CardContent>
                  <div className="space-y-4">
                    {groupedContests.map((group) => {
                      const { primary, pools, poolCount, totalEntries, totalMaxEntries, totalPrize, overallStatus, regattaName, hasTiers, tierGroups } = group;
                      const tierColors: Record<string, string> = { Bronze: 'border-amber-400', Silver: 'border-slate-400', Gold: 'border-yellow-400', Platinum: 'border-purple-400', Diamond: 'border-cyan-400' };
                      return (
                        <div key={primary.id} className="border rounded-lg p-4 space-y-3">
                          {/* Header */}
                          <div className="flex items-center justify-between">
                            <div>
                              <div className="flex items-center gap-2">
                                <span className="font-semibold text-lg">{regattaName}</span>
                                {hasTiers && <Badge variant="secondary" className="text-xs">{tierGroups.length} Tiers</Badge>}
                                <Badge variant={overallStatus === "settled" ? "default" : overallStatus === "voided" ? "destructive" : "secondary"}>
                                  {overallStatus === "results_entered" ? "results entered" : overallStatus}
                                </Badge>
                              </div>
                              <p className="text-sm text-muted-foreground">
                                {primary.contest_templates?.regatta_name ? '' : ''}{poolCount} pool{poolCount > 1 ? 's' : ''} · Locks {new Date(primary.lock_time).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit", hour12: true })}
                              </p>
                            </div>
                          </div>

                          {/* Tier breakdown or simple pool view */}
                          {hasTiers ? (
                            <div className="space-y-2">
                              {tierGroups.map((tier) => (
                                <div key={tier.tierName || 'default'} className={`border-l-4 ${tierColors[tier.tierName || ''] || 'border-slate-300'} rounded-r-lg bg-muted/30 p-3`}>
                                  <div className="flex items-center justify-between mb-1">
                                    <span className="font-semibold text-sm">{tier.tierName} ({formatCents(tier.entryFeeCents)})</span>
                                    {tier.overallStatus !== 'settled' && tier.overallStatus !== 'voided' && (
                                      <Button size="sm" variant="outline" className="text-xs h-7" onClick={() => voidTier(primary.contest_template_id, tier.tierName!)}>
                                        Void Tier
                                      </Button>
                                    )}
                                    {tier.overallStatus === 'voided' && <span className="text-xs text-destructive">Voided</span>}
                                  </div>
                                  {tier.pools.map((pool: any, idx: number) => {
                                    const isAutoVoided = pool.status === 'voided' && pool.void_unfilled_on_settle && pool.current_entries < pool.max_entries;
                                    return (
                                      <div key={pool.id} className="text-xs text-muted-foreground flex items-center gap-2">
                                        <span>Pool {idx + 1}: {pool.current_entries}/{pool.max_entries} entries</span>
                                        <span>·</span>
                                        <Badge variant="outline" className="text-[10px] h-5">
                                          {isAutoVoided ? 'Voided (unfilled)' : pool.status}
                                        </Badge>
                                        {idx > 0 && <span className="text-muted-foreground/60">(overflow)</span>}
                                        {pool.void_unfilled_on_settle && pool.current_entries < pool.max_entries && pool.status !== 'voided' && pool.status !== 'settled' && (
                                          <Badge variant="outline" className="text-[10px] h-5 border-amber-400 text-amber-600">⚠ Auto-void</Badge>
                                        )}
                                        {canResizePool(pool) && (
                                          <Button size="sm" variant="ghost" className="text-[10px] h-5 px-2" onClick={() => openResizeModal(pool)}>Resize</Button>
                                        )}
                                      </div>
                                    );
                                  })}
                                </div>
                              ))}
                            </div>
                          ) : (
                            <div className="space-y-1">
                              <div className="text-sm text-muted-foreground">
                                {totalEntries}/{totalMaxEntries} entries · {formatCents(totalPrize)} prize pool · {formatCents(primary.entry_fee_cents)} entry
                              </div>
                              {pools.map((pool: any, idx: number) => {
                                const isAutoVoided = pool.status === 'voided' && pool.void_unfilled_on_settle && pool.current_entries < pool.max_entries;
                                return (
                                  <div key={pool.id} className="text-xs text-muted-foreground flex items-center gap-2">
                                    <span>Pool {idx + 1}: {pool.current_entries}/{pool.max_entries} entries</span>
                                    <span>·</span>
                                    <Badge variant="outline" className="text-[10px] h-5">
                                      {isAutoVoided ? 'Voided (unfilled)' : pool.status}
                                    </Badge>
                                    {idx > 0 && <span className="text-muted-foreground/60">(overflow)</span>}
                                    {pool.void_unfilled_on_settle && pool.current_entries < pool.max_entries && pool.status !== 'voided' && pool.status !== 'settled' && (
                                      <Badge variant="outline" className="text-[10px] h-5 border-amber-400 text-amber-600">⚠ Auto-void</Badge>
                                    )}
                                    {canResizePool(pool) && (
                                      <Button size="sm" variant="ghost" className="text-[10px] h-5 px-2" onClick={() => openResizeModal(pool)}>Resize</Button>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          )}

                          {/* Actions */}
                          <div className="flex gap-2 flex-wrap pt-2 border-t">
                            {(overallStatus === "locked" || (overallStatus === "open" && isContestPastLockTime(primary))) && <Button size="sm" variant="outline" onClick={() => openResultsModal(primary)}>Enter Results</Button>}
                            {overallStatus === "results_entered" && <Button size="sm" variant="outline" onClick={() => openResultsModal(primary)}>Edit Results</Button>}
                            {overallStatus === "scoring_completed" && (
                              <div className="flex items-center gap-2">
                                <Button size="sm" variant="outline" onClick={() => openResultsModal(primary)}>Edit Results</Button>
                                <span className="text-xs text-muted-foreground">Editing results will reopen scoring.</span>
                              </div>
                            )}

                            {overallStatus === "results_entered" && <Button size="sm" variant="secondary" disabled={scoringPoolId === primary.id} onClick={() => calculateScores(primary.id)}>{scoringPoolId === primary.id ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Scoring...</> : "Calculate Scores"}</Button>}
                            {overallStatus === "scoring_completed" && <Button size="sm" variant="default" disabled={settlingPoolId === primary.id} onClick={() => settlePayouts(primary.id)}>{settlingPoolId === primary.id ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Settling...</> : hasTiers ? "Settle All Tiers" : "Settle Payouts"}</Button>}
                            {overallStatus === "settling" && <span className="text-sm text-muted-foreground flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" />Processing...</span>}
                            {overallStatus === "settled" && <span className="text-sm text-muted-foreground">Completed</span>}
                            {overallStatus === "open" && !isContestPastLockTime(primary) && <span className="text-sm text-muted-foreground">Awaiting lock</span>}
                            {overallStatus !== "settled" && overallStatus !== "voided" && (
                              <Button size="sm" variant="destructive" disabled={voidingPoolId === primary.contest_template_id} onClick={() => voidAllPoolsForTemplate(primary.contest_template_id)}>
                                {voidingPoolId === primary.contest_template_id ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Voiding...</> : hasTiers ? "Void All" : "Void"}
                              </Button>
                            )}
                            {overallStatus === "voided" && <span className="text-sm text-destructive">Voided</span>}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            {/* Contest Groups Tab */}
            <TabsContent value="groups" className="space-y-4">
              <ContestGroupsManager />
            </TabsContent>

            {/* Compliance Tab */}
            <TabsContent value="compliance" className="space-y-4">
              <Card>
                <CardHeader className="flex flex-row items-center justify-between">
                  <div><CardTitle>Compliance Audit Logs</CardTitle><CardDescription>Monitor compliance events and violations</CardDescription></div>
                  <Button onClick={exportComplianceLogs} variant="outline" size="sm" disabled={exporting}>{exporting ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Exporting...</> : <><Download className="mr-2 h-4 w-4" />Export Report</>}</Button>
                </CardHeader>
                <CardContent>
                  <div className="overflow-x-auto">
                    <table className="w-full">
                      <thead><tr className="border-b"><th className="text-left p-2">Timestamp</th><th className="text-left p-2">Event Type</th><th className="text-left p-2">Severity</th><th className="text-left p-2">Description</th><th className="text-left p-2">State</th></tr></thead>
                      <tbody>{complianceLogs.map((log) => (<tr key={log.id} className="border-b hover:bg-muted/50"><td className="p-2">{new Date(log.created_at).toLocaleString()}</td><td className="p-2 capitalize">{log.event_type.replace("_", " ")}</td><td className="p-2"><span className={`px-2 py-1 rounded text-xs ${log.severity === "error" ? "bg-red-100 text-red-800" : log.severity === "warn" ? "bg-yellow-100 text-yellow-800" : "bg-blue-100 text-blue-800"}`}>{log.severity}</span></td><td className="p-2 text-sm">{log.description}</td><td className="p-2">{log.state_code || "N/A"}</td></tr>))}</tbody>
                    </table>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>
            <TabsContent value="support" className="space-y-4">
              <AdminSupportInbox />
            </TabsContent>
          </Tabs>
        </div>
      </main>

      {/* Results Entry Modal */}
      <Dialog open={resultsModalOpen} onOpenChange={setResultsModalOpen}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader><DialogTitle>Enter Race Results - {selectedContest?.contest_templates?.regatta_name}</DialogTitle></DialogHeader>
          {loadingCrews ? (
            <div className="flex items-center justify-center py-8"><Loader2 className="h-8 w-8 animate-spin" /></div>
          ) : (
            <div className="space-y-4">
              {resultsForm.length === 0 ? (
                <p className="text-muted-foreground text-center py-4">No crews found for this contest pool.</p>
              ) : (
                <>
                  <div className="grid gap-4">
                    {resultsForm.map((crew) => {
                      const timeOnly = resultsV2 && parseTemplateScoringConfig(selectedContest?.contest_templates?.scoring_config)?.primitive === "time_vs_ref";
                      return (
                      <div key={crew.crew_id} className={`grid ${resultsV2 ? (timeOnly ? "grid-cols-3" : "grid-cols-4") : "grid-cols-3"} gap-3 items-center p-3 border rounded-lg`}>
                        <div>
                          <Label className="text-sm font-medium">{crew.crew_name}</Label>
                          <p className="text-xs text-muted-foreground">{resultsV2 ? `${crew.race_key} • ${crew.competitor_key}` : `ID: ${crew.crew_id}`}</p>
                        </div>
                        {!timeOnly && (
                        <div><Label htmlFor={`order-${crew.crew_id}`} className="text-xs">{resultsV2 ? "Place" : "Finish Order"}</Label><Input id={`order-${crew.crew_id}`} type="number" min="1" placeholder="1, 2, 3..." value={crew.finish_order} disabled={resultsV2 && (crew.status ?? "OK") !== "OK"} onChange={(e) => updateResultForm(crew.crew_id, "finish_order", e.target.value)} /></div>
                        )}
                        <div><Label htmlFor={`time-${crew.crew_id}`} className="text-xs">Finish Time</Label><Input id={`time-${crew.crew_id}`} type="text" placeholder={resultsV2 ? "5:30.50" : "05:30.50"} value={crew.finish_time} disabled={resultsV2 && (crew.status ?? "OK") !== "OK"} onChange={(e) => updateResultForm(crew.crew_id, "finish_time", e.target.value)} /></div>

                        {resultsV2 && (
                          <div>
                            <Label className="text-xs">Status</Label>
                            <Select value={crew.status ?? "OK"} onValueChange={(v) => updateResultForm(crew.crew_id, "status", v)}>
                              <SelectTrigger><SelectValue /></SelectTrigger>
                              <SelectContent>
                                {["OK", "DNF", "DNS", "DSQ", "PENDING"].map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                              </SelectContent>
                            </Select>
                          </div>
                        )}
                      </div>
                      );
                    })}


                  </div>
                  <div className="flex justify-end gap-3 pt-4 border-t">
                    <Button variant="outline" onClick={() => setResultsModalOpen(false)}>Cancel</Button>
                    <Button onClick={submitResults} disabled={submittingResults}>{submittingResults ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Submitting...</> : "Submit Results"}</Button>
                  </div>
                </>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Resize Pool Modal */}
      <Dialog open={!!resizeTarget} onOpenChange={(open) => { if (!open) setResizeTarget(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Resize Pool</DialogTitle>
            <DialogDescription>
              Lower the entry slots of this pool. Prizes scale down so the entry-fee-to-prize ratio is unchanged.
            </DialogDescription>
          </DialogHeader>
          {resizeTarget && (() => {
            const isLockedPool = resizeTarget.status === "locked";
            const minAllowed = Math.max(2, resizeTarget.current_entries, maxPrizeRank(resizeTarget.payout_structure));
            const parsed = parseInt(resizeMaxInput, 10);
            const isValidInput = Number.isInteger(parsed) && parsed < resizeTarget.max_entries &&
              (isLockedPool ? parsed === resizeTarget.current_entries : parsed >= minAllowed);
            const preview = isValidInput ? scalePayoutStructure(resizeTarget.payout_structure, resizeTarget.max_entries, parsed) : null;
            const hasZeroedPrize = !!preview && Object.entries(preview).some(([place, cents]) =>
              cents === 0 && Number(resizeTarget.payout_structure?.[place]) > 0);
            const formatPrizes = (structure: Record<string, number>) =>
              Object.entries(structure).sort(([a], [b]) => Number(a) - Number(b)).map(([place, cents]) => `#${place} ${formatCents(Number(cents))}`).join(" · ");
            const newPrizePool = preview ? Object.values(preview).reduce((sum, cents) => sum + cents, 0) : 0;
            return (
              <div className="space-y-3">
                <div className="text-sm text-muted-foreground">
                  Current: {resizeTarget.current_entries}/{resizeTarget.max_entries} entries · {formatCents(resizeTarget.entry_fee_cents)} entry
                </div>
                <div className="text-sm text-muted-foreground">Current prizes: {formatPrizes(resizeTarget.payout_structure || {})}</div>
                <div className="space-y-1.5">
                  <Label htmlFor="resizeMax">
                    {isLockedPool
                      ? `New max entries (locked pool — must equal current entries: ${resizeTarget.current_entries})`
                      : `New max entries (${minAllowed}–${resizeTarget.max_entries - 1})`}
                  </Label>
                  <Input id="resizeMax" type="number" min={minAllowed} max={resizeTarget.max_entries - 1} disabled={isLockedPool}
                    value={resizeMaxInput} onChange={(e) => setResizeMaxInput(e.target.value)} />
                </div>
                {preview && !hasZeroedPrize && (
                  <div className="text-sm">New prizes: {formatPrizes(preview)} · total {formatCents(newPrizePool)}</div>
                )}
                {hasZeroedPrize && (
                  <p className="text-sm text-destructive">This size would reduce an advertised prize to $0 — choose a larger size.</p>
                )}
                <p className="text-xs text-amber-600 border border-amber-300 rounded-md p-2 bg-amber-50">
                  ⚠ Material contest modification: this reduces the advertised prize amounts for players already entered. The change is audit-logged.
                </p>
                <div className="flex justify-end gap-2">
                  <Button variant="outline" onClick={() => setResizeTarget(null)}>Cancel</Button>
                  <Button disabled={!isValidInput || hasZeroedPrize || resizing} onClick={resizeContestPool}>
                    {resizing ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Resizing...</> : "Resize Pool"}
                  </Button>
                </div>
              </div>
            );
          })()}
        </DialogContent>
      </Dialog>

      {/* Create Contest Modal */}
      <Dialog open={createModalOpen} onOpenChange={(open) => { setCreateModalOpen(open); if (!open) resetCreateForm(); }}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader><DialogTitle>Create New Contest</DialogTitle></DialogHeader>
          <div className="space-y-6">
            {/* Basic Info */}
            <div className="grid gap-4">
              <div>
                <Label htmlFor="regattaName">Regatta Name *</Label>
                <Input id="regattaName" placeholder="e.g., Harvard-Yale Regatta 2026" value={createForm.regattaName} onChange={(e) => setCreateForm(prev => ({ ...prev, regattaName: e.target.value }))} />
              </div>
              <div>
                <Label>Card Banner — Lobby (optional)</Label>
                {!createForm.cardBannerUrl ? (
                  <label className="mt-1 flex flex-col items-center justify-center border-2 border-dashed border-slate-300 rounded-lg p-6 text-center cursor-pointer hover:border-slate-400 hover:bg-slate-50 transition-all">
                    {uploadingBanner ? (
                      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                    ) : (
                      <>
                        <Upload className="h-6 w-6 text-muted-foreground mb-1" />
                        <span className="text-sm text-muted-foreground">Drop image or click to upload</span>
                        <span className="text-xs text-slate-500 mt-1">Recommended: 760×320px (2.4:1). Fills the contest card in the lobby.</span>
                      </>
                    )}
                    <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      if (file.size > 5 * 1024 * 1024) { toast.error("File must be under 5MB"); return; }
                      setUploadingBanner(true);
                      try {
                        const fileName = `card-${Date.now()}-${file.name}`;
                        const { error } = await supabase.storage.from('contest-banners').upload(fileName, file, { contentType: file.type });
                        if (error) throw error;
                        const { data: { publicUrl } } = supabase.storage.from('contest-banners').getPublicUrl(fileName);
                        setCreateForm(prev => ({ ...prev, cardBannerUrl: publicUrl }));
                        toast.success("Card banner uploaded!");
                      } catch (err: any) {
                        console.error("Upload error:", err);
                        toast.error(err.message || "Failed to upload banner");
                      } finally { setUploadingBanner(false); }
                    }} />
                  </label>
                ) : (
                  <div className="mt-1 relative">
                    <img src={createForm.cardBannerUrl} alt="Card Banner" className="w-full h-[100px] object-cover rounded-lg border" />
                    <button type="button" className="absolute top-2 right-2 bg-black/60 text-white rounded-full p-1 hover:bg-black/80" onClick={() => setCreateForm(prev => ({ ...prev, cardBannerUrl: "" }))}>
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                )}
              </div>
              <div>
                <Label>Draft Page Banner — Header (optional)</Label>
                {!createForm.draftBannerUrl ? (
                  <label className="mt-1 flex flex-col items-center justify-center border-2 border-dashed border-slate-300 rounded-lg p-6 text-center cursor-pointer hover:border-slate-400 hover:bg-slate-50 transition-all">
                    {uploadingDraftBanner ? (
                      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                    ) : (
                      <>
                        <Upload className="h-6 w-6 text-muted-foreground mb-1" />
                        <span className="text-sm text-muted-foreground">Drop image or click to upload</span>
                        <span className="text-xs text-slate-500 mt-1">Recommended: 1500×300px (5:1). Fills the full-width header on the draft page.</span>
                      </>
                    )}
                    <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      if (file.size > 5 * 1024 * 1024) { toast.error("File must be under 5MB"); return; }
                      setUploadingDraftBanner(true);
                      try {
                        const fileName = `draft-${Date.now()}-${file.name}`;
                        const { error } = await supabase.storage.from('contest-banners').upload(fileName, file, { contentType: file.type });
                        if (error) throw error;
                        const { data: { publicUrl } } = supabase.storage.from('contest-banners').getPublicUrl(fileName);
                        setCreateForm(prev => ({ ...prev, draftBannerUrl: publicUrl }));
                        toast.success("Draft banner uploaded!");
                      } catch (err: any) {
                        console.error("Upload error:", err);
                        toast.error(err.message || "Failed to upload banner");
                      } finally { setUploadingDraftBanner(false); }
                    }} />
                  </label>
                ) : (
                  <div className="mt-1 relative">
                    <img src={createForm.draftBannerUrl} alt="Draft Banner" className="w-full h-[80px] object-cover rounded-lg border" />
                    <button type="button" className="absolute top-2 right-2 bg-black/60 text-white rounded-full p-1 hover:bg-black/80" onClick={() => setCreateForm(prev => ({ ...prev, draftBannerUrl: "" }))}>
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                )}
              </div>
              {/* Card Preview */}
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-2">Card Preview</p>
                <div className="rounded-xl overflow-hidden border border-slate-200 shadow-sm max-w-xs">
                  <div className="relative h-28 overflow-hidden">
                    {createForm.cardBannerUrl ? (
                      <img src={createForm.cardBannerUrl} alt="Preview" className="w-full h-full object-cover" />
                    ) : (
                      <div
                        className="w-full h-full flex items-center justify-center"
                        style={{ background: CARD_GRADIENTS[hashString(createForm.regattaName || 'Contest') % CARD_GRADIENTS.length] }}
                      >
                        <span className="text-white/20 text-lg font-bold text-center px-4 select-none">
                          {createForm.regattaName || 'Contest Name'}
                        </span>
                      </div>
                    )}
                    <div className="absolute bottom-2 left-2 bg-black/60 text-white text-[10px] font-semibold px-2 py-0.5 rounded-full">
                      2d 8h
                    </div>
                  </div>
                  <div className="h-1 bg-slate-200"><div className="h-full w-0 bg-teal-400 rounded-r-full" /></div>
                  <div className="p-3 bg-white">
                    <div className="border-l-3 border-teal-400 pl-2">
                      <p className="text-sm font-bold text-slate-900 truncate">{createForm.regattaName || 'Contest Name'}</p>
                      <p className="text-xs text-slate-500">{createForm.genderCategory} · Locks Thu 8:00 AM</p>
                    </div>
                    <div className="flex gap-1.5 mt-2">
                      <div className="bg-slate-50 rounded px-2 py-1 text-center flex-1">
                        <div className="text-xs font-bold text-slate-900">0/{createForm.maxEntries || '?'}</div>
                        <div className="text-[8px] text-slate-500 uppercase">Entries</div>
                      </div>
                      <div className="bg-slate-50 rounded px-2 py-1 text-center flex-1">
                        <div className="text-xs font-bold text-teal-600">{createForm.entryFee ? formatDollars(parseFloat(createForm.entryFee)) : '$?.??'}</div>
                        <div className="text-[8px] text-slate-500 uppercase">Entry</div>
                      </div>
                      <div className="bg-slate-50 rounded px-2 py-1 text-center flex-1">
                        <div className="text-xs font-bold text-amber-600">{createForm.prizes[0]?.amount ? formatDollars(parseFloat(createForm.prizes[0].amount)) : '$?.??'}</div>
                        <div className="text-[8px] text-slate-500 uppercase">Prizes</div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
              {contestGroups.length > 0 && (
                <div>
                  <Label>Contest Group (optional)</Label>
                  <Select value={createForm.contestGroupId} onValueChange={(value) => setCreateForm(prev => ({ ...prev, contestGroupId: value }))}>
                    <SelectTrigger><SelectValue placeholder="Select a group..." /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">None / Ungrouped</SelectItem>
                      {contestGroups.map(g => <SelectItem key={g.id} value={g.id}>{g.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              )}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label>Contest Type *</Label>
                  <Select value={createForm.contestType} onValueChange={(value) => {
                    const newType = CONTEST_TYPES.find(t => t.key === value);
                    const oldType = CONTEST_TYPES.find(t => t.key === createForm.contestType);
                    const modeChanged = !!newType?.perCompetitor !== !!oldType?.perCompetitor;
                    const toPrediction = value === "podium_predictor";
                    const fromPrediction = createForm.contestType === "podium_predictor" && !toPrediction;
                    const toTiers = value === "tier_pick";
                    setCreateForm(prev => {
                      // Tiers: two empty tiers on entry; cleared when leaving.
                      const nextTiers = toTiers
                        ? (prev.rosterTiers.length >= 2
                            ? prev.rosterTiers
                            : [{ name: "Tier 1", competitors: [] }, { name: "Tier 2", competitors: [] }])
                        : [];
                      return {
                      ...prev,
                      contestType: value as ContestTypeKey,
                      maxPicks: newType?.fixedRoster ? prev.minPicks : prev.maxPicks,
                      crews: modeChanged ? [] : prev.crews,
                      rosterTiers: modeChanged ? nextTiers.map(t => ({ ...t, competitors: [] })) : nextTiers,
                      ...(toTiers ? { minPicks: String(nextTiers.length), maxPicks: String(nextTiers.length) } : {}),
                      // Podium Predictor is always free, single-tier, and picks == podium size.
                      ...(toPrediction ? { entryFee: "0", multiTier: false, minPicks: "3", maxPicks: "3", podiumSize: "3" } : {}),
                      // Switching away restores the initial-fixture defaults so nothing leaks.
                      ...(fromPrediction ? { entryFee: "", multiTier: false, minPicks: "2", maxPicks: newType?.fixedRoster ? "2" : "4" } : {}),
                      };
                    });

                    if (modeChanged) {
                      setNewCrewInput({ crew_name: "", crew_id: "", event_id: "", logo_url: null });
                      toast.info("Lineup cleared — competitor entry differs for this contest type");
                    }
                  }}>

                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {CONTEST_TYPES.map(t => <SelectItem key={t.key} value={t.key}>{t.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground mt-1">
                    {CONTEST_TYPES.find(t => t.key === createForm.contestType)?.subtitle}
                  </p>
                </div>
                <div>
                  <Label>Sport *</Label>
                  <Select value={createForm.sport} onValueChange={(value) => setCreateForm(prev => ({ ...prev, sport: value }))}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {SPORT_OPTIONS.map(s => <SelectItem key={s} value={s} className="capitalize">{s}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
            </div>
              {isRoundsTypeUI && (
                <div className="space-y-4">
                  <div className="border rounded-lg p-3 space-y-2">
                    <Label className="text-sm font-semibold">Rounds *</Label>
                    <p className="text-xs text-muted-foreground">{isAccumulateUI ? "Every round locks at its own time. Every entry scores every round." : "Each round locks at its own time. Entries that fail to advance are eliminated. The final round must advance exactly 1."}</p>
                    {createForm.rounds.map((r, idx) => (
                      <div key={idx} className="flex items-end gap-2">
                        <span className="text-xs text-muted-foreground w-16 pb-2">Round {idx + 1}</span>
                        <div className="flex-1">
                          <Label className="text-xs">Lock time</Label>
                          <Input
                            type="datetime-local"
                            value={r.lockTime}
                            onChange={(e) => { const v = e.target.value; setCreateForm(prev => ({ ...prev, rounds: prev.rounds.map((x, i) => i === idx ? { ...x, lockTime: v } : x) })); }}
                          />
                        </div>
                        {!isAccumulateUI && (
                          <div className="w-28">
                            <Label className="text-xs">Advances</Label>
                            <Input
                              type="number"
                              min={1}
                              step={1}
                              value={r.advanceCount}
                              onChange={(e) => { const v = e.target.value; setCreateForm(prev => ({ ...prev, rounds: prev.rounds.map((x, i) => i === idx ? { ...x, advanceCount: v } : x) })); }}
                            />
                          </div>
                        )}
                        {createForm.rounds.length > 2 && (
                          <Button size="sm" variant="ghost" onClick={() => setCreateForm(prev => {
                            const removed = idx + 1;
                            const nextRaceRounds: Record<string, string> = {};
                            for (const [k, v] of Object.entries(prev.raceRounds)) {
                              const n = Number(v);
                              if (n === removed) continue;
                              nextRaceRounds[k] = n > removed ? String(n - 1) : v;
                            }
                            return { ...prev, rounds: prev.rounds.filter((_, i) => i !== idx), raceRounds: nextRaceRounds };
                          })}>
                            <X className="h-4 w-4" />
                          </Button>
                        )}
                      </div>
                    ))}
                    <Button size="sm" variant="outline" onClick={() => setCreateForm(prev => ({ ...prev, rounds: [...prev.rounds, { lockTime: "", advanceCount: "1" }] }))}>
                      <Plus className="mr-2 h-4 w-4" />Add Round
                    </Button>
                    <p className="text-xs text-muted-foreground">{isAccumulateUI ? "Everyone plays every round. This contest always voids if unfilled at settle time." : "Survivor contests always void if unfilled at settle time."}</p>
                  </div>
                  <div className="border rounded-lg p-3 space-y-2">
                    <Label className="text-sm font-semibold">Race → Round *</Label>
                    <p className="text-xs text-muted-foreground">Every race must belong to a round. Each round needs at least as many races as the picks-per-entry, and at least 2 different competitors.</p>
                    {Array.from(new Set(createForm.crews.map(c => c.event_id))).map(key => (
                      <div key={key} className="flex items-center gap-2">
                        <span className="text-sm flex-1 truncate">{key}</span>
                        <div className="w-40">
                          <Select
                            value={createForm.raceRounds[key] || ""}
                            onValueChange={(value) => setCreateForm(prev => ({ ...prev, raceRounds: { ...prev.raceRounds, [key]: value } }))}
                          >
                            <SelectTrigger><SelectValue placeholder="Round" /></SelectTrigger>
                            <SelectContent>
                              {createForm.rounds.map((_, i) => (
                                <SelectItem key={i} value={String(i + 1)}>Round {i + 1}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      </div>
                    ))}
                    {createForm.crews.length === 0 && (
                      <p className="text-xs text-muted-foreground">Add competitors below to assign their races to rounds.</p>
                    )}
                  </div>
                </div>
              )}
              {CONTEST_TYPES.find(t => t.key === createForm.contestType)?.requiresEventClass && (
                <div>
                  <Label htmlFor="eventClass">Event Class *</Label>
                  <Input id="eventClass" placeholder="e.g., 2000m Eight" value={createForm.eventClass} onChange={(e) => setCreateForm(prev => ({ ...prev, eventClass: e.target.value }))} />
                  <p className="text-xs text-muted-foreground mt-1">All races share this class — required for time-based scoring.</p>
                </div>
              )}
              {CONTEST_TYPES.find(t => t.key === createForm.contestType)?.perCompetitor && (
                <div className="border rounded-lg p-3 space-y-2">
                  <Label className="text-sm font-semibold">Stages *</Label>
                  <p className="text-xs text-muted-foreground">Ordered stages. Every competitor is entered in every stage. Minimum 2.</p>
                  {createForm.stages.map((stage, idx) => (
                    <div key={idx} className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground w-6">{idx + 1}.</span>
                      <Input
                        value={stage}
                        placeholder={`Stage ${idx + 1}`}
                        onChange={(e) => { const v = e.target.value; setCreateForm(prev => ({ ...prev, stages: prev.stages.map((s, i) => i === idx ? v : s) })); }}
                      />
                      {createForm.stages.length > 2 && (
                        <Button size="sm" variant="ghost" onClick={() => setCreateForm(prev => ({ ...prev, stages: prev.stages.filter((_, i) => i !== idx) }))}>
                          <X className="h-4 w-4" />
                        </Button>
                      )}
                    </div>
                  ))}
                  <Button size="sm" variant="outline" onClick={() => setCreateForm(prev => ({ ...prev, stages: [...prev.stages, `Stage ${prev.stages.length + 1}`] }))}>
                    <Plus className="mr-2 h-4 w-4" />Add Stage
                  </Button>
                </div>
              )}
              {createForm.contestType === "tier_pick" && (
                <div className="border rounded-lg p-3 space-y-3">
                  <Label className="text-sm font-semibold">Roster Tiers *</Label>
                  <p className="text-xs text-muted-foreground">Entrants pick exactly one competitor from each tier.</p>
                  {createForm.rosterTiers.map((tier, idx) => (
                    <div key={idx} className="border rounded-md p-2 space-y-2">
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground w-6">{idx + 1}.</span>
                        <Input
                          value={tier.name}
                          placeholder={`Tier ${idx + 1}`}
                          onChange={(e) => { const v = e.target.value; setCreateForm(prev => ({ ...prev, rosterTiers: prev.rosterTiers.map((t, i) => i === idx ? { ...t, name: v } : t) })); }}
                        />
                        {createForm.rosterTiers.length > 2 && (
                          <Button size="sm" variant="ghost" onClick={() => setCreateForm(prev => {
                            const next = prev.rosterTiers.filter((_, i) => i !== idx);
                            return { ...prev, rosterTiers: next, minPicks: String(next.length), maxPicks: String(next.length) };
                          })}>
                            <X className="h-4 w-4" />
                          </Button>
                        )}
                      </div>
                      {createForm.crews.length === 0 ? (
                        <p className="text-xs text-muted-foreground">Add competitors below to assign them to tiers.</p>
                      ) : (
                        <div className="flex flex-wrap gap-2">
                          {Array.from(new Map(createForm.crews.map(c => [c.crew_id, c])).values()).map((c) => {
                            const selected = tier.competitors.includes(c.crew_id);
                            return (
                              <Button
                                key={c.crew_id}
                                size="sm"
                                variant={selected ? "default" : "outline"}
                                onClick={() => setCreateForm(prev => {
                                  const movedFrom = prev.rosterTiers.findIndex((t, i) => i !== idx && t.competitors.includes(c.crew_id));
                                  if (!selected && movedFrom >= 0) {
                                    toast.info(`${c.crew_name} moved from ${prev.rosterTiers[movedFrom].name || `Tier ${movedFrom + 1}`}`);
                                  }
                                  return {
                                    ...prev,
                                    rosterTiers: prev.rosterTiers.map((t, i) => {
                                      if (i === idx) {
                                        return {
                                          ...t,
                                          competitors: selected
                                            ? t.competitors.filter(k => k !== c.crew_id)
                                            : [...t.competitors, c.crew_id],
                                        };
                                      }
                                      // A competitor belongs to at most one tier.
                                      return selected ? t : { ...t, competitors: t.competitors.filter(k => k !== c.crew_id) };
                                    }),
                                  };
                                })}
                              >
                                {c.crew_name}
                              </Button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  ))}
                  {createForm.rosterTiers.length < 10 && (
                    <Button size="sm" variant="outline" onClick={() => setCreateForm(prev => {
                      const next = [...prev.rosterTiers, { name: `Tier ${prev.rosterTiers.length + 1}`, competitors: [] }];
                      return { ...prev, rosterTiers: next, minPicks: String(next.length), maxPicks: String(next.length) };
                    })}>
                      <Plus className="mr-2 h-4 w-4" />Add Tier
                    </Button>
                  )}
                </div>
              )}
              {CONTEST_TYPES.find(t => t.key === createForm.contestType)?.fixedRoster ? (
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label htmlFor="picksPerEntry">Picks per entry *</Label>
                    <Input id="picksPerEntry" type="number" min={2} disabled={createForm.contestType === "podium_predictor" || createForm.contestType === "tier_pick"} value={createForm.minPicks} onChange={(e) => { const v = e.target.value; setCreateForm(prev => ({ ...prev, minPicks: v, maxPicks: v })); }} />
                    <p className="text-xs text-muted-foreground mt-1">
                      {createForm.contestType === "podium_predictor"
                        ? "Set by podium size"
                        : createForm.contestType === "tier_pick"
                          ? "Set by tier count"
                          : createForm.contestType === "gc_pool"
                            ? "Fixed roster — must be ≤ the number of competitors."
                            : "Fixed roster — must be ≤ the number of races."}

                    </p>
                  </div>
                  {createForm.contestType === "podium_predictor" && (
                    <div>
                      <Label>Podium size *</Label>
                      <Select
                        value={createForm.podiumSize}
                        onValueChange={(v) => setCreateForm(prev => ({ ...prev, podiumSize: v, minPicks: v, maxPicks: v }))}
                      >
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {[2, 3, 4, 5, 6, 7, 8, 9, 10].map(n => (
                            <SelectItem key={n} value={String(n)}>{n}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <p className="text-xs text-muted-foreground mt-1">Free contest — no cash prizes.</p>
                    </div>
                  )}

                </div>

              ) : (
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label htmlFor="minPicks">Min picks *</Label>
                    <Input id="minPicks" type="number" min={2} value={createForm.minPicks} onChange={(e) => setCreateForm(prev => ({ ...prev, minPicks: e.target.value }))} />
                  </div>
                  <div>
                    <Label htmlFor="maxPicks">Max picks *</Label>
                    <Input id="maxPicks" type="number" min={2} value={createForm.maxPicks} onChange={(e) => setCreateForm(prev => ({ ...prev, maxPicks: e.target.value }))} />
                  </div>
                </div>
              )}
              <div>
                <Label htmlFor="genderCategory">Gender Category *</Label>
                <Select value={createForm.genderCategory} onValueChange={(value) => setCreateForm(prev => ({ ...prev, genderCategory: value }))}>
                  <SelectTrigger><SelectValue placeholder="Select category" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Men's">Men's</SelectItem>
                    <SelectItem value="Women's">Women's</SelectItem>
                    <SelectItem value="Mixed">Mixed</SelectItem>
                    {(createForm.contestType !== "classic" || createForm.sport !== "rowing") && <SelectItem value="Open">Open</SelectItem>}
                  </SelectContent>
                </Select>
              </div>

              <div>
                <Label htmlFor="lockTime">Lock Time *</Label>
                <Input id="lockTime" type="datetime-local" disabled={isRoundsTypeUI} value={isRoundsTypeUI ? (createForm.rounds[0]?.lockTime || "") : createForm.lockTime} onChange={(e) => setCreateForm(prev => ({ ...prev, lockTime: e.target.value }))} />
                <p className="text-xs text-muted-foreground mt-1">{isRoundsTypeUI ? "Set by Round 1" : "Entries will be locked at this time"}</p>
              </div>
            </div>

            {/* Max Entries */}
            <div className="grid grid-cols-2 gap-4">
              {!createForm.multiTier && createForm.contestType !== "podium_predictor" && (
                <div>
                  <Label htmlFor="entryFee">Entry Fee ($) *</Label>
                  <Input id="entryFee" type="number" min="0" step="0.01" placeholder="10.00" value={createForm.entryFee} onChange={(e) => setCreateForm(prev => ({ ...prev, entryFee: e.target.value }))} />
                </div>
              )}

              <div>
                <Label htmlFor="maxEntries">Max Entries *</Label>
                <Input id="maxEntries" type="number" min="2" placeholder="100" value={createForm.maxEntries} onChange={(e) => setCreateForm(prev => ({ ...prev, maxEntries: e.target.value }))} />
              </div>
            </div>
            <div className="flex items-start space-x-3">
              <Checkbox id="allowOverflow" checked={createForm.allowOverflow} onCheckedChange={(checked) => setCreateForm(prev => ({ ...prev, allowOverflow: checked === true }))} />
              <div className="grid gap-1.5 leading-none">
                <Label htmlFor="allowOverflow" className="text-sm font-medium cursor-pointer">Enable Auto-Pooling</Label>
                <p className="text-xs text-muted-foreground">Automatically create a new pool when this one fills up.</p>
              </div>
            </div>
            <div className="flex items-start space-x-3">
              <Checkbox id="voidUnfilled" disabled={isRoundsTypeUI} checked={isRoundsTypeUI ? true : createForm.voidUnfilledOnSettle} onCheckedChange={(checked) => setCreateForm(prev => ({ ...prev, voidUnfilledOnSettle: checked === true }))} />
              <div className="grid gap-1.5 leading-none">
                <Label htmlFor="voidUnfilled" className="text-sm font-medium cursor-pointer">Auto-void unfilled pools on settlement</Label>
                <p className="text-xs text-muted-foreground">Pools that don't completely fill will be voided and entry fees refunded when the contest is settled. Applies to parent and overflow pools alike.</p>
              </div>
            </div>

            {/* Multi-Tier Toggle */}
            {createForm.contestType !== "podium_predictor" && (
              <div className="flex items-start space-x-3 border-t pt-4">
                <Checkbox id="multiTier" checked={createForm.multiTier} onCheckedChange={(checked) => setCreateForm(prev => ({ ...prev, multiTier: checked === true }))} />
                <div className="grid gap-1.5 leading-none">
                  <Label htmlFor="multiTier" className="text-sm font-medium cursor-pointer">Multiple Entry Tiers</Label>
                  <p className="text-xs text-muted-foreground">Offer multiple entry fee/payout levels within the same pool.</p>
                </div>
              </div>
            )}

            {createForm.contestType === "podium_predictor" && (
              <div className="border-t pt-4">
                <p className="text-sm text-muted-foreground">Free contest — no cash prizes</p>
              </div>
            )}

            {/* Single-tier Prize Structure */}
            {!createForm.multiTier && createForm.contestType !== "podium_predictor" && (

              <div className="border-t pt-4">
                <Label className="text-base font-semibold">Prize Structure</Label>
                <p className="text-sm text-muted-foreground mb-3">
                  Define payouts for each finishing position. Use "# of places" to pay the same amount to a range (e.g., 2nd–10th each get $10).
                </p>
                <div className="space-y-2 mb-4">
                  <div className="flex items-center gap-3 text-xs text-muted-foreground font-medium">
                    <div className="w-28">Place(s)</div>
                    <div className="w-24"># of places</div>
                    <div className="flex-1">Amount each ($)</div>
                    <div className="w-8" />
                  </div>
                  {createForm.prizes.map((prize, idx) => {
                    const { label, from } = getPrizeRankRange(createForm.prizes, idx);
                    const medal = from === 1 && prize.places === 1 ? "🥇 "
                                : from === 2 && prize.places === 1 ? "🥈 "
                                : from === 3 && prize.places === 1 ? "🥉 " : "";
                    return (
                      <div key={idx} className="flex items-center gap-3">
                        <div className="w-28 text-sm font-medium">{medal}{label}</div>
                        <div className="w-24">
                          <Input type="number" min="1" step="1" value={prize.places}
                            onChange={(e) => updatePrizePlaces(idx, e.target.value)} className="h-9 text-sm" />
                        </div>
                        <div className="flex-1">
                          <Input type="number" min="0" step="0.01" placeholder="50.00"
                            value={prize.amount} onChange={(e) => updatePrizeAmount(idx, e.target.value)} />
                        </div>
                        {idx > 0 ? (
                          <Button size="sm" variant="ghost" onClick={() => removePrizeTier(idx)}>
                            <X className="h-4 w-4" />
                          </Button>
                        ) : <div className="w-8" />}
                      </div>
                    );
                  })}
                </div>
                <Button variant="outline" size="sm" onClick={addPrizeTier} className="mb-4">
                  <Plus className="mr-2 h-4 w-4" />Add Prize Tier
                </Button>
              </div>
            )}

            {/* Multi-Tier Builder */}
            {createForm.multiTier && (
              <div className="border rounded-lg p-4 space-y-4 bg-muted/30">
                <Label className="text-base font-semibold">Entry Tiers</Label>
                <p className="text-sm text-muted-foreground">Define 2-5 entry fee/payout tiers. All tiers share the same pool.</p>

                {createForm.entryTiers.map((tier, idx) => (
                  <div key={idx} className="border rounded-lg p-4 bg-background space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-semibold">Tier {idx + 1}</span>
                      {createForm.entryTiers.length > 2 && (
                        <Button size="sm" variant="ghost" onClick={() => removeEntryTier(idx)}>
                          <X className="h-4 w-4" />
                        </Button>
                      )}
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <Label className="text-xs">Name</Label>
                        <Input placeholder="Bronze" value={tier.name} onChange={(e) => updateEntryTier(idx, "name", e.target.value)} />
                      </div>
                      <div>
                        <Label className="text-xs">Entry Fee ($)</Label>
                        <Input type="number" min="0" step="0.01" placeholder="10.00" value={tier.entryFee} onChange={(e) => updateEntryTier(idx, "entryFee", e.target.value)} />
                      </div>
                    </div>
                    <div>
                      <Label className="text-xs">Prizes</Label>
                      <div className="flex items-center gap-2 text-[10px] text-muted-foreground font-medium mt-1">
                        <div className="w-16">Place(s)</div>
                        <div className="w-14"># places</div>
                        <div className="flex-1">Amount each</div>
                        <div className="w-6" />
                      </div>
                      <div className="space-y-1.5 mt-1">
                        {tier.prizes.map((prize, prizeIdx) => {
                          const { label } = getPrizeRankRange(tier.prizes, prizeIdx);
                          return (
                            <div key={prizeIdx} className="flex items-center gap-2">
                              <span className="text-xs w-16 text-muted-foreground">{label}</span>
                              <Input type="number" min="1" step="1" value={prize.places}
                                onChange={(e) => updateTierPrizePlaces(idx, prizeIdx, e.target.value)}
                                className="h-8 text-sm w-14" />
                              <Input type="number" min="0" step="0.01" placeholder="19.00"
                                className="h-8 text-sm flex-1" value={prize.amount}
                                onChange={(e) => updateTierPrizeAmount(idx, prizeIdx, e.target.value)} />
                              {prizeIdx > 0 ? (
                                <Button size="sm" variant="ghost" className="h-8 w-6 p-0"
                                  onClick={() => removeTierPrize(idx, prizeIdx)}>
                                  <X className="h-3 w-3" />
                                </Button>
                              ) : <div className="w-6" />}
                            </div>
                          );
                        })}
                      </div>
                      <Button variant="ghost" size="sm" className="text-xs mt-1" onClick={() => addTierPrize(idx)}>
                        <Plus className="h-3 w-3 mr-1" />Add Place
                      </Button>
                    </div>
                  </div>
                ))}

                {createForm.entryTiers.length < 5 && (
                  <Button variant="outline" size="sm" onClick={addEntryTier}>
                    <Plus className="mr-2 h-4 w-4" />Add Tier
                  </Button>
                )}
              </div>
            )}

            {/* Profit Projection */}
            {(() => {
              const { maxRevenue, totalPayout, projectedProfit } = calculateProfitMetrics();
              const hasData = createForm.multiTier
                ? createForm.maxEntries && createForm.entryTiers.some(t => t.entryFee)
                : createForm.entryFee && createForm.maxEntries;
              return hasData ? (
                <div className="bg-muted/50 rounded-lg p-4 space-y-2">
                  <div className="flex justify-between text-sm"><span className="text-muted-foreground">Max Potential Revenue:</span><span className="font-medium">{formatDollars(maxRevenue)}</span></div>
                  <div className="flex justify-between text-sm"><span className="text-muted-foreground">Total Guaranteed Payout:</span><span className="font-medium">{formatDollars(totalPayout)}</span></div>
                  <div className="flex justify-between text-sm border-t pt-2"><span className="font-medium">Projected Profit:</span><span className={`font-bold ${projectedProfit >= 0 ? 'text-green-600' : 'text-destructive'}`}>{formatDollars(projectedProfit)}</span></div>
                  {projectedProfit < 0 && <p className="text-xs text-destructive">⚠️ Payouts exceed max revenue.</p>}
                </div>
              ) : null;
            })()}

            {/* Crew Management */}
            <div className="border-t pt-4">
              <Label className="text-base font-semibold">{CONTEST_TYPES.find(t => t.key === createForm.contestType)?.perCompetitor ? "Competitors" : "Crews"} ({createForm.crews.length})</Label>
              <p className="text-sm text-muted-foreground mb-3">
                {CONTEST_TYPES.find(t => t.key === createForm.contestType)?.perCompetitor
                  ? "Add at least 2 competitors — each one is entered in every stage"
                  : "Add at least 2 crews to the contest"}

              </p>
              {createForm.crews.length > 0 && (
                <div className="space-y-2 mb-4">
                  {createForm.crews.map((crew) => (
                    <div key={`${crew.crew_id}-${crew.event_id}`} className="flex items-center gap-3 p-2 bg-muted rounded-lg">
                      <LogoPicker logoUrl={crew.logo_url} crewName={crew.crew_name} onSelect={(url) => setCreateForm(prev => ({ ...prev, crews: prev.crews.map(c => c.crew_id === crew.crew_id && c.event_id === crew.event_id ? { ...c, logo_url: url } : c) }))} />
                      <div className="flex-1 text-sm"><span className="font-medium">{crew.crew_name}</span><span className="text-muted-foreground ml-2">({crew.crew_id}{crew.event_id ? ` • ${crew.event_id}` : ""})</span></div>
                      <Button size="sm" variant="ghost" onClick={() => removeCrewFromForm(crew.crew_id, crew.event_id)}><X className="h-4 w-4" /></Button>
                    </div>
                  ))}
                </div>
              )}

              <div className="flex items-end gap-2">
                <LogoPicker logoUrl={newCrewInput.logo_url} crewName={newCrewInput.crew_name || "?"} onSelect={(url) => setNewCrewInput(prev => ({ ...prev, logo_url: url }))} />
                <div className={`flex-1 grid gap-2 ${CONTEST_TYPES.find(t => t.key === createForm.contestType)?.perCompetitor ? "grid-cols-2" : "grid-cols-3"}`}>
                  <div><Label htmlFor="crewName" className="text-xs">Name</Label><Input id="crewName" placeholder="Yale" value={newCrewInput.crew_name} onChange={(e) => { const name = e.target.value; const autoLogo = getCircleFlagUrl(name) || getCollegeLogoUrl(name); setNewCrewInput(prev => ({ ...prev, crew_name: name, ...(autoLogo ? { logo_url: autoLogo } : {}) })); }} /></div>
                  <div><Label htmlFor="crewId" className="text-xs">Crew ID</Label><Input id="crewId" placeholder="yale_1v" value={newCrewInput.crew_id} onChange={(e) => setNewCrewInput(prev => ({ ...prev, crew_id: e.target.value }))} /></div>
                  {!CONTEST_TYPES.find(t => t.key === createForm.contestType)?.perCompetitor && (

                    <div><Label htmlFor="eventId" className="text-xs">Event ID</Label><Input id="eventId" placeholder="mens_8" value={newCrewInput.event_id} onChange={(e) => setNewCrewInput(prev => ({ ...prev, event_id: e.target.value }))} /></div>
                  )}
                </div>

                <Button variant="secondary" onClick={addCrewToForm}>Add</Button>
              </div>
            </div>

            {/* Submit */}
            <div className="flex justify-end gap-3 pt-4 border-t">
              <Button variant="outline" onClick={() => setCreateModalOpen(false)}>Cancel</Button>
              <Button onClick={submitCreateContest} disabled={creatingContest || createForm.crews.length < 2}>
                {creatingContest ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Creating...</> : "Create Contest"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default Admin;
