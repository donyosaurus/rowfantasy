import { useState } from "react";
import { useToast } from "@/hooks/use-toast";
import stateStatuses from "@/data/stateStatuses.json";

const US_STATES: { code: string; name: string }[] = [
  { code: "AL", name: "Alabama" }, { code: "AK", name: "Alaska" }, { code: "AZ", name: "Arizona" },
  { code: "AR", name: "Arkansas" }, { code: "CA", name: "California" }, { code: "CO", name: "Colorado" },
  { code: "CT", name: "Connecticut" }, { code: "DE", name: "Delaware" }, { code: "FL", name: "Florida" },
  { code: "GA", name: "Georgia" }, { code: "HI", name: "Hawaii" }, { code: "ID", name: "Idaho" },
  { code: "IL", name: "Illinois" }, { code: "IN", name: "Indiana" }, { code: "IA", name: "Iowa" },
  { code: "KS", name: "Kansas" }, { code: "KY", name: "Kentucky" }, { code: "LA", name: "Louisiana" },
  { code: "ME", name: "Maine" }, { code: "MD", name: "Maryland" }, { code: "MA", name: "Massachusetts" },
  { code: "MI", name: "Michigan" }, { code: "MN", name: "Minnesota" }, { code: "MS", name: "Mississippi" },
  { code: "MO", name: "Missouri" }, { code: "MT", name: "Montana" }, { code: "NE", name: "Nebraska" },
  { code: "NV", name: "Nevada" }, { code: "NH", name: "New Hampshire" }, { code: "NJ", name: "New Jersey" },
  { code: "NM", name: "New Mexico" }, { code: "NY", name: "New York" }, { code: "NC", name: "North Carolina" },
  { code: "ND", name: "North Dakota" }, { code: "OH", name: "Ohio" }, { code: "OK", name: "Oklahoma" },
  { code: "OR", name: "Oregon" }, { code: "PA", name: "Pennsylvania" }, { code: "RI", name: "Rhode Island" },
  { code: "SC", name: "South Carolina" }, { code: "SD", name: "South Dakota" }, { code: "TN", name: "Tennessee" },
  { code: "TX", name: "Texas" }, { code: "UT", name: "Utah" }, { code: "VT", name: "Vermont" },
  { code: "VA", name: "Virginia" }, { code: "WA", name: "Washington" }, { code: "WV", name: "West Virginia" },
  { code: "WI", name: "Wisconsin" }, { code: "WY", name: "Wyoming" },
];

const statusColors: Record<string, string> = {
  permitted: "bg-green-300",
  restricted: "bg-amber-300",
  banned: "bg-muted",
};

const statusBorderColors: Record<string, string> = {
  permitted: "border-green-400",
  restricted: "border-amber-400",
  banned: "border-muted-foreground/30",
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
    <div className="w-full max-w-4xl mx-auto">
      <div className="grid grid-cols-5 sm:grid-cols-7 md:grid-cols-10 gap-1.5">
        {US_STATES.map(({ code, name }) => {
          const status = getStatus(code);
          const isHovered = hoveredState === code;
          return (
            <button
              key={code}
              className={`
                flex items-center justify-center rounded-md px-1 py-2 text-xs font-bold
                border transition-all cursor-pointer
                ${statusColors[status] || statusColors.banned}
                ${statusBorderColors[status] || statusBorderColors.banned}
                ${isHovered ? "ring-2 ring-primary scale-110 z-10" : ""}
              `}
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
            {US_STATES.find((s) => s.code === hoveredState)?.name}
          </span>
          <span className="text-xs text-muted-foreground ml-2 capitalize">
            {getStatus(hoveredState)}
          </span>
        </div>
      )}

      <div className="flex justify-center gap-6 mt-6 flex-wrap">
        {[
          { label: "Permitted", color: "bg-green-300" },
          { label: "Restricted", color: "bg-amber-300" },
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
