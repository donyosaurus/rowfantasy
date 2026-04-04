import { CrewLogo } from "@/components/CrewLogo";
import { getCrewColor } from "@/lib/school-colors";
import { isCountry } from "@/lib/country-detection";
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
        {picks.map((pick) => {
          const color = getCrewColor(pick.crewName);
          const country = isCountry(pick.crewName);
          return (
            <div
              key={pick.crewId}
              className="flex items-center gap-3 px-3 py-2 rounded-lg border-l-4"
              style={{
                borderLeftColor: color,
                backgroundColor: `${color}14`,
              }}
            >
              <CrewLogo
                logoUrl={pick.logoUrl}
                crewName={pick.crewName}
                size={32}
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-sm text-foreground truncate">{pick.crewName}</p>
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

        {events
          .filter((eventId) => !pickedEventIds.has(eventId))
          .slice(0, maxPicks - picks.length)
          .map((eventId) => (
            <div
              key={`empty-${eventId}`}
              className="flex items-center gap-3 px-3 py-2 rounded-lg border-2 border-dashed border-border text-sm text-muted-foreground"
            >
              <div className="w-8 h-8 rounded-full border-2 border-dashed border-border flex-shrink-0" />
              <span>Select a crew for {eventId}</span>
            </div>
          ))}
      </div>
    </div>
  );
}
