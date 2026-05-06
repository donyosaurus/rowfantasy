// All money values must route through src/lib/formatCurrency.ts. Direct division by 100 in JSX is a bug.
import { useState, useEffect, useMemo } from "react";
import { useWalletBalance } from "@/hooks/useWalletBalance";
import { useParams, Link, useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { DraftPageBackground } from "@/components/DraftPageBackground";
import { supabase } from "@/integrations/supabase/client";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { CrewCard } from "@/components/CrewCard";
import { CrewLogo } from "@/components/CrewLogo";
import { DraftPicksList } from "@/components/DraftPicksList";
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
  prize_pool_cents: number;
  payout_structure: Record<string, number> | null;
  current_entries: number;
  max_entries: number;
  contest_template_id: string;
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
  1: 100, 2: 75, 3: 60, 4: 45, 5: 30, 6: 15, 7: 10,
};
const DEFAULT_POINTS = 0;

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function groupContiguousEqualPayouts(rows: Array<{ rank: number; cents: number }>) {
  if (rows.length === 0) return [] as Array<{ fromRank: number; toRank: number; cents: number }>;
  const sorted = [...rows].sort((a, b) => a.rank - b.rank);
  const groups: Array<{ fromRank: number; toRank: number; cents: number }> = [];
  let cur = { fromRank: sorted[0].rank, toRank: sorted[0].rank, cents: sorted[0].cents };
  for (let i = 1; i < sorted.length; i++) {
    const row = sorted[i];
    if (row.cents === cur.cents && row.rank === cur.toRank + 1) cur.toRank = row.rank;
    else { groups.push(cur); cur = { fromRank: row.rank, toRank: row.rank, cents: row.cents }; }
  }
  groups.push(cur);
  return groups;
}

const TIER_ACCENT: Record<string, string> = {
  Bronze: "border-l-amber-600 bg-amber-500/5",
  Silver: "border-l-slate-400 bg-slate-300/5",
  Gold: "border-l-yellow-500 bg-yellow-400/5",
};

