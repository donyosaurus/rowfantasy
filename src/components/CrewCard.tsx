import { CrewLogo } from "@/components/CrewLogo";
import { Input } from "@/components/ui/input";
import { Check } from "lucide-react";
import { getCrewColor } from "@/lib/school-colors";

interface CrewCardProps {
  crewId: string;
  crewName: string;
  eventId: string;
  logoUrl?: string | null;
  isSelected: boolean;
  marginVal: number;
  isOpen: boolean;
  onToggle: (crewId: string) => void;
  onMarginChange: (crewId: string, margin: number) => void;
  animDelay?: number;
}

export function CrewCard({
  crewId, crewName, eventId, logoUrl, isSelected, marginVal,
  isOpen, onToggle, onMarginChange, animDelay = 0,
}: CrewCardProps) {
  const color = getCrewColor(crewName);
  const hasLogo = !!logoUrl;

  // For cards with logos, use school color theming; without logos, use dark slate
  const unselectedBg = hasLogo
    ? `linear-gradient(135deg, ${color}18 0%, ${color}08 100%)`
    : `linear-gradient(135deg, #334155 0%, #1e293b 100%)`;

  const selectedBg = hasLogo
    ? `linear-gradient(135deg, ${color}30 0%, ${color}15 100%)`
    : `linear-gradient(135deg, #334155 0%, #1e293b 100%)`;

  const borderColor = isSelected
    ? color
    : hasLogo ? `${color}40` : "rgba(255,255,255,0.15)";

  const selectedShadow = isSelected ? `0 4px 20px -4px ${color}50` : undefined;

  return (
    <div
      className={`group relative rounded-xl border-2 transition-all duration-200 overflow-hidden ${
        !isOpen ? "opacity-50 pointer-events-none" : "cursor-pointer"
      } ${isSelected ? "" : "hover:shadow-lg hover:-translate-y-1"}`}
      style={{
        background: isSelected ? selectedBg : unselectedBg,
        borderColor,
        boxShadow: selectedShadow,
        animationDelay: `${animDelay}ms`,
      }}
    >
      <div
        className="flex flex-col items-center text-center p-4 pb-3"
        onClick={() => isOpen && onToggle(crewId)}
      >
        {/* Selection checkmark badge */}
        {isSelected && (
          <div className="absolute top-2 right-2 z-10">
            <div
              className="w-6 h-6 rounded-full flex items-center justify-center shadow-md"
              style={{ backgroundColor: color }}
            >
              <Check className="h-3.5 w-3.5 text-white" />
            </div>
          </div>
        )}

        <CrewLogo
          logoUrl={logoUrl}
          crewName={crewName}
          size={64}
          className={`mb-2.5 ${!hasLogo ? "ring-2 ring-white/30" : ""} ${isSelected ? "ring-2" : ""}`}
          {...(isSelected && hasLogo ? { style: { "--tw-ring-color": color } as any } : {})}
        />
        <p className={`font-semibold text-sm ${hasLogo ? "text-foreground" : "text-white"}`}>{crewName}</p>
        <p className={`text-xs ${hasLogo ? "text-muted-foreground" : "text-white/60"}`}>{eventId}</p>
      </div>

      {isSelected && isOpen && (
        <div className="px-3 pb-3 animate-fade-in">
          <div className="space-y-1">
            <p className={`text-[10px] font-medium ${hasLogo ? "text-muted-foreground" : "text-white/60"}`}>Predicted Margin</p>
            <div className="flex items-center gap-2 p-2 rounded-lg bg-white/10 border border-white/10">
              <Input
                type="number"
                min="0.01"
                step="0.1"
                placeholder="e.g. 2.5"
                className="h-7 text-sm border-0 bg-transparent p-0 focus-visible:ring-0 text-foreground placeholder:text-muted-foreground/50"
                value={marginVal || ""}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => { e.stopPropagation(); onMarginChange(crewId, parseFloat(e.target.value) || 0); }}
              />
              <span className={`text-xs ${hasLogo ? "text-muted-foreground" : "text-white/60"}`}>seconds</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
