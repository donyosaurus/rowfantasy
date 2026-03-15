import { useState } from "react";
import { Trophy, ChevronDown, ChevronUp, Lock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { formatCents } from "@/lib/formatCurrency";
import type { EntrantRow, CrewInfo } from "./types";
import { parsePicks, getEntrantData, getRankLabel, formatEventId } from "./utils";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

interface MultiEntryLayoutProps {
  entrants: EntrantRow[];
  currentUserId: string;
  crewMap: Map<string, CrewInfo>;
  isLocked: boolean;
  isCompleted: boolean;
}

function RankBadge({ rank }: { rank: number | null }) {
  if (!rank) return <div className="w-7 h-7 rounded-full bg-muted flex items-center justify-center text-xs text-muted-foreground">—</div>;
  const colors: Record<number, string> = {
    1: "bg-gold/15 text-gold border-gold/30",
    2: "bg-[hsl(0_0%_75%)]/15 text-[hsl(0_0%_45%)] border-[hsl(0_0%_75%)]/30",
    3: "bg-[hsl(30_60%_50%)]/15 text-[hsl(30_60%_40%)] border-[hsl(30_60%_50%)]/30",
  };
  const cls = colors[rank] || "bg-muted text-muted-foreground border-border";
  return (
    <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-heading font-bold border ${cls}`}>
      {rank}
    </div>
  );
}

function EntrantCard({
  entrant,
  currentUserId,
  crewMap,
  isLocked,
  isCompleted,
}: {
  entrant: EntrantRow;
  currentUserId: string;
  crewMap: Map<string, CrewInfo>;
  isLocked: boolean;
  isCompleted: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const isCurrentUser = entrant.user_id === currentUserId;
  const { rank, points, marginError, payout, isWinner } = getEntrantData(entrant);
  const picks = parsePicks(entrant.picks, crewMap);
  const canSeePicks = isCurrentUser || isLocked || isCompleted;

  return (
    <Collapsible open={expanded} onOpenChange={setExpanded}>
      <div
        className={`rounded-xl border transition-all ${
          isWinner && isCompleted
            ? "border-l-[3px] border-l-gold border-gold/20 bg-gold/5"
            : isCurrentUser
            ? "border-accent/30 bg-accent/5"
            : "border-border bg-card"
        }`}
      >
        <CollapsibleTrigger asChild>
          <button className="w-full p-3 flex items-center gap-3 text-left hover:bg-muted/30 transition-colors rounded-xl">
            {isCompleted && <RankBadge rank={rank ?? null} />}

            {/* Avatar */}
            <div
              className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${
                isWinner && isCompleted
                  ? "bg-gold/15 text-gold"
                  : isCurrentUser
                  ? "bg-accent/10 text-accent"
                  : "bg-muted text-muted-foreground"
              }`}
            >
              {isWinner && isCompleted ? (
                <Trophy className="h-3.5 w-3.5" />
              ) : (
                <span className="text-xs font-heading font-bold">
                  {(entrant.username || "?")[0].toUpperCase()}
                </span>
              )}
            </div>

            {/* Name + picks preview */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5">
                {isWinner && isCompleted && <Trophy className="h-3 w-3 text-gold shrink-0" />}
                <span className={`text-sm font-heading font-semibold truncate ${isCurrentUser ? "text-accent" : ""}`}>
                  @{entrant.username || "anonymous"}
                </span>
                {isCurrentUser && <span className="text-[10px] text-muted-foreground">(you)</span>}
              </div>
              {canSeePicks && picks.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-1">
                  {picks.slice(0, 3).map((pick, idx) => (
                    <Badge key={idx} variant="secondary" className="text-[10px] rounded-md px-1.5 py-0 h-5 bg-primary/5 border border-primary/10">
                      {pick.crewName}
                    </Badge>
                  ))}
                  {picks.length > 3 && (
                    <span className="text-[10px] text-muted-foreground">+{picks.length - 3}</span>
                  )}
                </div>
              )}
              {!canSeePicks && (
                <div className="flex items-center gap-1 mt-1 text-[10px] text-muted-foreground">
                  <Lock className="h-2.5 w-2.5" /> Hidden until lock
                </div>
              )}
            </div>

            {/* Score columns */}
            {isCompleted && (
              <div className="flex items-center gap-3 shrink-0">
                <div className="text-right">
                  <p className="text-sm font-heading font-bold">{points ?? "—"}</p>
                  <p className="text-[10px] text-muted-foreground">pts</p>
                </div>
                <div className="text-right">
                  <p className="text-xs text-muted-foreground">
                    ±{marginError != null ? Number(marginError).toFixed(1) : "—"}s
                  </p>
                </div>
                <div className="text-right min-w-[3.5rem]">
                  <p className={`text-sm font-heading font-bold ${payout && payout > 0 ? "text-success" : "text-muted-foreground"}`}>
                    {payout && payout > 0 ? formatCents(payout) : "—"}
                  </p>
                </div>
              </div>
            )}

            <ChevronDown
              className={`h-4 w-4 text-muted-foreground shrink-0 transition-transform ${expanded ? "rotate-180" : ""}`}
            />
          </button>
        </CollapsibleTrigger>

        <CollapsibleContent>
          <div className="px-3 pb-3 pt-1 border-t border-border">
            {canSeePicks && picks.length > 0 ? (
              <div className="grid gap-1.5 sm:grid-cols-2">
                {picks.map((pick, idx) => (
                  <div key={idx} className="flex items-center gap-2 rounded-lg bg-muted/40 p-2 text-sm">
                    <span>🚣</span>
                    <div className="flex-1 min-w-0">
                      <p className="font-heading font-semibold text-xs truncate">{pick.crewName}</p>
                      {pick.eventId && <p className="text-[10px] text-muted-foreground">{formatEventId(pick.eventId)}</p>}
                    </div>
                    {pick.margin != null && (
                      <span className="text-xs font-heading font-semibold text-accent">
                        +{pick.margin.toFixed(1)}s
                      </span>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground text-center py-2">
                Picks will be revealed when the contest locks.
              </p>
            )}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

export function MultiEntryLayout({
  entrants,
  currentUserId,
  crewMap,
  isLocked,
  isCompleted,
}: MultiEntryLayoutProps) {
  return (
    <div className="p-4 space-y-2">
      {/* Column headers for completed */}
      {isCompleted && (
        <div className="flex items-center px-3 py-1 text-[10px] font-heading font-semibold text-muted-foreground uppercase tracking-wider">
          <span className="w-7 mr-3">Rk</span>
          <span className="w-8 mr-3" />
          <span className="flex-1">Player</span>
          <span className="w-10 text-right mr-3">Pts</span>
          <span className="w-12 text-right mr-3">Margin</span>
          <span className="w-14 text-right mr-3">Payout</span>
          <span className="w-4" />
        </div>
      )}
      {entrants.map((entrant) => (
        <EntrantCard
          key={entrant.id}
          entrant={entrant}
          currentUserId={currentUserId}
          crewMap={crewMap}
          isLocked={isLocked}
          isCompleted={isCompleted}
        />
      ))}
    </div>
  );
}