const ContestDetail = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();

  const [contestPool, setContestPool] = useState<ContestPool | null>(null);
  const [allTemplatePools, setAllTemplatePools] = useState<any[]>([]);
  const [poolLoading, setPoolLoading] = useState(true);
  const [poolError, setPoolError] = useState<string | null>(null);
  // Wave 1 #6: balance now flows through fail-closed centralized RPC.
  // walletBalanceCents stays nullable so existing render logic (which hides the
  // balance row + skips the insufficient-funds compare on null) continues to
  // behave correctly on loading/error — never silently rendering "$0.00".
  const wallet = useWalletBalance();
  const walletBalanceCents: number | null = wallet.status === 'ready' ? wallet.availableCents : null;
  const [crewPicks, setCrewPicks] = useState<Map<string, number>>(new Map());
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [scoringOpen, setScoringOpen] = useState(false);
  const [prizePoolOpen, setPrizePoolOpen] = useState(false);
  const [selectedTier, setSelectedTier] = useState<EntryTier | null>(null);

  useEffect(() => {
    if (!authLoading && !user) navigate("/login");
  }, [user, authLoading, navigate]);

  useEffect(() => {
    if (!id) return;
    const fetchPool = async () => {
      setPoolLoading(true);
      const { data, error } = await supabase
        .from("contest_pools")
        .select(`
          id, lock_time, status, entry_fee_cents, prize_pool_cents, payout_structure,
          current_entries, max_entries, contest_template_id, tier_name, allow_overflow,
          contest_templates (id, regatta_name, gender_category, min_picks, max_picks, card_banner_url, draft_banner_url),
          contest_pool_crews (id, crew_id, crew_name, event_id, logo_url)
        `)
        .eq("id", id)
        .single();
      if (error || !data) {
        setPoolError("Contest not found.");
      } else {
        const pool = data as unknown as ContestPool;
        // Fetch ALL pools for this template to find all tiers
        const { data: allPools } = await supabase
          .from("contest_pools")
          .select("id, tier_name, entry_fee_cents, payout_structure, current_entries, max_entries, status, allow_overflow")
          .eq("contest_template_id", pool.contest_template_id)
          .order("entry_fee_cents", { ascending: true });

        setAllTemplatePools(allPools || []);

        const tierPools = (allPools || []).filter((p: any) => p.tier_name);
        if (tierPools.length > 1) {
          // Build entry_tiers from the separate tier pools
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
      }
      setPoolLoading(false);
    };
    fetchPool();
  }, [id]);

  // (Wave 1 #6) Direct .from('wallets') read removed — useWalletBalance hook
  // above handles the load through get_user_wallet_balances() RPC.

  const crewsByEvent = useMemo(() => {
    if (!contestPool) return {} as Record<string, PoolCrew[]>;
    return contestPool.contest_pool_crews.reduce((acc, crew) => {
      if (!acc[crew.event_id]) acc[crew.event_id] = [];
      acc[crew.event_id].push(crew);
      return acc;
    }, {} as Record<string, PoolCrew[]>);
  }, [contestPool]);

  const events = Object.keys(crewsByEvent);
  const numEvents = events.length;
  const minPicks = Math.min(contestPool?.contest_templates?.min_picks ?? 2, numEvents);
  const maxPicks = Math.min(contestPool?.contest_templates?.max_picks ?? 4, numEvents);
  const isOpen = contestPool?.status === "open" && new Date(contestPool.lock_time) > new Date();
  const isFull = !!contestPool && contestPool.current_entries >= contestPool.max_entries && !contestPool.allow_overflow;

  const entryTiers = contestPool?.entry_tiers as EntryTier[] | null;
  const hasTiers = !!(entryTiers && entryTiers.length > 1);
  const activeEntryFee = hasTiers && selectedTier ? selectedTier.entry_fee_cents : contestPool?.entry_fee_cents ?? 0;

  const payoutRows = useMemo(() => {
    if (!contestPool?.payout_structure) return [];
    return Object.entries(contestPool.payout_structure)
      .map(([rank, cents]) => ({ rank: Number(rank), cents }))
      .sort((a, b) => a.rank - b.rank);
  }, [contestPool]);

  const groupedPayoutRows = useMemo(() => groupContiguousEqualPayouts(payoutRows), [payoutRows]);

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

  const formattedLockTime = contestPool?.lock_time
    ? new Date(contestPool.lock_time).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    : "";

  const allMarginsValid = useMemo(() => {
    for (const [, margin] of crewPicks) {
      if (margin === undefined || margin <= 0) return false;
    }
    return true;
  }, [crewPicks]);

  const draftPicksList = useMemo(() => {
    return Array.from(crewPicks.entries()).map(([crewId, margin]) => {
      const crew = contestPool?.contest_pool_crews.find((c) => c.crew_id === crewId);
      return { crewId, crewName: crew?.crew_name ?? crewId, eventId: crew?.event_id ?? "", margin, logoUrl: crew?.logo_url };
    });
  }, [crewPicks, contestPool]);

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

  const handleSubmit = async () => {
    if (!contestPool || !user) return;
    if (isFull) {
      toast.error("This contest is full.");
      return;
    }
    if (crewPicks.size < minPicks) { toast.error(`Select at least ${minPicks} crews from different events.`); return; }
    const uniqueEvents = new Set(draftPicksList.map((p) => p.eventId));
    if (uniqueEvents.size < 2) { toast.error("Pick crews from at least 2 different events."); return; }
    for (const [crewId, margin] of crewPicks) {
      if (margin <= 0) {
        const crew = contestPool.contest_pool_crews.find((c) => c.crew_id === crewId);
        toast.error(`Enter a valid margin for ${crew?.crew_name || crewId}`);
        return;
      }
    }
    if (hasTiers && !selectedTier) { toast.error("Please select an entry tier"); return; }
    if (walletBalanceCents !== null && walletBalanceCents < activeEntryFee) {
      toast.error(`Insufficient balance. Need ${formatCents(activeEntryFee)}, have ${formatCents(walletBalanceCents)}.`);
      return;
    }

    setIsSubmitting(true);
    const picks = draftPicksList.map((p) => ({
      crewId: p.crewId,
      event_id: p.eventId,
      predictedMargin: p.margin,
    }));

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
      if (!data?.entryId) { toast.error(data?.error || "Failed to submit entry."); return; }

      toast.success("Entry submitted! You're in the contest.");
      // (Wave 1 #6) Refresh balance via centralized fail-closed RPC.
      await wallet.refetch();
      setTimeout(() => navigate("/my-entries"), 1500);
    } catch (err: any) {
      toast.error(err.message || "An unexpected error occurred.");
    } finally {
      setIsSubmitting(false);
    }
  };

  if (authLoading || poolLoading) {
    return (
      <div className="flex flex-col min-h-screen bg-background">
        <Header />
        <main className="flex-1 flex items-center justify-center">
          <Loader2 className="h-12 w-12 animate-spin text-accent" />
        </main>
      </div>
    );
  }

  if (poolError || !contestPool) {
    return (
      <div className="flex flex-col min-h-screen bg-background">
        <Header />
        <main className="flex-1 flex flex-col items-center justify-center gap-4">
          <p className="text-xl text-white/60">{poolError || "Contest not found."}</p>
          <Button variant="outline" onClick={() => navigate("/lobby")}>Back to Lobby</Button>
        </main>
      </div>
    );
  }

  const template = contestPool.contest_templates;
  const statusLabel = isOpen ? "Open" : contestPool.status.charAt(0).toUpperCase() + contestPool.status.slice(1);

  return (
    <div className="flex flex-col min-h-screen relative">
      <DraftPageBackground />
      <div className="relative z-10 flex flex-col min-h-screen">
      <Header />

      {/* ── Banner Image Header ── */}
      <ContestBannerHeader
        regattaName={template.regatta_name}
        genderCategory={template.gender_category}
        lockTime={contestPool.lock_time}
        status={contestPool.status}
        bannerUrl={template.draft_banner_url || template.card_banner_url}
        maxEntries={contestPool.max_entries}
        entryFeeCents={contestPool.entry_fee_cents}
        entryTiers={entryTiers}
        allowOverflow={contestPool.allow_overflow}
      />

      {/* ── Main Content ── */}
      <main className="flex-1 pb-32 lg:pb-12">
        <div className="container mx-auto px-4 max-w-6xl py-6 lg:py-8">
          {!isOpen && (
            <div className="mb-6 px-6 py-3 rounded-xl border border-red-500/30 bg-red-500/10 text-center">
              <p className="text-red-400 font-medium text-sm flex items-center justify-center gap-2">
                <Lock className="h-4 w-4 text-red-400" />
                Contest is {contestPool.status} — entries are closed.
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

              {events.length === 0 ? (
                <Card className="bg-card border-border"><CardContent className="py-8 text-center text-muted-foreground">No crews available.</CardContent></Card>
              ) : (
                events.map((eventId) => (
                  <div key={eventId}>
                    <div className="flex items-center gap-2 mb-3">
                      <div className="flex items-center gap-2 rounded-full bg-white/10 text-white/80 px-3 py-1 border border-white/10">
                        <span className="font-semibold text-xs">{eventId}</span>
                        <span className="opacity-60 text-xs">· {crewsByEvent[eventId].length} crews</span>
                      </div>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      {crewsByEvent[eventId].map((crew, idx) => (
                        <CrewCard
                          key={crew.id}
                          crewId={crew.crew_id}
                          crewName={crew.crew_name}
                          eventId={eventId}
                          logoUrl={crew.logo_url}
                          isSelected={crewPicks.has(crew.crew_id)}
                          marginVal={crewPicks.get(crew.crew_id) ?? 0}
                          isOpen={!!isOpen}
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

            {/* ── RIGHT: Sidebar ── */}
            <div className="w-full lg:w-[340px] xl:w-[380px] flex-shrink-0 space-y-4 lg:sticky lg:top-4 lg:self-start">
              {/* 1. Your Draft — always first */}
              <Card className="rounded-xl bg-white/95 backdrop-blur-sm shadow-xl border border-white/20 border-t-2 border-t-accent">
                <CardContent className="p-4">
                  <h3 className="font-heading text-sm font-bold flex items-center gap-2 mb-3 text-slate-900">
                    <Zap className="h-4 w-4 text-accent" />Your Draft
                  </h3>

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
                    events={events}
                    maxPicks={maxPicks}
                    onRemove={toggleCrewSelection}
                  />

                  <div className="mt-4">
                    {isOpen && (
                      isFull ? (
                        <Button
                          variant="outline"
                          size="lg"
                          className="w-full font-semibold"
                          disabled
                        >
                          Contest Full
                        </Button>
                      ) : (
                        <Button
                          onClick={handleSubmit}
                          variant="hero"
                          size="lg"
                          className="w-full font-semibold"
                          disabled={isSubmitting || crewPicks.size < minPicks || !allMarginsValid || (hasTiers && !selectedTier)}
                        >
                          {isSubmitting ? (
                            <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Processing…</>
                          ) : hasTiers && !selectedTier ? (
                            "Select a Tier"
                          ) : (
                            <>Enter Contest — {formatCents(activeEntryFee)}</>
                          )}
                        </Button>
                      )
                    )}

                    {walletBalanceCents !== null && (
                      <div className={`flex items-center justify-center gap-1.5 mt-3 text-xs ${
                        walletBalanceCents < activeEntryFee ? "text-destructive" : "text-muted-foreground"
                      }`}>
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
                              const tierGrouped = groupContiguousEqualPayouts(tierPayoutRows);
                              const accentClass = TIER_ACCENT[tier.name] || "border-l-accent bg-accent/5";
                              return (
                                <div key={tier.name} className={`border-l-4 rounded-r-lg pl-3 py-2 ${accentClass}`}>
                                  <p className="text-xs font-semibold text-foreground mb-1">
                                    {tier.name} <span className="text-muted-foreground font-normal">({formatCents(tier.entry_fee_cents)} entry)</span>
                                  </p>
                                  <div className="space-y-0.5">
                                    {tierGrouped.map((g) => {
                                       const isRange = g.fromRank !== g.toRank;
                                       const label = isRange ? `${ordinal(g.fromRank)}–${ordinal(g.toRank)}` : ordinal(g.fromRank);
                                       const isSingle = !isRange;
                                       const medal = isSingle && g.fromRank === 1 ? "🥇"
                                                   : isSingle && g.fromRank === 2 ? "🥈"
                                                   : isSingle && g.fromRank === 3 ? "🥉" : null;
                                       return (
                                         <div key={g.fromRank} className="flex justify-between items-center text-sm">
                                           <span className={`flex items-center gap-2 ${g.fromRank === 1 ? "font-semibold text-gold" : "text-muted-foreground"}`}>
                                             {medal && <span className="text-base leading-none">{medal}</span>}
                                             <span>{label}</span>
                                           </span>
                                           <span className={g.fromRank === 1 ? "font-bold text-gold" : "font-medium"}>
                                             {formatCents(g.cents)}{isRange ? " each" : ""}
                                           </span>
                                         </div>
                                       );
                                     })}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        ) : groupedPayoutRows.length > 0 ? (
                          <div className="space-y-1.5">
                            {groupedPayoutRows.map((g) => {
                              const isRange = g.fromRank !== g.toRank;
                              const label = isRange ? `${ordinal(g.fromRank)}–${ordinal(g.toRank)}` : ordinal(g.fromRank);
                              const isSingle = !isRange;
                              const medal = isSingle && g.fromRank === 1 ? "🥇"
                                          : isSingle && g.fromRank === 2 ? "🥈"
                                          : isSingle && g.fromRank === 3 ? "🥉" : null;
                              return (
                                <div key={g.fromRank} className="flex justify-between items-center text-sm">
                                  <span className={`flex items-center gap-2 ${g.fromRank === 1 ? "font-semibold text-gold" : "text-muted-foreground"}`}>
                                    {medal && <span className="text-base leading-none">{medal}</span>}
                                    <span>{label}</span>
                                  </span>
                                  <span className={g.fromRank === 1 ? "font-bold text-gold" : "font-medium"}>
                                    {formatCents(g.cents)}{isRange ? " each" : ""}
                                  </span>
                                </div>
                              );
                            })}
                            <div className="flex items-center justify-between mt-2 pt-2 border-t text-xs text-muted-foreground">
                              <span>Total</span>
                              <span className="font-semibold text-foreground">{formatCents(totalPrize)}</span>
                            </div>
                          </div>
                        ) : (
                          <p className="text-xs text-muted-foreground">No prize details available.</p>
                        )}
                      </div>
                    </CollapsibleContent>
                  </CardContent>
                </Card>
              </Collapsible>

              {/* 3. Scoring — Collapsible */}
              <Collapsible open={scoringOpen} onOpenChange={setScoringOpen}>
                <Card className="rounded-xl bg-white/95 backdrop-blur-sm shadow-xl border border-white/20">
                  <CardContent className="p-4">
                    <CollapsibleTrigger className="flex items-center justify-between w-full">
                      <h3 className="font-heading text-sm font-bold">How Scoring Works</h3>
                      <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform ${scoringOpen ? "rotate-180" : ""}`} />
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <div className="grid grid-cols-2 gap-x-4 gap-y-1 mt-3 text-sm">
                        {Object.entries(FINISH_POINTS).map(([pos, pts]) => (
                          <div key={pos} className="flex items-center justify-between py-1">
                            <span className="text-muted-foreground">{ordinal(Number(pos))}:</span>
                            <span className="font-semibold">{pts} pts</span>
                          </div>
                        ))}
                        <div className="flex items-center justify-between py-1">
                          <span className="text-muted-foreground">8th+:</span>
                          <span className="font-semibold">{DEFAULT_POINTS} pts</span>
                        </div>
                      </div>
                      <p className="text-xs text-muted-foreground mt-3 pt-2 border-t">
                        Margin predictions are tiebreakers only — they don't add to your score.
                      </p>
                    </CollapsibleContent>
                  </CardContent>
                </Card>
              </Collapsible>
            </div>
          </div>
        </div>
      </main>

      {/* ── Mobile Sticky Bottom Bar ── */}
      {isOpen && (
        <div className="lg:hidden fixed bottom-0 left-0 right-0 bg-card/95 backdrop-blur-md border-t shadow-lg z-50">
          <div className="container mx-auto px-4 py-3">
            {hasTiers && (
              <div className="flex gap-2 mb-2 overflow-x-auto">
                {entryTiers!.map((tier) => {
                  const isSelected = selectedTier?.name === tier.name;
                  const displayFee = formatCents(tier.entry_fee_cents);
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
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="font-semibold text-sm">
                  {crewPicks.size} pick{crewPicks.size !== 1 ? "s" : ""} selected
                </p>
                <p className="text-xs text-muted-foreground truncate">
                  {isFull
                    ? "This contest is full"
                    : crewPicks.size < minPicks
                      ? `Need ${minPicks - crewPicks.size} more`
                      : !allMarginsValid
                        ? "Enter margins for all crews"
                        : hasTiers && !selectedTier
                          ? "Select an entry tier"
                          : `Entry: ${formatCents(activeEntryFee)}`}
                </p>
              </div>
              {isFull ? (
                <Button size="sm" variant="outline" disabled className="flex-shrink-0">
                  Contest Full
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="hero"
                  onClick={handleSubmit}
                  disabled={isSubmitting || crewPicks.size < minPicks || !allMarginsValid || (hasTiers && !selectedTier)}
                  className="flex-shrink-0"
                >
                  {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : "Enter"}
                </Button>
              )}
            </div>
          </div>
        </div>
      )}

      <Footer />
      </div>
    </div>
  );
};

export default ContestDetail;
