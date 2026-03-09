import { useState, useEffect, useMemo } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ArrowLeft, Check, Circle, Clock, DollarSign, Info, Plus, Trash2, Trophy, Loader2 } from "lucide-react";
import { toast } from "sonner";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

interface DraftPick {
  crewId: string;
  crewName: string;
  eventId: string;
  predictedMargin: number;
}

// Canonical finish-order points — matches shared/scoring-logic.ts exactly
const FINISH_POINTS: Record<number, number> = {
  1: 100,
  2: 75,
  3: 60,
  4: 45,
  5: 35,
  6: 25,
  7: 15,
};
const DEFAULT_POINTS = 10;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatLockTime(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short",
  });
}

function centsToDisplay(cents: number): string {
  return (cents / 100).toFixed(2);
}

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

  // Wallet balance in cents (matches DB storage)
  const [walletBalanceCents, setWalletBalanceCents] = useState<number | null>(null);

  // Draft state
  const [draftPicks, setDraftPicks] = useState<DraftPick[]>([]);
  const [currentEventId, setCurrentEventId] = useState<string>("");
  const [currentCrewId, setCurrentCrewId] = useState<string>("");
  const [currentMargin, setCurrentMargin] = useState<string>("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Auth guard
  useEffect(() => {
    if (!authLoading && !user) {
      navigate("/login");
    }
  }, [user, authLoading, navigate]);

  // Fetch contest pool from Supabase
  useEffect(() => {
    if (!id) return;
    const fetchPool = async () => {
      setPoolLoading(true);
      setPoolError(null);
      const { data, error } = await supabase
        .from("contest_pools")
        .select(
          `
          id,
          lock_time,
          status,
          entry_fee_cents,
          prize_pool_cents,
          payout_structure,
          current_entries,
          max_entries,
          contest_template_id,
          contest_templates (
            id,
            regatta_name,
            gender_category,
            min_picks,
            max_picks
          ),
          contest_pool_crews (
            id,
            crew_id,
            crew_name,
            event_id
          )
        `,
        )
        .eq("id", id)
        .single();

      if (error || !data) {
        console.error("Error fetching contest pool:", error);
        setPoolError("Contest not found.");
      } else {
        setContestPool(data as unknown as ContestPool);
      }
      setPoolLoading(false);
    };
    fetchPool();
  }, [id]);

  // Fetch wallet balance in cents
  useEffect(() => {
    if (!user) return;
    const fetchWallet = async () => {
      const { data, error } = await supabase
        .from("wallets")
        .select("available_balance")
        .eq("user_id", user.id)
        .single();
      if (!error && data) {
        setWalletBalanceCents(Number(data.available_balance));
      }
    };
    fetchWallet();
  }, [user]);

  // Derived: group crews by event_id
  const crewsByEvent = useMemo(() => {
    if (!contestPool) return {} as Record<string, PoolCrew[]>;
    return contestPool.contest_pool_crews.reduce(
      (acc, crew) => {
        if (!acc[crew.event_id]) acc[crew.event_id] = [];
        acc[crew.event_id].push(crew);
        return acc;
      },
      {} as Record<string, PoolCrew[]>,
    );
  }, [contestPool]);

  const pickedEvents = useMemo(() => new Set(draftPicks.map((p) => p.eventId)), [draftPicks]);
  const availableEventIds = useMemo(
    () => Object.keys(crewsByEvent).filter((eid) => !pickedEvents.has(eid)),
    [crewsByEvent, pickedEvents],
  );
  const availableCrews = useMemo(
    () => (currentEventId ? crewsByEvent[currentEventId] || [] : []),
    [crewsByEvent, currentEventId],
  );

  const payoutRows = useMemo(() => {
    if (!contestPool?.payout_structure) return [];
    return Object.entries(contestPool.payout_structure)
      .map(([rank, cents]) => ({ rank: Number(rank), cents }))
      .sort((a, b) => a.rank - b.rank);
  }, [contestPool]);

  const minPicks = contestPool?.contest_templates?.min_picks ?? 2;
  const maxPicks = contestPool?.contest_templates?.max_picks ?? 4;

  // Draft actions
  const addPick = () => {
    if (!currentCrewId || !currentMargin) {
      toast.error("Please select a crew and enter a margin prediction.");
      return;
    }
    const margin = parseFloat(currentMargin);
    if (isNaN(margin) || margin <= 0) {
      toast.error("Please enter a valid margin in seconds (e.g. 1.42).");
      return;
    }
    if (draftPicks.length >= maxPicks) {
      toast.error(`Maximum ${maxPicks} picks allowed.`);
      return;
    }
    const crew = contestPool!.contest_pool_crews.find((c) => c.crew_id === currentCrewId);
    if (!crew) return;

    if (pickedEvents.has(crew.event_id)) {
      toast.error("You already have a crew from this event.");
      return;
    }

    setDraftPicks([
      ...draftPicks,
      {
        crewId: crew.crew_id,
        crewName: crew.crew_name,
        eventId: crew.event_id,
        predictedMargin: margin,
      },
    ]);
    setCurrentCrewId("");
    setCurrentMargin("");
    setCurrentEventId("");
    toast.success(`${crew.crew_name} added to your draft.`);
  };

  const removePick = (index: number) => {
    setDraftPicks(draftPicks.filter((_, i) => i !== index));
  };

  // Submit entry
  const handleSubmit = async () => {
    if (!contestPool || !user) return;

    if (draftPicks.length < minPicks) {
      toast.error(`You must pick at least ${minPicks} crews from different events.`);
      return;
    }

    const uniqueEvents = new Set(draftPicks.map((p) => p.eventId));
    if (uniqueEvents.size < 2) {
      toast.error("You must pick crews from at least 2 different events.");
      return;
    }

    if (walletBalanceCents === null) {
      toast.error("Unable to verify wallet balance. Please refresh and try again.");
      return;
    }

    // All comparisons in cents — no unit mismatch
    if (walletBalanceCents < contestPool.entry_fee_cents) {
      toast.error(
        `Insufficient balance. You need $${centsToDisplay(contestPool.entry_fee_cents)} but have $${centsToDisplay(walletBalanceCents)}.`,
      );
      return;
    }

    if (contestPool.status !== "open") {
      toast.error("This contest is no longer accepting entries.");
      return;
    }

    setIsSubmitting(true);
    try {
      const { data, error } = await supabase.functions.invoke("contest-matchmaking", {
        body: {
          contestTemplateId: contestPool.contest_template_id,
          tierId: contestPool.id,
          picks: draftPicks.map((pick) => ({
            crewId: pick.crewId,
            event_id: pick.eventId,
            predictedMargin: pick.predictedMargin,
          })),
          entryFeeCents: contestPool.entry_fee_cents,
          stateCode: null,
        },
      });

      if (error) {
        console.error("Matchmaking error:", error);
        if (error.message?.includes("Insufficient balance")) {
          toast.error("Insufficient balance to enter this contest.");
        } else if (error.message?.includes("already entered")) {
          toast.error("You have already entered this contest.");
        } else if (error.message?.includes("not open")) {
          toast.error("Contest entry period has ended.");
        } else {
          toast.error("Failed to submit entry. Please try again.");
        }
        return;
      }

      if (!data?.entryId) {
        toast.error(data?.error || "Failed to submit entry.");
        return;
      }

      toast.success("Entry submitted! You're in the contest.");

      // Refresh wallet
      const { data: walletData } = await supabase
        .from("wallets")
        .select("available_balance")
        .eq("user_id", user.id)
        .single();
      if (walletData) setWalletBalanceCents(Number(walletData.available_balance));

      setTimeout(() => navigate("/my-entries"), 1500);
    } catch (err) {
      console.error("Unexpected error:", err);
      toast.error("An unexpected error occurred. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  };

  // ---------------------------------------------------------------------------
  // Loading / error states
  // ---------------------------------------------------------------------------

  if (authLoading || poolLoading) {
    return (
      <div className="flex flex-col min-h-screen">
        <Header />
        <main className="flex-1 flex items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
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
          <Button variant="outline" onClick={() => navigate("/lobby")}>
            Back to Lobby
          </Button>
        </main>
        <Footer />
      </div>
    );
  }

  const template = contestPool.contest_templates;

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="flex flex-col min-h-screen">
      <Header />

      <main className="flex-1 gradient-subtle py-12">
        <div className="container mx-auto px-4 max-w-5xl">
          <Link
            to={`/regatta/${id}`}
            className="inline-flex items-center gap-2 text-muted-foreground hover:text-foreground mb-6 transition-base"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to Entry Options
          </Link>

          {/* Header */}
          <div className="mb-8">
            <div className="flex items-start justify-between mb-4">
              <div>
                <h1 className="text-4xl font-bold mb-2">{template.regatta_name}</h1>
                <p className="text-lg text-muted-foreground">
                  {template.gender_category} Multi-Team Fantasy • Pick {minPicks}–{maxPicks} crews from different events
                </p>
              </div>
              {contestPool.status !== "open" && (
                <Badge variant="destructive" className="text-sm px-3 py-1 capitalize">
                  {contestPool.status}
                </Badge>
              )}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              {/* Entry Fee */}
              <Card>
                <CardContent className="pt-6">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-lg bg-accent/10 flex items-center justify-center">
                      <DollarSign className="h-5 w-5 text-accent" />
                    </div>
                    <div>
                      <p className="text-sm text-muted-foreground">Entry Fee</p>
                      <p className="text-2xl font-bold">${centsToDisplay(contestPool.entry_fee_cents)}</p>
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* Prize */}
              <Card>
                <CardContent className="pt-6">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-lg bg-success/10 flex items-center justify-center">
                      <Trophy className="h-5 w-5 text-success" />
                    </div>
                    <div className="flex-1">
                      <p className="text-sm text-muted-foreground mb-1">Prizes</p>
                      {payoutRows.length > 0 ? (
                        <div className="space-y-0.5">
                          {payoutRows.map(({ rank, cents }) => (
                            <div key={rank} className="flex items-center justify-between">
                              <span className="text-xs text-muted-foreground">#{rank}</span>
                              <span className="text-sm font-bold text-success">${centsToDisplay(cents)}</span>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="text-2xl font-bold text-success">
                          ${centsToDisplay(contestPool.prize_pool_cents)}
                        </p>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* Lock Time */}
              <Card>
                <CardContent className="pt-6">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
                      <Clock className="h-5 w-5 text-primary" />
                    </div>
                    <div>
                      <p className="text-sm text-muted-foreground">Locks</p>
                      <p className="text-sm font-semibold">{formatLockTime(contestPool.lock_time)}</p>
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* Wallet */}
              <Card>
                <CardContent className="pt-6">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-lg bg-muted/50 flex items-center justify-center">
                      <DollarSign className="h-5 w-5 text-foreground" />
                    </div>
                    <div>
                      <p className="text-sm text-muted-foreground">Your Balance</p>
                      {walletBalanceCents !== null ? (
                        <p
                          className={`text-2xl font-bold ${walletBalanceCents < contestPool.entry_fee_cents ? "text-destructive" : ""}`}
                        >
                          ${centsToDisplay(walletBalanceCents)}
                        </p>
                      ) : (
                        <p className="text-sm text-muted-foreground">Loading...</p>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
            {/* Draft form */}
            <div className="lg:col-span-2 space-y-6">
              {/* Current picks */}
              {draftPicks.length > 0 && (
                <Card>
                  <CardHeader>
                    <CardTitle>
                      Your Draft ({draftPicks.length}/{maxPicks})
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {draftPicks.map((pick, index) => (
                      <div
                        key={index}
                        className="flex items-center justify-between p-4 rounded-lg border-2 border-accent/20 bg-accent/5"
                      >
                        <div className="flex-1">
                          <p className="font-semibold">{pick.crewName}</p>
                          <p className="text-sm text-muted-foreground">Event: {pick.eventId}</p>
                          <p className="text-sm mt-1">
                            Margin prediction: <span className="font-medium">{pick.predictedMargin}s</span>
                          </p>
                        </div>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => removePick(index)}
                          className="text-destructive hover:text-destructive"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    ))}
                  </CardContent>
                </Card>
              )}

              {/* Event progress checklist */}
              {Object.keys(crewsByEvent).length > 0 && (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Event Progress</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    {Object.keys(crewsByEvent).map((eid) => {
                      const pick = draftPicks.find((p) => p.eventId === eid);
                      return (
                        <div key={eid} className="flex items-center gap-3 text-sm">
                          {pick ? (
                            <Check className="h-4 w-4 text-green-500 flex-shrink-0" />
                          ) : (
                            <Circle className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                          )}
                          <span className={pick ? "font-medium" : "text-muted-foreground"}>
                            {eid}
                          </span>
                          {pick && (
                            <Badge variant="secondary" className="ml-auto text-xs">
                              {pick.crewName}
                            </Badge>
                          )}
                        </div>
                      );
                    })}
                  </CardContent>
                </Card>
              )}

              {/* Add pick form */}
              <Card>
                <CardHeader>
                  <CardTitle>Add Crew to Draft</CardTitle>
                  <p className="text-sm text-muted-foreground mt-2">
                    {draftPicks.length < minPicks
                      ? `You need ${minPicks - draftPicks.length} more crew(s) from different events`
                      : draftPicks.length < maxPicks
                        ? `Optional: Add up to ${maxPicks - draftPicks.length} more crew(s)`
                        : "Draft complete!"}
                  </p>
                </CardHeader>

                {draftPicks.length < maxPicks && contestPool.status === "open" && (
                  <CardContent className="space-y-6">
                    {/* Step 1: Event */}
                    <div className="space-y-3">
                      <Label className="text-base font-semibold">Step 1: Choose Event</Label>
                      <Select
                        value={currentEventId}
                        onValueChange={(v) => {
                          setCurrentEventId(v);
                          setCurrentCrewId("");
                        }}
                      >
                        <SelectTrigger className="text-base">
                          <SelectValue placeholder="Select an event..." />
                        </SelectTrigger>
                        <SelectContent>
                          {availableEventIds.map((eid) => (
                            <SelectItem key={eid} value={eid} className="text-base">
                              {eid}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    {/* Step 2: Crew */}
                    {currentEventId && (
                      <div className="space-y-3">
                        <Label className="text-base font-semibold">Step 2: Select Crew</Label>
                        <Select value={currentCrewId} onValueChange={setCurrentCrewId}>
                          <SelectTrigger className="text-base">
                            <SelectValue placeholder="Select a crew..." />
                          </SelectTrigger>
                          <SelectContent>
                            {availableCrews.map((crew) => (
                              <SelectItem key={crew.crew_id} value={crew.crew_id} className="text-base">
                                {crew.crew_name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    )}

                    {/* Step 3: Margin */}
                    {currentCrewId && (
                      <div className="space-y-3">
                        <Label htmlFor="margin" className="text-base font-semibold">
                          Step 3: Predict Winning Margin (Tie-Breaker)
                        </Label>
                        <div className="space-y-2">
                          <div className="flex items-center gap-2">
                            <Input
                              id="margin"
                              type="number"
                              step="0.01"
                              min="0.01"
                              placeholder="1.42"
                              value={currentMargin}
                              onChange={(e) => setCurrentMargin(e.target.value)}
                              className="text-base"
                            />
                            <span className="text-muted-foreground font-medium">seconds</span>
                          </div>
                          <p className="text-sm text-muted-foreground flex items-start gap-2">
                            <Info className="h-4 w-4 mt-0.5 flex-shrink-0" />
                            Time gap between 1st and 2nd place in this event. Used only if scores are tied.
                          </p>
                        </div>
                      </div>
                    )}

                    <Button
                      type="button"
                      onClick={addPick}
                      variant="outline"
                      size="lg"
                      className="w-full"
                      disabled={!currentCrewId || !currentMargin}
                    >
                      <Plus className="h-5 w-5 mr-2" />
                      Add Crew to Draft
                    </Button>
                  </CardContent>
                )}
              </Card>

              {/* Submit */}
              {draftPicks.length >= minPicks && (
                <Button
                  onClick={handleSubmit}
                  variant="hero"
                  size="lg"
                  className="w-full text-lg py-6"
                  disabled={isSubmitting || contestPool.status !== "open"}
                >
                  {isSubmitting ? (
                    <>
                      <Loader2 className="h-5 w-5 mr-2 animate-spin" />
                      Processing...
                    </>
                  ) : (
                    <>Submit Draft — ${centsToDisplay(contestPool.entry_fee_cents)}</>
                  )}
                </Button>
              )}

              {contestPool.status !== "open" && (
                <Card className="border-destructive/30 bg-destructive/5">
                  <CardContent className="pt-6 text-center">
                    <p className="text-destructive font-semibold capitalize">
                      Contest is {contestPool.status} — entries are closed.
                    </p>
                  </CardContent>
                </Card>
              )}
            </div>

            {/* Sidebar */}
            <div className="space-y-6">
              {/* Scoring table — matches scoring-logic.ts */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-lg flex items-center gap-2">
                    <Trophy className="h-5 w-5 text-accent" />
                    Finish-Order Scoring
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3 text-sm">
                  <div className="space-y-2">
                    {Object.entries(FINISH_POINTS).map(([pos, pts]) => (
                      <div
                        key={pos}
                        className={`flex items-center justify-between p-2 rounded ${Number(pos) === 1 ? "bg-accent/5" : "bg-muted/50"}`}
                      >
                        <span className={Number(pos) === 1 ? "font-medium" : ""}>{ordinal(Number(pos))} Place</span>
                        <span className={`font-semibold ${Number(pos) === 1 ? "text-accent font-bold" : ""}`}>
                          {pts} pts
                        </span>
                      </div>
                    ))}
                    <div className="flex items-center justify-between p-2 rounded bg-muted/50">
                      <span>8th+ Place</span>
                      <span className="font-semibold">{DEFAULT_POINTS} pts</span>
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground pt-2 border-t">
                    Your total score = sum of all your crews' finish points
                  </p>
                </CardContent>
              </Card>

              {/* How to Win */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-lg">How to Win</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4 text-sm">
                  <div>
                    <h4 className="font-semibold mb-2">1. Automatic Finish Points</h4>
                    <p className="text-muted-foreground">
                      Your drafted crews earn points based on their actual finish positions.
                    </p>
                  </div>
                  <div>
                    <h4 className="font-semibold mb-2">2. Margin Accuracy (Tie-Breaker)</h4>
                    <p className="text-muted-foreground">
                      If tied on points, the user with the most accurate margin predictions wins.
                    </p>
                  </div>
                  <div className="p-3 rounded-lg bg-muted/30">
                    <p className="text-xs font-medium mb-1">Example:</p>
                    <p className="text-xs text-muted-foreground">
                      Draft Yale (1st = 100 pts) and Harvard (3rd = 60 pts) = 160 total points.
                    </p>
                  </div>
                </CardContent>
              </Card>

              {/* Prize pool */}
              <Card className="border-accent/20 bg-accent/5">
                <CardHeader>
                  <CardTitle className="text-lg">Prize Pool</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-sm text-muted-foreground mb-4">
                    Distributed to top finishers after all entries are submitted.
                  </p>
                  {payoutRows.length > 0 ? (
                    <div className="space-y-2">
                      {payoutRows.map(({ rank, cents }) => (
                        <div
                          key={rank}
                          className="flex items-center justify-between p-2 rounded bg-background border border-border"
                        >
                          <span className="text-sm font-medium">{ordinal(rank)} Place</span>
                          <span className="text-lg font-bold text-success">${centsToDisplay(cents)}</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="p-4 rounded-lg bg-background border border-border">
                      <p className="text-2xl font-bold text-success text-center">
                        ${centsToDisplay(contestPool.prize_pool_cents)}
                      </p>
                      <p className="text-xs text-center text-muted-foreground mt-1">Total prize pool</p>
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Entry count progress */}
              <Card>
                <CardContent className="pt-6">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm text-muted-foreground">Entries</span>
                    <span className="text-sm font-semibold">
                      {contestPool.current_entries} / {contestPool.max_entries}
                    </span>
                  </div>
                  <div className="w-full bg-muted rounded-full h-2">
                    <div
                      className="bg-accent h-2 rounded-full transition-all"
                      style={{
                        width: `${Math.min(100, (contestPool.current_entries / contestPool.max_entries) * 100)}%`,
                      }}
                    />
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>
        </div>
      </main>

      <Footer />
    </div>
  );
};

export default ContestDetail;
