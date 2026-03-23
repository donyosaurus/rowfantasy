import { CrewLogo } from "@/components/CrewLogo";
import { getCrewColor } from "@/lib/school-colors";
import { X } from "lucide-react";

interface DraftPick {
  crewId: string;
  crewName: string;
  eventId: string;
  margin: number;
  logoUrl?: string | null;
}

interface DraftPicksListProps {
  picks: DraftPick[];
  events: string[];
  maxPicks: number;
  onRemove: (crewId: string) => void;
}

export function DraftPicksList({ picks, events, maxPicks, onRemove }: DraftPicksListProps) {
  const pickedEventIds = new Set(picks.map((p) => p.eventId));
  const allComplete = picks.length >= maxPicks;

  return (
    <div>
      <p className={`text-xs font-semibold tracking-wider uppercase mb-2 ${allComplete ? "text-teal-600" : "text-muted-foreground"}`}>
        Your Picks ({picks.length}/{maxPicks})
      </p>
      <div className="space-y-2">
        {/* Filled picks */}
        {picks.map((pick) => {
          const color = getCrewColor(pick.crewName);
          return (
            <div
              key={pick.crewId}
              className="w-full rounded-lg p-3 flex items-center gap-3 border-l-4"
              style={{
                borderLeftColor: color,
                backgroundColor: `${color}14`,
              }}
            >
              <CrewLogo logoUrl={pick.logoUrl} crewName={pick.crewName} size={40} />
              <div className="flex-1 min-w-0">
                <p className="font-bold text-sm text-foreground truncate">{pick.crewName}</p>
                <p className="text-xs text-muted-foreground">{pick.eventId}</p>
              </div>
              <button
                onClick={(e) => { e.stopPropagation(); onRemove(pick.crewId); }}
                className="w-6 h-6 rounded-full bg-secondary hover:bg-destructive/10 hover:text-destructive flex items-center justify-center text-muted-foreground text-xs cursor-pointer transition-colors flex-shrink-0"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          );
        })}

        {/* Empty placeholder slots */}
        {events
          .filter((eventId) => !pickedEventIds.has(eventId))
          .slice(0, maxPicks - picks.length)
          .map((eventId) => (
            <div
              key={`empty-${eventId}`}
              className="w-full rounded-lg p-3 border-2 border-dashed border-border text-sm text-muted-foreground flex items-center gap-2"
            >
              <div className="w-6 h-6 rounded-full border-2 border-dashed border-border flex-shrink-0" />
              <span>Select a crew for {eventId}</span>
            </div>
          ))}
      </div>
    </div>
  );
}
