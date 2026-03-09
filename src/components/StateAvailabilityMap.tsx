import { useState } from "react";
import stateStatuses from "@/data/stateStatuses.json";

const STATUS_COLORS: Record<string, string> = {
  permitted: "bg-green-300 hover:bg-green-400",
  restricted: "bg-yellow-300 hover:bg-yellow-400",
  banned: "bg-muted hover:bg-muted/80",
};

const STATUS_LABELS: Record<string, string> = {
  permitted: "Permitted",
  restricted: "Restricted",
  banned: "Banned",
};

const STATES: { abbr: string; name: string }[] = [
  { abbr: "AL", name: "Alabama" }, { abbr: "AK", name: "Alaska" }, { abbr: "AZ", name: "Arizona" },
  { abbr: "AR", name: "Arkansas" }, { abbr: "CA", name: "California" }, { abbr: "CO", name: "Colorado" },
  { abbr: "CT", name: "Connecticut" }, { abbr: "DE", name: "Delaware" }, { abbr: "FL", name: "Florida" },
  { abbr: "GA", name: "Georgia" }, { abbr: "HI", name: "Hawaii" }, { abbr: "ID", name: "Idaho" },
  { abbr: "IL", name: "Illinois" }, { abbr: "IN", name: "Indiana" }, { abbr: "IA", name: "Iowa" },
  { abbr: "KS", name: "Kansas" }, { abbr: "KY", name: "Kentucky" }, { abbr: "LA", name: "Louisiana" },
  { abbr: "ME", name: "Maine" }, { abbr: "MD", name: "Maryland" }, { abbr: "MA", name: "Massachusetts" },
  { abbr: "MI", name: "Michigan" }, { abbr: "MN", name: "Minnesota" }, { abbr: "MS", name: "Mississippi" },
  { abbr: "MO", name: "Missouri" }, { abbr: "MT", name: "Montana" }, { abbr: "NE", name: "Nebraska" },
  { abbr: "NV", name: "Nevada" }, { abbr: "NH", name: "New Hampshire" }, { abbr: "NJ", name: "New Jersey" },
  { abbr: "NM", name: "New Mexico" }, { abbr: "NY", name: "New York" }, { abbr: "NC", name: "North Carolina" },
  { abbr: "ND", name: "North Dakota" }, { abbr: "OH", name: "Ohio" }, { abbr: "OK", name: "Oklahoma" },
  { abbr: "OR", name: "Oregon" }, { abbr: "PA", name: "Pennsylvania" }, { abbr: "RI", name: "Rhode Island" },
  { abbr: "SC", name: "South Carolina" }, { abbr: "SD", name: "South Dakota" }, { abbr: "TN", name: "Tennessee" },
  { abbr: "TX", name: "Texas" }, { abbr: "UT", name: "Utah" }, { abbr: "VT", name: "Vermont" },
  { abbr: "VA", name: "Virginia" }, { abbr: "WA", name: "Washington" }, { abbr: "WV", name: "West Virginia" },
  { abbr: "WI", name: "Wisconsin" }, { abbr: "WY", name: "Wyoming" },
];

export const StateAvailabilityMap = () => {
  const [hoveredState, setHoveredState] = useState<string | null>(null);

  const getStatus = (abbr: string): string =>
    (stateStatuses as Record<string, string>)[abbr] || "banned";

  return (
    <div className="w-full max-w-4xl mx-auto">
      <div className="grid grid-cols-5 sm:grid-cols-8 md:grid-cols-10 gap-1.5">
        {STATES.map(({ abbr, name }) => {
          const status = getStatus(abbr);
          const isHovered = hoveredState === abbr;
          return (
            <div
              key={abbr}
              className={`relative flex items-center justify-center rounded-md p-2 text-xs font-bold cursor-default transition-all select-none ${STATUS_COLORS[status] || STATUS_COLORS.banned} ${isHovered ? "ring-2 ring-primary scale-110 z-10" : ""}`}
              onMouseEnter={() => setHoveredState(abbr)}
              onMouseLeave={() => setHoveredState(null)}
              title={`${name}: ${STATUS_LABELS[status] || "Unknown"}`}
            >
              {abbr}
            </div>
          );
        })}
      </div>

      {hoveredState && (
        <div className="mt-4 text-center">
          <span className="font-semibold">
            {STATES.find((s) => s.abbr === hoveredState)?.name}
          </span>
          <span className="text-muted-foreground ml-2 capitalize">
            — {getStatus(hoveredState)}
          </span>
        </div>
      )}

      <div className="flex justify-center gap-6 mt-6 flex-wrap">
        {Object.entries(STATUS_LABELS).map(([key, label]) => (
          <div key={key} className="flex items-center gap-2">
            <div className={`w-4 h-4 rounded ${STATUS_COLORS[key]?.split(" ")[0]}`} />
            <span className="text-sm font-medium">{label}</span>
          </div>
        ))}
      </div>

      <p className="text-center text-xs text-muted-foreground mt-6 italic">
        The use of VPNs to bypass geofencing regulations is unethical and heavily discouraged.
      </p>
    </div>
  );
};
