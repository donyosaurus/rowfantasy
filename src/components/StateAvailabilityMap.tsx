import { useState } from "react";
import { useToast } from "@/hooks/use-toast";
import stateStatuses from "@/data/stateStatuses.json";

// Cartogram grid positions (col, row) approximating US geography
const STATE_POSITIONS: Record<string, { col: number; row: number; name: string }> = {
  AK: { col: 0, row: 0, name: "Alaska" },
  HI: { col: 0, row: 5, name: "Hawaii" },
  WA: { col: 1, row: 0, name: "Washington" },
  OR: { col: 1, row: 1, name: "Oregon" },
  CA: { col: 1, row: 2, name: "California" },
  NV: { col: 2, row: 2, name: "Nevada" },
  ID: { col: 2, row: 1, name: "Idaho" },
  MT: { col: 2, row: 0, name: "Montana" },
  UT: { col: 2, row: 3, name: "Utah" },
  AZ: { col: 2, row: 4, name: "Arizona" },
  WY: { col: 3, row: 1, name: "Wyoming" },
  CO: { col: 3, row: 2, name: "Colorado" },
  NM: { col: 3, row: 4, name: "New Mexico" },
  ND: { col: 4, row: 0, name: "North Dakota" },
  SD: { col: 4, row: 1, name: "South Dakota" },
  NE: { col: 4, row: 2, name: "Nebraska" },
  KS: { col: 4, row: 3, name: "Kansas" },
  OK: { col: 4, row: 4, name: "Oklahoma" },
  TX: { col: 4, row: 5, name: "Texas" },
  MN: { col: 5, row: 0, name: "Minnesota" },
  IA: { col: 5, row: 1, name: "Iowa" },
  MO: { col: 5, row: 2, name: "Missouri" },
  AR: { col: 5, row: 3, name: "Arkansas" },
  LA: { col: 5, row: 4, name: "Louisiana" },
  WI: { col: 6, row: 0, name: "Wisconsin" },
  IL: { col: 6, row: 1, name: "Illinois" },
  IN: { col: 7, row: 1, name: "Indiana" },
  MI: { col: 7, row: 0, name: "Michigan" },
  KY: { col: 7, row: 2, name: "Kentucky" },
  TN: { col: 7, row: 3, name: "Tennessee" },
  MS: { col: 6, row: 3, name: "Mississippi" },
  AL: { col: 7, row: 4, name: "Alabama" },
  OH: { col: 8, row: 1, name: "Ohio" },
  WV: { col: 8, row: 2, name: "West Virginia" },
  GA: { col: 8, row: 4, name: "Georgia" },
  FL: { col: 9, row: 5, name: "Florida" },
  SC: { col: 9, row: 4, name: "South Carolina" },
  NC: { col: 9, row: 3, name: "North Carolina" },
  VA: { col: 9, row: 2, name: "Virginia" },
  PA: { col: 9, row: 1, name: "Pennsylvania" },
  NY: { col: 9, row: 0, name: "New York" },
  MD: { col: 10, row: 2, name: "Maryland" },
  DE: { col: 10, row: 3, name: "Delaware" },
  NJ: { col: 10, row: 1, name: "New Jersey" },
  CT: { col: 10, row: 0, name: "Connecticut" },
  VT: { col: 11, row: 0, name: "Vermont" },
  NH: { col: 11, row: 1, name: "New Hampshire" },
  MA: { col: 11, row: 2, name: "Massachusetts" },
  RI: { col: 11, row: 3, name: "Rhode Island" },
  ME: { col: 12, row: 0, name: "Maine" },
};

const statusColors: Record<string, string> = {
  permitted: "bg-green-500/80 hover:bg-green-500 border-green-400",
  restricted: "bg-amber-500/80 hover:bg-amber-500 border-amber-400",
  banned: "bg-muted hover:bg-muted/80 border-muted-foreground/30",
};

const statusText: Record<string, string> = {
  permitted: "text-green-50",
  restricted: "text-amber-50",
  banned: "text-muted-foreground",
};

export const StateAvailabilityMap = () => {
  const [hoveredState, setHoveredState] = useState<string | null>(null);
  const { toast } = useToast();

  const getStatus = (code: string): string =>
    stateStatuses[code as keyof typeof stateStatuses] || "unknown";

  const handleClick = (code: string, name: string) => {
    const status = getStatus(code);
    const text = `${name}: ${status.charAt(0).toUpperCase() + status.slice(1)}`;
    navigator.clipboard.writeText(text);
    toast({ title: "Copied to clipboard", description: text, duration: 2000 });
  };

  return (
    <div className="w-full max-w-5xl mx-auto">
      <div
        className="grid gap-1"
        style={{
          gridTemplateColumns: "repeat(13, minmax(0, 1fr))",
          gridTemplateRows: "repeat(6, minmax(0, 1fr))",
        }}
      >
        {Object.entries(STATE_POSITIONS).map(([code, { col, row, name }]) => {
          const status = getStatus(code);
          const isHovered = hoveredState === code;
          return (
            <button
              key={code}
              className={`
                flex items-center justify-center rounded-md aspect-square text-[10px] sm:text-xs font-bold
                border transition-all cursor-pointer
                ${statusColors[status] || statusColors.banned}
                ${statusText[status] || statusText.banned}
                ${isHovered ? "ring-2 ring-primary scale-110 z-10 shadow-lg" : ""}
              `}
              style={{ gridColumn: col + 1, gridRow: row + 1 }}
              onMouseEnter={() => setHoveredState(code)}
              onMouseLeave={() => setHoveredState(null)}
              onClick={() => handleClick(code, name)}
              title={`${name} — ${status}`}
            >
              {code}
            </button>
          );
        })}
      </div>

      {hoveredState && (
        <div className="mt-4 text-center">
          <span className="font-semibold text-sm">
            {STATE_POSITIONS[hoveredState]?.name}
          </span>
          <span className="text-xs text-muted-foreground ml-2 capitalize">
            {getStatus(hoveredState)}
          </span>
        </div>
      )}

      <div className="flex justify-center gap-6 mt-6 flex-wrap">
        {[
          { label: "Permitted", color: "bg-green-500/80" },
          { label: "Restricted", color: "bg-amber-500/80" },
          { label: "Banned", color: "bg-muted" },
        ].map(({ label, color }) => (
          <div key={label} className="flex items-center gap-2">
            <div className={`w-4 h-4 rounded ${color}`} />
            <span className="text-sm font-medium">{label}</span>
          </div>
        ))}
      </div>

      <p className="text-center text-sm text-muted-foreground mt-4">
        Click any state to copy its status to clipboard
      </p>
      <p className="text-center text-xs text-muted-foreground mt-6 italic">
        The use of VPNs to bypass geofencing regulations is unethical and heavily discouraged.
      </p>
    </div>
  );
};
