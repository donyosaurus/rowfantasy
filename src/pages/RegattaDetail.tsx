import { useParams, Link, useNavigate } from "react-router-dom";
import { CrewLogo } from "@/components/CrewLogo";
import { DraftPicksList } from "@/components/DraftPicksList";
import { CrewCard } from "@/components/CrewCard";
import { DraftPageBackground } from "@/components/DraftPageBackground";
import { useEffect, useState, useMemo } from "react";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Loader2,
  Trophy,
  Zap,
  ChevronDown,
  Lock,
  Wallet,
} from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { formatCents } from "@/lib/formatCurrency";
import { TierSelector, type EntryTier } from "@/components/TierSelector";
import { ContestBannerHeader } from "@/components/ContestBannerHeader";

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
  allow_overflow?: boolean;
  entry_tiers: EntryTier[] | null;
  contest_templates: {
    id: string;
    regatta_name: string;
    gender_category: string;
    min_picks: number;
    max_picks: number;
    card_banner_url?: string | null;
    draft_banner_url?: string | null;
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

const TIER_ACCENT: Record<string, string> = {
  Bronze: "border-l-amber-600 bg-amber-500/5",
  Silver: "border-l-slate-400 bg-slate-300/5",
  Gold: "border-l-yellow-500 bg-yellow-400/5",
};

const RegattaDetail = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();

  const [contestPool, setContestPool] = useState<ContestPool | null>(null);
  const [allTemplatePools, setAllTemplatePools] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [crewPicks, setCrewPicks] = useState<Map<string, number>>(new Map());
  const [submitting, setSubmitting] = useState(false);
  const [scoringOpen, setScoringOpen] = useState(false);
  const [prizePoolOpen, setPrizePoolOpen] = useState(false);
  const [walletBalanceCents, setWalletBalanceCents] = useState<number | null>(null);
  const [selectedTier, setSelectedTier] = useState<EntryTier | null>(null);

  useEffect(() => {
    if (!authLoading && !user) navigate("/login");
  }, [user, authLoading, navigate]);

  useEffect(() => {
    if (!id) { setError("No contest ID provided"); setLoading(false); return; }
    const fetchPoolData = async () => {
      const { data, error: fetchError } = await supabase
        .from("contest_pools")
        .select(`*, payout_structure, contest_template_id, tier_id, allow_overflow, contest_templates (id, regatta_name, gender_category, min_picks, max_picks, card_banner_url, draft_banner_url), contest_pool_crews (id, crew_id, crew_name, event_id, logo_url)`)
        .eq("id", id)
        .single();
      if (fetchError || !data) { setError("Contest not found"); setLoading(false); return; }

      const pool = data as unknown as ContestPool;

      // Fetch ALL pools for this template to detect tiers
      const { data: allPools } = await supabase
        .from("contest_pools")
        .select("id, tier_name, entry_fee_cents, payout_structure, current_entries, max_entries, status, allow_overflow")
        .eq("contest_template_id", pool.contest_template_id)
        .order("entry_fee_cents", { ascending: true });

      setAllTemplatePools(allPools || []);

      const tierPools = (allPools || []).filter((p: any) => p.tier_name);
      if (tierPools.length > 1) {
        const tiers: EntryTier[] = [];
        const seenTiers = new Set<string>();
        for (const tp of tierPools) {
          if (seenTiers.has(tp.tier_name)) continue;
          seenTiers.add(tp.tier_name);
          tiers.push({
            name: tp.tier_name,
            entry_fee_cents: tp.entry_fee_cents,
            payout_structure: (tp.payout_structure as Record<string, number>) || {},
          });
        }
        tiers.sort((a, b) => a.entry_fee_cents - b.entry_fee_cents);
        (pool as any).entry_tiers = tiers;
      }

      setContestPool(pool);
      setLoading(false);
    };
    fetchPoolData();
  }, [id]);

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
    const clickedCrew = contestPool?.contest_pool_crews.find((c) => c.crew_id === crewId);
    if (!clickedCrew) return;

    setCrewPicks((prev) => {
      const newPicks = new Map(prev);
      if (newPicks.has(crewId)) {
        newPicks.delete(crewId);
        return newPicks;
      }
      const existingFromSameEvent = contestPool?.contest_pool_crews.find(
        (c) => c.event_id === clickedCrew.event_id && newPicks.has(c.crew_id)
      );
      if (existingFromSameEvent) {
        const oldMargin = newPicks.get(existingFromSameEvent.crew_id) ?? 0;
        newPicks.delete(existingFromSameEvent.crew_id);
        newPicks.set(crewId, oldMargin);
        return newPicks;
      }
      if (newPicks.size >= maxPicks) { toast.error(`Maximum ${maxPicks} picks allowed`); return prev; }
      newPicks.set(crewId, 0);
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
  const numDivisions = divisions.length;
  const minPicks = Math.min(contestPool?.contest_templates?.min_picks ?? 2, numDivisions);
  const maxPicks = Math.min(contestPool?.contest_templates?.max_picks ?? 10, numDivisions);

  const formattedLockTime = contestPool?.lock_time
    ? new Date(contestPool.lock_time).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    : "";

  const allMarginsValid = useMemo(() => {
    for (const [, margin] of crewPicks) {
      if (margin === undefined || margin <= 0) return false;
    }
    return true;
  }, [crewPicks]);

  const entryTiers = contestPool?.entry_tiers as EntryTier[] | null;
  const hasTiers = !!(entryTiers && entryTiers.length > 1);
  const activeEntryFee = hasTiers && selectedTier ? selectedTier.entry_fee_cents : contestPool?.entry_fee_cents ?? 0;

  const payoutRows = useMemo(() => {
    if (!contestPool?.payout_structure) return [];
    return Object.entries(contestPool.payout_structure)
      .map(([rank, cents]) => ({ rank: Number(rank), cents }))
      .sort((a, b) => a.rank - b.rank);
  }, [contestPool]);

  // Header stats — tiered-aware
  const headerStats = useMemo(() => {
    if (!contestPool) return { firstPrize: 0, entryFeeLabel: "", entriesLabel: "", isTiered: false };
    if (hasTiers && entryTiers) {
      const highestPrize = Math.max(...entryTiers.map(t => {
        const ps = t.payout_structure || {};
        return (ps as any)['1'] || 0;
      }));
      const lowestFee = Math.min(...entryTiers.map(t => t.entry_fee_cents));
      const perTierMax = allTemplatePools[0]?.max_entries || contestPool.max_entries;
      const hasOverflow = allTemplatePools.some((p: any) => p.allow_overflow);
      const contestType = perTierMax === 2 ? 'Head to Head' : `${perTierMax} Player Pool`;
      return {
        firstPrize: highestPrize,
        firstPrizePrefix: "Up to ",
        entryFeeLabel: `From ${formatCents(lowestFee)}`,
        entriesLabel: hasOverflow ? contestType : `${contestPool.current_entries}/${contestPool.max_entries}`,
        entriesSublabel: hasOverflow ? "Type" : "Entries",
        isTiered: true,
      };
    }
    const firstPrize = payoutRows.length > 0 ? payoutRows[0].cents : contestPool.prize_pool_cents ?? 0;
    return {
      firstPrize,
      firstPrizePrefix: "",
      entryFeeLabel: formatCents(contestPool.entry_fee_cents),
      entriesLabel: `${contestPool.current_entries}/${contestPool.max_entries}`,
      entriesSublabel: "Entries",
      isTiered: false,
    };
  }, [contestPool, hasTiers, entryTiers, payoutRows, allTemplatePools]);

  const totalPrize = payoutRows.length > 0
    ? payoutRows.reduce((sum, r) => sum + r.cents, 0)
    : contestPool?.prize_pool_cents ?? 0;
  const fillPercent = contestPool ? Math.min(100, (contestPool.current_entries / contestPool.max_entries) * 100) : 0;

  const draftPicksList = useMemo(() => {
    return Array.from(crewPicks.entries()).map(([crewId, margin]) => {
      const crew = contestPool?.contest_pool_crews.find((c) => c.crew_id === crewId);
      return { crewId, crewName: crew?.crew_name ?? crewId, eventId: crew?.event_id ?? "", margin, logoUrl: crew?.logo_url };
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
    if (hasTiers && !selectedTier) { toast.error("Please select an entry tier"); return; }
    if (walletBalanceCents !== null && walletBalanceCents < activeEntryFee) {
      toast.error(`Insufficient balance. You need ${formatCents(activeEntryFee)} but have ${formatCents(walletBalanceCents)}.`);
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
          entryFeeCents: activeEntryFee,
          tierName: selectedTier?.name ?? null,
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

  if (authLoading || loading) {
    return (
      <div className="flex flex-col min-h-screen bg-background">
        <Header />
        <main className="flex-1 flex items-center justify-center">
          <Loader2 className="h-12 w-12 animate-spin text-accent" />
        </main>
      </div>
    );
  }

  if (error || !contestPool) {
    return (
      <div className="flex flex-col min-h-screen bg-background">
        <Header />
        <main className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <h2 className="text-2xl font-bold mb-2 text-white">Contest Not Found</h2>
            <p className="text-white/60 mb-4">{error}</p>
            <Link to="/lobby"><Button>Back to Lobby</Button></Link>
          </div>
        </main>
      </div>
    );
  }

  const statusLabel = isContestOpen ? "Open" : contestPool.status.charAt(0).toUpperCase() + contestPool.status.slice(1);

  return (
    <div className="flex flex-col min-h-screen relative">
      <DraftPageBackground />
      <div className="relative z-10 flex flex-col min-h-screen">
      <Header />
      {/* ── Banner Image Header ── */}
      <ContestBannerHeader
        regattaName={contestPool.contest_templates.regatta_name}
        genderCategory={contestPool.contest_templates.gender_category}
        lockTime={contestPool.lock_time}
        status={contestPool.status}
        bannerUrl={contestPool.contest_templates.draft_banner_url || contestPool.contest_templates.card_banner_url}
        maxEntries={contestPool.max_entries}
        entryFeeCents={contestPool.entry_fee_cents}
        entryTiers={entryTiers}
        allowOverflow={contestPool.allow_overflow}
      />

      {/* ── Main Content ── */}
      <main className="flex-1 pb-32 lg:pb-12">
        <div className="container mx-auto px-4 max-w-6xl py-6 lg:py-8">
          {!isContestOpen && (
            <div className="mb-6 px-6 py-3 rounded-xl border border-red-500/30 bg-red-500/10 text-center">
              <p className="text-red-400 font-medium text-sm flex items-center justify-center gap-2">
                <Lock className="h-4 w-4 text-red-400" />
                This contest is no longer accepting entries.
              </p>
            </div>
          )}

          <div className="flex flex-col lg:flex-row gap-6 lg:gap-8">
            {/* ── LEFT: Crew Selection ── */}
            <div className="flex-1 min-w-0 space-y-5">
               <div>
                <h2 className="font-heading text-xl lg:text-2xl font-bold mb-1 text-white">Select Your Crews</h2>
                <p className="text-sm text-slate-400">
                  Draft a crew from each event. Your entry will be matched against other players.
                </p>
              </div>

              {divisions.length === 0 ? (
                <Card className="bg-card border-border"><CardContent className="py-8 text-center text-muted-foreground">No crews available.</CardContent></Card>
              ) : (
                divisions.map((divisionId) => (
                  <div key={divisionId}>
                    <div className="flex items-center gap-2 mb-3">
                      <div className="flex items-center gap-2 rounded-full bg-white/10 text-white/80 px-3 py-1 border border-white/10">
                        <span className="font-semibold text-xs">{divisionId}</span>
                        <span className="opacity-60 text-xs">· {crewsByDivision[divisionId].length} crews</span>
                      </div>
                    </div>
                    <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                      {crewsByDivision[divisionId].map((crew, idx) => (
                        <CrewCard
                          key={crew.id}
                          crewId={crew.crew_id}
                          crewName={crew.crew_name}
                          eventId={divisionId}
                          logoUrl={crew.logo_url}
                          isSelected={crewPicks.has(crew.crew_id)}
                          marginVal={crewPicks.get(crew.crew_id) ?? 0}
                          isOpen={!!isContestOpen}
                          onToggle={toggleCrewSelection}
                          onMarginChange={updateCrewMargin}
                          animDelay={idx * 50}
                        />
                      ))}
                    </div>
                  </div>
                ))
              )}
            </div>

            {/* ── RIGHT: Sticky Sidebar ── */}
            <div className="w-full lg:w-[340px] lg:sticky lg:top-4 lg:self-start space-y-4">
              {/* 1. Your Draft — always first */}
              <Card className="rounded-xl bg-white/95 backdrop-blur-sm shadow-xl border border-white/20 border-t-2 border-t-accent">
                <CardContent className="p-4">
                  <h3 className="font-heading text-sm font-bold mb-3 flex items-center gap-2 text-slate-900"><Zap className="h-4 w-4 text-accent" />Your Draft</h3>

                  {/* Tier Selection */}
                  {hasTiers && (
                    <TierSelector
                      tiers={entryTiers!}
                      selectedTier={selectedTier}
                      onSelectTier={setSelectedTier}
                      walletBalanceCents={walletBalanceCents}
                    />
                  )}

                  <DraftPicksList
                    picks={draftPicksList}
                    events={divisions}
                    maxPicks={maxPicks}
                    onRemove={toggleCrewSelection}
                  />

                  <div className="mt-4">
                    <Button
                      variant="hero"
                      className="w-full rounded-xl font-semibold"
                      disabled={!isContestOpen || crewPicks.size < minPicks || !allMarginsValid || (hasTiers && !selectedTier) || submitting}
                      onClick={handleSubmitEntry}
                    >
                      {submitting ? (
                        <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Entering...</>
                      ) : hasTiers && !selectedTier ? (
                        "Select a Tier"
                      ) : (
                        `Enter Contest — ${formatCents(activeEntryFee)}`
                      )}
                    </Button>

                    {walletBalanceCents !== null && (
                      <div className={`flex items-center gap-1.5 mt-3 text-xs ${walletBalanceCents < activeEntryFee ? "text-destructive" : "text-muted-foreground"}`}>
                        <Wallet className="h-3.5 w-3.5" />
                        Balance: {formatCents(walletBalanceCents)}
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>

              {/* 2. Prize Pool — Collapsible */}
              <Collapsible open={prizePoolOpen} onOpenChange={setPrizePoolOpen}>
                <Card className="rounded-xl bg-white/95 backdrop-blur-sm shadow-xl border border-white/20">
                  <CardContent className="p-4">
                    <CollapsibleTrigger className="flex items-center justify-between w-full">
                      <h3 className="font-heading text-sm font-bold flex items-center gap-2">
                        <Trophy className="h-4 w-4 text-gold" />Prize Pool
                      </h3>
                      <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform ${prizePoolOpen ? "rotate-180" : ""}`} />
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <div className="mt-3">
                        {hasTiers && entryTiers ? (
                          <div className="space-y-3">
                            {entryTiers.map((tier) => {
                              const tierPayoutRows = Object.entries(tier.payout_structure)
                                .map(([rank, cents]) => ({ rank: Number(rank), cents }))
                                .sort((a, b) => a.rank - b.rank);
                              const accentClass = TIER_ACCENT[tier.name] || "border-l-accent bg-accent/5";
                              return (
                                <div key={tier.name} className={`border-l-4 rounded-r-lg pl-3 py-2 ${accentClass}`}>
                                  <p className="text-xs font-semibold text-foreground mb-1">{tier.name} <span className="text-muted-foreground font-normal">({formatCents(tier.entry_fee_cents)} entry)</span></p>
                                  <div className="space-y-0.5">
                                    {tierPayoutRows.map((row) => (
                                      <div key={row.rank} className="flex justify-between text-sm">
                                        <span className={row.rank === 1 ? "font-semibold text-gold" : "text-muted-foreground"}>{ordinal(row.rank)}</span>
                                        <span className={row.rank === 1 ? "font-bold text-gold" : "font-medium"}>{formatCents(row.cents)}</span>
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        ) : payoutRows.length > 0 ? (
                          <div className="space-y-1.5">
                            {payoutRows.map(({ rank, cents }) => (
                              <div key={rank} className="flex justify-between text-sm">
                                <span className={rank === 1 ? "font-semibold text-gold" : "text-muted-foreground"}>{ordinal(rank)}</span>
                                <span className={rank === 1 ? "font-bold text-gold" : "font-medium"}>{formatCents(cents)}</span>
                              </div>
                            ))}
                            <div className="flex justify-between text-sm border-t pt-1.5 mt-1.5"><span className="font-medium">Total</span><span className="font-bold">{formatCents(totalPrize)}</span></div>
                          </div>
                        ) : (
                          <p className="text-xs text-muted-foreground">No prize details available.</p>
                        )}
                      </div>
                    </CollapsibleContent>
                  </CardContent>
                </Card>
              </Collapsible>

              {/* 3. Scoring (Collapsible) */}
              <Collapsible open={scoringOpen} onOpenChange={setScoringOpen}>
                <Card className="rounded-xl bg-white/95 backdrop-blur-sm shadow-xl border border-white/20">
                  <CardContent className="p-4">
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
                  </CardContent>
                </Card>
              </Collapsible>
            </div>
          </div>
        </div>
      </main>

      {/* Mobile sticky footer */}
      {isContestOpen && (
        <div className="lg:hidden fixed bottom-0 left-0 right-0 z-50 border-t bg-card/95 backdrop-blur-sm p-4 shadow-lg">
          {hasTiers && (
            <div className="flex gap-2 mb-2 overflow-x-auto">
              {entryTiers!.map((tier) => {
                const isSelected = selectedTier?.name === tier.name;
                const dollars = tier.entry_fee_cents / 100;
                const displayFee = Number.isInteger(dollars) ? `$${dollars}` : `$${dollars.toFixed(2)}`;
                const insufficientBalance = walletBalanceCents !== null && walletBalanceCents < tier.entry_fee_cents;
                return (
                  <button
                    key={tier.name}
                    disabled={insufficientBalance}
                    onClick={() => !insufficientBalance && setSelectedTier(tier)}
                    className={`flex-1 min-w-0 rounded-lg py-2 text-center transition-all border-2 font-bold ${
                      insufficientBalance ? "opacity-40 cursor-not-allowed border-border bg-secondary text-muted-foreground"
                      : isSelected ? "border-accent bg-accent text-accent-foreground"
                      : "border-border bg-secondary cursor-pointer text-foreground"
                    }`}
                  >
                    {displayFee}
                  </button>
                );
              })}
            </div>
          )}
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium">{crewPicks.size} pick{crewPicks.size !== 1 ? "s" : ""} selected</span>
            {walletBalanceCents !== null && (
              <span className={`text-xs ${walletBalanceCents < activeEntryFee ? "text-destructive" : "text-muted-foreground"}`}>
                Balance: {formatCents(walletBalanceCents)}
              </span>
            )}
          </div>
          <Button
            variant="hero"
            className="w-full rounded-xl font-semibold"
            disabled={!isContestOpen || crewPicks.size < minPicks || !allMarginsValid || (hasTiers && !selectedTier) || submitting}
            onClick={handleSubmitEntry}
          >
            {submitting ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Entering...</> : hasTiers && !selectedTier ? "Select a Tier" : `Enter Contest — ${formatCents(activeEntryFee)}`}
          </Button>
        </div>
      )}

      <Footer />
      </div>
    </div>
  );
};

export default RegattaDetail;
