import { CrewLogo } from "@/components/CrewLogo";
import { Input } from "@/components/ui/input";
import { getCrewColor, isLightColor } from "@/lib/school-colors";

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
  const light = isLightColor(color);
  const textColor = light ? "text-slate-900" : "text-white";
  const subtextColor = light ? "text-slate-600" : "text-white/70";
  const overlayClass = light ? "bg-white/20" : "bg-black/10";

  return (
    <div
      className={`relative rounded-[14px] overflow-hidden transition-all duration-300 w-full h-[255px] ${
        !isOpen
          ? "opacity-60 cursor-not-allowed"
          : "cursor-pointer hover:scale-[1.01] hover:brightness-110"
      }`}
      style={{
        backgroundColor: color,
        border: isSelected
          ? `2px solid rgba(45,212,191,0.9)`
          : `1.5px solid rgba(255,255,255,0.2)`,
        boxShadow: isSelected
          ? `0 0 0 4px rgba(45,212,191,0.35), 0 10px 30px rgba(0,0,0,0.2)`
          : `0 4px 20px rgba(0,0,0,0.12)`,
        transform: isSelected && isOpen ? "scale(1.02)" : undefined,
        animation: `fadeUp 0.4s ease forwards`,
        animationDelay: `${animDelay}ms`,
        opacity: 0,
      }}
      onClick={() => isOpen && onToggle(crewId)}
    >
      {/* Selected checkmark badge */}
      {isSelected && (
        <div
          className="absolute top-1.5 right-2 w-6 h-6 rounded-full z-10 flex items-center justify-center bg-teal-400"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path
              d="M2.5 7.5L5.5 10.5L11.5 4"
              stroke="white"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
      )}

      {/* Logo area — top section */}
      <div className="flex items-center justify-center pt-6 pb-3">
        <div
          className="rounded-full overflow-hidden bg-white/20 ring-2 ring-white/30"
          style={{ width: 72, height: 72 }}
        >
          <CrewLogo
            logoUrl={logoUrl}
            crewName={crewName}
            size={72}
            className="rounded-full"
          />
        </div>
      </div>

      {/* Text area — bottom section with overlay */}
      <div className={`absolute bottom-0 left-0 right-0 text-center px-3 pb-3 pt-2 ${overlayClass}`}>
        <p className={`font-bold text-xl tracking-tight leading-tight ${textColor}`}>
          {crewName}
        </p>
        <p className={`text-[11px] font-medium mt-[3px] tracking-wider uppercase ${subtextColor}`}>
          {eventId}
        </p>

        {isSelected && isOpen && (
          <div className="mt-2 animate-fade-in" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-1.5 p-1.5 rounded-md bg-black/20 border border-white/20">
              <Input
                type="number"
                min="0.01"
                step="0.1"
                placeholder="Margin"
                className={`h-6 text-xs border-0 bg-transparent p-0 focus-visible:ring-0 placeholder:text-white/40 ${textColor}`}
                value={marginVal || ""}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => {
                  e.stopPropagation();
                  onMarginChange(crewId, parseFloat(e.target.value) || 0);
                }}
              />
              <span className={`text-[10px] whitespace-nowrap ${subtextColor}`}>sec</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
