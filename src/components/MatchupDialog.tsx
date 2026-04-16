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
import { Users } from "lucide-react";
import type { MatchupDialogProps, EntrantRow, CrewInfo } from "./matchup/types";
import { getPrizeLines } from "./matchup/utils";
import { HeadToHeadLayout } from "./matchup/HeadToHeadLayout";
import { MultiEntryLayout } from "./matchup/MultiEntryLayout";

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
  const isH2H = maxEntries === 2;
  const displayedEntries = Math.max(currentEntries ?? 0, entrants.length);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    fetchData();
  }, [open, poolId]);

  const fetchData = async () => {
    try {
      const [entriesRes, crewsRes, scoresRes] = await Promise.all([
        supabase.rpc("get_pool_entrants", { p_pool_id: poolId }),
        supabase
          .from("contest_pool_crews")
          .select("crew_id, crew_name, event_id, logo_url")
          .eq("contest_pool_id", poolId),
        supabase
          .from("contest_scores")
          .select("entry_id, total_points, margin_bonus, rank, payout_cents, is_winner, crew_scores")
          .eq("pool_id", poolId),
      ]);

      const newCrewMap = new Map<string, CrewInfo>();
      (crewsRes.data || []).forEach((c: CrewInfo) => newCrewMap.set(c.crew_id, c));
      setCrewMap(newCrewMap);

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

      const userIds = [...new Set((entriesRes.data || []).map((e: any) => e.user_id))];
      const usernameMap = new Map<string, string>();
      if (userIds.length > 0) {
        const { data: usernameData } = await supabase.rpc("get_usernames", { user_ids: userIds });
        (usernameData || []).forEach((u: { user_id: string; username: string }) => {
          if (u.username) usernameMap.set(u.user_id, u.username);
        });
      }

      const rows: EntrantRow[] = (entriesRes.data || []).map((e: any) => ({
        id: e.id,
        user_id: e.user_id,
        username: usernameMap.get(e.user_id) || null,
        tier_name: e.tier_name || null,
        picks: e.picks,
        total_points: e.total_points,
        margin_error: e.margin_error,
        rank: e.rank,
        payout_cents: e.payout_cents,
        status: e.status,
        created_at: e.created_at,
        score: scoresMap.get(e.id),
      }));

      rows.sort((a, b) => {
        const rankA = a.score?.rank ?? a.rank ?? 999;
        const rankB = b.score?.rank ?? b.rank ?? 999;
        if (isCompleted && rankA !== rankB) return rankA - rankB;
        return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
      });

      setEntrants(rows);
    } catch (err) {
      console.error("Error fetching matchup data:", err);
    } finally {
      setLoading(false);
    }
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={`${isH2H ? "max-w-2xl" : "max-w-xl"} max-h-[85vh] overflow-y-auto p-0 rounded-xl animate-scale-in`}
      >
        {/* Gradient Header */}
        <div
          className="rounded-t-xl"
          style={{ background: "var(--gradient-hero)" }}
        >
          <DialogHeader className="p-5 pb-4">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <DialogTitle className="text-lg font-heading font-bold text-primary-foreground">
                {contestName}
                {isH2H && (
                  <span className="ml-2 text-xs font-body font-normal text-primary-foreground/60">
                    H2H Matchup
                  </span>
                )}
              </DialogTitle>
              {getStatusBadge()}
            </div>
            <div className="flex items-center gap-4 text-sm mt-2 flex-wrap">
              <span className="flex items-center gap-1.5 text-primary-foreground/70">
                <Users className="h-3.5 w-3.5" />
                {displayedEntries}/{maxEntries} entries
              </span>
              {payoutStructure && (
                <span className="text-gold font-heading font-medium text-xs">
                  {getPrizeLines(payoutStructure)}
                </span>
              )}
            </div>
          </DialogHeader>
        </div>

        {/* Body */}
        {loading ? (
          <div className="p-5 space-y-3">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-20 w-full rounded-xl" />
            ))}
          </div>
        ) : entrants.length === 0 ? (
          <div className="py-14 text-center px-6">
            <div className="w-14 h-14 rounded-full bg-accent/10 flex items-center justify-center mx-auto mb-3">
              <Users className="h-7 w-7 text-accent" />
            </div>
            <p className="text-muted-foreground font-heading font-medium">Waiting for opponents…</p>
            <p className="text-sm text-muted-foreground font-body mt-1">Other players haven't joined yet.</p>
          </div>
        ) : entrants.length === 1 ? (
          isH2H ? (
            <div className="py-14 text-center px-6">
              <div className="w-14 h-14 rounded-full bg-gold/10 flex items-center justify-center mx-auto mb-3">
                <Users className="h-7 w-7 text-gold" />
              </div>
              <p className="text-foreground font-heading font-medium">Opponent matched!</p>
              <p className="text-sm text-muted-foreground font-body mt-1">Their picks will be revealed when the contest locks.</p>
            </div>
          ) : (
            <div className="py-14 text-center px-6">
              <div className="w-14 h-14 rounded-full bg-accent/10 flex items-center justify-center mx-auto mb-3">
                <Users className="h-7 w-7 text-accent" />
              </div>
              <p className="text-muted-foreground font-heading font-medium">Waiting for opponents…</p>
              <p className="text-sm text-muted-foreground font-body mt-1">Other players haven't joined yet.</p>
            </div>
          )
        ) : entrants.length === 2 ? (
          <HeadToHeadLayout
            entrants={entrants}
            currentUserId={currentUserId}
            crewMap={crewMap}
            isLocked={isLocked}
            isCompleted={isCompleted}
            lockTime={lockTime}
          />
        ) : (
          <MultiEntryLayout
            entrants={entrants}
            currentUserId={currentUserId}
            crewMap={crewMap}
            isLocked={isLocked}
            isCompleted={isCompleted}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
