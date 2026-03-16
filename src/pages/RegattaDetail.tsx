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

const RegattaDetail = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();

  const [contestPool, setContestPool] = useState<ContestPool | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [crewPicks, setCrewPicks] = useState<Map<string, number>>(new Map());
  const [submitting, setSubmitting] = useState(false);
  const [scoringOpen, setScoringOpen] = useState(false);
  const [walletBalanceCents, setWalletBalanceCents] = useState<number | null>(null);

  useEffect(() => {
    if (!authLoading && !user) navigate("/login");
  }, [user, authLoading, navigate]);

  useEffect(() => {
    if (!id) { setError("No contest ID provided"); setLoading(false); return; }
    const fetchPoolData = async () => {
      const { data, error: fetchError } = await supabase
        .from("contest_pools")
        .select(`*, payout_structure, contest_template_id, contest_templates (regatta_name, gender_category, min_picks, max_picks), contest_pool_crews (id, crew_id, crew_name, event_id)`)
        .eq("id", id)
        .single();
      if (fetchError || !data) { setError("Contest not found"); setLoading(false); return; }
      setContestPool(data as ContestPool);
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
                {contestPool.contest_templates.gender_category} Multi-Team Fantasy · Pick {minPicks}–{maxPicks} crews
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
            {/* 1st Prize */}
            <div className="rounded-xl bg-primary-foreground/10 backdrop-blur-sm border border-primary-foreground/10 p-3 lg:p-4">
              <div className="flex items-center gap-2 mb-1">
                <Trophy className="h-4 w-4 text-gold" />
                <span className="text-xs text-primary-foreground/60 font-medium">1st Prize</span>
              </div>
              <p className="font-heading text-xl lg:text-2xl font-bold text-gold">
                {formatCents(firstPrize)}
              </p>
            </div>

            {/* Entry Fee */}
            <div className="rounded-xl bg-primary-foreground/10 backdrop-blur-sm border border-primary-foreground/10 p-3 lg:p-4">
              <div className="flex items-center gap-2 mb-1">
                <Zap className="h-4 w-4 text-accent" />
                <span className="text-xs text-primary-foreground/60 font-medium">Entry Fee</span>
              </div>
              <p className="font-heading text-xl lg:text-2xl font-bold">
                {formatCents(contestPool.entry_fee_cents)}
              </p>
            </div>

            {/* Lock Time */}
            <div className="rounded-xl bg-primary-foreground/10 backdrop-blur-sm border border-primary-foreground/10 p-3 lg:p-4">
              <div className="flex items-center gap-2 mb-1">
                <Clock className="h-4 w-4 text-primary-foreground/60" />
                <span className="text-xs text-primary-foreground/60 font-medium">Locks</span>
              </div>
              <p className="font-heading text-lg lg:text-xl font-bold">{formattedLockTime}</p>
            </div>

            {/* Entries */}
            <div className="rounded-xl bg-primary-foreground/10 backdrop-blur-sm border border-primary-foreground/10 p-3 lg:p-4">
              <div className="flex items-center gap-2 mb-1">
                <Users className="h-4 w-4 text-primary-foreground/60" />
                <span className="text-xs text-primary-foreground/60 font-medium">Entries</span>
              </div>
              <p className="font-heading text-xl lg:text-2xl font-bold mb-1.5">
                {contestPool.current_entries}/{contestPool.max_entries}
              </p>
              <div className="h-1 w-full rounded-full bg-primary-foreground/10 overflow-hidden">
                <div
                  className="h-full rounded-full bg-accent transition-all"
                  style={{ width: `${fillPercent}%` }}
                />
              </div>
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
                  Pick {minPicks}–{maxPicks} crews from at least 2 different events
                </p>
              </div>

              {divisions.length === 0 ? (
                <Card><CardContent className="py-8 text-center text-muted-foreground">No crews available.</CardContent></Card>
              ) : (
                divisions.map((divisionId) => (
                  <div key={divisionId}>
                    <div className="flex items-center gap-2 mb-3">
                      <Badge variant="outline" className="font-semibold text-xs px-2.5 py-1 bg-muted/50">
                        {divisionId}
                      </Badge>
                      <span className="text-xs text-muted-foreground">
                        {crewsByDivision[divisionId].length} crews
                      </span>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      {crewsByDivision[divisionId].map((crew) => {
                        const isSelected = crewPicks.has(crew.crew_id);
                        const marginVal = crewPicks.get(crew.crew_id) ?? 0;
                        return (
                          <div
                            key={crew.id}
                            className={`group rounded-xl border-2 transition-all overflow-hidden ${
                              !isContestOpen ? "opacity-50 pointer-events-none" : "cursor-pointer"
                            } ${
                              isSelected
                                ? "border-accent bg-accent/5 shadow-sm"
                                : "border-border hover:border-muted-foreground/30 hover:shadow-sm hover:-translate-y-0.5"
                            }`}
                          >
                            <div
                              className="flex items-center gap-3 p-3.5"
                              onClick={() => isContestOpen && toggleCrewSelection(crew.crew_id)}
                            >
                              {/* Selection indicator */}
                              <div
                                className={`flex-shrink-0 w-6 h-6 rounded-md border-2 flex items-center justify-center transition-all ${
                                  isSelected
                                    ? "bg-accent border-accent"
                                    : "border-border group-hover:border-muted-foreground/40"
                                }`}
                              >
                                {isSelected && <Check className="h-4 w-4 text-accent-foreground" />}
                              </div>

                              <div className="flex-1 min-w-0">
                                <p className="font-semibold text-sm truncate">{crew.crew_name}</p>
                                <p className="text-xs text-muted-foreground">{divisionId}</p>
                              </div>
                            </div>

                            {/* Inline margin input with animation */}
                            {isSelected && isContestOpen && (
                              <div className="px-3.5 pb-3.5 animate-fade-in">
                                <div className="flex items-center gap-2 p-2 rounded-lg bg-muted/50 border border-border/50">
                                  <span className="text-xs text-muted-foreground whitespace-nowrap">Margin:</span>
                                  <Input
                                    type="number"
                                    min="0.01"
                                    step="0.1"
                                    placeholder="e.g. 2.5"
                                    value={marginVal || ""}
                                    onChange={(e) => updateCrewMargin(crew.crew_id, parseFloat(e.target.value) || 0)}
                                    onClick={(e) => e.stopPropagation()}
                                    className="h-7 text-xs border-0 bg-background px-2"
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

              {/* Your Draft — most prominent */}
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
                          <div className="min-w-0">
                            <span className="font-medium">{pick.crewName}</span>
                            <span className="text-xs text-muted-foreground ml-2">
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

                  {/* Submit Button */}
                  {isContestOpen && (
                    <Button
                      onClick={handleSubmitEntry}
                      variant="hero"
                      size="lg"
                      className="w-full font-semibold"
                      disabled={submitting || crewPicks.size < minPicks || !allMarginsValid}
                    >
                      {submitting ? (
                        <>
                          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                          Processing…
                        </>
                      ) : (
                        <>Enter Contest — {formatCents(contestPool.entry_fee_cents)}</>
                      )}
                    </Button>
                  )}

                  {/* Wallet balance */}
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
      {isContestOpen && (
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
                onClick={handleSubmitEntry}
                disabled={submitting || crewPicks.size < minPicks || !allMarginsValid}
                className="flex-shrink-0"
              >
                {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : "Enter"}
              </Button>
            </div>
          </div>
        </div>
      )}

      <Footer />
    </div>
  );
};

export default RegattaDetail;
