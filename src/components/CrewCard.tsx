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

  return (
    <div
      className={`group relative rounded-xl bg-card shadow-md transition-all duration-200 overflow-hidden ${
        !isOpen ? "opacity-50 pointer-events-none" : "cursor-pointer hover:shadow-xl hover:-translate-y-1"
      }`}
      style={{
        borderWidth: 2,
        borderStyle: "solid",
        borderColor: isSelected ? color : "hsl(var(--border))",
        boxShadow: isSelected ? `0 4px 20px -4px ${color}40` : undefined,
        animationDelay: `${animDelay}ms`,
      }}
    >
      <div
        className="flex flex-col items-center text-center p-4 pb-3"
        onClick={() => isOpen && onToggle(crewId)}
      >
        {/* Selection checkmark */}
        {isSelected && (
          <div className="absolute top-2 right-2 z-10">
            <div className="w-6 h-6 rounded-full bg-accent flex items-center justify-center shadow-md">
              <Check className="h-3.5 w-3.5 text-accent-foreground" />
            </div>
          </div>
        )}

        <div
          className="rounded-full flex items-center justify-center mb-2.5"
          style={{ width: 72, height: 72, backgroundColor: `${color}15` }}
        >
          <CrewLogo
            logoUrl={logoUrl}
            crewName={crewName}
            size={64}
            className={isSelected ? "ring-2" : ""}
            {...(isSelected ? { style: { "--tw-ring-color": color } as any } : {})}
          />
        </div>
        <p className="font-bold text-base text-foreground">{crewName}</p>
        <p className="text-sm text-muted-foreground">{eventId}</p>
      </div>

      {isSelected && isOpen && (
        <div className="px-3 pb-3 animate-fade-in">
          <div className="space-y-1">
            <p className="text-[10px] font-medium text-muted-foreground">Predicted Margin</p>
            <div className="flex items-center gap-2 p-2 rounded-lg bg-secondary border border-border">
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
              <span className="text-xs text-muted-foreground">seconds</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
