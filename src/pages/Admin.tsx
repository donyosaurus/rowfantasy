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
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Users, DollarSign, Trophy, Shield, Download, Settings, Loader2, Plus, X, Upload, ImageIcon, Layers } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { ContestGroupsManager } from "@/components/admin/ContestGroupsManager";
import { LogoPicker } from "@/components/LogoPicker";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "sonner";
// All money values must route through src/lib/formatCurrency.ts. Direct division by 100 in JSX is a bug.
import { getCircleFlagUrl } from "@/data/countryFlags";
import { getCollegeLogoUrl } from "@/data/collegeLogos";
import { formatCents } from "@/lib/formatCurrency";

interface CrewResult {
  crew_id: string;
  crew_name: string;
  finish_order: string;
  finish_time: string;
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
  const [submittingResults, setSubmittingResults] = useState(false);
  const [settlingPoolId, setSettlingPoolId] = useState<string | null>(null);
  const [scoringPoolId, setScoringPoolId] = useState<string | null>(null);
  const [voidingPoolId, setVoidingPoolId] = useState<string | null>(null);
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
      const { data: txData } = await supabase.from("transactions").select("*, profiles!inner(username)").order("created_at", { ascending: false }).limit(100);
      setTransactions(txData || []);
      const { data: poolsData } = await supabase.from("contest_pools").select("*, contest_templates!inner(regatta_name)").order("created_at", { ascending: false }).limit(50);
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
    try {
      const { data: crews, error } = await supabase.from("contest_pool_crews").select("id, crew_id, crew_name, manual_finish_order, manual_result_time").eq("contest_pool_id", contest.id);
      if (error) throw error;
      setPoolCrews(crews || []);
      setResultsForm((crews || []).map(crew => ({ crew_id: crew.crew_id, crew_name: crew.crew_name, finish_order: crew.manual_finish_order?.toString() || "", finish_time: crew.manual_result_time || "" })));
    } catch (error) { console.error("Error loading crews:", error); toast.error("Failed to load crews"); } finally { setLoadingCrews(false); }
  };

  const updateResultForm = (crewId: string, field: "finish_order" | "finish_time", value: string) => {
    setResultsForm(prev => prev.map(r => r.crew_id === crewId ? { ...r, [field]: value } : r));
  };

  const submitResults = async () => {
    if (!selectedContest) return;
    const invalidEntries = resultsForm.filter(r => !r.finish_order);
    if (invalidEntries.length > 0) { toast.error("Please enter finish order for all crews"); return; }
    setSubmittingResults(true);
    try {
      const results = resultsForm.map(r => ({ crew_id: r.crew_id, finish_order: parseInt(r.finish_order), finish_time: r.finish_time || null }));
      const { error: resultsError } = await supabase.functions.invoke("admin-contest-results", { body: { contestPoolId: selectedContest.id, results } });
      if (resultsError) throw new Error(`Saving results failed: ${resultsError.message}`);
      toast.success("Results saved. Calculating scores...");
      const { data: scoringData, error: scoringError } = await supabase.functions.invoke("contest-scoring", { body: { contestPoolId: selectedContest.id } });
      if (scoringError) throw new Error(`Scoring failed: ${scoringError.message}`);
      toast.success(`Scored ${scoringData?.poolsScored || 1} pool(s). Settling payouts...`);
      const { data: settleData, error: settleError } = await supabase.functions.invoke("contest-settle", { body: { contestPoolId: selectedContest.id } });
      if (settleError) throw new Error(`Settlement failed: ${settleError.message}`);
      let settleMsg = `Done! ${settleData?.winnersCount || 0} winner(s) paid out.`;
      if (settleData?.poolsAutoVoided > 0) {
        settleMsg += ` ${settleData.poolsAutoVoided} unfilled pool(s) auto-voided, ${settleData.entriesRefunded || 0} entry fee(s) refunded.`;
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
      const settledCount = details.filter((d: any) => d.action === 'settled').length;
      const voidedCount = details.filter((d: any) => d.action === 'auto_voided').length;
      const refundedEntries = details
        .filter((d: any) => d.action === 'auto_voided')
        .reduce((sum: number, d: any) => sum + (d.entriesRefunded || 0), 0);

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
        await supabase.functions.invoke("admin-contest-void", { body: { contestPoolId: pool.id } });
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
        await supabase.functions.invoke("admin-contest-void", { body: { contestPoolId: pool.id } });
      }
      toast.success(allPools.length === 1 ? "Contest voided and refunds issued" : "All pools voided and refunds issued");
      loadDashboardData();
    } catch (error: any) { console.error("Error voiding contest:", error); toast.error(error.message || "Failed to void contest"); } finally { setVoidingPoolId(null); }
  };

  const isContestPastLockTime = (contest: any) => new Date() > new Date(contest.lock_time);

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
    });
    setNewCrewInput({ crew_name: "", crew_id: "", event_id: "", logo_url: null });
  };

  const addCrewToForm = () => {
    if (!newCrewInput.crew_name || !newCrewInput.crew_id || !newCrewInput.event_id) { toast.error("Please fill in all crew fields"); return; }
    if (createForm.crews.some(c => c.crew_id === newCrewInput.crew_id)) { toast.error("Crew ID already exists"); return; }
    setCreateForm(prev => ({ ...prev, crews: [...prev.crews, { ...newCrewInput }] }));
    setNewCrewInput({ crew_name: "", crew_id: "", event_id: "", logo_url: null });
  };

  const removeCrewFromForm = (crewId: string) => {
    setCreateForm(prev => ({ ...prev, crews: prev.crews.filter(c => c.crew_id !== crewId) }));
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

  const submitCreateContest = async () => {
    if (!createForm.regattaName.trim()) { toast.error("Regatta name is required"); return; }
    if (!createForm.genderCategory) { toast.error("Gender category is required"); return; }
    if (!createForm.lockTime) { toast.error("Lock time is required"); return; }
    const lockDate = new Date(createForm.lockTime);
    if (lockDate <= new Date()) { toast.error("Lock time must be in the future"); return; }
    if (createForm.crews.length < 2) { toast.error("At least 2 crews are required"); return; }
    const maxEntries = parseInt(createForm.maxEntries);
    if (isNaN(maxEntries) || maxEntries < 2) { toast.error("Max entries must be at least 2"); return; }

    let entryFeeCents: number;
    let payouts: Record<string, number> = {};
    let entryTiersPayload: any[] | null = null;

    if (createForm.multiTier) {
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

    setCreatingContest(true);
    try {
      const { data, error } = await supabase.functions.invoke("admin-create-contest", {
        body: {
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
          voidUnfilledOnSettle: createForm.allowOverflow ? createForm.voidUnfilledOnSettle : false,
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
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">Geofencing:</span>
                  <Switch
                    checked={!!featureFlags.ipbase_enabled?.enabled}
                    onCheckedChange={async (checked) => {
                      const confirmMsg = checked
                        ? "Enabling geofencing will block users from 28 states that require DFS licensing. Admins will always bypass restrictions. Continue?"
                        : "Disabling geofencing will allow users from all states to access the platform. Are you sure?";
                      if (!confirm(confirmMsg)) return;
                      const { error } = await supabase
                        .from("feature_flags")
                        .upsert({ key: "ipbase_enabled", value: { enabled: checked } as any }, { onConflict: "key" });
                      if (error) { toast.error("Failed to update geofencing setting"); return; }
                      setFeatureFlags((prev: any) => ({ ...prev, ipbase_enabled: { enabled: checked } }));
                      toast.success(checked ? "Geofencing enabled" : "Geofencing disabled");
                    }}
                  />
                  <Badge variant={featureFlags.ipbase_enabled?.enabled ? "default" : "secondary"}>
                    {featureFlags.ipbase_enabled?.enabled ? "ON" : "OFF"}
                  </Badge>
                </div>
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
                                      </div>
                                    );
                                  })}
                                </div>
                              ))}
                            </div>
                          ) : (
                            <div className="text-sm text-muted-foreground">
                              {totalEntries}/{totalMaxEntries} entries · {formatCents(totalPrize)} prize pool · {formatCents(primary.entry_fee_cents)} entry
                            </div>
                          )}

                          {/* Actions */}
                          <div className="flex gap-2 flex-wrap pt-2 border-t">
                            {(overallStatus === "locked" || (overallStatus === "open" && isContestPastLockTime(primary))) && <Button size="sm" variant="outline" onClick={() => openResultsModal(primary)}>Enter Results</Button>}
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
                    {resultsForm.map((crew) => (
                      <div key={crew.crew_id} className="grid grid-cols-3 gap-3 items-center p-3 border rounded-lg">
                        <div><Label className="text-sm font-medium">{crew.crew_name}</Label><p className="text-xs text-muted-foreground">ID: {crew.crew_id}</p></div>
                        <div><Label htmlFor={`order-${crew.crew_id}`} className="text-xs">Finish Order</Label><Input id={`order-${crew.crew_id}`} type="number" min="1" placeholder="1, 2, 3..." value={crew.finish_order} onChange={(e) => updateResultForm(crew.crew_id, "finish_order", e.target.value)} /></div>
                        <div><Label htmlFor={`time-${crew.crew_id}`} className="text-xs">Finish Time</Label><Input id={`time-${crew.crew_id}`} type="text" placeholder="05:30.50" value={crew.finish_time} onChange={(e) => updateResultForm(crew.crew_id, "finish_time", e.target.value)} /></div>
                      </div>
                    ))}
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
                        <div className="text-xs font-bold text-teal-600">{createForm.entryFee ? `$${parseFloat(createForm.entryFee).toFixed(2)}` : '$?.??'}</div>
                        <div className="text-[8px] text-slate-500 uppercase">Entry</div>
                      </div>
                      <div className="bg-slate-50 rounded px-2 py-1 text-center flex-1">
                        <div className="text-xs font-bold text-amber-600">{createForm.prizes[0]?.amount ? `$${parseFloat(createForm.prizes[0].amount).toFixed(2)}` : '$?.??'}</div>
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
              <div>
                <Label htmlFor="genderCategory">Gender Category *</Label>
                <Select value={createForm.genderCategory} onValueChange={(value) => setCreateForm(prev => ({ ...prev, genderCategory: value }))}>
                  <SelectTrigger><SelectValue placeholder="Select category" /></SelectTrigger>
                  <SelectContent><SelectItem value="Men's">Men's</SelectItem><SelectItem value="Women's">Women's</SelectItem><SelectItem value="Mixed">Mixed</SelectItem></SelectContent>
                </Select>
              </div>
              <div>
                <Label htmlFor="lockTime">Lock Time *</Label>
                <Input id="lockTime" type="datetime-local" value={createForm.lockTime} onChange={(e) => setCreateForm(prev => ({ ...prev, lockTime: e.target.value }))} />
                <p className="text-xs text-muted-foreground mt-1">Entries will be locked at this time</p>
              </div>
            </div>

            {/* Max Entries */}
            <div className="grid grid-cols-2 gap-4">
              {!createForm.multiTier && (
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
              <Checkbox id="allowOverflow" checked={createForm.allowOverflow} onCheckedChange={(checked) => setCreateForm(prev => ({ ...prev, allowOverflow: checked === true, voidUnfilledOnSettle: checked === true ? prev.voidUnfilledOnSettle : false }))} />
              <div className="grid gap-1.5 leading-none">
                <Label htmlFor="allowOverflow" className="text-sm font-medium cursor-pointer">Enable Auto-Pooling</Label>
                <p className="text-xs text-muted-foreground">Automatically create a new pool when this one fills up.</p>
              </div>
            </div>
            {createForm.allowOverflow && (
              <div className="flex items-start space-x-3 ml-6 mt-2">
                <Checkbox id="voidUnfilled" checked={createForm.voidUnfilledOnSettle} onCheckedChange={(checked) => setCreateForm(prev => ({ ...prev, voidUnfilledOnSettle: checked === true }))} />
                <div className="grid gap-1.5 leading-none">
                  <Label htmlFor="voidUnfilled" className="text-sm font-medium cursor-pointer">Auto-void unfilled pools on settlement</Label>
                  <p className="text-xs text-muted-foreground">Pools that don't completely fill will be voided and entry fees refunded when the contest is settled.</p>
                </div>
              </div>
            )}

            {/* Multi-Tier Toggle */}
            <div className="flex items-start space-x-3 border-t pt-4">
              <Checkbox id="multiTier" checked={createForm.multiTier} onCheckedChange={(checked) => setCreateForm(prev => ({ ...prev, multiTier: checked === true }))} />
              <div className="grid gap-1.5 leading-none">
                <Label htmlFor="multiTier" className="text-sm font-medium cursor-pointer">Multiple Entry Tiers</Label>
                <p className="text-xs text-muted-foreground">Offer multiple entry fee/payout levels within the same pool.</p>
              </div>
            </div>

            {/* Single-tier Prize Structure */}
            {!createForm.multiTier && (
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
                  <div className="flex justify-between text-sm"><span className="text-muted-foreground">Max Potential Revenue:</span><span className="font-medium">${maxRevenue.toFixed(2)}</span></div>
                  <div className="flex justify-between text-sm"><span className="text-muted-foreground">Total Guaranteed Payout:</span><span className="font-medium">${totalPayout.toFixed(2)}</span></div>
                  <div className="flex justify-between text-sm border-t pt-2"><span className="font-medium">Projected Profit:</span><span className={`font-bold ${projectedProfit >= 0 ? 'text-green-600' : 'text-destructive'}`}>${projectedProfit.toFixed(2)}</span></div>
                  {projectedProfit < 0 && <p className="text-xs text-destructive">⚠️ Payouts exceed max revenue.</p>}
                </div>
              ) : null;
            })()}

            {/* Crew Management */}
            <div className="border-t pt-4">
              <Label className="text-base font-semibold">Crews ({createForm.crews.length})</Label>
              <p className="text-sm text-muted-foreground mb-3">Add at least 2 crews to the contest</p>
              {createForm.crews.length > 0 && (
                <div className="space-y-2 mb-4">
                  {createForm.crews.map((crew) => (
                    <div key={crew.crew_id} className="flex items-center gap-3 p-2 bg-muted rounded-lg">
                      <LogoPicker logoUrl={crew.logo_url} crewName={crew.crew_name} onSelect={(url) => setCreateForm(prev => ({ ...prev, crews: prev.crews.map(c => c.crew_id === crew.crew_id ? { ...c, logo_url: url } : c) }))} />
                      <div className="flex-1 text-sm"><span className="font-medium">{crew.crew_name}</span><span className="text-muted-foreground ml-2">({crew.crew_id} • {crew.event_id})</span></div>
                      <Button size="sm" variant="ghost" onClick={() => removeCrewFromForm(crew.crew_id)}><X className="h-4 w-4" /></Button>
                    </div>
                  ))}
                </div>
              )}
              <div className="flex items-end gap-2">
                <LogoPicker logoUrl={newCrewInput.logo_url} crewName={newCrewInput.crew_name || "?"} onSelect={(url) => setNewCrewInput(prev => ({ ...prev, logo_url: url }))} />
                <div className="flex-1 grid grid-cols-3 gap-2">
                  <div><Label htmlFor="crewName" className="text-xs">Name</Label><Input id="crewName" placeholder="Yale" value={newCrewInput.crew_name} onChange={(e) => { const name = e.target.value; const autoLogo = getCircleFlagUrl(name) || getCollegeLogoUrl(name); setNewCrewInput(prev => ({ ...prev, crew_name: name, ...(autoLogo ? { logo_url: autoLogo } : {}) })); }} /></div>
                  <div><Label htmlFor="crewId" className="text-xs">Crew ID</Label><Input id="crewId" placeholder="yale_1v" value={newCrewInput.crew_id} onChange={(e) => setNewCrewInput(prev => ({ ...prev, crew_id: e.target.value }))} /></div>
                  <div><Label htmlFor="eventId" className="text-xs">Event ID</Label><Input id="eventId" placeholder="mens_8" value={newCrewInput.event_id} onChange={(e) => setNewCrewInput(prev => ({ ...prev, event_id: e.target.value }))} /></div>
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
