import { useState, useEffect, useMemo } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  ArrowLeft,
  Check,
  Clock,
  Loader2,
  Trophy,
  Users,
  Zap,
  ChevronDown,
  Lock,
  X,
  Wallet,
} from "lucide-react";
import { toast } from "sonner";
import { formatCents } from "@/lib/formatCurrency";
import { CrewLogo } from "@/components/CrewLogo";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
  contest_templates: {
    id: string;
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

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const ContestDetail = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();

  const [contestPool, setContestPool] = useState<ContestPool | null>(null);
  const [poolLoading, setPoolLoading] = useState(true);
  const [poolError, setPoolError] = useState<string | null>(null);
  const [walletBalanceCents, setWalletBalanceCents] = useState<number | null>(null);

  // Draft state — direct click-to-select, Map<crewId, margin>
  const [crewPicks, setCrewPicks] = useState<Map<string, number>>(new Map());
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [scoringOpen, setScoringOpen] = useState(false);

  // Auth guard
  useEffect(() => {
    if (!authLoading && !user) navigate("/login");
  }, [user, authLoading, navigate]);

  // Fetch contest pool
  useEffect(() => {
    if (!id) return;
    const fetchPool = async () => {
      setPoolLoading(true);
      const { data, error } = await supabase
        .from("contest_pools")
        .select(`
          id, lock_time, status, entry_fee_cents, prize_pool_cents, payout_structure,
          current_entries, max_entries, contest_template_id,
          contest_templates (id, regatta_name, gender_category, min_picks, max_picks),
          contest_pool_crews (id, crew_id, crew_name, event_id, logo_url)
        `)
        .eq("id", id)
        .single();
      if (error || !data) {
        setPoolError("Contest not found.");
      } else {
        setContestPool(data as unknown as ContestPool);
      }
      setPoolLoading(false);
    };
    fetchPool();
  }, [id]);

  // Fetch wallet
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

  // Derived state
  const crewsByEvent = useMemo(() => {
    if (!contestPool) return {} as Record<string, PoolCrew[]>;
    return contestPool.contest_pool_crews.reduce((acc, crew) => {
      if (!acc[crew.event_id]) acc[crew.event_id] = [];
      acc[crew.event_id].push(crew);
      return acc;
    }, {} as Record<string, PoolCrew[]>);
  }, [contestPool]);

  const events = Object.keys(crewsByEvent);
  const minPicks = contestPool?.contest_templates?.min_picks ?? 2;
  const maxPicks = contestPool?.contest_templates?.max_picks ?? 4;
  const isOpen = contestPool?.status === "open" && new Date(contestPool.lock_time) > new Date();

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

  // Crew selection
  const toggleCrewSelection = (crewId: string) => {
    setCrewPicks((prev) => {
      const newPicks = new Map(prev);
      if (newPicks.has(crewId)) {
        newPicks.delete(crewId);
      } else {
        if (newPicks.size >= maxPicks) { toast.error(`Maximum ${maxPicks} picks allowed`); return prev; }
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

  // Submit
  const handleSubmit = async () => {
    if (!contestPool || !user) return;

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

    if (walletBalanceCents !== null && walletBalanceCents < contestPool.entry_fee_cents) {
      toast.error(`Insufficient balance. Need ${formatCents(contestPool.entry_fee_cents)}, have ${formatCents(walletBalanceCents)}.`);
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
          entryFeeCents: contestPool.entry_fee_cents,
          stateCode: null,
        },
      });
      if (error) throw error;
      if (!data?.entryId) { toast.error(data?.error || "Failed to submit entry."); return; }

      toast.success("Entry submitted! You're in the contest.");
      const { data: walletData } = await supabase
        .from("wallets")
        .select("available_balance")
        .eq("user_id", user.id)
        .single();
      if (walletData) setWalletBalanceCents(Number(walletData.available_balance));
      setTimeout(() => navigate("/my-entries"), 1500);
    } catch (err: any) {
      const msg = err.message || "An unexpected error occurred.";
      toast.error(msg);
    } finally {
      setIsSubmitting(false);
    }
  };

  // Loading / Error
  if (authLoading || poolLoading) {
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

  if (poolError || !contestPool) {
    return (
      <div className="flex flex-col min-h-screen">
        <Header />
        <main className="flex-1 flex flex-col items-center justify-center gap-4">
          <p className="text-xl text-muted-foreground">{poolError || "Contest not found."}</p>
          <Button variant="outline" onClick={() => navigate("/lobby")}>Back to Lobby</Button>
        </main>
        <Footer />
      </div>
    );
  }

  const template = contestPool.contest_templates;
  const statusLabel = isOpen ? "Open" : contestPool.status.charAt(0).toUpperCase() + contestPool.status.slice(1);

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
              <h1 className="font-heading text-3xl lg:text-4xl font-bold mb-1">{template.regatta_name}</h1>
              <p className="text-primary-foreground/70 text-sm lg:text-base">
                {template.gender_category} Multi-Team Fantasy · Draft a crew from each event
              </p>
            </div>
            <Badge
              className={`flex-shrink-0 text-sm px-3 py-1 font-semibold ${
                isOpen
                  ? "bg-success/20 text-success border-success/30"
                  : "bg-primary-foreground/10 text-primary-foreground/60 border-primary-foreground/20"
              }`}
            >
              {statusLabel}
            </Badge>
          </div>

          {/* Stat cards */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <div className="rounded-xl bg-primary-foreground/10 backdrop-blur-sm border border-primary-foreground/10 p-3 lg:p-4">
              <div className="flex items-center gap-2 mb-1">
                <Trophy className="h-4 w-4 text-gold" />
                <span className="text-xs text-primary-foreground/60 font-medium">1st Prize</span>
              </div>
              <p className="font-heading text-xl lg:text-2xl font-bold text-gold">{formatCents(firstPrize)}</p>
            </div>
            <div className="rounded-xl bg-primary-foreground/10 backdrop-blur-sm border border-primary-foreground/10 p-3 lg:p-4">
              <div className="flex items-center gap-2 mb-1">
                <Zap className="h-4 w-4 text-accent" />
                <span className="text-xs text-primary-foreground/60 font-medium">Entry Fee</span>
              </div>
              <p className="font-heading text-xl lg:text-2xl font-bold">{formatCents(contestPool.entry_fee_cents)}</p>
            </div>
            <div className="rounded-xl bg-primary-foreground/10 backdrop-blur-sm border border-primary-foreground/10 p-3 lg:p-4">
              <div className="flex items-center gap-2 mb-1">
                <Clock className="h-4 w-4 text-primary-foreground/60" />
                <span className="text-xs text-primary-foreground/60 font-medium">Locks</span>
              </div>
              <p className="font-heading text-lg lg:text-xl font-bold">{formattedLockTime}</p>
            </div>
            <div className="rounded-xl bg-primary-foreground/10 backdrop-blur-sm border border-primary-foreground/10 p-3 lg:p-4">
              <div className="flex items-center gap-2 mb-1">
                <Users className="h-4 w-4 text-primary-foreground/60" />
                <span className="text-xs text-primary-foreground/60 font-medium">Entries</span>
              </div>
              <p className="font-heading text-xl lg:text-2xl font-bold mb-1.5">
                {contestPool.current_entries}/{contestPool.max_entries}
              </p>
              <div className="h-1 w-full rounded-full bg-primary-foreground/10 overflow-hidden">
                <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${fillPercent}%` }} />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ── Main Content ── */}
      <main className="flex-1 bg-background pb-32 lg:pb-12">
        <div className="container mx-auto px-4 max-w-6xl py-6 lg:py-8">
          {!isOpen && (
            <div className="mb-6 p-4 rounded-xl border border-destructive/30 bg-destructive/5 text-center">
              <p className="text-destructive font-semibold flex items-center justify-center gap-2">
                <Lock className="h-4 w-4" />
                Contest is {contestPool.status} — entries are closed.
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

              {events.length === 0 ? (
                <Card><CardContent className="py-8 text-center text-muted-foreground">No crews available.</CardContent></Card>
              ) : (
                events.map((eventId) => (
                  <div key={eventId}>
                    <div className="flex items-center gap-2 mb-3">
                      <Badge variant="outline" className="font-semibold text-xs px-2.5 py-1 bg-muted/50">
                        {eventId}
                      </Badge>
                      <span className="text-xs text-muted-foreground">
                        {crewsByEvent[eventId].length} crews
                      </span>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
                      {crewsByEvent[eventId].map((crew) => {
                        const isSelected = crewPicks.has(crew.crew_id);
                        const marginVal = crewPicks.get(crew.crew_id) ?? 0;
                        return (
                          <div
                            key={crew.id}
                            className={`group relative rounded-xl border-2 transition-all overflow-hidden ${
                              !isOpen ? "opacity-50 pointer-events-none" : "cursor-pointer"
                            } ${
                              isSelected
                                ? "border-accent bg-accent/5 shadow-sm"
                                : "border-border hover:border-muted-foreground/30 hover:shadow-md hover:-translate-y-0.5"
                            }`}
                          >
                            <div
                              className="flex flex-col items-center text-center p-4 pb-3"
                              onClick={() => isOpen && toggleCrewSelection(crew.crew_id)}
                            >
                              {isSelected && (
                                <div className="absolute top-2 left-2">
                                  <div className="w-5 h-5 rounded-full bg-accent flex items-center justify-center">
                                    <Check className="h-3 w-3 text-accent-foreground" />
                                  </div>
                                </div>
                              )}
                              <CrewLogo logoUrl={crew.logo_url} crewName={crew.crew_name} size={48} className="mb-2" />
                              <p className="font-semibold text-sm">{crew.crew_name}</p>
                              <p className="text-xs text-muted-foreground">{eventId}</p>
                            </div>

                            {isSelected && isOpen && (
                              <div className="px-3 pb-3 animate-fade-in">
                                <div className="space-y-1">
                                  <p className="text-[10px] text-muted-foreground font-medium">Predicted Margin</p>
                                  <div className="flex items-center gap-2 p-2 rounded-lg bg-muted/50 border border-border/50">
                                    <Input
                                      type="number"
                                      min="0.01"
                                      step="0.1"
                                      placeholder="e.g. 2.5"
                                      className="h-7 text-sm border-0 bg-transparent p-0 focus-visible:ring-0"
                                      value={marginVal || ""}
                                      onClick={(e) => e.stopPropagation()}
                                      onChange={(e) => { e.stopPropagation(); updateCrewMargin(crew.crew_id, parseFloat(e.target.value) || 0); }}
                                    />
                                    <span className="text-xs text-muted-foreground">seconds</span>
                                  </div>
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

            {/* ── RIGHT: Sidebar ── */}
            <div className="w-full lg:w-[340px] xl:w-[380px] flex-shrink-0 space-y-4 lg:sticky lg:top-4 lg:self-start">
              {/* Prize Pool */}
              {payoutRows.length > 0 && (
                <Card className="border-gold/20">
                  <CardContent className="p-4">
                    <h3 className="font-heading text-sm font-bold flex items-center gap-2 mb-3">
                      <Trophy className="h-4 w-4 text-gold" />
                      Prize Pool
                    </h3>
                    <div className="space-y-1.5">
                      {payoutRows.map(({ rank, cents }) => (
                        <div
                          key={rank}
                          className={`flex items-center justify-between py-1.5 px-2.5 rounded-lg text-sm ${
                            rank === 1 ? "bg-gold/10 font-semibold" : ""
                          }`}
                        >
                          <span className={rank === 1 ? "text-gold" : "text-muted-foreground"}>
                            {ordinal(rank)} Place
                          </span>
                          <span className={rank === 1 ? "text-gold font-bold" : "font-semibold"}>
                            {formatCents(cents)}
                          </span>
                        </div>
                      ))}
                    </div>
                    <div className="flex items-center justify-between mt-2 pt-2 border-t text-xs text-muted-foreground">
                      <span>Total</span>
                      <span className="font-semibold text-foreground">{formatCents(totalPrize)}</span>
                    </div>
                  </CardContent>
                </Card>
              )}

              {/* Scoring — Collapsible */}
              <Collapsible open={scoringOpen} onOpenChange={setScoringOpen}>
                <Card>
                  <CardContent className="p-4">
                    <CollapsibleTrigger className="flex items-center justify-between w-full">
                      <h3 className="font-heading text-sm font-bold">How Scoring Works</h3>
                      <ChevronDown
                        className={`h-4 w-4 text-muted-foreground transition-transform ${scoringOpen ? "rotate-180" : ""}`}
                      />
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

              {/* Your Draft */}
              <Card className="border-2 border-accent/30 shadow-sm">
                <CardContent className="p-4">
                  <h3 className="font-heading text-sm font-bold flex items-center gap-2 mb-3">
                    Your Draft
                    <Badge variant="secondary" className="text-xs ml-auto">
                      {crewPicks.size}/{maxPicks} picks
                    </Badge>
                  </h3>

                  {draftPicksList.length === 0 ? (
                    <p className="text-sm text-muted-foreground py-4 text-center">
                      Click crews above to build your draft
                    </p>
                  ) : (
                    <div className="space-y-2 mb-4">
                      {draftPicksList.map((pick) => (
                        <div
                          key={pick.crewId}
                          className="flex items-center justify-between py-1.5 px-2.5 rounded-lg bg-accent/5 text-sm"
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <CrewLogo logoUrl={pick.logoUrl} crewName={pick.crewName} size={24} />
                            <span className="font-medium truncate">{pick.crewName}</span>
                            <span className="text-xs text-muted-foreground flex-shrink-0">
                              {pick.margin > 0 ? `+${pick.margin}s` : "—"}
                            </span>
                          </div>
                          <button
                            onClick={() => toggleCrewSelection(pick.crewId)}
                            className="text-muted-foreground hover:text-destructive transition-colors p-0.5"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                  {isOpen && (
                    <Button
                      onClick={handleSubmit}
                      variant="hero"
                      size="lg"
                      className="w-full font-semibold"
                      disabled={isSubmitting || crewPicks.size < minPicks || !allMarginsValid}
                    >
                      {isSubmitting ? (
                        <>
                          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                          Processing…
                        </>
                      ) : (
                        <>Enter Contest — {formatCents(contestPool.entry_fee_cents)}</>
                      )}
                    </Button>
                  )}

                  {walletBalanceCents !== null && (
                    <div className={`flex items-center justify-center gap-1.5 mt-3 text-xs ${
                      walletBalanceCents < contestPool.entry_fee_cents ? "text-destructive" : "text-muted-foreground"
                    }`}>
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

      {/* ── Mobile Sticky Bottom Bar ── */}
      {isOpen && (
        <div className="lg:hidden fixed bottom-0 left-0 right-0 bg-background/95 backdrop-blur-md border-t shadow-lg z-50">
          <div className="container mx-auto px-4 py-3">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="font-semibold text-sm">
                  {crewPicks.size} pick{crewPicks.size !== 1 ? "s" : ""} selected
                </p>
                <p className="text-xs text-muted-foreground truncate">
                  {crewPicks.size < minPicks
                    ? `Need ${minPicks - crewPicks.size} more`
                    : !allMarginsValid
                      ? "Enter margins for all crews"
                      : `Entry: ${formatCents(contestPool.entry_fee_cents)}`}
                </p>
              </div>
              <Button
                size="sm"
                variant="hero"
                onClick={handleSubmit}
                disabled={isSubmitting || crewPicks.size < minPicks || !allMarginsValid}
                className="flex-shrink-0"
              >
                {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : "Enter"}
              </Button>
            </div>
          </div>
        </div>
      )}

      <Footer />
    </div>
  );
};

export default ContestDetail;
