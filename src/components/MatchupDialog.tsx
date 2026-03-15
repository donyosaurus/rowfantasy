import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Trophy, Users, Lock, Eye } from "lucide-react";
import { formatCents } from "@/lib/formatCurrency";

interface MatchupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  poolId: string;
  currentUserId: string;
  contestName: string;
  poolStatus: string;
  lockTime: string;
  maxEntries: number;
  currentEntries: number;
  payoutStructure: Record<string, number> | null;
}

interface EntrantRow {
  id: string;
  user_id: string;
  username: string | null;
  picks: unknown;
  total_points: number | null;
  margin_error: number | null;
  rank: number | null;
  payout_cents: number | null;
  status: string;
  created_at: string;
  score?: {
    total_points: number;
    margin_bonus: number;
    rank: number | null;
    payout_cents: number | null;
    is_winner: boolean | null;
    crew_scores: unknown;
  };
}

interface CrewInfo {
  crew_id: string;
  crew_name: string;
  event_id: string;
}

interface ParsedPick {
  crewName: string;
  crewId: string;
  margin: number | null;
  eventId: string;
}

export function MatchupDialog({
  open,
  onOpenChange,
  poolId,
  currentUserId,
  contestName,
  poolStatus,
  lockTime,
  maxEntries,
  currentEntries,
  payoutStructure,
}: MatchupDialogProps) {
  const [entrants, setEntrants] = useState<EntrantRow[]>([]);
  const [crewMap, setCrewMap] = useState<Map<string, CrewInfo>>(new Map());
  const [loading, setLoading] = useState(true);

  const isLocked = new Date(lockTime) <= new Date();
  const isCompleted = ["settled", "completed", "scoring_completed", "results_entered", "voided"].includes(poolStatus);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    fetchData();
  }, [open, poolId]);

  const fetchData = async () => {
    try {
      const [entriesRes, crewsRes, scoresRes] = await Promise.all([
        supabase
          .from("contest_entries")
          .select("id, user_id, picks, total_points, margin_error, rank, payout_cents, status, created_at")
          .eq("pool_id", poolId)
          .in("status", ["active", "scored", "settled", "voided"]),
        supabase
          .from("contest_pool_crews")
          .select("crew_id, crew_name, event_id")
          .eq("contest_pool_id", poolId),
        supabase
          .from("contest_scores")
          .select("entry_id, total_points, margin_bonus, rank, payout_cents, is_winner, crew_scores")
          .eq("pool_id", poolId),
      ]);

      // Build crew map
      const newCrewMap = new Map<string, CrewInfo>();
      (crewsRes.data || []).forEach((c: CrewInfo) => newCrewMap.set(c.crew_id, c));
      setCrewMap(newCrewMap);

      // Build scores map
      const scoresMap = new Map<string, EntrantRow["score"]>();
      (scoresRes.data || []).forEach((s: any) => {
        scoresMap.set(s.entry_id, {
          total_points: s.total_points,
          margin_bonus: s.margin_bonus,
          rank: s.rank,
          payout_cents: s.payout_cents,
          is_winner: s.is_winner,
          crew_scores: s.crew_scores,
        });
      });

      // Fetch usernames via security definer RPC
      const userIds = [...new Set((entriesRes.data || []).map((e: any) => e.user_id))];
      const usernameMap = new Map<string, string>();
      if (userIds.length > 0) {
        const { data: usernameData } = await supabase.rpc("get_usernames", { user_ids: userIds });
        (usernameData || []).forEach((u: { user_id: string; username: string }) => {
          if (u.username) usernameMap.set(u.user_id, u.username);
        });
      }

      // Build entrant rows
      const rows: EntrantRow[] = (entriesRes.data || []).map((e: any) => ({
        id: e.id,
        user_id: e.user_id,
        username: usernameMap.get(e.user_id) || null,
        picks: e.picks,
        total_points: e.total_points,
        margin_error: e.margin_error,
        rank: e.rank,
        payout_cents: e.payout_cents,
        status: e.status,
        created_at: e.created_at,
        score: scoresMap.get(e.id),
      }));

      // Sort: completed → by rank asc; active → by created_at asc
      rows.sort((a, b) => {
        const rankA = a.score?.rank ?? a.rank ?? 999;
        const rankB = b.score?.rank ?? b.rank ?? 999;
        if (isCompleted && (rankA !== rankB)) return rankA - rankB;
        return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
      });

      setEntrants(rows);
    } catch (err) {
      console.error("Error fetching matchup data:", err);
    } finally {
      setLoading(false);
    }
  };

  const parsePicks = (picks: unknown): ParsedPick[] => {
    if (!picks) return [];
    let parsed = picks;
    if (typeof parsed === "string") {
      try { parsed = JSON.parse(parsed); } catch { return []; }
    }

    let arr: unknown[];
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) && "crews" in (parsed as any)) {
      arr = Array.isArray((parsed as any).crews) ? (parsed as any).crews : [];
    } else if (Array.isArray(parsed)) {
      arr = parsed;
    } else {
      return [];
    }

    return arr.map((pick) => {
      if (typeof pick === "object" && pick !== null && "crewId" in pick) {
        const p = pick as { crewId: string; predictedMargin: number };
        const crew = crewMap.get(p.crewId);
        return { crewName: crew?.crew_name || p.crewId, crewId: p.crewId, margin: p.predictedMargin, eventId: crew?.event_id || "" };
      }
      if (typeof pick === "string") {
        const crew = crewMap.get(pick);
        return { crewName: crew?.crew_name || pick, crewId: pick, margin: null, eventId: crew?.event_id || "" };
      }
      return { crewName: "Unknown", crewId: "", margin: null, eventId: "" };
    });
  };

  const getStatusBadge = () => {
    const map: Record<string, { label: string; className: string }> = {
      open: { label: "Open", className: "bg-success/10 text-success border-success/30" },
      locked: { label: "Live", className: "bg-gold/10 text-gold border-gold/30" },
      results_entered: { label: "Results In", className: "bg-gold/10 text-gold border-gold/30" },
      scoring_completed: { label: "Scored", className: "bg-accent/10 text-accent border-accent/30" },
      settled: { label: "Settled", className: "bg-muted text-muted-foreground" },
      completed: { label: "Completed", className: "bg-muted text-muted-foreground" },
      voided: { label: "Voided", className: "bg-destructive/10 text-destructive border-destructive/30" },
    };
    const config = map[poolStatus] || map.open;
    return <Badge variant="outline" className={config.className}>{config.label}</Badge>;
  };

  const getPrizeLines = (): string => {
    if (!payoutStructure) return "";
    const sorted = Object.entries(payoutStructure).sort(([a], [b]) => Number(a) - Number(b));
    return sorted.map(([rank, cents]) => `${getRankLabel(Number(rank))}: ${formatCents(cents)}`).join(" · ");
  };

  const getRankLabel = (r: number) => {
    if (r === 1) return "1st";
    if (r === 2) return "2nd";
    if (r === 3) return "3rd";
    return `${r}th`;
  };

  const canSeePicks = (entrant: EntrantRow) => {
    if (entrant.user_id === currentUserId) return true;
    if (isLocked || isCompleted) return true;
    return false;
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto p-0 rounded-xl">
        {/* Header */}
        <DialogHeader className="p-6 pb-4 border-b bg-primary/5">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <DialogTitle className="text-xl font-heading font-bold">{contestName}</DialogTitle>
            {getStatusBadge()}
          </div>
          <div className="flex items-center gap-4 text-sm text-muted-foreground mt-2 flex-wrap">
            <span className="flex items-center gap-1.5">
              <Users className="h-3.5 w-3.5" />
              {currentEntries}/{maxEntries} entries
            </span>
            {payoutStructure && (
              <span className="text-gold font-medium">{getPrizeLines()}</span>
            )}
          </div>
        </DialogHeader>

        {/* Body */}
        <div className="p-4 space-y-2">
          {loading ? (
            <div className="space-y-3">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-24 w-full rounded-xl" />
              ))}
            </div>
          ) : entrants.length <= 1 ? (
            <div className="py-12 text-center">
              <div className="w-14 h-14 rounded-full bg-accent/10 flex items-center justify-center mx-auto mb-3">
                <Users className="h-7 w-7 text-accent" />
              </div>
              <p className="text-muted-foreground font-medium">Waiting for opponents…</p>
              <p className="text-sm text-muted-foreground mt-1">Other players haven't joined yet.</p>
            </div>
          ) : (
            <>
              {/* Column headers for completed */}
              {isCompleted && (
                <div className="grid grid-cols-[2rem_1fr_4rem_5rem_4.5rem] gap-2 px-3 py-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                  <span>Rk</span>
                  <span>Player</span>
                  <span className="text-right">Pts</span>
                  <span className="text-right">Margin</span>
                  <span className="text-right">Payout</span>
                </div>
              )}

              {entrants.map((entrant) => {
                const isCurrentUser = entrant.user_id === currentUserId;
                const isWinner = entrant.score?.is_winner || false;
                const picks = parsePicks(entrant.picks);
                const showPicks = canSeePicks(entrant);
                const rank = entrant.score?.rank ?? entrant.rank;
                const points = entrant.score?.total_points ?? entrant.total_points;
                const marginError = entrant.score?.margin_bonus ?? entrant.margin_error;
                const payout = entrant.score?.payout_cents ?? entrant.payout_cents;

                return (
                  <div
                    key={entrant.id}
                    className={`rounded-xl border p-3 transition-colors ${
                      isCurrentUser
                        ? "bg-accent/5 border-accent/30"
                        : isWinner && isCompleted
                        ? "border-l-4 border-l-gold border-gold/20 bg-gold/5"
                        : "border-border"
                    }`}
                  >
                    {isCompleted ? (
                      /* Completed layout with grid */
                      <div>
                        <div className="grid grid-cols-[2rem_1fr_4rem_5rem_4.5rem] gap-2 items-center">
                          <span className="font-heading font-bold text-sm">
                            {rank ? `#${rank}` : "—"}
                          </span>
                          <div className="flex items-center gap-2 min-w-0">
                            <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                              {isWinner ? (
                                <Trophy className="h-3.5 w-3.5 text-gold" />
                              ) : (
                                <span className="text-xs font-bold text-primary/60">
                                  {(entrant.username || "?")[0].toUpperCase()}
                                </span>
                              )}
                            </div>
                            <span className={`text-sm font-medium truncate ${isCurrentUser ? "text-accent" : ""}`}>
                              @{entrant.username || "anonymous"}
                              {isCurrentUser && <span className="text-xs text-muted-foreground ml-1">(you)</span>}
                            </span>
                          </div>
                          <span className="text-sm font-heading font-bold text-right">{points ?? "—"}</span>
                          <span className="text-sm text-muted-foreground text-right">
                            {marginError != null ? `±${Number(marginError).toFixed(1)}s` : "—"}
                          </span>
                          <span className={`text-sm font-semibold text-right ${payout && payout > 0 ? "text-success" : "text-muted-foreground"}`}>
                            {payout && payout > 0 ? formatCents(payout) : "—"}
                          </span>
                        </div>
                        {/* Picks row */}
                        {showPicks && picks.length > 0 && (
                          <div className="flex flex-wrap gap-1.5 mt-2 ml-9">
                            {picks.map((pick, idx) => (
                              <Badge key={idx} variant="secondary" className="text-xs rounded-lg bg-primary/5 border border-primary/10">
                                {pick.crewName}
                                {pick.margin != null && (
                                  <span className="ml-1 text-accent font-semibold">(+{pick.margin.toFixed(1)}s)</span>
                                )}
                              </Badge>
                            ))}
                          </div>
                        )}
                      </div>
                    ) : (
                      /* Active layout */
                      <div className="flex items-start gap-3">
                        <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
                          <span className="text-xs font-bold text-primary/60">
                            {(entrant.username || "?")[0].toUpperCase()}
                          </span>
                        </div>
                        <div className="flex-1 min-w-0">
                          <span className={`text-sm font-medium ${isCurrentUser ? "text-accent" : ""}`}>
                            @{entrant.username || "anonymous"}
                            {isCurrentUser && <span className="text-xs text-muted-foreground ml-1">(you)</span>}
                          </span>
                          {showPicks ? (
                            <div className="flex flex-wrap gap-1.5 mt-1.5">
                              {picks.map((pick, idx) => (
                                <Badge key={idx} variant="secondary" className="text-xs rounded-lg bg-primary/5 border border-primary/10">
                                  {pick.crewName}
                                  {pick.margin != null && (
                                    <span className="ml-1 text-accent font-semibold">(+{pick.margin.toFixed(1)}s)</span>
                                  )}
                                </Badge>
                              ))}
                            </div>
                          ) : (
                            <div className="flex items-center gap-1.5 mt-1.5 text-xs text-muted-foreground">
                              <Lock className="h-3 w-3" />
                              <span>Picks hidden until lock</span>
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
