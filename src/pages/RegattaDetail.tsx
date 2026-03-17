import { useParams, Link, useNavigate } from "react-router-dom";
import { useEffect, useState, useMemo } from "react";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  ArrowLeft,
  Clock,
  Loader2,
  Check,
  Trophy,
  Users,
  Zap,
  ChevronDown,
  Lock,
  X,
  Wallet,
  Crown,
  Star,
} from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { formatCents } from "@/lib/formatCurrency";

interface PoolCrew {
  id: string;
  crew_id: string;
  crew_name: string;
  event_id: string;
  logo_url?: string | null;
}

interface ContestPool {
  id: string;
  lock_time: string;
  status: string;
  entry_fee_cents: number;
  max_entries: number;
  current_entries: number;
  prize_pool_cents: number;
  payout_structure: Record<string, number> | null;
  contest_template_id: string;
  tier_id: string;
  contest_templates: {
    regatta_name: string;
    gender_category: string;
    min_picks: number;
    max_picks: number;
  };
  contest_pool_crews: PoolCrew[];
}

const FINISH_POINTS: Record<number, number> = {
  1: 100, 2: 75, 3: 60, 4: 45, 5: 35, 6: 25, 7: 15,
};
const DEFAULT_POINTS = 10;

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function tierDisplayName(tierId: string): string {
  // Convert tier_id like "bronze", "silver", "gold", "tier_1000" to display name
  const cleaned = tierId.replace(/^tier_/, '').replace(/_/g, ' ');
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

const RegattaDetail = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();

  const [contestPool, setContestPool] = useState<ContestPool | null>(null);
  const [siblingPools, setSiblingPools] = useState<ContestPool[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [crewPicks, setCrewPicks] = useState<Map<string, number>>(new Map());
  const [submitting, setSubmitting] = useState(false);
  const [scoringOpen, setScoringOpen] = useState(false);
  const [walletBalanceCents, setWalletBalanceCents] = useState<number | null>(null);
  const [userEnteredPoolIds, setUserEnteredPoolIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!authLoading && !user) navigate("/login");
  }, [user, authLoading, navigate]);

  useEffect(() => {
    if (!id) { setError("No contest ID provided"); setLoading(false); return; }
    const fetchPoolData = async () => {
      const { data, error: fetchError } = await supabase
        .from("contest_pools")
        .select(`*, payout_structure, contest_template_id, tier_id, contest_templates (regatta_name, gender_category, min_picks, max_picks), contest_pool_crews (id, crew_id, crew_name, event_id, logo_url)`)
        .eq("id", id)
        .single();
      if (fetchError || !data) { setError("Contest not found"); setLoading(false); return; }
      const pool = data as ContestPool;
      setContestPool(pool);

      // Fetch sibling pools (same template, different fees = multi-tier)
      const { data: siblings } = await supabase
        .from("contest_pools")
        .select(`*, payout_structure, contest_template_id, tier_id, contest_templates (regatta_name, gender_category, min_picks, max_picks), contest_pool_crews (id, crew_id, crew_name, event_id, logo_url)`)
        .eq("contest_template_id", pool.contest_template_id)
        .in("status", ["open", "locked"]);

      if (siblings) {
        setSiblingPools(siblings as ContestPool[]);
      }

      setLoading(false);
    };
    fetchPoolData();
  }, [id]);

  // Fetch user's entered pools
  useEffect(() => {
    if (!user || siblingPools.length === 0) return;
    const fetchEntries = async () => {
      const poolIds = siblingPools.map(p => p.id);
      const { data } = await supabase
        .from("contest_entries")
        .select("pool_id")
        .eq("user_id", user.id)
        .in("pool_id", poolIds)
        .in("status", ["active", "confirmed", "scored"]);
      if (data) {
        setUserEnteredPoolIds(new Set(data.map(e => e.pool_id)));
      }
    };
    fetchEntries();
  }, [user, siblingPools]);

  useEffect(() => {
    if (!user) return;
    const fetchWallet = async () => {
      const { data } = await supabase
        .from("wallets")
        .select("available_balance")
        .eq("user_id", user.id)
        .single();
      if (data) setWalletBalanceCents(Number(data.available_balance));
    };
    fetchWallet();
  }, [user]);

  // Detect multi-tier: sibling pools with different entry_fee_cents
  const isMultiTier = useMemo(() => {
    if (siblingPools.length <= 1) return false;
    const uniqueFees = new Set(siblingPools.map(p => p.entry_fee_cents));
    return uniqueFees.size > 1;
  }, [siblingPools]);

  // Group tier pools (collapse overflow pools into one per tier)
  const tierPools = useMemo(() => {
    if (!isMultiTier) return [];
    const tierMap = new Map<string, ContestPool[]>();
    for (const pool of siblingPools) {
      const key = `${pool.entry_fee_cents}_${pool.tier_id}`;
      if (!tierMap.has(key)) tierMap.set(key, []);
      tierMap.get(key)!.push(pool);
    }
    return Array.from(tierMap.values()).map(pools => {
      const primary = pools[0];
      const totalEntries = pools.reduce((s, p) => s + p.current_entries, 0);
      const totalMax = pools.reduce((s, p) => s + p.max_entries, 0);
      const hasCapacity = pools.some(p => p.current_entries < p.max_entries && p.status === "open");
      const userEntered = pools.some(p => userEnteredPoolIds.has(p.id));
      // Find pool with capacity to link to
      const entryPool = pools.find(p => p.current_entries < p.max_entries && p.status === "open") || primary;
      const firstPrize = primary.payout_structure ? primary.payout_structure['1'] || 0 : primary.prize_pool_cents;
      return { primary, entryPool, totalEntries, totalMax, hasCapacity, userEntered, firstPrize, pools };
    }).sort((a, b) => a.primary.entry_fee_cents - b.primary.entry_fee_cents);
  }, [isMultiTier, siblingPools, userEnteredPoolIds]);

  // Find the tier with most entries for "Popular" badge
  const mostPopularTierIdx = useMemo(() => {
    if (tierPools.length < 3) return -1;
    let maxIdx = 0;
    for (let i = 1; i < tierPools.length; i++) {
      if (tierPools[i].totalEntries > tierPools[maxIdx].totalEntries) maxIdx = i;
    }
    return tierPools[maxIdx].totalEntries > 0 ? maxIdx : -1;
  }, [tierPools]);

  const crewsByDivision = useMemo(() => {
    if (!contestPool?.contest_pool_crews) return {};
    const grouped: Record<string, PoolCrew[]> = {};
    for (const crew of contestPool.contest_pool_crews) {
      if (!grouped[crew.event_id]) grouped[crew.event_id] = [];
      grouped[crew.event_id].push(crew);
    }
    return grouped;
  }, [contestPool?.contest_pool_crews]);

  const divisions = Object.keys(crewsByDivision);

  const toggleCrewSelection = (crewId: string) => {
    setCrewPicks((prev) => {
      const newPicks = new Map(prev);
      if (newPicks.has(crewId)) {
        newPicks.delete(crewId);
      } else {
        const maxPicks = contestPool?.contest_templates?.max_picks ?? 10;
        if (newPicks.size >= maxPicks) {
          toast.error(`Maximum ${maxPicks} picks allowed`);
          return prev;
        }
        newPicks.set(crewId, 0);
      }
      return newPicks;
    });
  };

  const updateCrewMargin = (crewId: string, margin: number) => {
    setCrewPicks((prev) => {
      const newPicks = new Map(prev);
      newPicks.set(crewId, margin);
      return newPicks;
    });
  };

  const isContestOpen = contestPool?.status === "open" && new Date(contestPool.lock_time) > new Date();
  const minPicks = contestPool?.contest_templates?.min_picks ?? 2;
  const maxPicks = contestPool?.contest_templates?.max_picks ?? 10;

  const formattedLockTime = contestPool?.lock_time
    ? new Date(contestPool.lock_time).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    : "";

  const allMarginsValid = useMemo(() => {
    for (const [, margin] of crewPicks) {
      if (margin === undefined || margin <= 0) return false;
    }
    return true;
  }, [crewPicks]);

  const payoutRows = useMemo(() => {
    if (!contestPool?.payout_structure) return [];
    return Object.entries(contestPool.payout_structure)
      .map(([rank, cents]) => ({ rank: Number(rank), cents }))
      .sort((a, b) => a.rank - b.rank);
  }, [contestPool]);

  const firstPrize = payoutRows.length > 0 ? payoutRows[0].cents : contestPool?.prize_pool_cents ?? 0;
  const totalPrize = payoutRows.length > 0
    ? payoutRows.reduce((sum, r) => sum + r.cents, 0)
    : contestPool?.prize_pool_cents ?? 0;

  const fillPercent = contestPool ? Math.min(100, (contestPool.current_entries / contestPool.max_entries) * 100) : 0;

  const draftPicksList = useMemo(() => {
    return Array.from(crewPicks.entries()).map(([crewId, margin]) => {
      const crew = contestPool?.contest_pool_crews.find((c) => c.crew_id === crewId);
      return { crewId, crewName: crew?.crew_name ?? crewId, eventId: crew?.event_id ?? "", margin };
    });
  }, [crewPicks, contestPool]);

  const handleSubmitEntry = async () => {
    if (!id || !user || !contestPool) return;
    if (crewPicks.size < minPicks) { toast.error(`Please select at least ${minPicks} crews`); return; }
    for (const [crewId, margin] of crewPicks) {
      if (margin <= 0) {
        const crew = contestPool.contest_pool_crews.find((c) => c.crew_id === crewId);
        toast.error(`Please enter a valid margin for ${crew?.crew_name || crewId}`);
        return;
      }
    }
    const selectedDivisions = new Set<string>();
    for (const crewId of crewPicks.keys()) {
      const crew = contestPool.contest_pool_crews.find((c) => c.crew_id === crewId);
      if (crew) selectedDivisions.add(crew.event_id);
    }
    if (selectedDivisions.size < 2) { toast.error("You must select crews from at least 2 different events"); return; }
    if (walletBalanceCents !== null && walletBalanceCents < contestPool.entry_fee_cents) {
      toast.error(`Insufficient balance. You need ${formatCents(contestPool.entry_fee_cents)} but have ${formatCents(walletBalanceCents)}.`);
      return;
    }

    setSubmitting(true);
    const picks = Array.from(crewPicks.entries()).map(([crewId, margin]) => {
      const crew = contestPool.contest_pool_crews.find((c) => c.crew_id === crewId);
      return { crewId, event_id: crew?.event_id ?? "", predictedMargin: margin };
    });

    try {
      const { data, error } = await supabase.functions.invoke("contest-matchmaking", {
        body: {
          contestTemplateId: contestPool.contest_template_id,
          tierId: contestPool.id,
          picks,
          entryFeeCents: contestPool.entry_fee_cents,
          stateCode: null,
        },
      });
      if (error) throw error;
      if (data?.wasOverflow) {
        toast.info("Original pool was full — you've been placed in a new pool!", { duration: 5000 });
      } else if (data?.entryId) {
        toast.success("Entry submitted! You're in the contest.");
      } else {
        toast.error(data?.error || "Failed to submit entry.");
        return;
      }
      navigate("/my-entries");
    } catch (err: any) {
      let errorMessage = "Failed to enter contest";
      if (err.context?.json) {
        try {
          const ctx = typeof err.context.json === "string" ? JSON.parse(err.context.json) : err.context.json;
          errorMessage = ctx.error || ctx.message || errorMessage;
        } catch { errorMessage = err.message || errorMessage; }
      } else if (err.message) { errorMessage = err.message; }
      toast.error(errorMessage);
    } finally {
      setSubmitting(false);
    }
  };

  // Loading / Error states
  if (authLoading || loading) {
    return (
      <div className="flex flex-col min-h-screen">
        <Header />
        <main className="flex-1 flex items-center justify-center">
          <Loader2 className="h-12 w-12 animate-spin text-accent" />
        </main>
        <Footer />
      </div>
    );
  }

  if (error || !contestPool) {
    return (
      <div className="flex flex-col min-h-screen">
        <Header />
        <main className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <h2 className="text-2xl font-bold mb-2">Contest Not Found</h2>
            <p className="text-muted-foreground mb-4">{error}</p>
            <Link to="/lobby"><Button>Back to Lobby</Button></Link>
          </div>
        </main>
        <Footer />
      </div>
    );
  }

  const statusLabel = isContestOpen ? "Open" : contestPool.status.charAt(0).toUpperCase() + contestPool.status.slice(1);

  // ── MULTI-TIER: Show tier selection page ──
  if (isMultiTier) {
    return (
      <div className="flex flex-col min-h-screen">
        <Header />

        <div className="gradient-hero text-primary-foreground">
          <div className="container mx-auto px-4 max-w-5xl py-6 lg:py-8">
            <Link
              to="/lobby"
              className="inline-flex items-center gap-2 text-primary-foreground/70 hover:text-primary-foreground text-sm mb-4 transition-base"
            >
              <ArrowLeft className="h-4 w-4" />
              Back to Lobby
            </Link>

            <div className="flex items-start justify-between gap-4 mb-3">
              <div>
                <h1 className="font-heading text-3xl lg:text-4xl font-bold mb-1">
                  {contestPool.contest_templates.regatta_name}
                </h1>
                <p className="text-primary-foreground/70 text-sm lg:text-base">
                  {contestPool.contest_templates.gender_category} Multi-Team Fantasy · Draft a crew from each event
                </p>
              </div>
              <Badge className="flex-shrink-0 text-sm px-3 py-1 font-semibold bg-success/20 text-success border-success/30">
                {statusLabel}
              </Badge>
            </div>

            <div className="flex items-center gap-2 text-primary-foreground/60 text-sm">
              <Clock className="h-4 w-4" />
              <span>Locks {formattedLockTime}</span>
            </div>
          </div>
        </div>

        <main className="flex-1 bg-background">
          <div className="container mx-auto px-4 max-w-5xl py-8">
            <h2 className="font-heading text-2xl font-bold mb-2">Choose Your Entry Level</h2>
            <p className="text-muted-foreground mb-6">Same crews, same events — pick your stakes.</p>

            <div className={`grid gap-5 ${tierPools.length <= 3 ? 'grid-cols-1 md:grid-cols-' + tierPools.length : 'grid-cols-1 md:grid-cols-2 lg:grid-cols-3'}`}>
              {tierPools.map((tier, idx) => {
                const isHighest = idx === tierPools.length - 1;
                const isPopular = idx === mostPopularTierIdx;
                const isFull = !tier.hasCapacity;
                const fillPct = tier.totalMax > 0 ? Math.min(100, (tier.totalEntries / tier.totalMax) * 100) : 0;

                return (
                  <Card
                    key={tier.primary.id}
                    className={`relative rounded-xl overflow-hidden transition-all ${
                      isHighest ? "border-2 border-gold shadow-lg" : "border"
                    } ${tier.userEntered ? "opacity-80" : ""}`}
                  >
                    {/* Top accent */}
                    <div className={`h-1.5 ${isHighest ? "bg-gradient-to-r from-gold to-amber-400" : "gradient-hero"}`} />

                    {/* Badges */}
                    {isPopular && !tier.userEntered && (
                      <div className="absolute top-4 right-4">
                        <Badge className="bg-accent text-accent-foreground text-xs font-semibold">
                          <Star className="h-3 w-3 mr-1" /> Most Popular
                        </Badge>
                      </div>
                    )}
                    {tier.userEntered && (
                      <div className="absolute top-4 right-4">
                        <Badge className="bg-success/20 text-success border-success/30 text-xs font-semibold">
                          ✓ Entered
                        </Badge>
                      </div>
                    )}

                    <CardContent className="p-6 space-y-4">
                      {/* Tier name */}
                      <div className="flex items-center gap-2">
                        {isHighest && <Crown className="h-5 w-5 text-gold" />}
                        <h3 className="font-heading text-xl font-bold">
                          {tierDisplayName(tier.primary.tier_id)}
                        </h3>
                      </div>

                      {/* Entry fee */}
                      <div className="text-center py-3">
                        <p className="font-heading text-4xl font-extrabold">{formatCents(tier.primary.entry_fee_cents)}</p>
                        <p className="text-sm text-muted-foreground">entry</p>
                      </div>

                      {/* First prize */}
                      <div className="flex items-center gap-2 justify-center p-3 rounded-lg bg-gradient-to-br from-amber-50 to-yellow-50/50 dark:from-amber-950/30 dark:to-yellow-950/20 border border-amber-200/40 dark:border-amber-800/30">
                        <Trophy className="h-5 w-5 text-gold" />
                        <span className="font-heading text-lg font-bold text-gold">Win {formatCents(tier.firstPrize)}</span>
                      </div>

                      {/* Full payout if multiple places */}
                      {tier.primary.payout_structure && Object.keys(tier.primary.payout_structure).length > 1 && (
                        <div className="text-center">
                          <div className="flex flex-wrap gap-1.5 justify-center">
                            {Object.entries(tier.primary.payout_structure).sort(([a], [b]) => Number(a) - Number(b)).map(([rank, cents]) => (
                              <span key={rank} className="text-xs text-muted-foreground">
                                {ordinal(Number(rank))}: {formatCents(cents)}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Entries */}
                      <div className="space-y-2">
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-muted-foreground flex items-center gap-1.5"><Users className="h-4 w-4" />Entries</span>
                          <span className="font-semibold">{tier.totalEntries}/{tier.totalMax}</span>
                        </div>
                        <Progress value={fillPct} className="h-1.5" />
                      </div>

                      {/* Action */}
                      {tier.userEntered ? (
                        <Button disabled className="w-full rounded-xl" variant="ghost">
                          ✓ Entered
                        </Button>
                      ) : isFull ? (
                        <Button disabled className="w-full rounded-xl">Full</Button>
                      ) : (
                        <Link to={`/contest/${tier.entryPool.id}`} className="block">
                          <Button className="w-full rounded-xl font-semibold" variant="hero">
                            Enter — {formatCents(tier.primary.entry_fee_cents)}
                          </Button>
                        </Link>
                      )}
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          </div>
        </main>

        <Footer />
      </div>
    );
  }

  // ── SINGLE-TIER: Original crew drafting UI ──
  return (
    <div className="flex flex-col min-h-screen">
      <Header />

      {/* ── Gradient Hero Header ── */}
      <div className="gradient-hero text-primary-foreground">
        <div className="container mx-auto px-4 max-w-6xl py-6 lg:py-8">
          <Link
            to="/lobby"
            className="inline-flex items-center gap-2 text-primary-foreground/70 hover:text-primary-foreground text-sm mb-4 transition-base"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to Lobby
          </Link>

          <div className="flex items-start justify-between gap-4 mb-5">
            <div>
              <h1 className="font-heading text-3xl lg:text-4xl font-bold mb-1">
                {contestPool.contest_templates.regatta_name}
              </h1>
              <p className="text-primary-foreground/70 text-sm lg:text-base">
                {contestPool.contest_templates.gender_category} Multi-Team Fantasy · Draft a crew from each event
              </p>
            </div>
            <Badge
              className={`flex-shrink-0 text-sm px-3 py-1 font-semibold ${
                isContestOpen
                  ? "bg-success/20 text-success border-success/30"
                  : "bg-primary-foreground/10 text-primary-foreground/60 border-primary-foreground/20"
              }`}
            >
              {statusLabel}
            </Badge>
          </div>

          {/* Stat Cards Row */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <div className="rounded-xl bg-primary-foreground/10 backdrop-blur-sm border border-primary-foreground/10 p-3 lg:p-4">
              <div className="flex items-center gap-2 mb-1"><Trophy className="h-4 w-4 text-gold" /><span className="text-xs text-primary-foreground/60 font-medium">1st Prize</span></div>
              <p className="font-heading text-xl lg:text-2xl font-bold text-gold">{formatCents(firstPrize)}</p>
            </div>
            <div className="rounded-xl bg-primary-foreground/10 backdrop-blur-sm border border-primary-foreground/10 p-3 lg:p-4">
              <div className="flex items-center gap-2 mb-1"><Zap className="h-4 w-4 text-accent" /><span className="text-xs text-primary-foreground/60 font-medium">Entry Fee</span></div>
              <p className="font-heading text-xl lg:text-2xl font-bold">{formatCents(contestPool.entry_fee_cents)}</p>
            </div>
            <div className="rounded-xl bg-primary-foreground/10 backdrop-blur-sm border border-primary-foreground/10 p-3 lg:p-4">
              <div className="flex items-center gap-2 mb-1"><Clock className="h-4 w-4 text-primary-foreground/60" /><span className="text-xs text-primary-foreground/60 font-medium">Locks</span></div>
              <p className="font-heading text-lg lg:text-xl font-bold">{formattedLockTime}</p>
            </div>
            <div className="rounded-xl bg-primary-foreground/10 backdrop-blur-sm border border-primary-foreground/10 p-3 lg:p-4">
              <div className="flex items-center gap-2 mb-1"><Users className="h-4 w-4 text-primary-foreground/60" /><span className="text-xs text-primary-foreground/60 font-medium">Entries</span></div>
              <p className="font-heading text-xl lg:text-2xl font-bold mb-1.5">{contestPool.current_entries}/{contestPool.max_entries}</p>
              <div className="h-1 w-full rounded-full bg-primary-foreground/10 overflow-hidden"><div className="h-full rounded-full bg-accent transition-all" style={{ width: `${fillPercent}%` }} /></div>
            </div>
          </div>
        </div>
      </div>

      {/* ── Main Content ── */}
      <main className="flex-1 bg-background pb-32 lg:pb-12">
        <div className="container mx-auto px-4 max-w-6xl py-6 lg:py-8">
          {!isContestOpen && (
            <div className="mb-6 p-4 rounded-xl border border-destructive/30 bg-destructive/5 text-center">
              <p className="text-destructive font-semibold flex items-center justify-center gap-2">
                <Lock className="h-4 w-4" />
                This contest is no longer accepting entries.
              </p>
            </div>
          )}

          <div className="flex flex-col lg:flex-row gap-6 lg:gap-8">
            {/* ── LEFT: Crew Selection ── */}
            <div className="flex-1 min-w-0 space-y-5">
              <div>
                <h2 className="font-heading text-xl font-bold mb-1">Select Your Crews</h2>
                <p className="text-sm text-muted-foreground">
                  Draft a crew from each event. Your entry will be matched against other players.
                </p>
              </div>

              {divisions.length === 0 ? (
                <Card><CardContent className="py-8 text-center text-muted-foreground">No crews available.</CardContent></Card>
              ) : (
                divisions.map((divisionId) => (
                  <div key={divisionId}>
                    <div className="flex items-center gap-2 mb-3">
                      <Badge variant="outline" className="font-semibold text-xs px-2.5 py-1 bg-muted/50">{divisionId}</Badge>
                      <span className="text-xs text-muted-foreground">{crewsByDivision[divisionId].length} crews</span>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      {crewsByDivision[divisionId].map((crew) => {
                        const isSelected = crewPicks.has(crew.crew_id);
                        const marginVal = crewPicks.get(crew.crew_id) ?? 0;
                        return (
                          <div
                            key={crew.id}
                            className={`group rounded-xl border-2 transition-all overflow-hidden ${!isContestOpen ? "opacity-50 pointer-events-none" : "cursor-pointer"} ${
                              isSelected ? "border-accent bg-accent/5 shadow-sm" : "border-border hover:border-muted-foreground/30 hover:shadow-sm hover:-translate-y-0.5"
                            }`}
                          >
                            <div className="flex items-center gap-3 p-3.5" onClick={() => isContestOpen && toggleCrewSelection(crew.crew_id)}>
                              <div className={`flex-shrink-0 w-6 h-6 rounded-md border-2 flex items-center justify-center transition-all ${isSelected ? "bg-accent border-accent" : "border-border group-hover:border-muted-foreground/40"}`}>
                                {isSelected && <Check className="h-4 w-4 text-accent-foreground" />}
                              </div>
                              <div className="flex-1 min-w-0">
                                <p className="font-semibold text-sm truncate">{crew.crew_name}</p>
                                <p className="text-xs text-muted-foreground">{divisionId}</p>
                              </div>
                            </div>
                            {isSelected && isContestOpen && (
                              <div className="px-3.5 pb-3.5 animate-fade-in">
                                <div className="flex items-center gap-2 p-2 rounded-lg bg-muted/50 border border-border/50">
                                  <span className="text-xs text-muted-foreground whitespace-nowrap">Margin:</span>
                                  <Input type="number" min="0.01" step="0.1" placeholder="e.g. 2.5" className="h-7 text-sm border-0 bg-transparent p-0 focus-visible:ring-0"
                                    value={marginVal || ""} onClick={(e) => e.stopPropagation()}
                                    onChange={(e) => { e.stopPropagation(); updateCrewMargin(crew.crew_id, parseFloat(e.target.value) || 0); }}
                                  />
                                  <span className="text-xs text-muted-foreground">sec</span>
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))
              )}
            </div>

            {/* ── RIGHT: Sticky Sidebar ── */}
            <div className="w-full lg:w-[340px] lg:sticky lg:top-4 lg:self-start space-y-4">
              {/* Prize Pool */}
              {payoutRows.length > 0 && (
                <Card className="rounded-xl">
                  <CardContent className="p-4">
                    <h3 className="font-heading text-sm font-bold mb-3 flex items-center gap-2"><Trophy className="h-4 w-4 text-gold" />Prize Pool</h3>
                    <div className="space-y-1.5">
                      {payoutRows.map((row) => (
                        <div key={row.rank} className="flex justify-between text-sm">
                          <span className={row.rank === 1 ? "font-semibold text-gold" : "text-muted-foreground"}>{ordinal(row.rank)}</span>
                          <span className={row.rank === 1 ? "font-bold text-gold" : "font-medium"}>{formatCents(row.cents)}</span>
                        </div>
                      ))}
                      <div className="flex justify-between text-sm border-t pt-1.5 mt-1.5"><span className="font-medium">Total</span><span className="font-bold">{formatCents(totalPrize)}</span></div>
                    </div>
                  </CardContent>
                </Card>
              )}

              {/* Scoring (Collapsible) */}
              <Card className="rounded-xl">
                <CardContent className="p-4">
                  <Collapsible open={scoringOpen} onOpenChange={setScoringOpen}>
                    <CollapsibleTrigger className="flex items-center justify-between w-full">
                      <h3 className="font-heading text-sm font-bold">How Scoring Works</h3>
                      <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform ${scoringOpen ? "rotate-180" : ""}`} />
                    </CollapsibleTrigger>
                    <CollapsibleContent className="pt-3">
                      <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                        {Object.entries(FINISH_POINTS).map(([place, pts]) => (
                          <div key={place} className="flex justify-between text-xs text-muted-foreground">
                            <span>{ordinal(Number(place))}</span><span className="font-medium text-foreground">{pts} pts</span>
                          </div>
                        ))}
                        <div className="flex justify-between text-xs text-muted-foreground"><span>8th+</span><span className="font-medium text-foreground">{DEFAULT_POINTS} pts</span></div>
                      </div>
                    </CollapsibleContent>
                  </Collapsible>
                </CardContent>
              </Card>

              {/* Your Draft */}
              <Card className="rounded-xl border-2 border-accent/30">
                <CardContent className="p-4">
                  <h3 className="font-heading text-sm font-bold mb-3 flex items-center gap-2"><Zap className="h-4 w-4 text-accent" />Your Draft</h3>
                  <p className="text-xs text-muted-foreground mb-3">{crewPicks.size}/{maxPicks} picks selected</p>
                  {draftPicksList.length > 0 ? (
                    <div className="space-y-2 mb-4">
                      {draftPicksList.map((pick) => (
                        <div key={pick.crewId} className="flex items-center justify-between text-sm">
                          <div className="flex items-center gap-2 min-w-0">
                            <Check className="h-3.5 w-3.5 text-accent flex-shrink-0" />
                            <span className="truncate font-medium">{pick.crewName}</span>
                          </div>
                          {pick.margin > 0 && <span className="text-xs text-accent font-semibold flex-shrink-0">+{pick.margin.toFixed(1)}s</span>}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground mb-4">Select crews from the events on the left.</p>
                  )}

                  <Button
                    variant="hero"
                    className="w-full rounded-xl font-semibold"
                    disabled={!isContestOpen || crewPicks.size < minPicks || !allMarginsValid || submitting}
                    onClick={handleSubmitEntry}
                  >
                    {submitting ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Entering...</> : `Enter Contest — ${formatCents(contestPool.entry_fee_cents)}`}
                  </Button>

                  {walletBalanceCents !== null && (
                    <div className={`flex items-center gap-1.5 mt-3 text-xs ${walletBalanceCents < contestPool.entry_fee_cents ? "text-destructive" : "text-muted-foreground"}`}>
                      <Wallet className="h-3.5 w-3.5" />
                      Balance: {formatCents(walletBalanceCents)}
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          </div>
        </div>
      </main>

      {/* Mobile sticky footer */}
      <div className="lg:hidden fixed bottom-0 left-0 right-0 z-50 border-t bg-card/95 backdrop-blur-sm p-4 shadow-lg">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-medium">{crewPicks.size} pick{crewPicks.size !== 1 ? "s" : ""} selected</span>
          {walletBalanceCents !== null && (
            <span className={`text-xs ${walletBalanceCents < contestPool.entry_fee_cents ? "text-destructive" : "text-muted-foreground"}`}>
              Balance: {formatCents(walletBalanceCents)}
            </span>
          )}
        </div>
        <Button
          variant="hero"
          className="w-full rounded-xl font-semibold"
          disabled={!isContestOpen || crewPicks.size < minPicks || !allMarginsValid || submitting}
          onClick={handleSubmitEntry}
        >
          {submitting ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Entering...</> : `Enter Contest — ${formatCents(contestPool.entry_fee_cents)}`}
        </Button>
      </div>

      <Footer />
    </div>
  );
};

export default RegattaDetail;
