import { Trophy, Lock, CheckCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { formatCents } from "@/lib/formatCurrency";
import { CrewLogo } from "@/components/CrewLogo";
import type { EntrantRow, CrewInfo, ParsedPick } from "./types";
import { parsePicks, getEntrantData, formatEventId } from "./utils";

interface HeadToHeadLayoutProps {
  entrants: EntrantRow[];
  currentUserId: string;
  crewMap: Map<string, CrewInfo>;
  isLocked: boolean;
  isCompleted: boolean;
  lockTime: string;
}

function EntrantColumn({
  entrant,
  isCurrentUser,
  picks,
  showPicks,
  isCompleted,
  side,
}: {
  entrant: EntrantRow;
  isCurrentUser: boolean;
  picks: ParsedPick[];
  showPicks: boolean;
  isCompleted: boolean;
  side: "left" | "right";
}) {
  const { points, marginError, payout, isWinner } = getEntrantData(entrant);

  return (
    <div
      className={`flex-1 flex flex-col items-center p-5 relative ${
        isCurrentUser ? "bg-accent/5" : "bg-background"
      } ${isWinner && isCompleted ? "border-t-2 border-t-gold" : ""}`}
    >
      {/* Avatar */}
      <div
        className={`w-14 h-14 rounded-full flex items-center justify-center text-xl font-heading font-bold mb-2 ${
          isWinner && isCompleted
            ? "bg-gold/15 text-gold ring-2 ring-gold/30"
            : isCurrentUser
            ? "bg-accent/10 text-accent"
            : "bg-muted text-muted-foreground"
        }`}
      >
        {isWinner && isCompleted ? (
          <Trophy className="h-6 w-6 text-gold" />
        ) : (
          (entrant.username || "?")[0].toUpperCase()
        )}
      </div>

      {/* Username */}
      <div className="flex items-center gap-1.5 mb-4">
        {isWinner && isCompleted && <Trophy className="h-3.5 w-3.5 text-gold" />}
        <span
          className={`text-sm font-heading font-semibold ${
            isCurrentUser ? "text-accent" : "text-foreground"
          }`}
        >
          @{entrant.username || "anonymous"}
        </span>
        {isCurrentUser && (
          <span className="text-[10px] text-muted-foreground font-body">(you)</span>
        )}
      </div>

      {/* Picks Section */}
      <div className="w-full">
        <div className="flex items-center gap-2 mb-3">
          <div className="h-px flex-1 bg-border" />
          <span className="text-[10px] uppercase tracking-widest text-muted-foreground font-heading font-semibold">
            {isCurrentUser ? "Your Picks" : "Their Picks"}
          </span>
          <div className="h-px flex-1 bg-border" />
        </div>

        {showPicks ? (
          <div className="space-y-2">
            {picks.map((pick, idx) => (
              <div
                key={idx}
                className="rounded-lg border border-border bg-card p-2.5 transition-all hover:shadow-sm hover:border-accent/20"
              >
                <div className="flex items-center gap-2">
                  <CrewLogo logoUrl={pick.logoUrl} crewName={pick.crewName} size={32} />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-heading font-semibold text-foreground truncate">
                      {pick.crewName}
                    </p>
                    {pick.eventId && (
                      <p className="text-[10px] text-muted-foreground font-body">
                        {formatEventId(pick.eventId)}
                      </p>
                    )}
                  </div>
                </div>
                {pick.margin != null && (
                  <div className="mt-1.5 text-xs font-heading font-semibold text-accent">
                    Margin: +{pick.margin.toFixed(1)}s
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : (
          <div className="relative rounded-lg border border-border bg-muted/50 p-6">
            <div className="space-y-2 opacity-10 blur-[6px] pointer-events-none select-none">
              {[1, 2].map((i) => (
                <div key={i} className="h-12 rounded-lg bg-muted-foreground/20" />
              ))}
            </div>
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <Lock className="h-4 w-4 text-muted-foreground mb-1" />
              <span className="text-xs text-muted-foreground font-body">
                Picks revealed at lock
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Scoring for completed */}
      {isCompleted && (
        <div className="w-full mt-4 pt-3 border-t border-border">
          <div className="text-center">
            <p className="text-2xl font-heading font-bold text-foreground">
              {points ?? "—"}
              <span className="text-sm font-normal text-muted-foreground ml-1">pts</span>
            </p>
            <p className="text-xs text-muted-foreground font-body mt-0.5">
              Margin: ±{marginError != null ? Number(marginError).toFixed(1) : "—"}s
            </p>
          </div>
          {payout != null && payout > 0 && (
            <div className="mt-2 flex items-center justify-center gap-1.5">
              <CheckCircle className="h-3.5 w-3.5 text-success" />
              <span className="text-sm font-heading font-bold text-success">
                {formatCents(payout)}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function HeadToHeadLayout({
  entrants,
  currentUserId,
  crewMap,
  isLocked,
  isCompleted,
  lockTime,
}: HeadToHeadLayoutProps) {
  // Ensure current user is on the left
  const sorted = [...entrants].sort((a, b) => {
    if (a.user_id === currentUserId) return -1;
    if (b.user_id === currentUserId) return 1;
    return 0;
  });

  const [left, right] = sorted;
  const leftData = getEntrantData(left);
  const rightData = getEntrantData(right);

  // Determine result banner
  let resultBanner: React.ReactNode;
  if (isCompleted) {
    const winner = leftData.isWinner ? left : rightData.isWinner ? right : null;
    if (winner) {
      const winnerPayout = getEntrantData(winner).payout;
      resultBanner = (
        <div className="flex items-center justify-center gap-2">
          <Trophy className="h-4 w-4 text-gold" />
          <span className="text-sm font-heading font-bold text-gold">
            @{winner.username || "anonymous"} wins {winnerPayout ? formatCents(winnerPayout) : ""}
          </span>
        </div>
      );
    } else {
      // Tie / refund
      resultBanner = (
        <span className="text-sm font-heading font-semibold text-gold">
          Tie — refunded
        </span>
      );
    }
  } else {
    const lockDate = new Date(lockTime);
    resultBanner = (
      <span className="text-xs text-muted-foreground font-body">
        Contest in progress — locks at{" "}
        {lockDate.toLocaleString(undefined, {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        })}
      </span>
    );
  }

  const canSeePicks = (entrant: EntrantRow) =>
    entrant.user_id === currentUserId || isLocked || isCompleted;

  return (
    <div>
      {/* VS Split */}
      <div className="flex relative">
        <EntrantColumn
          entrant={left}
          isCurrentUser={left.user_id === currentUserId}
          picks={parsePicks(left.picks, crewMap)}
          showPicks={canSeePicks(left)}
          isCompleted={isCompleted}
          side="left"
        />

        {/* VS Divider */}
        <div className="absolute left-1/2 top-12 -translate-x-1/2 z-10">
          <div
            className={`w-10 h-10 rounded-full bg-primary flex items-center justify-center shadow-lg ${
              !isCompleted ? "animate-pulse" : ""
            }`}
          >
            <span className="text-xs font-heading font-bold text-primary-foreground">VS</span>
          </div>
        </div>

        {/* Center divider line */}
        <div className="w-px bg-border" />

        <EntrantColumn
          entrant={right}
          isCurrentUser={right.user_id === currentUserId}
          picks={parsePicks(right.picks, crewMap)}
          showPicks={canSeePicks(right)}
          isCompleted={isCompleted}
          side="right"
        />
      </div>

      {/* Result Banner */}
      <div className="border-t border-border px-4 py-3 text-center bg-muted/30">
        {resultBanner}
      </div>
    </div>
  );
}
